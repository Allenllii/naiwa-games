/*
 * 打奶蛙 · 画面与交互（Canvas 绘制 + 输入 + 特效 + HUD）
 * 规则全部在 logic.js（window.WhackLogic）里，这里只负责：
 *   1) 把 state 画出来（草地、奶油土坑、奶蛙、锤子、粒子、飘字）
 *   2) 把点击 / 触摸 / 按键翻译成 WhackLogic.hit(state, 洞号)，再按结果放特效和音效
 *   3) 倒计时、数据卡、开始 / 暂停 / 结束浮层
 */
(function () {
  'use strict';

  var L = window.WhackLogic;
  // 规则脚本没加载到，或者是旧版本的浏览器缓存（缺命中区函数）：给个提示让用户强制刷新，别白屏
  if (!L || !L.holeAtPoint || !L.CONFIG || !L.CONFIG.HIT) {
    var warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;left:12px;right:12px;top:12px;padding:12px 14px;border-radius:14px;background:#fff;color:#4a3325;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:99;font:14px/1.5 system-ui,sans-serif';
    warn.textContent = '页面脚本版本不一致（可能是浏览器缓存了旧文件），请强制刷新一下：Ctrl+F5，或手机上清缓存后重新打开。';
    if (document.body) document.body.appendChild(warn);
    return;
  }
  var CFG = L.CONFIG;
  var NCOL = CFG.COLS, NROW = CFG.ROWS, NHOLE = CFG.HOLES;

  /* =====================================================================
   * 1. 视觉 / 手感参数（集中放这里，想调外观只改这一块）
   * ===================================================================== */
  // 锤子的动作时序（秒）：待命(举着) -> 蓄力上抬(慢) -> 快速下砸(加速) -> 落点停顿(压扁) -> 回弹回到待命
  var SWING = { LIFT: 0.075, SLAM: 0.045, HOLD: 0.07, RECOVER: 0.26 };
  SWING.IMPACT = SWING.LIFT + SWING.SLAM;          // 从按下到"砸中"的时间：命中特效 / 音效 / 受击动画都排到这一刻
  SWING.TOTAL = SWING.IMPACT + SWING.HOLD + SWING.RECOVER;

  var VIS = {
    FONT: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif',
    DPR_MAX: 2,                   // 高分屏最多按几倍渲染（再高没必要，费电）
    MAX_PARTICLES: 320,           // 粒子数量上限（低端手机别卡）
    STORAGE_KEY: 'nai_best_whack',

    // —— 舞台与棋盘 ——
    ASPECT_MIN: 0.55, ASPECT_MAX: 1.0,   // 舞台宽高比的允许范围（太宽就两边留白，太窄就上下留白）
    HUD_H: 56,                    // 舞台顶部给倒计时条留的高度（px）
    HUD_H_SHORT: 42,              // 舞台高度 < SHORT_STAGE（手机横屏）时用这个更矮的
    SHORT_STAGE: 440,
    PAD_X: 12, PAD_BOTTOM: 12,    // 棋盘左右 / 底部留白
    CELL_ASPECT_MIN: 1.16,        // 格子高/宽（格子至少这么高，给奶蛙留出冒头的空间）
    CELL_ASPECT_MAX: 1.3,
    CELL_MAX_W: 230,              // 格子宽度上限（超大屏也别无限放大，图片会糊）
    MAX_UPSCALE: 2,               // 素材原图最多放大几倍

    // —— 土坑几何（相对格宽 cw）——
    PIT_RX: 0.37,                 // 洞口半宽
    PIT_FLAT: 0.40,               // 洞口扁度 ry/rx
    PIT_BELOW: CFG.HIT.PIT_BELOW, // 洞心到格子底边的距离（和点击命中区共用 logic.js 里的同一个数，两边永远对得上）
    MOUND_X: 1.2, MOUND_Y: 1.55,  // 奶油土墩比洞口大多少
    SPRITE_MAX_W: 0.94,           // 单只奶蛙最宽不超过格宽的这个比例

    // —— 节奏 ——
    OVER_DELAY: 0.6,              // 时间到之后，等多久再弹结算浮层
    OVER_LOCK: 0.9,               // 结算浮层弹出后，多久内按钮不响应（防止狂点的手指直接重开）
    WIN_SCORE: 120,               // 得分达到这个数（或破纪录）就放胜利音效，否则放失败音效
    POP_SFX_GAP: 0.07             // 冒头音效最短间隔（秒），避免叠成一团
  };

  // 素材：box = 裁剪区域 [x, y, w, h]（原图像素，已避开半透明杂点）；h = 完全冒出时的高度（相对格宽）
  var SPRITES = {
    mouse:   { file: 'nai03-mouse',   box: [6, 0, 124, 136],     h: 0.90 },
    rooster: { file: 'nai04-rooster', box: [6, 0, 160, 172],     h: 0.86 },
    dog:     { file: 'nai05-dog',     box: [10, 0, 191, 212],    h: 0.86 },
    horse:   { file: 'nai06-horse',   box: [6, 1, 240, 250],     h: 0.84 },
    sumo:    { file: 'nai08-sumo',    box: [61, 14, 235, 324],   h: 1.00 },
    angel:   { file: 'nai09-angel',   box: [6, 9, 400, 394],     h: 0.92 },
    laugh:   { file: 'nai10-laugh',   box: [42, 7, 389, 457],    h: 0.94 },
    // 神奶蛙原图周围有褐色半透明碎光，绿草地上像脏点：用椭圆羽化遮罩把边缘淡出去（mask = 椭圆中心/半径/不透明内圈，均为相对比例）
    god:     { file: 'nai11-god',     box: [140, 108, 232, 272], h: 1.14, mask: { cx: 0.5, cy: 0.5, rx: 0.53, ry: 0.53, inner: 0.76 } }
  };

  // 键盘：右手一块 4x4，对应 16 个洞（避开 R，R 是重开）
  var KEY_CODES = ['Digit6', 'Digit7', 'Digit8', 'Digit9', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'KeyN', 'KeyM', 'Comma', 'Period'];
  var KEY_LABELS = ['6', '7', '8', '9', 'Y', 'U', 'I', 'O', 'H', 'J', 'K', 'L', 'N', 'M', ',', '.'];
  var KEY_MAP = {};
  KEY_CODES.forEach(function (c, i) { KEY_MAP[c] = i; });

  var STAR_COLORS = ['#ffd23f', '#ff9f43', '#ff6b9d', '#ffffff', '#ffe27a'];
  var LAUGH_WORDS = ['哦齁齁～', '哈哈哈', '嘿嘿嘿', '噗～', '哦齁齁齁！'];

  /* =====================================================================
   * 2. 小工具
   * ===================================================================== */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function easeOutCubic(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }
  function easeOutBack(x) { x = clamp(x, 0, 1); var c1 = 1.70158, c3 = c1 + 1, u = x - 1; return 1 + c3 * u * u * u + c1 * u * u; }
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  function roundRectPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h);
    c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r);
    c.arcTo(x, y, x + r, y, r);
    c.closePath();
  }

  // 固定种子的随机数：装饰（花、草）每次 resize 位置都一样，不会"闪"
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function starPath(c, x, y, r, rot) {
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = rot + i * Math.PI / 5 - Math.PI / 2;
      var rr = (i % 2 === 0) ? r : r * 0.46;
      var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
  }

  /* =====================================================================
   * 3. DOM / 存档 / 音效封装
   * ===================================================================== */
  function $(id) { return document.getElementById(id); }
  var stageWrap = $('stageWrap'), stage = $('stage'), cv = $('cv');
  var ctx = cv.getContext('2d');
  var hudEl = $('hud'), hudTime = $('hudTime'), timeFill = $('timeFill'), hudPlus = $('hudPlus');
  var comboChip = $('comboChip'), ccNum = $('ccNum'), ccMult = $('ccMult');
  var vScore = $('vScore'), vBest = $('vBest'), vTime = $('vTime'), vCombo = $('vCombo'), vMult = $('vMult');
  var ovStart = $('ovStart'), ovPause = $('ovPause'), ovOver = $('ovOver');
  var btnSound = $('btnSound'), btnRestart = $('btnRestart'), btnStart = $('btnStart'), btnResume = $('btnResume'), btnAgain = $('btnAgain');
  var ovScore = $('ovScore'), ovBest = $('ovBest'), ovNew = $('ovNew'), ovRank = $('ovRank'), ovStats = $('ovStats'), confettiEl = $('confetti');

  function loadBest() {
    try { var v = parseInt(window.localStorage.getItem(VIS.STORAGE_KEY), 10); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  function saveBest(v) {
    try { window.localStorage.setItem(VIS.STORAGE_KEY, String(v)); } catch (e) { /* 存储不可用：游戏照常 */ }
  }

  // 音效：全部走这里，音效缺失 / 抛异常都不影响游戏
  function sfx(name) {
    try {
      var S = window.NaiSFX;
      if (S && typeof S[name] === 'function') return S[name].apply(S, Array.prototype.slice.call(arguments, 1));
    } catch (e) { /* 忽略 */ }
  }
  var audioUnlocks = 0;
  function unlockAudio() {
    if (audioUnlocks >= 2) return;           // 第一次手势里 init；iOS 上再给一次机会（touchend / click 才算手势）
    audioUnlocks++;
    sfx('init');
  }

  var best = loadBest();

  /* =====================================================================
   * 4. 素材加载（失败有兜底：画个黄色圆团）
   * ===================================================================== */
  Object.keys(SPRITES).forEach(function (k) {
    var sp = SPRITES[k];
    sp.ok = false;
    var img = new Image();
    img.onload = function () {
      sp.img = img; sp.sil = {};
      try { sp.cut = buildCut(sp, img); sp.ok = true; } catch (e) { sp.ok = false; }
    };
    img.onerror = function () { sp.ok = false; };
    img.src = '../assets/nai/' + sp.file + '.webp';
  });

  // 把素材按 box 裁出来（有 mask 的再套一层羽化遮罩），后面绘制都直接用这张裁好的小画布。
  // 全程只用 drawImage + 合成，不读像素，所以 file:// 下不会触发跨域污染报错。
  function buildCut(sp, img) {
    var c = document.createElement('canvas');
    c.width = sp.box[2]; c.height = sp.box[3];
    var g = c.getContext('2d');
    g.drawImage(img, sp.box[0], sp.box[1], sp.box[2], sp.box[3], 0, 0, c.width, c.height);
    if (sp.mask) {
      var m = sp.mask;
      g.globalCompositeOperation = 'destination-in';
      g.save();
      g.translate(c.width * m.cx, c.height * m.cy);
      g.scale(c.width * m.rx, c.height * m.ry);
      var gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(m.inner, 'rgba(0,0,0,1)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(-2, -2, 4, 4);
      g.restore();
    }
    return c;
  }

  // 白/红色"剪影"，用来做受击闪白
  function silhouette(key, color) {
    var sp = SPRITES[key];
    if (!sp.ok) return null;
    var c = sp.sil[color];
    if (!c) {
      c = document.createElement('canvas');
      c.width = sp.cut.width; c.height = sp.cut.height;
      var g = c.getContext('2d');
      g.drawImage(sp.cut, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      sp.sil[color] = c;
    }
    return c;
  }

  /* =====================================================================
   * 5. 全局状态
   * ===================================================================== */
  var state = L.createState();
  var paused = false;
  var result = null;                 // 结算数据
  var overTimer = -1;                // >=0 表示正在倒数"弹结算浮层"
  var overLockUntil = 0;             // 结算浮层的按钮锁（performance.now 毫秒）
  var lastPopSfx = -1;
  var lastTickSec = -1;
  var isTouchLike = false;           // 是否触屏为主（触屏不显示键位提示）
  try { isTouchLike = !(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch (e) {}

  // 画布与布局
  var W = 0, H = 0, dpr = 1;
  var cw = 0, ch = 0, bx = 0, by = 0;
  var layout = { bx: 0, by: 0, cw: 1, ch: 1, cols: NCOL, rows: NROW };   // 给命中区判定用（logic.js 的纯函数）
  var cells = [];                    // 16 个洞：{ x, y, cx, cy, jiggle }
  var pit = null;                    // 土坑几何
  var pitCv = null, bgCv = null;     // 预渲染的土坑 / 草地
  var dimCache = {};                 // 素材显示尺寸缓存（布局变了就清）

  // 特效
  var parts = [], texts = [];
  var shakeAmp = 0, shakeT = 0;
  var flashes = [];                  // 全屏闪色 {r,g,b,a,t,dur}
  var hoverHole = -1;

  // 锤子：鼠标用一把常驻的（跟着光标，点击时挥动）；触屏 / 键盘每次点击生成一把，挥完淡出
  var mouseHammer = { visible: false, x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0, t: 99, dir: 1 };
  var hammers = [];

  // 延迟调度：判定是"按下的瞬间"完成的，但特效 / 音效要等锤子砸到才出现（SWING.IMPACT 秒后）
  var pending = [];
  function schedule(delay, fn) { pending.push({ t: delay, fn: fn }); }
  function runPending(dt) {
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      p.t -= dt;
      if (p.t <= 0) { pending.splice(i, 1); i--; try { p.fn(); } catch (e) { /* 特效出错不能影响游戏 */ } }
    }
  }

  // 调试开关：地址带 ?debug 暴露 window.__whack；带 ?debug=1 还会画出每个格子的命中框
  var DEBUG_API = /[?&#]debug/.test(window.location.href);
  var DEBUG_BOXES = /[?&#]debug=1/.test(window.location.href);
  var lastClickDbg = null;

  /* =====================================================================
   * 6. 布局
   * ===================================================================== */
  function fitStage() {
    var aw = stageWrap.clientWidth, ah = stageWrap.clientHeight;
    if (aw < 20 || ah < 20) return;
    var sw = aw, sh = ah;
    if (sw / sh > VIS.ASPECT_MAX) sw = sh * VIS.ASPECT_MAX;
    else if (sw / sh < VIS.ASPECT_MIN) sh = sw / VIS.ASPECT_MIN;
    sw = Math.floor(sw); sh = Math.floor(sh);
    stage.style.width = sw + 'px';
    stage.style.height = sh + 'px';
    stage.style.left = Math.floor((aw - sw) / 2) + 'px';
    stage.style.top = Math.floor((ah - sh) / 2) + 'px';

    var ratio = window.devicePixelRatio || 1;
    var newDpr = Math.min(ratio, VIS.DPR_MAX);
    if (sw === W && sh === H && newDpr === dpr && cells.length) return;
    W = sw; H = sh; dpr = newDpr;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    layoutBoard();
    buildStatics();
    // 锤子的位置是按舞台坐标记的，resize 之后会错位：藏起来，下次移动鼠标 / 点击时再出现
    mouseHammer.visible = false; hammers.length = 0;
  }

  function layoutBoard() {
    var padX = Math.max(8, Math.min(VIS.PAD_X * 2, W * 0.035));
    var hudH = H < VIS.SHORT_STAGE ? VIS.HUD_H_SHORT : VIS.HUD_H;     // 舞台很矮（手机横屏）时，顶部倒计时条少占点地方，把空间让给格子
    var availW = W - 2 * padX;
    var availH = H - hudH - (H < VIS.SHORT_STAGE ? 8 : VIS.PAD_BOTTOM);
    cw = Math.min(availW / NCOL, availH / NROW / VIS.CELL_ASPECT_MIN, VIS.CELL_MAX_W);
    ch = Math.min(availH / NROW, cw * VIS.CELL_ASPECT_MAX);
    bx = (W - NCOL * cw) / 2;
    by = hudH + (availH - NROW * ch) / 2;
    layout = { bx: bx, by: by, cw: cw, ch: ch, cols: NCOL, rows: NROW };
    cells = [];
    for (var r = 0; r < NROW; r++) {
      for (var c = 0; c < NCOL; c++) {
        var x = bx + c * cw, y = by + r * ch;
        cells.push({ x: x, y: y, cx: x + cw / 2, cy: y + ch - VIS.PIT_BELOW * cw, jiggle: 0, jt: 0 });
      }
    }
    dimCache = {};
  }

  // 点 -> 洞号：只有点在"命中区"（格子上部、奶蛙冒头那一块）里才算；点在洞口前沿 / 缝隙 / 棋盘外返回 -1。
  // 规则本体在 logic.js 的 holeAtPoint（纯函数，有单元测试），这里只是传入当前布局。
  function cellAt(x, y) { return L.holeAtPoint(layout, x, y); }

  /* =====================================================================
   * 7. 预渲染：草地背景 + 奶油土坑
   * ===================================================================== */
  function wobblePath(g, cx, cy, rx, ry, phase) {
    g.beginPath();
    var n = 72;
    for (var i = 0; i <= n; i++) {
      var th = i / n * Math.PI * 2;
      var k = 1 + 0.028 * Math.sin(5 * th + phase) + 0.016 * Math.sin(9 * th + phase * 1.7);
      var x = cx + Math.cos(th) * rx * k, y = cy + Math.sin(th) * ry * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  function buildStatics() {
    buildBackground();
    buildPit();
  }

  function buildBackground() {
    bgCv = bgCv || document.createElement('canvas');
    bgCv.width = Math.round(W * dpr); bgCv.height = Math.round(H * dpr);
    var g = bgCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 舞台底色（奶油色）当"托盘边"，里面是一块圆角草地
    g.fillStyle = '#fff3df';
    g.fillRect(0, 0, W, H);
    var inset = Math.max(5, Math.min(8, W * 0.018)), rad = 20;
    roundRectPath(g, inset, inset, W - 2 * inset, H - 2 * inset, rad);
    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#c9f1b0');
    grad.addColorStop(0.55, '#a5e08f');
    grad.addColorStop(1, '#84cf86');
    g.fillStyle = grad;
    g.fill();

    g.save();
    roundRectPath(g, inset, inset, W - 2 * inset, H - 2 * inset, rad);
    g.clip();

    // 割草机条纹：跟着每一行格子走
    for (var r = 0; r < NROW; r++) {
      if (r % 2 === 1) continue;
      g.fillStyle = 'rgba(255,255,255,.10)';
      g.fillRect(0, by + r * ch, W, ch);
    }
    g.fillStyle = 'rgba(255,255,255,.08)';
    g.fillRect(0, 0, W, VIS.HUD_H - 6);

    // 花和草丛：避开格子中间（奶蛙活动区），主要点缀边缘和缝隙
    var rnd = seeded(20260306);
    var tries = Math.round(W * H / 3200);
    for (var i = 0; i < tries; i++) {
      var x = rnd() * W, y = rnd() * H, kind = rnd(), size = (0.045 + rnd() * 0.04) * cw;
      var hit = false;
      for (var k = 0; k < cells.length; k++) {
        var cl = cells[k];
        if (Math.abs(x - cl.cx) < cw * 0.47 && y > cl.cy - cw * 0.98 && y < cl.cy + cw * 0.3) { hit = true; break; }
      }
      if (hit || y < 8) continue;
      if (kind < 0.42) drawFlower(g, x, y, size, rnd);
      else drawTuft(g, x, y, size * 1.5, rnd);
    }

    // 暗角，让视线聚到中间
    var vg = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.35, W / 2, H * 0.55, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(40,110,60,0)');
    vg.addColorStop(1, 'rgba(40,110,60,.22)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
    g.restore();

    // 草地内侧白色细描边
    roundRectPath(g, inset, inset, W - 2 * inset, H - 2 * inset, rad);
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.stroke();
  }

  function drawFlower(g, x, y, s, rnd) {
    var petals = ['#ffffff', '#ffd1e0', '#fff0a8', '#e5d4ff'];
    var col = petals[Math.floor(rnd() * petals.length)];
    g.fillStyle = col;
    for (var i = 0; i < 5; i++) {
      var a = i * Math.PI * 2 / 5 + rnd();
      g.beginPath(); g.arc(x + Math.cos(a) * s, y + Math.sin(a) * s, s * 0.78, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#ffc93c';
    g.beginPath(); g.arc(x, y, s * 0.62, 0, Math.PI * 2); g.fill();
  }

  function drawTuft(g, x, y, s, rnd) {
    g.strokeStyle = 'rgba(70,150,80,.55)';
    g.lineWidth = Math.max(1.2, s * 0.14);
    g.lineCap = 'round';
    for (var i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(x + i * s * 0.35, y);
      g.quadraticCurveTo(x + i * s * 0.6, y - s * 0.6, x + i * s * 0.9 + (rnd() - 0.5) * s * 0.2, y - s * (0.9 + rnd() * 0.3));
      g.stroke();
    }
  }

  function buildPit() {
    var rx = cw * VIS.PIT_RX, ry = rx * VIS.PIT_FLAT;
    var rxm = rx * VIS.MOUND_X, rym = ry * VIS.MOUND_Y;
    var thick = cw * 0.05;
    var padX = cw * 0.1, padT = cw * 0.04, padB = cw * 0.22;
    var w = Math.ceil(2 * rxm + 2 * padX), h = Math.ceil(2 * rym + thick + padT + padB);
    var ox = w / 2, oy = padT + rym;
    var pcy = oy + ry * 0.08;             // 洞口椭圆的中心（略低于土墩中心）
    pit = { rx: rx, ry: ry, rxm: rxm, rym: rym, w: w, h: h, ox: ox, oy: oy, pcy: pcy, thick: thick };

    pitCv = pitCv || document.createElement('canvas');
    pitCv.width = Math.round(w * dpr); pitCv.height = Math.round(h * dpr);
    var g = pitCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // 1) 贴地阴影
    g.save();
    g.translate(ox, oy + thick + rym * 0.55);
    g.scale(1, (rym * 1.25) / (rxm * 1.08));
    var sh = g.createRadialGradient(0, 0, rxm * 0.2, 0, 0, rxm * 1.08);
    sh.addColorStop(0, 'rgba(36,96,44,.42)');
    sh.addColorStop(1, 'rgba(36,96,44,0)');
    g.fillStyle = sh;
    g.beginPath(); g.arc(0, 0, rxm * 1.08, 0, Math.PI * 2); g.fill();
    g.restore();

    // 2) 土墩侧面（有厚度的奶油墩）
    var sideGrad = g.createLinearGradient(0, oy, 0, oy + rym + thick);
    sideGrad.addColorStop(0, '#ecc994');
    sideGrad.addColorStop(1, '#c78d52');
    g.fillStyle = sideGrad;
    wobblePath(g, ox, oy + thick, rxm, rym, 1.3); g.fill();
    g.fillRect(ox - rxm * 0.97, oy, rxm * 1.94, thick);
    g.strokeStyle = 'rgba(140,90,45,.45)';
    g.lineWidth = 1.2;
    wobblePath(g, ox, oy + thick, rxm, rym, 1.3); g.stroke();

    // 3) 土墩顶面（奶油白）
    var topGrad = g.createLinearGradient(ox - rxm * 0.7, oy - rym, ox + rxm * 0.7, oy + rym);
    topGrad.addColorStop(0, '#fffefa');
    topGrad.addColorStop(0.55, '#fcecd0');
    topGrad.addColorStop(1, '#f2d6a6');
    g.fillStyle = topGrad;
    wobblePath(g, ox, oy, rxm, rym, 1.3); g.fill();
    g.strokeStyle = 'rgba(190,135,75,.4)';
    g.lineWidth = 1.2;
    g.stroke();
    // 顶面高光
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.lineWidth = Math.max(1.5, cw * 0.022);
    g.lineCap = 'round';
    g.beginPath(); g.ellipse(ox, oy, rxm * 0.93, rym * 0.9, 0, Math.PI * 1.08, Math.PI * 1.62); g.stroke();

    // 4) 洞口（巧克力色的深坑）
    var pg = g.createLinearGradient(0, pcy - ry, 0, pcy + ry);
    pg.addColorStop(0, '#6d4631');
    pg.addColorStop(0.38, '#3a2217');
    pg.addColorStop(1, '#150a05');
    g.fillStyle = pg;
    g.beginPath(); g.ellipse(ox, pcy, rx, ry, 0, 0, Math.PI * 2); g.fill();
    // 洞内上沿阴影（深度感）
    g.save();
    g.beginPath(); g.ellipse(ox, pcy, rx, ry, 0, 0, Math.PI * 2); g.clip();
    var ig = g.createLinearGradient(0, pcy - ry, 0, pcy + ry * 0.2);
    ig.addColorStop(0, 'rgba(0,0,0,.5)');
    ig.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ig;
    g.fillRect(ox - rx, pcy - ry, rx * 2, ry * 1.2);
    g.restore();
    // 洞口边缘：暗线 + 近处的亮边
    g.lineWidth = 1.6;
    g.strokeStyle = 'rgba(70,38,20,.75)';
    g.beginPath(); g.ellipse(ox, pcy, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    g.lineWidth = Math.max(1.5, cw * 0.02);
    g.strokeStyle = 'rgba(255,248,230,.95)';
    g.beginPath(); g.ellipse(ox, pcy, rx + g.lineWidth * 0.6, ry + g.lineWidth * 0.6, 0, Math.PI * 0.12, Math.PI * 0.88); g.stroke();
  }

  /* =====================================================================
   * 8. 特效：粒子 / 飘字 / 抖动 / 闪屏 / 锤子
   * ===================================================================== */
  function addPart(p) { if (parts.length < VIS.MAX_PARTICLES) parts.push(p); }

  function fxStars(x, y, n, colors, speed, size) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = speed * rand(0.45, 1);
      addPart({ k: 'star', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - speed * 0.35, g: speed * 1.6,
        rot: rand(0, 6.28), vr: rand(-8, 8), s: size * rand(0.6, 1.2), t: 0, life: rand(0.5, 0.85), c: colors[i % colors.length] });
    }
  }
  function fxDots(x, y, n, colors, speed, size) {
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = speed * rand(0.4, 1);
      addPart({ k: 'dot', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - speed * 0.3, g: speed * 1.4,
        rot: 0, vr: 0, s: size * rand(0.5, 1.1), t: 0, life: rand(0.35, 0.65), c: colors[i % colors.length] });
    }
  }
  function fxPuff(x, y, n, color, spread) {
    for (var i = 0; i < n; i++) {
      var dir = (i / Math.max(1, n - 1) - 0.5) * 2;
      addPart({ k: 'puff', x: x + dir * spread * 0.6, y: y, vx: dir * spread * 1.1 + rand(-6, 6), vy: rand(-40, -15), g: 40,
        rot: 0, vr: 0, s: cw * rand(0.045, 0.08), t: 0, life: rand(0.3, 0.5), c: color });
    }
  }
  function fxRing(x, y, color, r1) {
    addPart({ k: 'ring', x: x, y: y, vx: 0, vy: 0, g: 0, rot: 0, vr: 0, s: r1, t: 0, life: 0.45, c: color });
  }
  function fxFeathers(x, y, n) {
    for (var i = 0; i < n; i++) {
      addPart({ k: 'feather', x: x + rand(-8, 8), y: y + rand(-8, 8), vx: rand(-60, 60), vy: rand(-90, -20), g: 70,
        rot: rand(0, 6.28), vr: rand(-4, 4), s: cw * rand(0.05, 0.08), t: 0, life: rand(0.8, 1.2), c: '#ffffff' });
    }
  }
  function fxText(x, y, str, color, size, o) {
    o = o || {};
    texts.push({ x: x, y: Math.max(y, by + 10), text: str, color: color, size: size, stroke: o.stroke || '#fff',
      t: 0, life: o.life || 0.95, rise: o.rise != null ? o.rise : cw * 0.55, scale: o.scale || 1, dx: o.dx || 0, rot: o.rot || 0 });
  }
  function fxShake(amp) { shakeAmp = Math.max(shakeAmp, amp); shakeT = 0.28; }
  function fxFlash(r, g, b, a, dur) { flashes.push({ r: r, g: g, b: b, a: a, t: 0, dur: dur || 0.3 }); }

  function updateFx(dt) {
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.k === 'puff') { p.vx *= 0.94; }
      if (p.k === 'feather') { p.vx *= 0.97; p.vy *= 0.97; }
    }
    for (var j = texts.length - 1; j >= 0; j--) {
      texts[j].t += dt;
      if (texts[j].t >= texts[j].life) texts.splice(j, 1);
    }
    for (var f = flashes.length - 1; f >= 0; f--) {
      flashes[f].t += dt;
      if (flashes[f].t >= flashes[f].dur) flashes.splice(f, 1);
    }
    if (shakeT > 0) { shakeT -= dt; if (shakeT <= 0) shakeAmp = 0; }
    for (var k = 0; k < cells.length; k++) {
      if (cells[k].jt > 0) { cells[k].jt -= dt; if (cells[k].jt < 0) cells[k].jt = 0; }
    }
    updateHammers(dt);
  }

  function drawParts() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], u = p.t / p.life, a = 1 - u * u;
      ctx.globalAlpha = clamp(a, 0, 1);
      if (p.k === 'star') {
        ctx.fillStyle = p.c; ctx.strokeStyle = p.c; ctx.lineJoin = 'round'; ctx.lineWidth = p.s * 0.28;
        starPath(ctx, p.x, p.y, p.s * (1 - u * 0.4), p.rot); ctx.fill(); ctx.stroke();
      } else if (p.k === 'dot') {
        ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1 - u * 0.5), 0, 6.283); ctx.fill();
      } else if (p.k === 'puff') {
        ctx.globalAlpha = clamp(0.8 * (1 - u), 0, 1);
        ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1 + u * 1.3), 0, 6.283); ctx.fill();
      } else if (p.k === 'ring') {
        ctx.globalAlpha = clamp(1 - u, 0, 1);
        ctx.strokeStyle = p.c; ctx.lineWidth = Math.max(2, cw * 0.05 * (1 - u));
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (0.4 + easeOutCubic(u) * 1.6), 0, 6.283); ctx.stroke();
      } else if (p.k === 'feather') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(170,170,200,.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, 0, p.s * 0.45, p.s, 0, 0, 6.283); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawTexts() {
    for (var i = 0; i < texts.length; i++) {
      var tx = texts[i], u = tx.t / tx.life;
      var pop = easeOutBack(tx.t / 0.22);
      var sc = (0.35 + 0.65 * pop) * tx.scale;
      var y = tx.y - tx.rise * easeOutCubic(u);
      var a = u < 0.72 ? 1 : 1 - (u - 0.72) / 0.28;
      ctx.save();
      ctx.font = '900 ' + tx.size + 'px ' + VIS.FONT;
      // 靠边的飘字别被舞台边缘切掉：按文字宽度把中心点夹回舞台内
      var halfW = ctx.measureText(tx.text).width * tx.scale * 0.5 + tx.size * 0.3;
      var px = clamp(tx.x + tx.dx * u, halfW + 4, Math.max(halfW + 4, W - halfW - 4));
      ctx.translate(px, y); ctx.rotate(tx.rot); ctx.scale(sc, sc);
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.lineWidth = tx.size * 0.3;
      ctx.strokeStyle = 'rgba(90,50,20,.28)';
      ctx.strokeText(tx.text, 0, tx.size * 0.07);
      ctx.strokeStyle = tx.stroke;
      ctx.strokeText(tx.text, 0, 0);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, 0, 0);
      ctx.restore();
    }
  }

  // ---- 锤子：横放的木槌（锤柄水平，锤头在一侧）----
  // 三个关键姿势：位置相对"敲击点"（锤头底面中心最终落下去的那个点），单位 u；
  // a = 旋转（弧度，正 = 锤头朝上抬、柄尾朝下，也就是"向后仰"）
  var POSE_REST = { x: 0.95, y: -0.9, a: 0.12 };    // 待命：举在敲击点的右上方，不挡住光标下面的奶蛙
  var POSE_UP   = { x: 1.4,  y: -2.0, a: 0.6 };     // 蓄力：整体上移、向后仰
  var POSE_HIT  = { x: 0,    y: 0,    a: -0.1 };    // 砸中：锤头底面正好落在敲击点

  function mixPose(a, b, k) { return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), a: lerp(a.a, b.a, k), sq: 0 }; }

  // t = 距离"按下"过了多久（秒）。时序：蓄力上抬(慢) -> 下砸(快) -> 落点压扁 -> 回弹回到待命
  function hammerPose(t) {
    if (t >= SWING.TOTAL) return { x: POSE_REST.x, y: POSE_REST.y, a: POSE_REST.a, sq: 0 };
    if (t < SWING.LIFT) {                                   // ① 蓄力上抬：慢，缓入缓出
      var k1 = t / SWING.LIFT;
      return mixPose(POSE_REST, POSE_UP, k1 * k1 * (3 - 2 * k1));
    }
    if (t < SWING.IMPACT) {                                 // ② 下砸：快，越来越快（立方加速）
      var k2 = (t - SWING.LIFT) / SWING.SLAM;
      return mixPose(POSE_UP, POSE_HIT, k2 * k2 * k2);
    }
    var tt = t - SWING.IMPACT, sq = Math.exp(-tt * 16);     // ③ 落点：压扁一下
    if (tt < SWING.HOLD) { var p0 = mixPose(POSE_HIT, POSE_HIT, 0); p0.sq = sq; return p0; }
    var k3 = (tt - SWING.HOLD) / SWING.RECOVER;             // ④ 回弹：先弹起一点，再落回待命位置
    var p = mixPose(POSE_HIT, POSE_REST, 1 - Math.pow(1 - k3, 3));
    p.y -= Math.sin(Math.min(1, k3 * 1.5) * Math.PI) * 0.3 * (1 - k3);
    p.sq = sq;
    return p;
  }

  // 画一把锤子。(px, py) = 敲击点；dir = 1 锤头在左、柄朝右；dir = -1 镜像（靠右边缘时，柄朝左伸，免得被舞台边缘切掉）
  function drawHammerAt(px, py, t, dir, alpha, idle) {
    if (alpha <= 0.01) return;
    var u = clamp(cw * 0.44, 26, 78);
    var pose = hammerPose(t);
    var a = pose.a + (idle && t >= SWING.TOTAL ? Math.sin(state.clock * 5) * 0.025 : 0);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px + dir * pose.x * u, py + pose.y * u);
    ctx.scale(dir, 1);
    ctx.rotate(a);
    ctx.scale(1 + 0.2 * pose.sq, 1 - 0.16 * pose.sq);

    // 局部坐标：原点 = 锤头底面中心（敲击点），+x 朝柄尾，y 朝下
    var headW = u * 1.05, headH = u * 0.92;
    var hLen = u * 1.75, hTh = u * 0.2;
    var hy = -headH * 0.5 - hTh / 2;

    // 手柄：从锤头一侧水平伸出去的木棍
    var gHandle = ctx.createLinearGradient(0, hy, 0, hy + hTh);
    gHandle.addColorStop(0, '#f6cf99'); gHandle.addColorStop(0.55, '#e0aa6b'); gHandle.addColorStop(1, '#bd834a');
    roundRectPath(ctx, headW * 0.4, hy, hLen, hTh, hTh / 2);
    ctx.fillStyle = gHandle; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#8a5a2b'; ctx.stroke();
    // 柄尾的奶油色握环
    ctx.fillStyle = '#fff4dc';
    roundRectPath(ctx, headW * 0.4 + hLen - u * 0.42, hy - u * 0.045, u * 0.3, hTh + u * 0.09, u * 0.07);
    ctx.fill(); ctx.stroke();

    // 锤头：红色软萌玩具锤头
    var gHead = ctx.createLinearGradient(0, -headH, 0, 0);
    gHead.addColorStop(0, '#ff9c9c'); gHead.addColorStop(0.5, '#ff6b6b'); gHead.addColorStop(1, '#e14b4b');
    roundRectPath(ctx, -headW / 2, -headH, headW, headH, u * 0.26);
    ctx.fillStyle = gHead; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#b53a3a'; ctx.stroke();
    // 锤头两端的奶油色锤箍（竖条）
    ctx.fillStyle = '#fff4dc';
    roundRectPath(ctx, -headW / 2 + u * 0.03, -headH * 0.9, headW * 0.12, headH * 0.8, u * 0.05); ctx.fill();
    roundRectPath(ctx, headW / 2 - u * 0.03 - headW * 0.12, -headH * 0.9, headW * 0.12, headH * 0.8, u * 0.05); ctx.fill();
    // 高光
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = Math.max(2, u * 0.07); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-headW * 0.26, -headH * 0.84); ctx.lineTo(headW * 0.1, -headH * 0.84); ctx.stroke();
    // 笑脸：眯眼大笑（致敬奶蛙）
    ctx.strokeStyle = '#6b2a2a'; ctx.lineWidth = Math.max(1.6, u * 0.06);
    ctx.beginPath(); ctx.arc(-headW * 0.19, -headH * 0.6, u * 0.075, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.beginPath(); ctx.arc(headW * 0.19, -headH * 0.6, u * 0.075, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    ctx.fillStyle = '#6b2a2a';
    ctx.beginPath(); ctx.ellipse(0, -headH * 0.36, u * 0.13, u * 0.1, 0, 0, Math.PI); ctx.fill();
    ctx.restore();
  }

  // 开始一次挥动（鼠标：常驻锤子重新计时；触屏 / 键盘：新生成一把，挥完淡出）
  function startSwing(x, y, mode) {
    var dir = x > W * 0.56 ? -1 : 1;
    if (mode === 'mouse') {
      var h = mouseHammer;
      if (!h.visible) { h.x = x; h.y = y; h.tx = x; h.ty = y; }
      h.sx = x; h.sy = y; h.t = 0; h.visible = true; h.dir = dir;
    } else {
      if (hammers.length >= 6) hammers.shift();
      hammers.push({ x: x, y: y, t: 0, dir: dir });
    }
  }

  function updateHammers(dt) {
    var h = mouseHammer;
    if (h.t < 50) h.t += dt;
    if (h.t < SWING.TOTAL) { h.x = h.sx; h.y = h.sy; }                       // 挥动期间锤子钉在点击的位置
    else if (h.visible) {                                                    // 平时轻轻跟着光标（45/秒的跟随，几乎无延迟）
      var k = 1 - Math.exp(-dt * 45);
      h.x += (h.tx - h.x) * k; h.y += (h.ty - h.y) * k;
      if (h.tx > W * 0.6) h.dir = -1; else if (h.tx < W * 0.46) h.dir = 1;   // 带一点滞回，别在中线上来回翻面
    }
    for (var i = hammers.length - 1; i >= 0; i--) {
      hammers[i].t += dt;
      if (hammers[i].t > SWING.TOTAL + 0.25) hammers.splice(i, 1);
    }
  }

  function drawHammers() {
    var h = mouseHammer;
    if (h.visible && state.mode === 'playing') {
      var rest = h.t >= SWING.TOTAL ? 1 : clamp((h.t - SWING.IMPACT - SWING.HOLD) / SWING.RECOVER, 0, 1);
      drawHammerAt(h.x, h.y, h.t, h.dir, lerp(1, 0.88, rest), true);         // 待命时略透明，不挡光标下面的奶蛙
    }
    for (var i = 0; i < hammers.length; i++) {
      var g = hammers[i];
      var a = clamp(g.t / 0.05, 0, 1) * (g.t < SWING.TOTAL ? 1 : clamp(1 - (g.t - SWING.TOTAL) / 0.25, 0, 1));
      drawHammerAt(g.x, g.y, g.t, g.dir, a, false);
    }
  }

  /* =====================================================================
   * 9. 绘制奶蛙与舞台
   * ===================================================================== */
  function spriteKeyFor(m) {
    // 判定在按下的瞬间，但画面要等锤子砸到（SWING.IMPACT 秒后）才演受击：先被锤扁 0.07 秒，再切成"捧腹大笑"
    var laughing = m.defeated && !(m.phase === 'hit' && (m.t - SWING.IMPACT) < 0.07);
    if (m.type === 'normal') return laughing ? 'laugh' : m.skin;
    if (m.type === 'sumo') return laughing ? 'laugh' : 'sumo';
    return m.type;                    // 'god' | 'angel'
  }

  function spriteDims(key) {
    var d = dimCache[key];
    if (d) return d;
    var sp = SPRITES[key];
    var asp = sp.box[2] / sp.box[3];
    // 格子比较高（舞台竖长）时，头顶空间有富余，奶蛙可以画大一点，画面不至于空
    var hScale = clamp((ch / cw - VIS.PIT_BELOW) / 0.89, 1, 1.15);
    var h = sp.h * cw * hScale, w = h * asp;
    var maxW = VIS.SPRITE_MAX_W * cw;
    if (w > maxW) { w = maxW; h = w / asp; }
    var up = h / sp.box[3];
    if (up > VIS.MAX_UPSCALE) { up = VIS.MAX_UPSCALE; h = sp.box[3] * up; w = sp.box[2] * up; }
    d = dimCache[key] = { w: w, h: h };
    return d;
  }

  // 一只奶蛙当前在画面上的位置（绘制 / 特效共用）
  function monsterGeom(m) {
    var cell = cells[m.hole];
    var key = spriteKeyFor(m);
    var d = spriteDims(key);
    var hgt = L.monsterHeight(m);
    var restBottom = cell.cy + pit.ry * 0.8;
    var travel = d.h + pit.ry * 0.3 + 3;
    var bottom = restBottom + (1 - hgt) * travel;
    return { x: cell.cx, bottom: bottom, top: bottom - d.h, w: d.w, h: d.h, hgt: hgt, key: key };
  }

  // 裁剪区域：洞心水平线以上整块可见 + 洞口下半椭圆。奶蛙因此像是从洞里"长"出来
  function clipHole(cx, cy) {
    var wide = cw * 0.72, tall = ch * 1.5;
    var pcy = cy + (pit.pcy - pit.oy);
    ctx.beginPath();
    ctx.moveTo(cx - wide, cy - tall);
    ctx.lineTo(cx + wide, cy - tall);
    ctx.lineTo(cx + wide, pcy);
    ctx.lineTo(cx + pit.rx * 0.98, pcy);
    ctx.ellipse(cx, pcy, pit.rx * 0.98, pit.ry * 0.97, 0, 0, Math.PI, false);
    ctx.lineTo(cx - wide, pcy);
    ctx.closePath();
    ctx.clip();
  }

  function glow(x, y, r, rgb, a) {
    var gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
    gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  }

  // 特殊种类的"底板"：天使粉红脉冲、大块头橙色、金奶蛙放射光芒
  function drawAura(m, g, clock, vDefeated) {
    var cy = -g.h * 0.5;
    if (m.type === 'angel') {
      glow(0, cy, g.h * 0.78, '255,92,124', 0.6 * (0.8 + 0.2 * Math.sin(clock * 7)));
    } else if (m.type === 'sumo' && !vDefeated) {
      glow(0, cy, g.h * 0.7, '255,166,64', 0.5);
    } else if (m.type === 'god') {
      // 光芒别超出裁剪区域的宽度（±0.72 格宽），否则会被截出一道竖边
      var reach = cw * 0.68;
      ctx.save();
      ctx.translate(0, cy); ctx.rotate(clock * 0.9);
      var rg = ctx.createLinearGradient(0, 0, 0, -reach);
      rg.addColorStop(0, 'rgba(255,236,140,.6)'); rg.addColorStop(1, 'rgba(255,236,140,0)');
      ctx.fillStyle = rg;
      for (var i = 0; i < 10; i++) {
        ctx.rotate(Math.PI * 2 / 10);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-reach * 0.16, -reach); ctx.lineTo(reach * 0.16, -reach); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      glow(0, cy, reach, '255,224,100', 0.75);
    }
  }

  function drawSpriteLocal(key, w, h) {
    var sp = SPRITES[key];
    if (sp.ok) {
      ctx.drawImage(sp.cut, -w / 2, -h, w, h);
    } else {
      // 兜底：黄色圆团（带两只小眼睛）
      var r = Math.min(w, h) * 0.5;
      ctx.fillStyle = '#f6d44c'; ctx.strokeStyle = '#d9a82b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, -r, r * 0.95, r, 0, 0, 6.283); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3a4a1c';
      ctx.beginPath(); ctx.arc(-r * 0.3, -r * 1.2, r * 0.1, 0, 6.283); ctx.arc(r * 0.3, -r * 1.2, r * 0.1, 0, 6.283); ctx.fill();
    }
  }

  function drawMonster(m, clock) {
    var cell = cells[m.hole];
    var g = monsterGeom(m);
    if (g.hgt <= 0.004) return;
    var sx = 1, sy = 1, rot = 0, alpha = 1, dy = 0, flash = 0, flashColor = '#ffffff';
    var t = m.t, ph = m.phase, sinceHit = clock - m.hitAt - SWING.IMPACT;   // 受击动画从"锤子砸到"那一刻开始计时
    var ht = Math.max(0.1, m.hitTime - SWING.IMPACT);                        // 砸到之后"笑 / 升天 / 发懵"能持续多久
    var preImpact = false;
    if (ph === 'hit') {
      t = m.t - SWING.IMPACT;
      if (t < 0) { preImpact = true; ph = 'up'; t = 1; }                     // 锤子还没砸到：奶蛙还是原来那副样子
    }
    var vDefeated = m.defeated && !preImpact;                                // 画面上"已经被打趴"

    if (ph === 'rise') {
      var s = (1 - clamp(t / m.riseTime, 0, 1)) * 0.18;
      sy = 1 + s; sx = 1 - s * 0.55;
    } else if (ph === 'up') {
      var osc = Math.exp(-t * 8) * Math.sin(t * 26) * 0.10;
      sy = 1 - osc; sx = 1 + osc * 0.7;
      var b = Math.sin(clock * 4.4 + m.id * 1.9) * 0.012;
      sy *= 1 + b; sx *= 1 - b * 0.7;
      rot = Math.sin(clock * 2.7 + m.id * 1.3) * 0.025;
    } else if (ph === 'hit') {
      if (m.type === 'normal' || m.type === 'sumo') {
        if (t < 0.07) {                           // 先被锤扁
          var u = t / 0.07;
          sy = lerp(1, 0.6, u); sx = lerp(1, 1.3, u); dy = g.h * 0.08 * u;
          flash = 0.8 * (1 - u);
        } else {                                  // 再"捧腹大笑"：弹性放大 + 狂抖
          var u2 = t - 0.07, pop = 1 + 0.16 * Math.exp(-u2 * 9) * Math.cos(u2 * 26);
          sx = sy = pop;
          rot = Math.sin(t * 46) * 0.1 * (1 - clamp(t / ht, 0, 1));
          sy *= 1 + Math.sin(t * 52) * 0.035;
        }
      } else if (m.type === 'god') {              // 升天：放大、上浮、淡出
        var ug = clamp(t / ht, 0, 1);
        dy = -g.h * 0.75 * easeOutCubic(ug);
        sx = sy = 1 + 0.32 * easeOutCubic(ug);
        alpha = 1 - smooth(0.35, 1, ug);
        flash = 0.85 * Math.exp(-t * 9);
      } else if (m.type === 'angel') {            // 被误伤：变红、发抖、被压扁一下
        sy = 1 - 0.16 * Math.exp(-t * 12); sx = 1 + 0.1 * Math.exp(-t * 12);
        rot = Math.sin(t * 50) * 0.12 * Math.exp(-t * 5);
        flash = 0.65 * Math.exp(-t * 9); flashColor = '#ff3b3b';
      }
    } else if (ph === 'fall') {
      if (m.defeated && m.type === 'god') alpha = 0;
    }
    // 大块头挨了第一下：压扁 + 抖 + 闪白
    if (m.type === 'sumo' && !vDefeated && sinceHit >= 0 && sinceHit < 0.5) {
      var k = Math.exp(-sinceHit * 9) * Math.cos(sinceHit * 34);
      sy *= 1 - 0.3 * k; sx *= 1 + 0.22 * k;
      rot += Math.sin(sinceHit * 60) * 0.06 * Math.exp(-sinceHit * 8);
      flash = Math.max(flash, 0.7 * Math.exp(-sinceHit * 14));
    }
    if (alpha <= 0.01) return;

    // 洞口辉光：特殊种类的洞口会发光，远远就能分辨
    if (m.type !== 'normal' && !vDefeated) {
      var rgb = m.type === 'angel' ? '255,80,110' : (m.type === 'sumo' ? '255,170,60' : '255,230,120');
      ctx.save();
      ctx.translate(cell.cx, cell.cy + (pit.pcy - pit.oy));
      ctx.scale(1, pit.ry / pit.rx);
      glow(0, 0, pit.rx * 1.35, rgb, 0.65 * clamp(g.hgt, 0, 1));
      ctx.restore();
    }

    ctx.save();
    clipHole(cell.cx, cell.cy);
    ctx.translate(g.x, g.bottom + dy);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.globalAlpha = alpha;
    drawAura(m, g, clock, vDefeated);
    drawSpriteLocal(g.key, g.w, g.h);
    if (flash > 0.02) {
      var sil = silhouette(g.key, flashColor);
      if (sil) { ctx.globalAlpha = alpha * clamp(flash, 0, 1); ctx.drawImage(sil, -g.w / 2, -g.h, g.w, g.h); }
    }
    ctx.restore();

    // 头顶标记（不裁剪）：天使的"禁止"牌、大块头的血点、金奶蛙的闪光
    if (g.hgt > 0.6 && alpha > 0.5) {
      var topY = g.bottom + dy - g.h * sy, r = cw * 0.1;
      if (m.type === 'angel' && !vDefeated) {
        var by0 = topY - r * 0.9 + Math.sin(clock * 6) * cw * 0.012;
        ctx.save(); ctx.translate(g.x, by0);
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.fill();
        ctx.lineWidth = r * 0.3; ctx.strokeStyle = '#e8334a';
        ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, 6.283); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-r * 0.58, -r * 0.58); ctx.lineTo(r * 0.58, r * 0.58); ctx.stroke();
        ctx.restore();
      } else if (m.type === 'sumo' && !vDefeated) {
        for (var i = 0; i < m.maxHp; i++) {
          var px = g.x + (i - (m.maxHp - 1) / 2) * r * 1.15, py = topY - r * 0.55;
          ctx.beginPath(); ctx.arc(px, py, r * 0.4, 0, 6.283);
          if (i < m.hp) { ctx.fillStyle = '#ff9f43'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
          else { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#ff9f43'; ctx.stroke(); }
        }
      } else if (m.type === 'god' && !vDefeated) {
        for (var j = 0; j < 4; j++) {
          var a = clock * 2.2 + j * 1.57, rr = g.w * (0.42 + 0.06 * Math.sin(clock * 3 + j));
          var sxp = g.x + Math.cos(a) * rr, syp = g.bottom - g.h * (0.55 + 0.3 * Math.sin(a * 1.3 + j));
          ctx.save(); ctx.globalAlpha = 0.6 + 0.4 * Math.sin(clock * 9 + j * 2);
          ctx.fillStyle = '#fff6b0'; starPath(ctx, sxp, syp, cw * 0.05, clock + j); ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  function drawPit(cell, idx) {
    var j = cell.jt > 0 ? cell.jt / 0.35 : 0;
    ctx.save();
    ctx.translate(cell.cx, cell.cy);
    if (j > 0) {
      var w = Math.sin((1 - j) * 22) * j;
      ctx.scale(1 + 0.06 * w, 1 - 0.08 * w);
    }
    ctx.drawImage(pitCv, -pit.ox, -pit.oy, pit.w, pit.h);
    ctx.restore();
    // 键位提示（仅非触屏设备）
    if (!isTouchLike && state.mode === 'playing') {
      var kw = cw * 0.19, kx = cell.cx + pit.rxm * 0.78 - kw / 2, ky = cell.cy + pit.rym * 0.45;
      ctx.save();
      ctx.globalAlpha = 0.62;
      roundRectPath(ctx, kx, ky, kw, kw * 0.9, kw * 0.25);
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(138,117,102,.5)'; ctx.stroke();
      ctx.fillStyle = '#8a7566'; ctx.font = '800 ' + Math.round(kw * 0.58) + 'px ' + VIS.FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(KEY_LABELS[idx], kx + kw / 2, ky + kw * 0.47);
      ctx.restore();
    }
  }

  // 鼠标悬停：把当前格子的命中区用一圈淡淡的虚线框出来（告诉你点在这块里才算）
  function drawHoverZone() {
    if (hoverHole < 0 || state.mode !== 'playing' || !mouseHammer.visible) return;
    var z = L.hitRect(layout, hoverHole);
    ctx.save();
    roundRectPath(ctx, z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0, cw * 0.16);
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fill();
    ctx.setLineDash([cw * 0.07, cw * 0.06]);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.stroke();
    ctx.restore();
  }

  // 调试（?debug=1）：画出每个格子的命中框、洞口中线、格子编号，以及最近一次点击的位置
  function drawZones() {
    ctx.save();
    ctx.font = 'bold 11px monospace'; ctx.textBaseline = 'top';
    for (var i = 0; i < NHOLE; i++) {
      var z = L.hitRect(layout, i);
      ctx.fillStyle = 'rgba(255,60,60,.14)'; ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(210,20,20,.95)'; ctx.setLineDash([]);
      ctx.strokeRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      ctx.strokeStyle = 'rgba(30,60,230,.9)'; ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(z.x0 - 4, z.cy); ctx.lineTo(z.x1 + 4, z.cy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#a00'; ctx.fillText(String(i), z.x0 + 3, z.y0 + 3);
    }
    if (lastClickDbg) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lastClickDbg.x - 8, lastClickDbg.y); ctx.lineTo(lastClickDbg.x + 8, lastClickDbg.y);
      ctx.moveTo(lastClickDbg.x, lastClickDbg.y - 8); ctx.lineTo(lastClickDbg.x, lastClickDbg.y + 8); ctx.stroke();
      ctx.fillStyle = lastClickDbg.hole >= 0 ? '#0a0' : '#c60'; ctx.fillText('click→' + lastClickDbg.hole, lastClickDbg.x + 8, lastClickDbg.y + 6);
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!bgCv || !pit) return;
    var clock = state.clock;

    ctx.save();
    if (shakeT > 0 && shakeAmp > 0) {
      var k = shakeT / 0.28;
      ctx.translate(Math.sin(clock * 90) * shakeAmp * k, Math.cos(clock * 77) * shakeAmp * k * 0.7);
    }
    ctx.drawImage(bgCv, 0, 0, W, H);

    // 从后排到前排：前排的奶蛙盖在后排上面
    for (var r = 0; r < NROW; r++) {
      for (var c = 0; c < NCOL; c++) {
        var idx = r * NCOL + c, cell = cells[idx];
        drawPit(cell, idx);
        var m = state.holes[idx];
        if (m) drawMonster(m, clock);
      }
    }
    drawHoverZone();
    drawParts();
    drawTexts();
    ctx.restore();

    // 全屏闪色（金奶蛙金光、误伤天使红光）
    for (var f = 0; f < flashes.length; f++) {
      var fl = flashes[f], a = fl.a * (1 - fl.t / fl.dur);
      ctx.fillStyle = 'rgba(' + fl.r + ',' + fl.g + ',' + fl.b + ',' + a.toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    drawHammers();
    if (DEBUG_BOXES) drawZones();
  }

  /* =====================================================================
   * 10. 命中反馈（特效 + 音效）
   * ===================================================================== */
  function pointsColor(p) { return p >= 5 ? '#e79a1f' : (p >= 3 ? '#ff7a2f' : '#ff4d6d'); }

  // 锤子砸到的一瞬间：落点冲击（白色冲击环 + 火星；砸在没奶蛙的地方还会扬起一点灰）
  function fxImpact(x, y, hitSomething) {
    fxRing(x, y, 'rgba(255,255,255,.95)', cw * 0.2);
    fxDots(x, y, 5, ['#ffffff', '#fff3b0'], cw * 1.5, cw * 0.03);
    if (!hitSomething) fxPuff(x, y + cw * 0.02, 3, '#fff4dc', cw * 0.2);
  }

  // 命中后的特效 + 音效。判定在按下的瞬间完成，这个函数由 schedule 延后到"锤子砸到"那一刻才执行
  function playHitFx(res) {
    var cell = cells[res.hole];
    var m = res.monster;
    var hx = cell.cx, hy = cell.cy - cw * 0.5;
    if (m) { var g = monsterGeom(m); hx = g.x; hy = g.top + g.h * 0.32; }
    var fs = clamp(cw * 0.36, 17, 48);
    var combo = res.combo;

    if (res.kind === 'miss') {
      cell.jt = 0.35;
      fxPuff(cell.cx, cell.cy + pit.ry * 0.5, 5, '#fff4dc', cw * 0.3);
      sfx('click');
      if (res.brokeCombo && res.comboBefore >= 3) fxText(cell.cx, cell.cy - cw * 0.35, '连击中断', '#8a7566', fs * 0.6, { rise: cw * 0.3, life: 0.8 });
    } else if (res.kind === 'partial') {
      sfx('boing');
      fxStars(hx, hy, 6, ['#ff9f43', '#ffd23f', '#ffffff'], cw * 2.6, cw * 0.07);
      fxText(hx, hy - cw * 0.1, '再来一下！', '#ff7a2f', fs * 0.7, { rise: cw * 0.35 });
      fxShake(3.5);
    } else if (res.kind === 'kill') {
      sfx('laugh', Math.min(1, combo / 15)); sfx('good', combo);
      fxStars(hx, hy, 8 + Math.min(10, combo), STAR_COLORS, cw * 3.4, cw * 0.085);
      fxDots(hx, hy, 6, ['#fff', '#ffe27a'], cw * 2.2, cw * 0.035);
      fxText(hx, hy - cw * 0.05, '+' + res.points, pointsColor(res.points), fs * (m && m.type === 'sumo' ? 1.3 : 1));
      fxShake(m && m.type === 'sumo' ? 5.5 : 2.2);
      if (res.multUp) comboUp(hx, hy, res.mult);
      else if (combo >= 3 && Math.random() < 0.3) fxText(hx + rand(-0.25, 0.25) * cw, hy - cw * 0.5, LAUGH_WORDS[Math.floor(Math.random() * LAUGH_WORDS.length)], '#b13bff', fs * 0.55, { rise: cw * 0.3, rot: rand(-0.15, 0.15), life: 0.85 });
    } else if (res.kind === 'god') {
      sfx('laugh', Math.min(1, combo / 15)); sfx('good', combo);
      sfx('tone', 1568, 0.1, 'sine', 0.08, 2093); sfx('tone', 2093, 0.16, 'sine', 0.07, 2637, 0.09);
      fxStars(hx, hy, 26, ['#ffd23f', '#fff3a0', '#ffffff', '#ffb02e'], cw * 4.6, cw * 0.1);
      fxRing(hx, hy, 'rgba(255,214,70,.95)', cw * 0.4);
      fxText(hx, hy - cw * 0.05, '+' + res.points, '#e79a1f', fs * 1.5);
      fxText(hx, hy + cw * 0.28, '时间 +' + res.timeBonus + ' 秒', '#18a999', fs * 0.72, { rise: cw * 0.3, life: 1.1 });
      fxFlash(255, 220, 90, 0.22, 0.3); fxShake(6);
      if (res.multUp) comboUp(hx, hy - cw * 0.4, res.mult);
      flashHudPlus();
    } else if (res.kind === 'angel') {
      sfx('bad');
      fxFeathers(hx, hy, 10);
      fxStars(hx, hy, 6, ['#8a96b8', '#c8cde0', '#ffffff'], cw * 2.4, cw * 0.06);
      fxText(hx, hy - cw * 0.05, res.delta === 0 ? '-0' : '-3', '#d42a45', fs * 1.35);
      if (res.brokeCombo) fxText(hx, hy + cw * 0.3, '连击中断', '#8a7566', fs * 0.6, { rise: cw * 0.25, life: 0.9 });
      fxFlash(255, 70, 70, 0.18, 0.3); fxShake(7);
    }
  }

  function comboUp(x, y, mult) {
    var cols = { 2: '#ff7a2f', 3: '#ff3d7f', 4: '#b13bff' };
    var fs = clamp(cw * 0.36, 17, 48);
    fxText(x, y - cw * 0.55, 'COMBO ×' + mult, cols[mult] || '#ff7a2f', fs * 0.95, { rise: cw * 0.35, life: 1.15, rot: -0.06 });
    fxRing(x, y, cols[mult] || '#ff7a2f', cw * 0.35);
    fxStars(x, y - cw * 0.3, 8, ['#b13bff', '#ff6b9d', '#ffd23f'], cw * 3.2, cw * 0.075);
    fxText(x, y - cw * 0.98, '哦齁齁齁！', '#b13bff', fs * 0.6, { rise: cw * 0.25, life: 1.0, rot: 0.07 });
  }

  /* =====================================================================
   * 11. HUD（数据卡、时间条、连击牌）
   * ===================================================================== */
  var hudCache = { score: -1, best: -1, time: -1, combo: -1, mult: -1 };

  function popEl(el) {
    try {
      if (el && el.animate) el.animate([{ transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    } catch (e) { /* 老浏览器没有 WAAPI：忽略 */ }
  }

  function updateHud() {
    var s = state;
    var shownBest = Math.max(best, s.score);
    var tl = Math.max(0, s.timeLeft);
    var tInt = s.mode === 'idle' ? CFG.GAME_TIME : Math.ceil(tl - 1e-6);

    if (hudCache.score !== s.score) { vScore.textContent = s.score; if (hudCache.score >= 0) popEl(vScore); hudCache.score = s.score; }
    if (hudCache.best !== shownBest) { vBest.textContent = shownBest; if (hudCache.best >= 0) popEl(vBest); hudCache.best = shownBest; }
    if (hudCache.time !== tInt) {
      vTime.textContent = tInt; hudTime.textContent = tInt;
      vTime.classList.toggle('low', s.mode === 'playing' && tInt <= 10);
      if (hudCache.time >= 0 && s.mode === 'playing' && tInt > hudCache.time) popEl(hudTime);   // 加时了
      hudCache.time = tInt;
    }
    hudEl.classList.toggle('danger', s.mode === 'playing' && tl <= 10);
    timeFill.style.width = (clamp(tl / CFG.GAME_TIME, 0, 1) * 100).toFixed(1) + '%';

    var mult = L.comboMultiplier(s.combo);
    if (hudCache.combo !== s.combo) {
      vCombo.textContent = s.combo;
      if (s.combo > hudCache.combo && s.combo > 0) popEl(vCombo);
      ccNum.textContent = s.combo;
      comboChip.classList.toggle('show', s.combo >= 2 && s.mode === 'playing');
      if (s.combo >= 2 && s.combo > hudCache.combo) popEl(comboChip);
      hudCache.combo = s.combo;
    }
    if (hudCache.mult !== mult) {
      vMult.textContent = '×' + mult; ccMult.textContent = '×' + mult;
      vMult.classList.toggle('on', mult > 1);
      comboChip.classList.remove('m3', 'm4');
      if (mult >= 3) comboChip.classList.add('m' + mult);
      hudCache.mult = mult;
    }
    if (s.mode !== 'playing') comboChip.classList.remove('show');
  }

  function flashHudPlus() {
    try {
      var r = hudTime.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      hudPlus.style.left = (r.left - sr.left - 8) + 'px';
      if (hudPlus.animate) hudPlus.animate(
        [{ opacity: 0, transform: 'translateY(6px) scale(.6)' }, { opacity: 1, transform: 'translateY(0) scale(1.15)', offset: 0.25 }, { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.7 }, { opacity: 0, transform: 'translateY(-12px) scale(1)' }],
        { duration: 1100, easing: 'ease-out' });
      popEl(hudTime);
    } catch (e) {}
  }

  function updateSoundButton() {
    var muted = false;
    try { muted = !!(window.NaiSFX && window.NaiSFX.isMuted && window.NaiSFX.isMuted()); } catch (e) {}
    var ico = btnSound.querySelector('.ico'), txt = btnSound.querySelector('.txt');
    if (ico && txt) { ico.textContent = muted ? '🔇' : '🔊'; txt.textContent = muted ? '音效关' : '音效开'; }
    else btnSound.textContent = muted ? '🔇 音效关' : '🔊 音效开';
    btnSound.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btnSound.setAttribute('aria-label', muted ? '音效已关闭，点按打开' : '音效已开启，点按关闭');   // 窄屏下只显示图标，给读屏 / 长按提示留文字
  }

  /* =====================================================================
   * 12. 流程：开始 / 重开 / 暂停 / 结束
   * ===================================================================== */
  function commitBest() {
    if (state.score > best) { best = state.score; saveBest(best); }
  }

  function clearFx() { parts.length = 0; texts.length = 0; flashes.length = 0; shakeT = 0; shakeAmp = 0; pending.length = 0; hammers.length = 0; }

  function startNewGame() {
    unlockAudio();
    if (state.mode === 'playing') commitBest();
    L.startGame(state);
    clearFx();
    paused = false; result = null; overTimer = -1; lastTickSec = -1; lastPopSfx = -1;
    hudCache = { score: -1, best: -1, time: -1, combo: -1, mult: -1 };
    ovStart.classList.add('hidden'); ovOver.classList.add('hidden'); ovPause.classList.add('hidden');
    confettiEl.innerHTML = '';
    document.body.classList.add('playing');
    // 浮层里的按钮已经看不见了，别让它还抓着键盘焦点（否则空格/回车会误触它）
    try { var ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur(); } catch (e) {}
    sfx('click');
    updateHud();
    placeHammerAtLastPointer();
    fxText(W / 2, by + ch * 1.4, '开始！', '#ff4d6d', clamp(cw * 0.6, 28, 70), { life: 0.9, rise: cw * 0.3 });
  }

  function pauseGame() {
    if (state.mode !== 'playing' || paused) return;
    paused = true;
    ovPause.classList.remove('hidden');
    document.body.classList.remove('playing');
    try { var b = document.activeElement; if (b && b.blur) b.blur(); } catch (e) {}
  }
  function resumeGame() {
    if (!paused) return;
    paused = false;
    lastTs = 0;
    ovPause.classList.add('hidden');
    document.body.classList.add('playing');
  }

  function onTimeUp() {
    document.body.classList.remove('playing');
    mouseHammer.visible = false; hammers.length = 0;
    var prev = best;
    var isNew = state.score > prev && state.score > 0;
    commitBest();
    result = { score: state.score, best: Math.max(prev, state.score), isNew: isNew, stats: state.stats, maxCombo: state.maxCombo };
    sfx((isNew || state.score >= VIS.WIN_SCORE) ? 'win' : 'lose');
    overTimer = VIS.OVER_DELAY;
    updateHud();
  }

  function rankText(score) {
    if (score >= 300) return '奶蛙本蛙！哦齁齁齁～';
    if (score >= 180) return '锤神附体，奶蛙们笑到发抖';
    if (score >= 100) return '手速在线，奶蛙笑出腹肌';
    if (score >= 40) return '还不错，奶蛙们开始害怕了';
    if (score >= 1) return '热身完毕，再来一局！';
    return '奶蛙们笑了……你一下都没打中？';
  }

  function countUp(el, to, ms) {
    var t0 = performance.now();
    function step(now) {
      var u = clamp((now - t0) / ms, 0, 1);
      el.textContent = Math.round(to * easeOutCubic(u));
      if (u < 1 && !ovOver.classList.contains('hidden')) requestAnimationFrame(step);
      else el.textContent = to;
    }
    el.textContent = 0;
    requestAnimationFrame(step);
  }

  function makeConfetti() {
    confettiEl.innerHTML = '';
    var colors = ['#ff6b6b', '#ffd23f', '#6bcB77', '#4da3ff', '#b13bff', '#ff9f43', '#ff6b9d'];
    var fall = (H || 700) + 60;
    for (var i = 0; i < 40; i++) {
      var p = document.createElement('i');
      p.style.left = rand(0, 100).toFixed(1) + '%';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', rand(-60, 60).toFixed(0) + 'px');
      p.style.setProperty('--rot', rand(300, 900).toFixed(0) + 'deg');
      p.style.setProperty('--fall', fall + 'px');
      p.style.animationDuration = rand(1.8, 3.4).toFixed(2) + 's';
      p.style.animationDelay = rand(0, 0.9).toFixed(2) + 's';
      p.style.width = rand(6, 10).toFixed(0) + 'px';
      confettiEl.appendChild(p);
    }
  }

  function showOver() {
    var r = result;
    if (!r) return;
    ovBest.textContent = r.best;
    ovNew.hidden = !r.isNew;
    ovRank.textContent = rankText(r.score);
    var st = r.stats;
    var acc = st.swings > 0 ? Math.round((st.kills + st.partials) / st.swings * 100) : 0;
    ovStats.textContent = '最高连击 ' + r.maxCombo + ' · 命中率 ' + acc + '%' + (st.angelHits ? ' · 误伤天使 ' + st.angelHits : '') + (st.godHits ? ' · 金奶蛙 ' + st.godHits : '');
    ovOver.classList.remove('hidden');
    overLockUntil = performance.now() + VIS.OVER_LOCK * 1000;
    countUp(ovScore, r.score, 700);
    if (r.isNew) makeConfetti(); else confettiEl.innerHTML = '';
    try { btnAgain.focus({ preventScroll: true }); } catch (e) {}
  }

  function overLocked() { return !ovOver.classList.contains('hidden') && performance.now() < overLockUntil; }

  /* =====================================================================
   * 13. 输入：Pointer Events（鼠标 + 触屏 + 笔）+ 键盘
   * ===================================================================== */
  function stagePoint(e) {
    var r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
  }

  // 一次 pointerdown = 一次判定（只监听 pointerdown，不监听 click，所以不会被触屏 click 延迟 / 重复触发影响）。
  // 判定当场完成（命中区 -> 洞号 -> hit()）；锤子无论打没打中都要挥下去，特效 / 音效等锤子砸到的那一刻再出。
  function whackAt(x, y, mode) {                  // 鼠标 / 触屏：按坐标走命中区
    if (state.mode !== 'playing' || paused) return null;
    startSwing(x, y, mode);
    var out = L.clickAt(state, layout, x, y);     // 点在命中区之外（洞口前沿 / 缝隙 / 棋盘外）：out.res 为 null，不做任何判定
    lastClickDbg = { x: x, y: y, hole: out.hole };
    afterJudge(out.res, x, y);
    return out.res;
  }

  function whackHole(idx) {                       // 键盘：直接指定洞号，锤子落在该格命中区里
    if (state.mode !== 'playing' || paused) return null;
    var z = L.hitRect(layout, idx);
    var x = (z.x0 + z.x1) / 2, y = z.y0 + (z.y1 - z.y0) * 0.6;
    startSwing(x, y, 'key');
    lastClickDbg = { x: x, y: y, hole: idx };
    var res = L.hit(state, idx);
    afterJudge(res, x, y);
    return res;
  }

  function afterJudge(res, x, y) {
    updateHud();                                  // 分数 / 连击立刻变化（判定是瞬间的，只有"演出"要等锤子）
    var hitSomething = !!(res && res.monster);
    schedule(SWING.IMPACT, function () {
      fxImpact(x, y, hitSomething);
      if (res) playHitFx(res);
    });
  }

  cv.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    unlockAudio();
    var p = stagePoint(e);
    // 没有悬停能力的设备（手机 / 平板）：个别 WebView 会把触摸上报成 mouse，这里一律当触屏处理，锤子只在点击处出现
    var asTouch = e.pointerType === 'touch' || (e.pointerType === 'mouse' && isTouchLike);
    if (!asTouch) { mouseHammer.tx = p.x; mouseHammer.ty = p.y; }
    whackAt(p.x, p.y, asTouch ? 'touch' : 'mouse');
  });

  stage.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch' || isTouchLike) return;   // 触屏没有"悬停"：只在点击的位置出现锤子，不会有错位的残影
    var p = stagePoint(e);
    hoverHole = cellAt(p.x, p.y);
    if (state.mode !== 'playing') return;
    var h = mouseHammer;
    h.tx = p.x; h.ty = p.y;
    if (!h.visible) { h.visible = true; h.x = p.x; h.y = p.y; h.t = 99; h.dir = p.x > W * 0.56 ? -1 : 1; }
  });
  // 记住鼠标最后的位置：开局时鼠标不动也要立刻看到锤子（画布上系统光标是隐藏的）
  var lastPtr = null;
  window.addEventListener('pointermove', function (e) { lastPtr = { x: e.clientX, y: e.clientY, type: e.pointerType }; }, true);
  window.addEventListener('pointerdown', function (e) { lastPtr = { x: e.clientX, y: e.clientY, type: e.pointerType }; }, true);
  function placeHammerAtLastPointer() {
    if (!lastPtr || lastPtr.type === 'touch') return;
    var r = cv.getBoundingClientRect();
    if (lastPtr.x < r.left || lastPtr.x > r.right || lastPtr.y < r.top || lastPtr.y > r.bottom) return;
    var x = (lastPtr.x - r.left) * (W / r.width), y = (lastPtr.y - r.top) * (H / r.height);
    var h = mouseHammer;
    h.tx = h.x = x; h.ty = h.y = y; h.t = 99; h.visible = true; h.dir = x > W * 0.56 ? -1 : 1;
  }
  stage.addEventListener('pointerleave', function (e) {
    if (e.pointerType === 'touch') return;
    hoverHole = -1;
    mouseHammer.visible = false;
  });
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  stage.addEventListener('dragstart', function (e) { e.preventDefault(); });
  // 触屏上长按会弹"保存图片 / 复制"之类的菜单，整页禁掉（桌面鼠标只在舞台里禁右键）
  document.addEventListener('contextmenu', function (e) { if (isTouchLike) e.preventDefault(); });
  // iOS 双指缩放 / 手势
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });

  // 开始 / 暂停浮层：点浮层任意位置即可
  ovStart.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('a')) return;
    e.preventDefault();
    startNewGame();
  });
  ovPause.addEventListener('pointerdown', function (e) { e.preventDefault(); resumeGame(); });
  btnAgain.addEventListener('click', function () { if (!overLocked()) startNewGame(); });
  ovOver.addEventListener('pointerdown', function (e) {
    // 结算浮层只有按钮可点；锁定期内吞掉点击，防止狂点的手指误触
    if (e.target === btnAgain) return;
    e.preventDefault();
  });
  btnRestart.addEventListener('click', function () { startNewGame(); btnRestart.blur(); });
  btnSound.addEventListener('click', function () {
    unlockAudio();
    try { if (window.NaiSFX && window.NaiSFX.toggleMuted) window.NaiSFX.toggleMuted(); } catch (e) {}
    updateSoundButton();
    sfx('click');
    btnSound.blur();
  });

  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('touchend', unlockAudio, true);

  function isInteractive(el) {
    if (!el || el === document.body) return false;
    var tag = el.tagName;
    return tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;       // 不抢浏览器快捷键（Ctrl+R 刷新等）
    unlockAudio();
    if (e.code === 'KeyR') {
      e.preventDefault();
      if (!e.repeat) { startNewGame(); }
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      if (state.mode !== 'playing' && !isInteractive(document.activeElement) && !overLocked()) {
        e.preventDefault(); startNewGame();
      } else if (paused && !isInteractive(document.activeElement)) {
        e.preventDefault(); resumeGame();
      }
      return;
    }
    if (e.repeat) return;
    var idx = KEY_MAP[e.code];
    if (idx != null && state.mode === 'playing' && !paused) {
      e.preventDefault();
      whackHole(idx);
    }
  });

  /* =====================================================================
   * 14. 主循环
   * ===================================================================== */
  var lastTs = 0;

  function handleEvents(events) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'spawn') {
        var cell = cells[e.monster.hole];
        fxPuff(cell.cx, cell.cy + pit.ry * 0.2, 3, '#fff4dc', cw * 0.22);
        if (state.mode === 'playing') {
          if (state.clock - lastPopSfx >= VIS.POP_SFX_GAP) { sfx('pop'); lastPopSfx = state.clock; }
          if (e.monster.type === 'god') sfx('tone', 1976, 0.12, 'sine', 0.06, 2637);
        }
      } else if (e.type === 'over') {
        onTimeUp();
      }
    }
  }

  function update(dt) {
    if (paused) return;
    var wasPlaying = state.mode === 'playing';
    handleEvents(L.tick(state, dt));
    runPending(dt);
    updateFx(dt);
    if (wasPlaying && state.mode === 'playing') {
      // 最后 5 秒的滴答声
      var sec = Math.ceil(state.timeLeft - 1e-6);
      if (sec <= 5 && sec >= 1 && sec !== lastTickSec) { lastTickSec = sec; sfx('tone', 880, 0.07, 'square', 0.05); }
      if (sec > 5) lastTickSec = -1;
    }
    if (overTimer >= 0) {
      overTimer -= dt;
      if (overTimer < 0) { overTimer = -1; if (state.mode === 'over') showOver(); }
    }
    updateHud();
  }

  var debugFrozen = false;           // 仅调试用：?debug 时可以冻结主循环，手动单步

  function frame(ts) {
    requestAnimationFrame(frame);
    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (dt > 0 && !debugFrozen) update(dt);
    render();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { pauseGame(); }
    lastTs = 0;                                    // 切回来时别算一个巨大的 dt
  });
  window.addEventListener('pagehide', function () { if (state.mode === 'playing') commitBest(); });

  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', function () { setTimeout(fitStage, 80); });
  if (window.ResizeObserver) { try { new ResizeObserver(fitStage).observe(stageWrap); } catch (e) {} }

  /* =====================================================================
   * 15. 启动
   * ===================================================================== */
  fitStage();
  updateSoundButton();
  updateHud();
  requestAnimationFrame(frame);

  // 调试入口：页面地址带 ?debug 或 #debug 时才暴露（正常玩家看不到）；?debug=1 还会画出命中框
  if (DEBUG_API) {
    window.__whack = {
      L: L, state: state, cells: function () { return cells; }, layout: function () { return layout; },
      geom: function () { return { W: W, H: H, cw: cw, ch: ch, bx: bx, by: by, dpr: dpr }; },
      zones: function () { var a = []; for (var i = 0; i < NHOLE; i++) a.push(L.hitRect(layout, i)); return a; },
      update: update, render: render, start: startNewGame, whackAt: whackAt, whackHole: whackHole, sprites: SPRITES, fit: fitStage,
      swing: SWING,
      spawn: function (type, hole) {
        var m = L.makeMonster(state, type, hole, Math.random);
        m.phase = 'rise'; m.t = 0;
        state.holes[hole] = m; return m;
      },
      info: function () { return { paused: paused, overTimer: overTimer, best: best, parts: parts.length, texts: texts.length, pending: pending.length, hammers: hammers.length, hidden: document.hidden, mouseHammer: { x: mouseHammer.x, y: mouseHammer.y, visible: mouseHammer.visible, t: mouseHammer.t, dir: mouseHammer.dir } }; },
      freeze: function (b) { debugFrozen = !!b; },
      step: function (dt, n) { for (var i = 0; i < (n || 1); i++) update(dt); render(); },
      // 调试：把锤子在一组时刻的姿势并排画到一个临时画布上（检查"先抬后砸"的时序）
      hammerSheet: function (times, dir) {
        var old = document.getElementById('hammerSheet'); if (old) old.remove();
        var cvs = document.createElement('canvas'), n = times.length, cellW = 190, cellH = 170;
        cvs.id = 'hammerSheet'; cvs.width = n * cellW; cvs.height = cellH;
        cvs.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:linear-gradient(#bfeaa6,#86d08a);width:' + (n * cellW) + 'px;height:' + cellH + 'px';
        document.body.appendChild(cvs);
        var c2 = cvs.getContext('2d'), savedCtx = ctx, savedCw = cw;
        ctx = c2; cw = 100;
        for (var i = 0; i < n; i++) {
          c2.save(); c2.beginPath(); c2.rect(i * cellW, 0, cellW, cellH); c2.clip();
          c2.strokeStyle = 'rgba(0,0,0,.15)'; c2.strokeRect(i * cellW + 0.5, 0.5, cellW - 1, cellH - 1);
          // 敲击点（红十字）
          var px = i * cellW + cellW * 0.4, py = cellH * 0.82;
          c2.strokeStyle = '#d00'; c2.beginPath(); c2.moveTo(px - 8, py); c2.lineTo(px + 8, py); c2.moveTo(px, py - 8); c2.lineTo(px, py + 8); c2.stroke();
          drawHammerAt(px, py, times[i], dir || 1, 1, false);
          c2.fillStyle = '#000'; c2.font = 'bold 12px monospace'; c2.fillText('t=' + times[i].toFixed(3), i * cellW + 6, 14);
          c2.restore();
        }
        ctx = savedCtx; cw = savedCw;
        return n;
      },
      removeSheet: function () { var old = document.getElementById('hammerSheet'); if (old) old.remove(); }
    };
  }
})();
