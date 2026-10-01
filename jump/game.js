/* ==========================================================================
 * 奶蛙跳一跳 · 渲染 + 交互
 *
 * 规则（蓄力距离公式 / 落点判定 / 台子生成 / 计分）都在 logic.js 里（纯函数，有 node 测试），
 * 这个文件只负责：Canvas 2.5D 等距绘制、输入、动画、音效触发、界面数据。
 *
 * 坐标：世界 (x, z) 在地面，y 向上，单位 u。
 *   轴 0 = +x = 屏幕「右上」；轴 1 = +z = 屏幕「左上」。
 * ========================================================================== */
(function () {
  'use strict';

  var JL = window.JumpLogic;
  if (!JL) { console.error('[奶蛙跳一跳] logic.js 没有加载'); return; }
  var CFG = JL.CFG;

  /* ==========================================================================
   * 一、可调参数（想改手感 / 外观，先看这里）
   * ======================================================================== */
  var BEST_KEY = 'nai_best_jump';
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';

  // 等距投影：两条地面轴与水平线成 30°
  var COS = 0.8660254, SIN = 0.5;
  var ISO_RX = Math.SQRT2 * COS, ISO_RY = Math.SQRT2 * SIN;   // 地面上半径 r 的圆 → 屏幕椭圆半轴 = r×ISO_R?×S
  var TAU = Math.PI * 2;

  var VIEW = {
    FIT_W: 11.0,       // 舞台宽度大约能装下多少个 u（越大，画面里的东西越小）
    FIT_H: 9.0,        // 舞台高度同理
    SCALE_MIN: 18,     // 1u = 多少像素的上下限
    SCALE_MAX: 86,     // （素材最多放大不到 2 倍）
    FOCUS_Y: 0.56,     // 镜头焦点放在舞台高度的哪个位置
    CAM_RATE: 5.0,     // 镜头跟随快慢（越大越紧）
    PILLAR: 3.0        // 台子画出来的厚度（u），底部渐隐进背景
  };

  var PLAYER = {
    H: 1.65,           // 奶蛙身高（u）
    LAUGH_H: 2.15,     // 大笑造型身高（u）
    SQUASH_X: 0.38,    // 压到最扁时：横向变宽的比例
    SQUASH_Y: 0.5,     // 压到最扁时：纵向压低的比例
    SINK_MAX: 0.26,    // 蓄满力时台子下沉多少（u）
    LAUGH_TIME: 0.95,  // 完美落地后大笑多久（秒）
    SPRING_K: 360,     // 压扁回弹的弹簧（越大越硬）
    SPRING_D: 15       // 阻尼（越小越 Q 弹）
  };

  var ANIM = {
    DROP_H: 7.5,       // 新台子从多高掉下来（u）
    DROP_TIME: 0.75,   // 掉落 + 弹跳总时长（秒）
    INTRO_LOCK: 0.45,  // 开局前几秒还不能蓄力（等台子落稳）
    SLIP_TIME: 0.5,    // 半个身子在台外：晃 + 滑落的时长（秒）
    FALL_TIME: 1.2,    // 掉下去最多多久后弹出结束浮层（秒）；奶蛙提前掉出画面则更早
    FALL_G: 22,        // 掉落时的重力（u/s²）：比起跳时小一点，让「哈哈哈」翻滚多演一会儿
    FALL_POP: 3.4,     // 掉落一开始先往上「噗」地弹一下（u/s），滑稽感
    OVERLAY_LOCK: 600  // 结束浮层出现后多少毫秒内按钮不响应（防误触）
  };

  // 台子配色：[色相, 饱和度, 亮度]，全是马卡龙糖果色，避开黄色（奶蛙是黄的，要有对比）
  var PALETTE = [
    [350, 76, 79],   // 草莓粉
    [158, 42, 69],   // 薄荷
    [201, 72, 77],   // 天空蓝
    [262, 62, 83],   // 薰衣草
    [22, 82, 76],    // 蜜桃橙
    [177, 42, 64],   // 湖水青
    [326, 64, 83],   // 玫瑰
    [98, 40, 68],    // 青柠
    [292, 48, 74]    // 兰花紫
  ];

  // 舞台背景：每 BG_STEP 分换一套（都是暖奶油/蜜桃一类的柔和色），平滑过渡
  var BG_STEP = 20;
  var BG_THEMES = [
    { top: [255, 241, 217], bot: [255, 216, 198] },   // 奶油 → 蜜桃
    { top: [255, 237, 228], bot: [255, 214, 208] },   // 蜜桃粉
    { top: [246, 247, 225], bot: [255, 233, 208] },   // 抹茶奶油
    { top: [255, 238, 210], bot: [255, 208, 186] },   // 杏子
    { top: [251, 238, 244], bot: [255, 222, 226] }    // 腮红粉
  ];

  // 素材：content 范围（top/bottom/cx）是量好的不透明区域，用来让「脚底」对齐落点
  var SPRITES = {
    stand: { src: '../assets/nai/nai02-stand.webp', w: 100, h: 100, cx: 49.5, top: 4, bottom: 94.5 },
    laugh: { src: '../assets/nai/nai10-laugh.webp', w: 472, h: 472, cx: 236, top: 19, bottom: 455 }
  };

  var CONFETTI = ['#ff6b6b', '#ffd84d', '#6bd6ff', '#a78bfa', '#6fe0a8', '#ff9ed8'];

  /* ==========================================================================
   * 二、小工具
   * ======================================================================== */
  var clamp = JL.clamp, lerp = JL.lerp;
  function rand(a, b) { return a + Math.random() * (b - a); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
  function easeInQuad(t) { return t * t; }
  function easeOutBack(t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeOutBounce(t) {
    var n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1; return n1 * t * t + 0.984375;
  }
  /** 弹簧：让 o[key] 追向 target，会过冲回弹（Q 弹的来源）。内部分小步，dt 大也稳 */
  function spring(o, key, vkey, target, k, d, dt) {
    var n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
    for (var i = 0; i < n; i++) {
      var a = k * (target - o[key]) - d * o[vkey];
      o[vkey] += a * h; o[key] += o[vkey] * h;
    }
  }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }
  function hsla(h, s, l, a) { return 'hsla(' + h + ',' + clamp(s, 0, 100) + '%,' + clamp(l, 0, 100) + '%,' + (a == null ? 1 : a) + ')'; }

  /** 调共用音效：NaiSFX 缺失 / 报错都不影响游戏 */
  function sfx(name) {
    var s = window.NaiSFX;
    if (!s || typeof s[name] !== 'function') return;
    try { s[name].apply(s, Array.prototype.slice.call(arguments, 1)); } catch (e) { /* 音效出错不影响玩 */ }
  }

  function loadBest() {
    try { var v = parseInt(window.localStorage.getItem(BEST_KEY), 10); return isFinite(v) && v > 0 ? v : 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { window.localStorage.setItem(BEST_KEY, String(v)); } catch (e) { /* 存储不可用就算了 */ }
  }

  // 台子颜色表（顶面/侧面/圆柱渐变）
  var COLORS = PALETTE.map(function (c) {
    var h = c[0], s = c[1], l = c[2];
    // 侧面只降亮度、略微降饱和并偏冷一点，保持软糯的马卡龙感，不发闷也不刺眼
    return {
      top: hsla(h, s, l), topHi: hsla(h, s - 8, l + 7), topLo: hsla(h, s, l - 3),
      left: hsla(h - 3, s - 4, l - 9), right: hsla(h - 8, s - 7, l - 18),
      cylL: hsla(h - 1, s - 3, l - 4), cylM: hsla(h - 4, s - 5, l - 11), cylR: hsla(h - 9, s - 8, l - 21)
    };
  });

  /* ==========================================================================
   * 三、DOM 与画布
   * ======================================================================== */
  var doc = document;
  function $(id) { return doc.getElementById(id); }
  var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
  var elScore = $('score'), elBest = $('best'), elStreak = $('streak'), elCombo = $('combo'), elHint = $('hint');
  var elOverlay = $('overlay'), elOvScore = $('ovScore'), elOvBest = $('ovBest'), elOvNew = $('ovNew'), btnAgain = $('btnAgain');
  var btnSound = $('btnSound'), btnRestart = $('btnRestart');

  var view = { w: 0, h: 0, dpr: 1, S: 40, ox: 0, oy: 0 };

  function resize() {
    var w = stage.clientWidth, h = stage.clientHeight;
    if (w < 2 || h < 2) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    view.w = w; view.h = h; view.dpr = dpr;
    view.S = clamp(Math.min(w / VIEW.FIT_W, h / VIEW.FIT_H), VIEW.SCALE_MIN, VIEW.SCALE_MAX);
    view.ox = w / 2; view.oy = h * VIEW.FOCUS_Y;
    spriteCache = {};
  }

  /* ---------- 素材预加载（失败有兜底：画个黄色圆团） ---------- */
  var imgs = {}, spritesReady = false;
  function loadSprites() {
    var names = Object.keys(SPRITES), left = names.length, finished = false;
    function done() { if (finished) return; finished = true; spritesReady = true; }
    names.forEach(function (n) {
      var rec = { img: new Image(), ok: false };
      imgs[n] = rec;
      rec.img.onload = function () { rec.ok = rec.img.naturalWidth > 0; if (--left === 0) done(); };
      rec.img.onerror = function () { rec.ok = false; if (--left === 0) done(); };
      rec.img.src = SPRITES[n].src;
    });
    setTimeout(done, 2500);   // 加载太慢就先用兜底圆团开玩，别白屏
  }

  /** 把大图逐级对半缩到目标像素宽，比一步缩小更清晰；结果缓存 */
  var spriteCache = {};
  function getSprite(name, wantW) {
    var rec = imgs[name], sp = SPRITES[name];
    if (!rec || !rec.ok) return null;
    var tw = Math.max(8, Math.round(wantW / 4) * 4);
    if (tw >= sp.w * 0.75) return rec.img;
    var key = name + ':' + tw;
    if (spriteCache[key]) return spriteCache[key];
    var src = rec.img, w = sp.w, h = sp.h;
    while (w * 0.5 > tw) {
      var nw = Math.round(w * 0.5), nh = Math.round(h * 0.5);
      var t = doc.createElement('canvas'); t.width = nw; t.height = nh;
      var tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, nw, nh);
      src = t; w = nw; h = nh;
    }
    var out = doc.createElement('canvas'); out.width = tw; out.height = Math.round(sp.h * tw / sp.w);
    var oc = out.getContext('2d'); oc.imageSmoothingQuality = 'high'; oc.drawImage(src, 0, 0, out.width, out.height);
    spriteCache[key] = out;
    return out;
  }

  /* ==========================================================================
   * 四、游戏状态
   * ======================================================================== */
  var time = 0;                   // 动画时钟（秒）
  var phase = 'idle';             // idle 站着 | charging 蓄力 | air 空中 | slip 台边打滑 | fall 掉落 | over 结束
  var platforms = [], pool = [], ci = 0;   // platforms[ci] 是脚下的台子，platforms[ci+1] 是目标
  var rest = { x: 0, z: 0 };      // 奶蛙站定的位置（上一次的落点）；新台子是对着它生成的
  var cam = { x: 0, z: 0 };
  var shake = { amp: 0, x: 0, y: 0 };
  var score = 0, best = 0, bestAtStart = 0, streak = 0;
  var lastAxis, axisRun = 1;
  var introT = 0, hintHidden = false, recordShown = false;
  var pressAt = 0, chargeC = 0, chargeToneT = 0, puffT = 0;
  var jump = null, slip = null, fall = null;
  var overlayReadyAt = 0;
  var support = null;             // 奶蛙脚下踩着的台子（跟着它下沉/弹）

  var player = {
    x: 0, z: 0, y: 0, baseY: 0,           // 脚底位置；y 是离「标准台面」的高度，baseY 是台子自身的起伏
    vx: 0, vz: 0, vy: 0,
    angle: 0, spin: 0, pivot: 0,          // 旋转角、角速度、旋转支点（0=脚底 0.5=身体中心）
    sq: 0, sqv: 0, sqTarget: 0,           // 压扁弹簧：>0 压扁，<0 拉长
    laughT: 0, wobbleT: 0, popT: 0,
    alpha: 1, visible: true
  };

  var bg = { top: BG_THEMES[0].top.slice(), bot: BG_THEMES[0].bot.slice() };
  var bubbles = [];
  var parts = [], floaters = [];

  /* ---------- 台子对象池（旧台子滑出画面后回收再用） ---------- */
  function newPlatform(plan, delay) {
    var p = pool.pop() || {};
    p.x = plan.x; p.z = plan.z; p.size = plan.size; p.shape = plan.shape; p.colorIdx = plan.colorIdx;
    p.axis = plan.axis; p.gap = plan.gap || 0; p.distance = plan.distance || 0;
    p.t = -delay; p.yOff = ANIM.DROP_H; p.alpha = 0; p.sink = 0; p.sinkV = 0; p.hit = false;
    return p;
  }

  /* ---------- 开局 / 重开 ---------- */
  function initGame() {
    for (var i = 0; i < platforms.length; i++) pool.push(platforms[i]);
    platforms.length = 0; parts.length = 0; floaters.length = 0;
    ci = 0; score = 0; streak = 0; lastAxis = undefined; axisRun = 1;
    jump = slip = fall = null;
    bestAtStart = best; recordShown = false;
    rest.x = 0; rest.z = 0;

    var first = newPlatform({ x: 0, z: 0, size: 2.4, shape: 'cube', colorIdx: Math.floor(Math.random() * CFG.PALETTE_SIZE), axis: 0 }, 0);
    platforms.push(first);
    support = first;
    spawnNext(0.28);

    var P = player;
    P.x = 0; P.z = 0; P.y = 0; P.baseY = first.yOff; P.vx = P.vz = P.vy = 0;
    P.angle = 0; P.spin = 0; P.pivot = 0; P.sq = 0; P.sqv = 0; P.sqTarget = 0;
    P.laughT = 0; P.wobbleT = 0; P.popT = 0; P.alpha = 1; P.visible = true;

    phase = 'idle'; introT = 0; chargeC = 0;
    var t = camTarget(); cam.x = t.x; cam.z = t.z;   // 镜头直接对准，不做平移
    shake.amp = 0;
    bgIndex = 0;
    elOverlay.classList.remove('show'); elOverlay.hidden = true;
    updateHud(false);
  }

  /** 在当前台子前方生成下一个台子（位置对着奶蛙的落点算，保证够得着） */
  function spawnNext(delay) {
    var cur = platforms[ci];
    var axis = JL.chooseAxis(lastAxis, axisRun, Math.random);
    axisRun = axis === lastAxis ? axisRun + 1 : 1;
    lastAxis = axis;
    var plan = JL.planNextPlatform({
      cur: cur, player: { x: rest.x, z: rest.z }, axis: axis, score: score, rng: Math.random, prevColor: cur.colorIdx
    });
    platforms.push(newPlatform(plan, delay));
  }

  function camTarget() {
    var nx = platforms[ci + 1];
    return nx ? { x: (rest.x + nx.x) / 2, z: (rest.z + nx.z) / 2 } : { x: rest.x, z: rest.z };
  }

  /* ==========================================================================
   * 五、投影
   * ======================================================================== */
  var PX = 0, PY = 0;      // proj() 的结果（省得每次分配对象）
  function proj(x, y, z) {
    var dx = x - cam.x, dz = z - cam.z;
    PX = view.ox + (dx - dz) * COS * view.S;
    PY = view.oy - ((dx + dz) * SIN + y) * view.S;
  }

  /* ==========================================================================
   * 六、输入（Pointer Events + 键盘）
   * ======================================================================== */
  var audioUnlocked = false;
  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    sfx('init');
  }

  function hideHint() {
    if (hintHidden) return;
    hintHidden = true;
    elHint.classList.add('gone');
  }

  var pendingCharge = false;     // 台子还没落稳时按下了：等落稳后如果还按着，就接着开始蓄力
  function beginCharge() {
    if (phase === 'idle' && introT < ANIM.INTRO_LOCK) { pendingCharge = true; return false; }
    if (phase !== 'idle') return false;
    pendingCharge = false;
    phase = 'charging';
    pressAt = performance.now();
    chargeC = 0; chargeToneT = 0; puffT = 0;
    support = platforms[ci];
    player.laughT = 0; player.wobbleT = 0;       // 上一次的大笑 / 晃悠到此为止，专心蓄力
    hideHint();
    return true;
  }

  /** 松手：chargeSec 不传就按按下到现在的真实时间算 */
  function endCharge(chargeSec) {
    pendingCharge = false;
    if (phase !== 'charging') return;
    if (chargeSec == null) chargeSec = (performance.now() - pressAt) / 1000;
    startJump(chargeSec);
  }

  /** 蓄力被打断（切走标签页 / 失去焦点 / 重开）：放弃这次，不跳 */
  function cancelCharge() {
    if (phase === 'charging') { phase = 'idle'; chargeC = 0; }
    pointerId = null; keyHeld = false; pendingCharge = false;
  }

  var pointerId = null, keyHeld = false;

  cv.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    unlockAudio();
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur) doc.activeElement.blur();
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器没有也行 */ }
    beginCharge();
  });
  function onPointerEnd(e) {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    endCharge();
  }
  cv.addEventListener('pointerup', onPointerEnd);
  cv.addEventListener('pointercancel', function (e) { if (e.pointerId === pointerId) { pointerId = null; cancelCharge(); } });
  cv.addEventListener('lostpointercapture', onPointerEnd);
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function overlayOpen() { return !elOverlay.hidden; }
  function controlFocused() {
    var a = doc.activeElement;
    return !!a && (a.tagName === 'BUTTON' || a.tagName === 'A') && a !== btnAgain;
  }

  window.addEventListener('keydown', function (e) {
    var k = e.key, code = e.code;
    if (code === 'Space' || k === ' ' || k === 'Spacebar') {
      if (controlFocused()) return;          // 焦点在别的按钮上时，空格留给按钮自己
      e.preventDefault();
      unlockAudio();
      if (e.repeat) return;
      if (overlayOpen()) { keyHeld = false; tryRestartFromOverlay(); return; }
      if (!keyHeld) { keyHeld = true; beginCharge(); }
    } else if (code === 'KeyR' || k === 'r' || k === 'R') {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      unlockAudio();
      restart();
    } else if ((k === 'Enter') && overlayOpen()) {
      e.preventDefault();
      tryRestartFromOverlay();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
      if (keyHeld) { e.preventDefault(); keyHeld = false; endCharge(); }
    }
  });
  window.addEventListener('blur', cancelCharge);

  function tryRestartFromOverlay() {
    if (performance.now() < overlayReadyAt) return;
    restart();
  }

  btnAgain.addEventListener('click', function () { sfx('click'); tryRestartFromOverlay(); });
  btnRestart.addEventListener('click', function () { unlockAudio(); sfx('click'); restart(); btnRestart.blur(); });
  btnSound.addEventListener('click', function () {
    unlockAudio();
    if (window.NaiSFX && typeof NaiSFX.toggleMuted === 'function') { try { NaiSFX.toggleMuted(); } catch (e) { /* 忽略 */ } }
    refreshSoundBtn();
    sfx('click');
    btnSound.blur();
  });
  function refreshSoundBtn() {
    var muted = false;
    try { muted = !!(window.NaiSFX && NaiSFX.isMuted && NaiSFX.isMuted()); } catch (e) { /* 忽略 */ }
    btnSound.textContent = muted ? '🔇 音效关' : '🔊 音效开';
    btnSound.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  function restart() {
    cancelCharge();
    initGame();
  }

  /* ==========================================================================
   * 七、起跳 / 落地 / 失败
   * ======================================================================== */
  function startJump(chargeSec) {
    var cur = platforms[ci], nxt = platforms[ci + 1];
    var axis = nxt.axis;
    var res = JL.resolveJump(cur, nxt, { x: rest.x, z: rest.z }, axis, chargeSec);
    var dist = res.distance;
    jump = {
      t: 0, T: JL.jumpDuration(dist), h: JL.jumpHeight(dist), dist: dist, axis: axis,
      sx: rest.x, sz: rest.z, flips: JL.flipCount(dist), sign: axis === 0 ? 1 : -1, res: res
    };
    phase = 'air';
    chargeC = 0;
    var P = player;
    P.pivot = 0.5; P.laughT = 0; P.wobbleT = 0;
    P.sqv = -16;                         // 松手瞬间猛地弹开：从压扁冲到拉长
    spawnDust(P.x, P.baseY, P.z, 7, 1.1, 0.7, 0.13);
    sfx('tone', 300, 0.15, 'sine', 0.13, 680);
    sfx('noise', 0.12, 0.04, 2000);
  }

  function updateAir(dt) {
    var P = player, J = jump;
    J.t += dt;
    var tau = Math.min(1, J.t / J.T);
    P.x = J.sx + (J.axis === 0 ? J.dist * tau : 0);
    P.z = J.sz + (J.axis === 1 ? J.dist * tau : 0);
    P.y = JL.arcHeight(J.h, tau);
    P.baseY = 0;
    if (J.flips > 0) {
      var u = clamp((tau - 0.1) / 0.78, 0, 1);              // 起跳后翻、落地前转完，落地时是正的
      P.angle = J.sign * TAU * J.flips * easeInOutCubic(u);
    } else {
      P.angle = J.sign * 0.2 * Math.sin(Math.PI * tau);      // 近处不翻，只是微微前倾
    }
    P.sqTarget = -0.26 + 0.14 * tau;                         // 空中拉长，临近落地渐渐收回
    if (J.t >= J.T) landNow();
  }

  /** 空中飞完，按 logic 里已经算好的结果收尾 */
  function landNow() {
    var P = player, J = jump, res = J.res;
    P.x = res.landing.x; P.z = res.landing.z; P.y = 0;
    P.angle = 0;
    rest.x = P.x; rest.z = P.z;

    if (res.outcome === 'miss') { startFallFromAir(J); return; }
    if (res.outcome === 'slip') { startSlip(res); return; }

    // —— 站住了：stay（太短，还在原台子）或 next（到了下一个台子）——
    var perfect = res.quality === 'perfect';
    var landed;
    if (res.outcome === 'next') {
      ci++;
      landed = platforms[ci];
      support = landed;
      var sc = JL.scoreLanding(res.quality, streak);
      score += sc.points; streak = sc.streak;
      if (score > best) { best = score; saveBest(best); }
      spawnNext(0);
      popScore(sc.points, perfect, res.judge.wobble);
      if (!recordShown && bestAtStart > 0 && score > bestAtStart) {   // 本局刚刚超过历史最高分：飘一个「新纪录」
        recordShown = true;
        addFloater('新纪录!', P.x, P.baseY + PLAYER.H * 1.15, P.z, { size: 24, fill: '#ffb13b', life: 1.3, rise: 3.0, delay: 0.25, dx: -4 });
        burstStars(P.x, P.baseY, P.z, 3);
      }
      updateHud(true);
    } else {
      landed = platforms[ci];
      support = landed;
    }

    P.pivot = 0;
    P.baseY = landed.yOff - landed.sink;
    P.sq = perfect ? 0.62 : 0.5; P.sqv = 0;        // 落地压扁，再弹回
    landed.sink = perfect ? 0.2 : 0.14; landed.sinkV = 0;   // 台子被踩得往下一沉
    phase = 'idle';
    jump = null;

    if (perfect) {
      P.laughT = PLAYER.LAUGH_TIME; P.popT = 0.3;
      burstStars(P.x, P.baseY, P.z, streak);
      addRing(P.x, P.baseY, P.z, 0.25, 1.7, 0.55, 'rgba(255,255,255,.95)', 3);
      addRing(P.x, P.baseY, P.z, 0.1, 1.2, 0.6, 'rgba(255,196,64,.9)', 2.5, 0.08);
      shake.amp = Math.max(shake.amp, 3);
      sfx('boing'); sfx('good', streak); sfx('laugh', clamp(streak / 8, 0, 1));
    } else {
      spawnDust(P.x, P.baseY, P.z, 8, 1.3, 0.5, 0.15);
      shake.amp = Math.max(shake.amp, 1.2);
      sfx('boing');
      if (res.outcome === 'next' && res.judge.wobble) {
        P.wobbleT = 0.8;
        sfx('tone', 420, 0.12, 'triangle', 0.1, 300); sfx('tone', 300, 0.14, 'triangle', 0.1, 420, 0.12);
      }
    }
  }

  /** 台边打滑：先晃一下，再歪着掉下去 */
  function startSlip(res) {
    var P = player;
    var sup = res.onPlatform === 'next' ? platforms[ci + 1] : platforms[ci];
    support = sup;
    var axis = jump.axis;
    slip = { t: 0, dir: res.slipDir, axis: axis, tip: res.slipDir * (axis === 0 ? 1 : -1) };
    phase = 'slip';
    jump = null;
    P.baseY = sup.yOff - sup.sink; P.y = 0; P.pivot = 0;
    P.sq = 0.45; P.sqv = 0; P.sqTarget = 0.1;
    sup.sink = 0.1; sup.sinkV = 0;
    spawnDust(P.x, P.baseY, P.z, 5, 1.0, 0.4, 0.12);
    sfx('boing');
    sfx('tone', 520, 0.3, 'sine', 0.09, 200, 0.05);
  }

  function updateSlip(dt) {
    var P = player, S = slip;
    S.t += dt;
    var u = clamp(S.t / ANIM.SLIP_TIME, 0, 1);
    var wob = Math.sin(S.t * 28) * 0.08 * Math.min(1, S.t / 0.18);
    P.angle = S.tip * (wob + 1.1 * easeInQuad(u));
    P.pivot = 0.5 * u;
    var slide = S.dir * (0.25 + 1.0 * u) * dt;                 // 慢慢往台外蹭
    if (S.axis === 0) P.x += slide; else P.z += slide;
    var sup = support;
    P.baseY = sup.yOff - sup.sink;
    if (S.t >= ANIM.SLIP_TIME) {
      var v = S.dir * 1.5;
      P.vx = S.axis === 0 ? v : 0; P.vz = S.axis === 1 ? v : 0; P.vy = ANIM.FALL_POP * 0.6;
      P.baseY = 0; P.y = sup.yOff - sup.sink;                  // 接着从台面高度往下掉
      P.spin = S.tip * 5.5;
      beginFall(ANIM.FALL_G);
    }
  }

  /** 在空中就没踩到台子：奶蛙「噗」地被自己的失误弹得往上一蹦，然后笑着翻滚着掉下去 */
  function startFallFromAir(J) {
    var P = player;
    var v = 0.5 * J.dist / J.T;                                // 保留一半前冲的势头
    P.vx = J.axis === 0 ? v : 0; P.vz = J.axis === 1 ? v : 0;
    P.vy = ANIM.FALL_POP;
    P.baseY = 0; P.y = 0; P.angle = 0; P.pivot = 0.5;
    P.spin = J.sign * rand(6.5, 9);
    jump = null;
    beginFall(ANIM.FALL_G);
  }

  function beginFall(g) {
    var P = player;
    fall = { t: 0, g: g, ha: 0 };
    phase = 'fall';
    P.laughT = 99; P.popT = 0.3; P.pivot = 0.5; P.sqTarget = 0; P.sq = -0.1; P.sqv = 0;
    sfx('laugh', 0.4);
    sfx('tone', 760, 0.75, 'sine', 0.07, 120, 0.1);
    shake.amp = Math.max(shake.amp, 2.5);
    // 「哈哈哈」气泡：在掉落起点上方依次冒出来，奶蛙自己已经笑着掉下去了
    var ox = P.x, oy = P.baseY + P.y + PLAYER.H * 1.1, oz = P.z;
    var words = ['哈', '哈', '哈', '哈~'];
    for (var i = 0; i < words.length; i++) {
      addFloater(words[i], ox, oy, oz, {
        size: 30 + i * 3, fill: '#ffd84d', rise: 0.8 + i * 0.35, life: 0.95, delay: 0.1 + i * 0.17,
        rot: rand(-0.3, 0.3), dx: (i - 1.5) * 38
      });
    }
  }

  function updateFall(dt) {
    var P = player, F = fall;
    F.t += dt;
    P.vy -= F.g * dt;
    P.x += P.vx * dt; P.z += P.vz * dt; P.y += P.vy * dt;
    P.angle += P.spin * dt;
    proj(P.x, P.baseY + P.y, P.z);
    if (F.t >= ANIM.FALL_TIME || PY > view.h + 160) endGame();
  }

  function endGame() {
    if (phase === 'over') return;
    phase = 'over';
    var isNew = score > bestAtStart && score > 0;
    if (score > best) { best = score; saveBest(best); }
    updateHud(false);
    elOvScore.textContent = String(score);
    elOvBest.textContent = String(Math.max(best, score));
    elOvNew.hidden = !isNew;
    elOverlay.hidden = false;
    void elOverlay.offsetWidth;                       // 让过渡动画能触发
    elOverlay.classList.add('show');
    overlayReadyAt = performance.now() + ANIM.OVERLAY_LOCK;
    try { btnAgain.focus({ preventScroll: true }); } catch (e) { /* 忽略 */ }
    sfx(isNew ? 'win' : 'lose');
  }

  /* ==========================================================================
   * 八、每帧更新
   * ======================================================================== */
  var bgIndex = 0;
  function updateBg(dt) {
    var idx = Math.floor(score / BG_STEP) % BG_THEMES.length;
    var tgt = BG_THEMES[idx], k = 1 - Math.exp(-dt * 1.6);
    for (var i = 0; i < 3; i++) { bg.top[i] += (tgt.top[i] - bg.top[i]) * k; bg.bot[i] += (tgt.bot[i] - bg.bot[i]) * k; }
    bgIndex = idx;
  }

  function updatePlatforms(dt) {
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      p.t += dt;
      var u = p.t / ANIM.DROP_TIME;
      if (u < 0) { p.yOff = ANIM.DROP_H; p.alpha = 0; }
      else if (u < 1) {
        p.yOff = ANIM.DROP_H * (1 - easeOutBounce(u));
        p.alpha = Math.min(1, u * 6);
        if (!p.hit && u >= 0.3636) { p.hit = true; platformImpact(p); }
      } else {
        p.yOff = 0; p.alpha = 1;
        if (!p.hit) { p.hit = true; platformImpact(p); }
      }
      var target = (phase === 'charging' && p === support) ? PLAYER.SINK_MAX * chargeC : 0;
      spring(p, 'sink', 'sinkV', target, 280, 17, dt);
    }
  }

  /** 新台子砸到位：一圈灰尘 + 轻微震动 */
  function platformImpact(p) {
    spawnDust(p.x, 0, p.z, 8, 1.6 + p.size * 0.35, 0.4, 0.15);
    shake.amp = Math.max(shake.amp, 1.6);
  }

  function updatePlayer(dt) {
    var P = player;
    P.popT = Math.max(0, P.popT - dt);
    if (P.laughT > 0 && P.laughT < 90) P.laughT -= dt;

    switch (phase) {
      case 'idle':
        P.baseY = support ? support.yOff - support.sink : 0;
        P.y = 0; P.pivot = 0;
        P.sqTarget = 0;
        if (P.wobbleT > 0) {                   // 险过：站在台边晃几下
          P.wobbleT = Math.max(0, P.wobbleT - dt);
          P.angle = Math.sin(time * 26) * 0.3 * (P.wobbleT / 0.8);
        } else {
          P.angle = 0;
        }
        break;
      case 'charging':
        var held = (performance.now() - pressAt) / 1000;
        chargeC = JL.chargeRatio(held);
        P.baseY = support ? support.yOff - support.sink : 0;
        P.y = 0; P.pivot = 0; P.angle = 0;
        P.sqTarget = chargeC;
        chargeToneT -= dt;
        if (chargeToneT <= 0) {                // 蓄力时音调一路升高
          chargeToneT = 0.065;
          var f = 200 + 760 * chargeC;
          sfx('tone', f, 0.09, 'sine', 0.05, f * 1.06);
        }
        puffT -= dt;
        if (puffT <= 0) {                      // 脚边冒小灰尘
          puffT = 0.12 - 0.06 * chargeC;
          var a = rand(0, TAU);
          addPart({ type: 'dust', x: P.x + Math.cos(a) * 0.45, y: P.baseY + 0.05, z: P.z + Math.sin(a) * 0.45,
            vx: Math.cos(a) * 0.5, vz: Math.sin(a) * 0.5, vy: 0.5, g: 0, life: 0.4, size: 0.1 });
        }
        break;
      case 'air': updateAir(dt); break;
      case 'slip': updateSlip(dt); break;
      case 'fall': updateFall(dt); break;
      default: break;
    }

    // 压扁/拉长的弹簧；大笑时额外抖一抖
    var target = P.sqTarget;
    if (P.laughT > 0 && P.laughT < 90) target += Math.sin(time * 24) * 0.07;
    spring(P, 'sq', 'sqv', target, PLAYER.SPRING_K, PLAYER.SPRING_D, dt);
    P.sq = clamp(P.sq, -0.5, 0.85);
  }

  function updateCamera(dt) {
    if (phase === 'slip' || phase === 'fall' || phase === 'over') return;   // 失败后镜头不动，看奶蛙表演
    var t = camTarget(), k = 1 - Math.exp(-dt * VIEW.CAM_RATE);
    cam.x += (t.x - cam.x) * k; cam.z += (t.z - cam.z) * k;
  }

  /** 回收滑出画面的旧台子 */
  function recycle() {
    while (ci > 1 && platforms.length > 3) {
      var p = platforms[0], S = view.S;
      proj(p.x, 0, p.z);
      var mx = (p.size * 0.87 + 0.6) * S;
      var gone = PY - p.size * 0.5 * S > view.h || PX < -mx || PX > view.w + mx;
      if (!gone) break;
      pool.push(platforms.shift());
      ci--;
    }
  }

  function update(dt) {
    time += dt;
    introT += dt;
    if (pendingCharge && introT >= ANIM.INTRO_LOCK) {            // 开局/重开时抢按的那一下，落稳后接上
      pendingCharge = false;
      if (pointerId !== null || keyHeld) beginCharge();
    }
    updateBg(dt);
    updatePlatforms(dt);
    updatePlayer(dt);
    updateCamera(dt);
    updateParts(dt);
    updateFloaters(dt);
    recycle();
    shake.amp *= Math.exp(-dt * 11);
    if (shake.amp < 0.05) shake.amp = 0;
    shake.x = (Math.random() - 0.5) * 2 * shake.amp;
    shake.y = (Math.random() - 0.5) * 2 * shake.amp;
  }

  /* ==========================================================================
   * 九、粒子 / 飘字
   * ======================================================================== */
  function addPart(o) {
    if (parts.length > 320) parts.shift();
    o.t = 0; o.rot = o.rot || 0; o.vr = o.vr || 0; o.delay = o.delay || 0;
    parts.push(o);
  }

  /** 灰尘：贴着台面向四周散开，一团软软的白 */
  function spawnDust(x, y, z, n, speed, up, size) {
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU + rand(-0.4, 0.4), s = speed * rand(0.5, 1);
      addPart({ type: 'dust', x: x + Math.cos(a) * 0.2, y: y + 0.05, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: up * rand(0.4, 1), g: 0, life: rand(0.35, 0.6), size: size * rand(0.8, 1.3) });
    }
  }

  /** 完美落地：星星 + 纸屑一起炸开，连击越高越多 */
  function burstStars(x, y, z, combo) {
    var n = Math.min(26, 10 + combo * 2);
    for (var i = 0; i < n; i++) {
      var a = rand(0, TAU), s = rand(1.2, 3.2);
      addPart({ type: 'star', x: x, y: y + 0.6, z: z, vx: Math.cos(a) * s, vz: Math.sin(a) * s, vy: rand(3, 6.5), g: 11,
        life: rand(0.75, 1.2), size: rand(0.16, 0.28), rot: rand(0, TAU), vr: rand(-6, 6),
        color: i % 3 === 0 ? '#fff6c2' : (i % 3 === 1 ? '#ffd84d' : '#ff9ed8') });
    }
    var m = Math.min(24, 6 + combo * 3);
    for (var j = 0; j < m; j++) {
      var b = rand(0, TAU), v = rand(0.8, 2.6);
      addPart({ type: 'conf', x: x, y: y + 0.5, z: z, vx: Math.cos(b) * v, vz: Math.sin(b) * v, vy: rand(4, 7.5), g: 9,
        life: rand(1.0, 1.6), size: rand(0.1, 0.17), rot: rand(0, TAU), vr: rand(-10, 10),
        color: CONFETTI[j % CONFETTI.length] });
    }
  }

  /** 台面上扩散的圆环 */
  function addRing(x, y, z, r0, r1, life, color, width, delay) {
    addPart({ type: 'ring', x: x, y: y + 0.02, z: z, r0: r0, r1: r1, life: life, color: color, width: width, delay: delay || 0 });
  }

  function updateParts(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.t += dt;
      if (p.t < p.delay) continue;
      if (p.t - p.delay >= p.life) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      if (p.type !== 'ring') {
        p.vy -= (p.g || 0) * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.rot += p.vr * dt;
        if (p.type === 'dust') { var damp = Math.exp(-dt * 4); p.vx *= damp; p.vz *= damp; p.vy *= damp; }
        if (p.type === 'conf') { var d2 = Math.exp(-dt * 1.5); p.vx *= d2; p.vz *= d2; }
      }
    }
  }

  function starPath(cx, cy, r, rot) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = rot + i * Math.PI / 5 - Math.PI / 2, rr = i % 2 === 0 ? r : r * 0.45;
      var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawParts() {
    var S = view.S;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.t < p.delay) continue;
      var u = (p.t - p.delay) / p.life;
      proj(p.x, p.y, p.z);
      var x = PX, y = PY;
      if (p.type === 'dust') {
        // 软软的一团白烟：中间实、边缘透
        var r = p.size * S * (1.2 + u * 1.5), da = 0.6 * (1 - u) * (1 - u * 0.5);
        var dg = ctx.createRadialGradient(x, y, 0, x, y, r);
        dg.addColorStop(0, 'rgba(255,255,255,' + da.toFixed(3) + ')');
        dg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = dg;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      } else if (p.type === 'star') {
        ctx.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
        ctx.fillStyle = p.color;
        starPath(x, y, p.size * S * (1 - u * 0.4), p.rot); ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (p.type === 'conf') {
        ctx.globalAlpha = u > 0.75 ? 1 - (u - 0.75) / 0.25 : 1;
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.rot); ctx.scale(1, Math.abs(Math.cos(p.rot * 1.7)) * 0.8 + 0.2);
        ctx.fillStyle = p.color; var w = p.size * S;
        ctx.fillRect(-w, -w * 0.5, w * 2, w);
        ctx.restore(); ctx.globalAlpha = 1;
      } else if (p.type === 'ring') {
        var rr = lerp(p.r0, p.r1, easeOutQuad(u));
        ctx.globalAlpha = 1 - u;
        ctx.strokeStyle = p.color; ctx.lineWidth = p.width * (1 - u * 0.5);
        ctx.beginPath(); ctx.ellipse(x, y, ISO_RX * rr * S, ISO_RY * rr * S, 0, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* ---------- 飘字 ---------- */
  function addFloater(text, x, y, z, o) {
    o = o || {};
    floaters.push({ text: text, x: x, y: y, z: z, t: 0, life: o.life || 1.0, rise: o.rise || 1.4, size: o.size || 26,
      fill: o.fill || '#fff', grad: !!o.grad, rot: o.rot || 0, delay: o.delay || 0, dx: o.dx || 0 });
  }

  function comboWord(n) {
    if (n <= 1) return '完美!';
    if (n === 2) return '连击 ×2!';
    if (n === 3) return '太强了 ×3!';
    if (n === 4) return '哦齁齁 ×4!';
    return '封神 ×' + n + '!';
  }
  /** 落地后在奶蛙头顶飘分数：+1 / +2 / +4 / +6 … */
  function popScore(points, perfect, wobble) {
    var P = player, hx = P.x, hy = P.baseY + PLAYER.H * 1.15, hz = P.z;
    if (perfect) {
      addFloater('+' + points, hx, hy, hz, { size: 34 + Math.min(18, points * 0.8), grad: true, life: 1.15, rise: 1.7 });
      addFloater(comboWord(streak), hx, hy + 0.2, hz,
        { size: 20, fill: '#ff7a59', life: 1.1, rise: 2.2, delay: 0.06, rot: rand(-0.08, 0.08) });
    } else {
      addFloater('+' + points, hx, hy, hz, { size: 30, fill: '#ffffff', life: 0.95, rise: 1.5 });
      if (wobble) addFloater('好险!', hx, hy, hz, { size: 18, fill: '#ffb13b', life: 0.9, rise: 2.0, delay: 0.1, dx: 34 });
    }
  }

  function updateFloaters(dt) {
    for (var i = floaters.length - 1; i >= 0; i--) {
      var f = floaters[i];
      f.t += dt;
      if (f.t - f.delay >= f.life) { floaters[i] = floaters[floaters.length - 1]; floaters.pop(); }
    }
  }

  function drawFloaters() {
    var fs = clamp(view.S / 46, 0.8, 1.6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (var i = 0; i < floaters.length; i++) {
      var f = floaters[i];
      if (f.t < f.delay) continue;
      var u = (f.t - f.delay) / f.life;
      proj(f.x, f.y + f.rise * easeOutQuad(Math.min(1, u * 1.2)), f.z);
      var size = f.size * fs;
      var sc = easeOutBack(Math.min(1, u * 5));
      ctx.save();
      ctx.translate(PX + f.dx, PY); ctx.rotate(f.rot); ctx.scale(sc, sc);
      ctx.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
      ctx.font = '900 ' + size.toFixed(1) + 'px ' + FONT;
      ctx.lineWidth = size * 0.28;
      ctx.strokeStyle = f.grad ? 'rgba(255,255,255,.96)' : 'rgba(74,51,37,.9)';
      ctx.strokeText(f.text, 0, 0);
      if (f.grad) {
        var w = ctx.measureText(f.text).width;
        var g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
        g.addColorStop(0, '#ff7a59'); g.addColorStop(0.55, '#ff4d6d'); g.addColorStop(1, '#b13bff');
        ctx.fillStyle = g;
      } else ctx.fillStyle = f.fill;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }

  /* ==========================================================================
   * 十、绘制
   * ======================================================================== */
  var sparkles = [];
  function initBubbles() {
    for (var i = 0; i < 12; i++) {
      bubbles.push({ rx: Math.random(), ry: Math.random(), r: 0.9 + Math.random() * 2.4, par: 0.12 + Math.random() * 0.3,
        sp: 2 + Math.random() * 5, a: 0.1 + Math.random() * 0.12 });
    }
    for (var j = 0; j < 14; j++) {
      sparkles.push({ rx: Math.random(), ry: Math.random(), r: Math.random(), sp: 1.2 + Math.random() * 1.8, ph: Math.random() * TAU });
    }
  }

  /** 四角小闪光（凹边的星形） */
  function sparklePath(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.closePath();
  }

  function drawBackground() {
    var W = view.w, H = view.h, S = view.S;
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgb(bg.top)); g.addColorStop(1, rgb(bg.bot));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 柔光（左上一团暖白）
    var rg = ctx.createRadialGradient(W * 0.2, H * 0.05, 0, W * 0.2, H * 0.05, Math.max(W, H) * 0.8);
    rg.addColorStop(0, 'rgba(255,255,255,.5)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    // 远处的大泡泡：随镜头慢慢视差移动，并缓缓上飘
    var camSX = (cam.x - cam.z) * COS * S, camSY = -(cam.x + cam.z) * SIN * S;
    for (var i = 0; i < bubbles.length; i++) {
      var b = bubbles[i], r = b.r * S;
      var x = mod(b.rx * W - camSX * b.par, W + 2 * r) - r;
      var y = mod(b.ry * H - camSY * b.par - time * b.sp, H + 2 * r) - r;
      var bg2 = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      bg2.addColorStop(0, 'rgba(255,255,255,' + (b.a * 1.8).toFixed(3) + ')');
      bg2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = bg2; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    // 小闪光：慢慢眨眼的四角星，给背景添一点梦幻感
    ctx.fillStyle = '#fff';
    for (var k = 0; k < sparkles.length; k++) {
      var sp = sparkles[k], tw = 0.5 + 0.5 * Math.sin(time * sp.sp + sp.ph);
      if (tw < 0.08) continue;
      var sx = mod(sp.rx * W - camSX * 0.35, W + 40) - 20, sy = mod(sp.ry * H - camSY * 0.35 - time * 3, H + 40) - 20;
      ctx.globalAlpha = 0.7 * tw;
      sparklePath(sx, sy, (4 + sp.r * 7) * (S / 46) * (0.55 + 0.45 * tw));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** 舞台背景在纵向 y 处的颜色（台子底部渐隐要融进它） */
  function bgAt(y) {
    var t = clamp(y / view.h, 0, 1);
    return [lerp(bg.top[0], bg.bot[0], t), lerp(bg.top[1], bg.bot[1], t), lerp(bg.top[2], bg.bot[2], t)];
  }
  function rgbStr(c) { return Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]); }
  /**
   * 台子底部的「雾」：从 y0（完全透明）到 y1（完全盖住）渐变，y1 之后到 yEnd 一直是背景色。
   * 沿途颜色跟着背景的纵向渐变走，所以台子底部能无缝融进背景，看不出边。
   */
  function fogGradient(y0, y1, yEnd) {
    var span = Math.max(1, yEnd - y0);
    var g = ctx.createLinearGradient(0, y0, 0, y0 + span);
    g.addColorStop(0, 'rgba(' + rgbStr(bgAt(y0)) + ',0)');
    g.addColorStop(clamp((y1 - y0) / span, 0.01, 0.99), 'rgba(' + rgbStr(bgAt(y1)) + ',1)');
    g.addColorStop(1, 'rgba(' + rgbStr(bgAt(yEnd)) + ',1)');
    return g;
  }

  /** 台面（顶面）路径：方块 = 菱形，圆柱 = 椭圆 */
  function topPath(p, yb) {
    var h = p.size / 2, S = view.S;
    ctx.beginPath();
    if (p.shape === 'cube') {
      proj(p.x - h, yb, p.z - h); ctx.moveTo(PX, PY);
      proj(p.x + h, yb, p.z - h); ctx.lineTo(PX, PY);
      proj(p.x + h, yb, p.z + h); ctx.lineTo(PX, PY);
      proj(p.x - h, yb, p.z + h); ctx.lineTo(PX, PY);
      ctx.closePath();
    } else {
      proj(p.x, yb, p.z);
      ctx.ellipse(PX, PY, ISO_RX * h * S, ISO_RY * h * S, 0, 0, TAU);
    }
  }

  function drawPlatform(p) {
    if (p.alpha <= 0.01) return;
    var col = COLORS[p.colorIdx % COLORS.length];
    var S = view.S, h = p.size / 2, yb = p.yOff - p.sink, th = VIEW.PILLAR * S;
    ctx.save();
    ctx.globalAlpha = p.alpha;

    if (p.shape === 'cube') {
      proj(p.x - h, yb, p.z - h); var ax = PX, ay = PY;     // 最近角（屏幕最下）
      proj(p.x + h, yb, p.z - h); var bx = PX, by = PY;     // 右角
      proj(p.x + h, yb, p.z + h); var ccx = PX, ccy = PY;   // 最远角（屏幕最上）
      proj(p.x - h, yb, p.z + h); var dx = PX, dy = PY;     // 左角
      // 先整体铺一层左面色（避免相邻面之间抗锯齿漏出背景），再盖右面
      ctx.beginPath();
      ctx.moveTo(dx, dy); ctx.lineTo(ccx, ccy); ctx.lineTo(bx, by); ctx.lineTo(bx, by + th);
      ctx.lineTo(ax, ay + th); ctx.lineTo(dx, dy + th); ctx.closePath();
      ctx.fillStyle = col.left; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(bx, by + th); ctx.lineTo(ax, ay + th); ctx.closePath();
      ctx.fillStyle = col.right; ctx.fill();
      // 底部渐隐进背景
      var yTop = Math.min(dy, by);
      ctx.beginPath();
      ctx.moveTo(dx, dy); ctx.lineTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(bx, by + th);
      ctx.lineTo(ax, ay + th); ctx.lineTo(dx, dy + th); ctx.closePath();
      ctx.fillStyle = fogGradient(yTop + th * 0.3, yTop + th, ay + th); ctx.fill();
      // 顶面
      topPath(p, yb);
      var tg = ctx.createLinearGradient(ax, ay, ccx, ccy);
      tg.addColorStop(0, col.topLo); tg.addColorStop(1, col.topHi);
      ctx.fillStyle = tg; ctx.fill();
      // 近处两条棱上一道高光
      ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke();
    } else {
      proj(p.x, yb, p.z);
      var cx = PX, cy = PY, rx = ISO_RX * h * S, ry = ISO_RY * h * S;
      ctx.beginPath();
      ctx.moveTo(cx - rx, cy); ctx.lineTo(cx - rx, cy + th);
      ctx.ellipse(cx, cy + th, rx, ry, 0, Math.PI, 0, true);
      ctx.lineTo(cx + rx, cy);
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI, false);
      ctx.closePath();
      var sg = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
      sg.addColorStop(0, col.cylL); sg.addColorStop(0.5, col.cylM); sg.addColorStop(1, col.cylR);
      ctx.fillStyle = sg; ctx.fill();
      ctx.fillStyle = fogGradient(cy + th * 0.3, cy + th, cy + th + ry); ctx.fill();
      // 顶面
      topPath(p, yb);
      var rg = ctx.createRadialGradient(cx - rx * 0.25, cy - ry * 0.3, 1, cx, cy, rx);
      rg.addColorStop(0, col.topHi); rg.addColorStop(1, col.topLo);
      ctx.fillStyle = rg; ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0.12, Math.PI - 0.12, false);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke();
    }

    // 台面中心的小靶心：完美落点范围（淡淡的，不抢戏）
    proj(p.x, yb, p.z);
    var tx = PX, ty = PY, R = CFG.PERFECT_R;
    ctx.beginPath(); ctx.ellipse(tx, ty, ISO_RX * R * S, ISO_RY * R * S, 0, 0, TAU);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.62)'; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(tx, ty, ISO_RX * 0.07 * S, ISO_RY * 0.07 * S, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fill();

    // 奶蛙的影子（只落在台面上，所以裁到台面形状里）
    if (player.visible && phase !== 'over') drawShadowOn(p, yb);
    ctx.restore();
  }

  function drawShadowOn(p, topY) {
    var P = player, S = view.S;
    var above = P.baseY + P.y - topY;
    if (above < -0.12) return;                             // 已经掉到台面下面了
    if (JL.signedDistance(p, P.x, P.z) > 0.5) return;      // 不在这个台子上方
    ctx.save();
    topPath(p, topY); ctx.clip();
    proj(P.x, topY, P.z);
    var k = clamp(1 - Math.max(0, above) * 0.16, 0.4, 1), r = 0.46 * k;
    ctx.fillStyle = 'rgba(74,40,30,' + (0.12 + 0.14 * k).toFixed(3) + ')';
    ctx.beginPath(); ctx.ellipse(PX, PY, ISO_RX * r * S, ISO_RY * r * S, 0, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /** 在「脚底为原点、内容高度为 hPx」的坐标系里画奶蛙；图没加载出来就画黄色圆团 */
  function drawSpriteAtFeet(name, hPx) {
    var sp = SPRITES[name], k = hPx / (sp.bottom - sp.top);
    var img = getSprite(name, sp.w * k * view.dpr);
    if (img) { ctx.drawImage(img, -sp.cx * k, -sp.bottom * k, sp.w * k, sp.h * k); return; }
    var rw = hPx * 0.42, rh = hPx * 0.5;
    var g = ctx.createRadialGradient(-rw * 0.3, -hPx * 0.72, 2, 0, -rh, hPx * 0.6);
    g.addColorStop(0, '#fff2a8'); g.addColorStop(1, '#f1bf2c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, -rh, rw, rh, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a3325';
    ctx.beginPath(); ctx.arc(-rw * 0.38, -rh * 1.2, hPx * 0.05, 0, TAU); ctx.arc(rw * 0.38, -rh * 1.2, hPx * 0.05, 0, TAU); ctx.fill();
    if (name === 'laugh') { ctx.beginPath(); ctx.arc(0, -rh * 0.95, hPx * 0.14, 0, Math.PI); ctx.fill(); }
  }

  function drawPlayer() {
    var P = player;
    if (!P.visible || !spritesReady) return;
    var S = view.S;
    var laugh = P.laughT > 0;
    var name = laugh ? 'laugh' : 'stand';
    var hPx = (laugh ? PLAYER.LAUGH_H : PLAYER.H) * S;

    proj(P.x, P.baseY + P.y, P.z);
    var fx = PX, fy = PY;
    if (phase === 'charging' && chargeC > 0.97) fx += Math.sin(time * 90) * 1.4;     // 蓄满了：憋得发抖

    // 压扁 / 拉长（体积大致守恒），站着时轻轻呼吸
    var sq = P.sq;
    if (phase === 'idle' && P.laughT <= 0) sq += Math.sin(time * 2.6) * 0.018;
    var sy = clamp(1 - PLAYER.SQUASH_Y * sq, 0.45, 1.45);
    var sx = clamp(1 + PLAYER.SQUASH_X * sq, 0.7, 1.45);
    if (P.popT > 0) { var pu = Math.sin(Math.PI * (1 - P.popT / 0.3)); sx *= 1 + 0.14 * pu; sy *= 1 + 0.14 * pu; }

    var a = (phase === 'idle' || phase === 'charging') && support ? support.alpha : 1;
    var ang = P.angle + (laugh && phase === 'idle' ? Math.sin(time * 22) * 0.06 : 0);

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(fx, fy);
    ctx.translate(0, -P.pivot * hPx * sy);   // 到旋转支点
    ctx.rotate(ang);
    ctx.scale(sx, sy);
    ctx.translate(0, P.pivot * hPx);         // 回到「脚底为原点」
    drawSpriteAtFeet(name, hPx);
    ctx.restore();
  }

  /** 该台子是否应该画在奶蛙「后面」（先画台子再画奶蛙）：远处的台子、或奶蛙在台面之上时 */
  function platformBehindPlayer(p) {
    var P = player;
    if (P.baseY + P.y - (p.yOff - p.sink) >= -0.06) return true;
    return p.x + p.z > P.x + P.z;
  }

  var order = [];
  function render() {
    if (!view.w) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    drawBackground();

    ctx.save();
    ctx.translate(shake.x, shake.y);
    order.length = 0;
    for (var i = 0; i < platforms.length; i++) order.push(platforms[i]);
    order.sort(function (a, b) { return (b.x + b.z) - (a.x + a.z); });    // 远 → 近
    // 掉落时奶蛙一律画在最上层：笑着翻滚着掉下去是这个游戏的梗，不能被台子挡住
    var playerLast = phase === 'fall' || phase === 'over', playerDone = false;
    for (var j = 0; j < order.length; j++) {
      var p = order[j];
      if (!playerLast && !playerDone && !platformBehindPlayer(p)) { drawPlayer(); playerDone = true; }
      drawPlatform(p);
    }
    if (playerLast || !playerDone) drawPlayer();
    drawParts();
    drawFloaters();
    ctx.restore();
  }

  /* ==========================================================================
   * 十一、界面数据
   * ======================================================================== */
  function setStat(el, v, bump) {
    if (el._v === v) return;
    el._v = v;
    el.textContent = String(v);
    if (bump) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
  }
  function updateHud(bump) {
    setStat(elScore, score, bump);
    setStat(elBest, Math.max(best, score), bump && score >= best && score > 0);
    setStat(elStreak, streak, bump && streak > 0);
    if (streak >= 2) {
      var txt = '完美连击 ×' + streak;
      if (elCombo.textContent !== txt) {
        elCombo.textContent = txt;
        elCombo.classList.remove('pop'); void elCombo.offsetWidth; elCombo.classList.add('pop');
      }
      elCombo.classList.add('show');
    } else {
      elCombo.classList.remove('show');       // 文字先留着，等淡出完
    }
  }

  /* ==========================================================================
   * 十二、主循环（rAF + 按 dt 更新；标签页隐藏时暂停）
   * ======================================================================== */
  var raf = 0, lastTs = 0, running = false, errCount = 0, lastDpr = window.devicePixelRatio || 1;
  function frame(ts) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    var dt = lastTs ? Math.min(0.05, Math.max(0, (ts - lastTs) / 1000)) : 0;
    lastTs = ts;
    if ((window.devicePixelRatio || 1) !== lastDpr) { lastDpr = window.devicePixelRatio || 1; resize(); }   // 缩放页面 / 换屏幕后重新适配
    try { update(dt); render(); }
    catch (e) {
      console.error('[奶蛙跳一跳]', e);
      if (++errCount > 5) { running = false; cancelAnimationFrame(raf); }
    }
  }
  function startLoop() {
    if (running) return;
    running = true; lastTs = 0;
    raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) { cancelCharge(); stopLoop(); } else startLoop();
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });

  /* ==========================================================================
   * 十三、启动
   * ======================================================================== */
  best = loadBest();
  initBubbles();
  loadSprites();
  resize();
  initGame();
  refreshSoundBtn();
  if (!doc.hidden) startLoop();

  // 调试/自测用的小把手（不影响正常玩；浏览器里实测时用它快速推进一局）
  window.NaiJumpDebug = {
    state: function () {
      var nx = platforms[ci + 1];
      return {
        phase: phase, score: score, best: best, streak: streak, ci: ci, platformCount: platforms.length, poolSize: pool.length,
        rest: { x: rest.x, z: rest.z }, cam: { x: cam.x, z: cam.z }, view: { w: view.w, h: view.h, S: view.S, dpr: view.dpr },
        next: nx ? { x: nx.x, z: nx.z, size: nx.size, shape: nx.shape, axis: nx.axis, distance: nx.distance } : null,
        player: { x: player.x, z: player.z, y: player.y, laughT: player.laughT }, spritesReady: spritesReady,
        sprites: Object.keys(imgs).map(function (n) { return n + ':' + imgs[n].ok; }),
        partCount: parts.length, floaterCount: floaters.length, floaterTexts: floaters.map(function (f) { return f.text; }),
        overlayOpen: overlayOpen(), running: running
      };
    },
    press: beginCharge,
    release: function (sec) { endCharge(sec); },
    holdFor: function (sec) { pressAt = performance.now() - sec * 1000; },   // 假装已经按了 sec 秒（手动推帧时用）
    step: function (dt, n) { for (var i = 0; i < (n || 1); i++) { update(dt); } render(); },
    restart: restart,
    needSeconds: function () {            // 到目标台子正中心需要蓄力多久
      var nx = platforms[ci + 1];
      return JL.chargeTimeForDistance(nx.axis === 0 ? nx.x - rest.x : nx.z - rest.z);
    },
    setScore: function (s) { score = s; updateHud(false); },
    screen: function () {                 // 奶蛙和目标台子中心在舞台里的像素位置（检查「目标一定看得见」）
      var out = { w: view.w, h: view.h, S: view.S }, nx = platforms[ci + 1], cu = platforms[ci];
      proj(rest.x, 0, rest.z); out.frog = [PX, PY];
      if (nx) { proj(nx.x, 0, nx.z); out.next = [PX, PY, nx.size * view.S]; }
      if (cu) { proj(cu.x, 0, cu.z); out.cur = [PX, PY, cu.size * view.S]; }
      return out;
    }
  };
})();
