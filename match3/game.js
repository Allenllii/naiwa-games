/* ============================================================
 *  奶蛙消消乐 · 游戏流程（状态、动画编排、输入、HUD、关卡）
 *
 *  分工：
 *    logic.js   纯规则：识别匹配 / 特殊块 / 下落补充 / 洗牌 / 一次操作的完整连锁结果
 *    render.js  纯绘制：图集、棋盘底座、特效粒子、飘字
 *    game.js    本文件：把 logic 算出的 steps 按时间轴回放成动画，处理输入和关卡
 *
 *  做法：逻辑棋盘 G.board 在 playMove 之后一步到位变成「最终状态」，
 *  画面（cell.vis）则按 steps 一轮一轮回放：块消失、特殊块冒出来、上方的块加速下落 + 落地回弹。
 *  所有等待都走「游戏时钟」(tween/sleep)，标签页隐藏时 rAF 停了，动画自然暂停；
 *  重开时直接清空时钟队列，旧流程里还在等的 await 永远不会再醒来。
 * ============================================================ */
(function () {
  'use strict';

  var Logic = window.Match3Logic, R = window.Match3Render;
  var SIZE = Logic.SIZE, SP = Logic.SP;

  /* ---------------- 可调参数 ---------------- */
  var CFG = {
    SWAP_MS: 170,            // 交换动画时长
    BAD_MS: 115,             // 无效交换：滑过去 / 滑回来各用多久
    HINT_IDLE: 5,            // 闲置多少秒后提示一个可行交换
    CLEAR_MS: 260,           // 单个块的消除动画时长
    GRAVITY: 78,             // 下落加速度（格/秒²）
    MAX_V: 42,               // 下落最大速度（格/秒）
    BOUNCE: 0.27,            // 落地反弹系数
    BOUNCE_MIN_V: 2.4,       // 反弹后速度小于这个值就不再弹
    LAUGH_CHAIN: 4,          // 连锁达到几次触发「全场大笑」
    BONUS_STEP_MS: 95,       // 过关后每转化 1 步奖励的节奏
    DRAG_THRESHOLD: 0.32,    // 拖动超过 0.32 格（且不小于 10px）就算一次滑动：手指轻轻一滑即可，又不易把点按误判成滑动
    BEST_KEY: 'nai_best_match3'
  };
  var IMG = '../assets/nai/';
  var CHAIN_COLORS = ['#ff9f1a', '#ff9f1a', '#ff9f1a', '#ff5c8a', '#b13bff', '#2a8cff'];

  /* ---------------- 小工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  var ease = {
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    inCubic: function (t) { return t * t * t; },
    inOutCubic: function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    outElastic: function (t) { return t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1; }
  };
  function sfx(name, a, b) {                          // 音效缺失 / 出错，游戏照常
    try { var s = window.NaiSFX; if (s && typeof s[name] === 'function') s[name](a, b); } catch (e) { /* ignore */ }
  }
  function setText(node, s) { if (node.textContent !== s) node.textContent = s; }

  var el = {
    stage: $('stage'), wrap: $('stageWrap'), cv: $('cv'), loading: $('loading'), toast: $('toast'),
    overlay: $('overlay'), ovCard: document.querySelector('.ov-card'), ovSprite: $('ovSprite'), ovTitle: $('ovTitle'), ovSub: $('ovSub'), ovScore: $('ovScore'),
    ovBest: $('ovBest'), ovRecord: $('ovRecord'), ovPrimary: $('ovPrimary'), ovSecondary: $('ovSecondary'),
    score: $('score'), best: $('best'), level: $('level'), moves: $('moves'), movesCard: $('movesCard'),
    goalText: $('goalText'), goalBar: $('goalBar'), btnSound: $('btnSound'), btnRestart: $('btnRestart')
  };

  /* ---------------- 游戏状态 ---------------- */
  var G = {
    state: 'loading',        // loading 加载中 / intro 开局入场 / idle 等待操作 / busy 动画中 / over 浮层
    level: 1, score: 0, levelScore: 0, levelStartScore: 0, movesLeft: 0, target: 0,
    best: 0, runStartBest: 0, lastBonus: 0, lastVerdict: '',
    board: null,
    sel: null,               // 当前选中的格 {r,c}
    kb: { r: 3, c: 3 }, kbActive: false,
    hint: null, idle: 0
  };
  var disp = { score: 0, best: 0, levelScore: 0 };       // HUD 上滚动显示的数字
  var sprites = new Set();                               // 所有「在场」的棋子（含正在消失的）
  var clock = 0;                                         // 游戏时钟（秒）

  /* ---------------- 时间轴：tween / sleep ---------------- */
  var tweens = [];
  function tween(ms, fn, easing) {
    return new Promise(function (resolve) {
      tweens.push({ t: 0, d: Math.max(0.001, ms / 1000), fn: fn, ease: easing || null, res: resolve });
    });
  }
  function sleep(ms) { return tween(ms, null); }
  function after(ms, fn) { sleep(ms).then(fn); }
  function updateTweens(dt) {
    for (var i = 0; i < tweens.length;) {
      var tw = tweens[i];
      tw.t += dt;
      var p = Math.min(1, tw.t / tw.d);
      if (tw.fn) tw.fn(tw.ease ? tw.ease(p) : p, p);
      if (p >= 1) { tweens.splice(i, 1); tw.res(); } else i++;
    }
  }

  /* ---------------- 棋子的视觉状态 ---------------- */
  function newVis(x, y) {
    return {
      x: x, y: y, ox: 0, oy: 0, sx: 1, sy: 1, rot: 0, alpha: 1, selT: 0, z: 0, zk: 0,
      vy: 0, falling: false, tgtY: y, landed: true, sq: 0, sqv: 0,          // 下落 / 压扁弹簧
      popOn: false, popT: 1,                                                // 冒出来
      dx: 0, dy: 0, drot: 0, pulse: 0,                                      // 由 tween 驱动的附加偏移
      dying: false, dieAt: 0, dieT: 0, dieStarted: false, merge: null, x0: 0, y0: 0
    };
  }
  function addSprite(cell, x, y) { cell.vis = newVis(x, y); sprites.add(cell); return cell.vis; }

  /* ---------------- 下落 / 落地等待 ---------------- */
  var fallPending = 0, fallWaiters = [];
  function landedOne() {
    fallPending = Math.max(0, fallPending - 1);
    if (fallPending === 0 && fallWaiters.length) { var w = fallWaiters; fallWaiters = []; w.forEach(function (f) { f(); }); }
  }
  function waitLanded() {
    return new Promise(function (resolve) {
      if (fallPending <= 0) { resolve(); return; }
      var done = false;
      fallWaiters.push(function () { done = true; resolve(); });
      after(3500, function () { if (!done) resync(); });   // 保险：万一卡住，3.5 秒后强制归位（正常落地后这里什么也不做）
    });
  }
  // 兜底：以逻辑棋盘为准，把所有棋子的画面状态重置到它们该在的格子里（只在出错/卡住时用）
  function resync() {
    sprites.clear();
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      var cell = G.board && G.board[r][c];
      if (!cell) continue;
      var v = addSprite(cell, c, r);
      v.tgtY = r;
    }
    fallPending = 0;
    var w = fallWaiters; fallWaiters = []; w.forEach(function (f) { f(); });
  }
  function applyDrops(drops) {
    drops.forEach(function (d) {
      var cell = d.cell;
      if (d.isNew || !cell.vis) addSprite(cell, d.c, d.fromR);
      var v = cell.vis;
      v.x = d.c; v.tgtY = d.toR; v.falling = true;
      if (v.landed) { v.landed = false; v.vy = 0; fallPending++; }
    });
  }
  // 落地后的小回弹还在进行时，玩家就开始下一次操作：先让所有块立刻静止，免得物理和交换动画互相打架
  function settleAll() {
    sprites.forEach(function (c) {
      var v = c.vis;
      if (v.dying || !v.falling || !v.landed) return;
      v.falling = false; v.vy = 0; v.y = v.tgtY;
    });
  }

  /* ---------------- 每帧更新一个棋子 ---------------- */
  var selCell = null, hintA = null, hintB = null, hintDir = null;

  function onCellDieStart(cell) {
    var v = cell.vis, x = R.px(v.x), y = R.py(v.y), col = cell.t >= 0 ? R.PLATES[cell.t] : null;
    var colors = col ? [col.glow, '#ffffff', '#ffd23f', col.top] : ['#ff6b6b', '#ffd23f', '#6ec6ff', '#7be06a', '#b13bff', '#fff'];
    R.fx.burst(x, y, v.merge ? 3 : cell.sp ? 12 : 7, { colors: colors, kinds: ['star', 'conf', 'conf'] });
  }
  function onLand(cell, impact) {
    if (impact > 22 && Math.random() < 0.3) {                // 重重落地才扬起一点点灰尘
      var v = cell.vis, x = R.px(v.x), y = R.py(v.y) + R.cs * 0.4;
      R.fx.burst(x, y, 2, { colors: ['rgba(255,244,222,.9)'], kinds: ['dot'], speed: R.cs * 1.4, up: R.cs * 0.5, g: R.cs * 5, size: R.cs * 0.11, life: 0.3 });
    }
  }

  function updateDying(cell, v, dt) {
    v.dieT += dt * 1000;
    if (v.dieT < v.dieAt) return;                       // 还没轮到
    if (!v.dieStarted) { v.dieStarted = true; v.x0 = v.x; v.y0 = v.y; onCellDieStart(cell); }
    var p = Math.min(1, (v.dieT - v.dieAt) / CFG.CLEAR_MS);
    if (v.merge) {                                      // 滑向新特殊块的位置并入
      var k = ease.inCubic(Math.min(1, p / 0.75));
      v.x = lerp(v.x0, v.merge.c, k); v.y = lerp(v.y0, v.merge.r, k);
      v.sx = v.sy = 1 - 0.4 * k; v.alpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
    } else if (p < 0.28) {                              // 先鼓一下
      var u = ease.outCubic(p / 0.28); v.sx = v.sy = 1 + 0.24 * u;
    } else {                                            // 再缩小旋转淡出
      var w = (p - 0.28) / 0.72;
      v.sx = v.sy = 1.24 * (1 - ease.inCubic(w)); v.rot = w * 0.8; v.alpha = 1 - Math.max(0, (w - 0.45) / 0.55);
    }
    v.ox = v.oy = 0; v.z = 3;
    if (p >= 1) sprites.delete(cell);
  }

  function updateCell(cell, dt) {
    var v = cell.vis;
    if (v.dying) { updateDying(cell, v, dt); return; }

    // 下落：重力加速 → 触地 → 回弹 → 再落地
    if (v.falling) {
      v.vy = Math.min(CFG.MAX_V, v.vy + CFG.GRAVITY * dt);
      v.y += v.vy * dt;
      if (v.y >= v.tgtY) {
        var impact = v.vy;
        v.y = v.tgtY;
        if (!v.landed) { v.landed = true; onLand(cell, impact); landedOne(); }
        if (impact * CFG.BOUNCE > CFG.BOUNCE_MIN_V) { v.vy = -impact * CFG.BOUNCE; v.sqv = Math.min(5.8, impact * 0.27); }
        else { v.vy = 0; v.falling = false; v.sqv += Math.min(2.2, impact * 0.1); }
      }
    }
    // 压扁弹簧（落地时 sq>0 = 压扁，然后弹回）
    v.sqv += (-520 * v.sq - 17 * v.sqv) * dt; v.sq += v.sqv * dt;
    if (!v.falling && Math.abs(v.sq) < 0.001 && Math.abs(v.sqv) < 0.01) { v.sq = 0; v.sqv = 0; }

    var sx = 1, sy = 1, ox = v.dx, oy = v.dy, rot = v.drot;
    if (v.falling && v.vy > 4) { var st = Math.min(0.17, (v.vy - 4) * 0.006); sy += st; sx -= st * 0.6; }   // 下落中拉长
    sy -= v.sq * 0.9; sx += v.sq * 0.65;                                                                  // 落地压扁
    if (v.popOn) {
      v.popT = Math.min(1, v.popT + dt / 0.55);
      var pk = ease.outElastic(v.popT); sx *= pk; sy *= pk;
      if (v.popT >= 1) v.popOn = false;
    }
    sx += v.pulse; sy += v.pulse;

    // 选中：抬起 + 呼吸
    var selTarget = cell === selCell ? 1 : 0;
    v.selT += (selTarget - v.selT) * Math.min(1, dt * 14);
    if (v.selT > 0.01) { var s = 1 + (0.1 + 0.025 * Math.sin(clock * 10)) * v.selT; sx *= s; sy *= s; }

    // 提示：两个块互相探头
    if (hintDir && (cell === hintA || cell === hintB)) {
      var hk = (clock - G.hint.t0) % 1.8;
      if (hk < 1.0) {
        var amp = Math.sin(hk / 1.0 * Math.PI), dir = cell === hintA ? hintDir : { r: -hintDir.r, c: -hintDir.c };
        ox += dir.c * 0.14 * amp; oy += dir.r * 0.14 * amp; sx += 0.07 * amp; sy += 0.07 * amp;
        rot += Math.sin(hk * 16) * 0.05 * amp;
      }
    }
    // 全场大笑：所有块一起抖
    var env = R.fx.laughEnv();
    if (env > 0) {
      ox += Math.sin(clock * 41 + cell.id * 1.7) * 0.045 * env; oy += Math.sin(clock * 37 + cell.id * 2.3) * 0.035 * env;
      rot += Math.sin(clock * 33 + cell.id) * 0.13 * env;
    }
    v.sx = sx; v.sy = sy; v.ox = ox; v.oy = oy; v.rot = rot;
    v.z = Math.max(v.zk, v.popOn ? 2.5 : 0, v.selT > 0.05 ? 1 : 0);      // 层级：交换中 > 冒出来 > 选中 > 普通
  }

  function updateCells(dt) {
    selCell = G.sel && G.board ? G.board[G.sel.r][G.sel.c] : null;
    hintA = hintB = hintDir = null;
    if (G.hint && G.board) {
      hintA = G.board[G.hint.a.r][G.hint.a.c]; hintB = G.board[G.hint.b.r][G.hint.b.c];
      hintDir = { r: G.hint.b.r - G.hint.a.r, c: G.hint.b.c - G.hint.a.c };
    }
    sprites.forEach(function (c) { updateCell(c, dt); });
  }

  /* ---------------- HUD ---------------- */
  var toastTimer = 0;
  function toast(html, ms) {
    el.toast.innerHTML = html;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, ms || 1800);
  }
  function loadBest() {
    try { var v = parseInt(window.localStorage.getItem(CFG.BEST_KEY), 10); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  function saveBest() { try { window.localStorage.setItem(CFG.BEST_KEY, String(G.best)); } catch (e) { /* 存储不可用就算了 */ } }

  function addScore(n) {
    G.score += n; G.levelScore += n;
    if (G.score > G.best) { G.best = G.score; saveBest(); }
  }
  var lastMovesShown = -1;
  function updateHUD(dt) {
    var k = Math.min(1, dt * 9);
    disp.score += (G.score - disp.score) * k; if (Math.abs(G.score - disp.score) < 1) disp.score = G.score;
    disp.best += (G.best - disp.best) * k; if (Math.abs(G.best - disp.best) < 1) disp.best = G.best;
    disp.levelScore += (G.levelScore - disp.levelScore) * k; if (Math.abs(G.levelScore - disp.levelScore) < 1) disp.levelScore = G.levelScore;
    setText(el.score, String(Math.round(disp.score)));
    setText(el.best, String(Math.round(disp.best)));
    setText(el.level, String(G.level));
    setText(el.moves, String(G.movesLeft));
    if (G.movesLeft !== lastMovesShown) {
      lastMovesShown = G.movesLeft;
      el.moves.classList.remove('bump'); void el.moves.offsetWidth; el.moves.classList.add('bump');
      el.movesCard.classList.toggle('low', G.movesLeft > 0 && G.movesLeft <= 3);
    }
    setText(el.goalText, Math.round(disp.levelScore) + ' / ' + G.target);
    var pct = (G.target ? clamp(G.levelScore / G.target * 100, 0, 100) : 0).toFixed(1) + '%';
    if (pct !== lastPct) { lastPct = pct; el.goalBar.style.width = pct; }
    var done = G.target > 0 && G.levelScore >= G.target;
    if (done !== lastDone) { lastDone = done; el.goalBar.parentNode.classList.toggle('done', done); }
  }
  var lastPct = '', lastDone = false;
  function syncSoundBtn() {
    var m = false;
    try { m = !!(window.NaiSFX && window.NaiSFX.isMuted && window.NaiSFX.isMuted()); } catch (e) { /* ignore */ }
    el.btnSound.innerHTML = (m ? '🔇' : '🔊') + ' <span class="t">' + (m ? '音效关' : '音效开') + '</span>';
    el.btnSound.setAttribute('aria-pressed', m ? 'true' : 'false');
  }

  /* ---------------- 浮层（过关 / 步数用完） ---------------- */
  function showOverlay(kind) {
    var win = kind === 'win';
    G.state = 'over'; G.lastVerdict = kind;
    var sprite = IMG + (win ? 'nai11-god' : 'nai10-laugh') + '.webp';
    if (el.ovSprite.getAttribute('src') !== sprite) { el.ovSprite.style.visibility = ''; el.ovSprite.src = sprite; }
    setText(el.ovTitle, win ? '过关！' : '步数用完');
    var line = '第 ' + G.level + ' 关 · 本关 ' + G.levelScore + ' / ' + G.target;
    if (win) line += G.lastBonus ? ' · 剩余步数奖励 +' + G.lastBonus : '';
    else line += '，就差 ' + Math.max(0, G.target - G.levelScore) + ' 分！';
    setText(el.ovSub, line);
    setText(el.ovScore, String(G.score));
    setText(el.ovBest, String(G.best));
    el.ovRecord.hidden = !(G.best > G.runStartBest);          // 本局把最高分刷新了才提示新纪录
    setText(el.ovPrimary, win ? '下一关 ▶' : '再来一局');
    el.ovSecondary.hidden = win;
    setText(el.ovSecondary, '从第 1 关重新开始');
    el.overlay.classList.add('show'); el.overlay.setAttribute('aria-hidden', 'false');
    fitOverlayCard();
    try { el.ovPrimary.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  // 浮层卡片太高 / 太宽（小屏、手机横屏）时整体缩小到装得下，保证按钮永远点得到
  function fitOverlayCard() {
    var card = el.ovCard;
    card.style.setProperty('--fit', '1');
    var h = card.offsetHeight || 1, w = card.offsetWidth || 1;
    var k = Math.min(1, el.overlay.clientHeight * 0.95 / h, el.overlay.clientWidth * 0.96 / w);
    card.style.setProperty('--fit', k.toFixed(3));
  }
  function hideOverlay() {
    el.overlay.classList.remove('show'); el.overlay.setAttribute('aria-hidden', 'true');
    if (document.activeElement && el.overlay.contains(document.activeElement)) document.activeElement.blur();
  }

  /* ---------------- 关卡流程 ---------------- */
  function resetWorld() {
    tweens.length = 0; sprites.clear(); fallPending = 0; fallWaiters = [];
    R.fx.clear(); G.sel = null; G.hint = null; G.idle = 0; selCell = hintA = hintB = null;
    el.toast.classList.remove('show');
  }
  function startRun() {                                  // 从第 1 关开始一整局
    resetWorld(); hideOverlay();
    G.level = 1; G.score = 0; G.runStartBest = G.best; disp.score = 0;
    startLevel(1);
  }
  function retryLevel() {                                // 重试当前关：分数回到本关开始时
    resetWorld(); hideOverlay();
    G.score = G.levelStartScore; disp.score = G.score;
    startLevel(G.level);
  }
  function nextLevel() {
    resetWorld(); hideOverlay();
    G.level += 1;
    startLevel(G.level);
  }
  function startLevel(n) {
    var cfg = Logic.levelConfig(n);
    G.level = n; G.target = cfg.target; G.movesLeft = cfg.moves; G.levelScore = 0; G.levelStartScore = G.score;
    disp.levelScore = 0; G.lastBonus = 0; lastMovesShown = -1;
    G.board = Logic.generateBoard(Math.random);
    // 开局入场：整盘奶蛙从上方依次落下
    var drops = [];
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      drops.push({ cell: G.board[r][c], c: c, fromR: r - SIZE - 1.2 - c * 0.7 - (SIZE - r) * 0.12, toR: r, isNew: true });
    }
    applyDrops(drops);
    G.state = 'intro';
    toast('第 ' + n + ' 关 · ' + cfg.moves + ' 步拿到 ' + cfg.target + ' 分' + (n === 1 ? '<small>点一个奶蛙，再点相邻的交换；也可以直接拖过去</small>' : ''), n === 1 ? 3600 : 2200);
    waitLanded().then(function () { if (G.state === 'intro') { G.state = 'idle'; resetIdle(); } });
  }

  function resetIdle() { G.idle = 0; G.hint = null; }

  /* ---------------- 一次操作：交换 → 回放消除 → 判定 ---------------- */
  function trySwap(a, b) {
    if (G.state !== 'idle') return;
    G.sel = null; resetIdle();
    doMove(a, b);
  }

  async function doMove(a, b) {
    G.state = 'busy';
    settleAll();
    var ca = G.board[a.r][a.c], cb = G.board[b.r][b.c];
    var res = Logic.playMove(G.board, a, b, Math.random);
    try {
      if (!res.valid) {
        sfx('swap');
        await badSwap(ca, cb, a, b);
        G.state = 'idle'; resetIdle();
        return;
      }
      G.movesLeft -= 1;
      sfx('swap');
      await swapAnim(ca, cb, a, b);
      for (var i = 0; i < res.steps.length; i++) await playStep(res.steps[i]);
      if (res.shuffle) await playShuffle(res.shuffle);
      await afterMove();
    } catch (err) {
      if (window.console) console.error(err);
      resync(); G.state = 'idle'; resetIdle();
    }
  }

  async function swapAnim(ca, cb, a, b) {
    var va = ca.vis, vb = cb.vis, ax = a.c, ay = a.r, bx = b.c, by = b.r;
    va.zk = 2; vb.zk = 1.9;
    await tween(CFG.SWAP_MS, function (p, raw) {
      va.x = lerp(ax, bx, p); va.y = lerp(ay, by, p); vb.x = lerp(bx, ax, p); vb.y = lerp(by, ay, p);
      var s = Math.sin(raw * Math.PI); va.pulse = 0.14 * s; vb.pulse = 0.05 * s;
    }, ease.inOutCubic);
    // 交换完成：位置、落点(tgtY)都要同步到新格子，否则之后的归位会把它拉回旧位置
    va.x = bx; va.y = by; va.tgtY = by; vb.x = ax; vb.y = ay; vb.tgtY = ay;
    va.pulse = vb.pulse = 0; va.zk = vb.zk = 0;
  }

  async function badSwap(ca, cb, a, b) {
    var va = ca.vis, vb = cb.vis, ax = a.c, ay = a.r, bx = b.c, by = b.r;
    va.zk = 2; vb.zk = 1.9;
    await tween(CFG.BAD_MS, function (p, raw) {
      va.x = lerp(ax, bx, p); va.y = lerp(ay, by, p); vb.x = lerp(bx, ax, p); vb.y = lerp(by, ay, p);
      va.pulse = 0.1 * Math.sin(raw * Math.PI);
    }, ease.outCubic);
    sfx('bad');
    await tween(CFG.BAD_MS, function (p) {
      va.x = lerp(bx, ax, p); va.y = lerp(by, ay, p); vb.x = lerp(ax, bx, p); vb.y = lerp(ay, by, p);
    }, ease.inOutCubic);
    va.x = ax; va.y = ay; vb.x = bx; vb.y = by; va.pulse = 0; va.zk = vb.zk = 0;
    // 换回去之后轻微抖动（不阻塞后续操作）
    tween(260, function (p, raw) {
      var k = Math.sin(raw * 24) * (1 - raw) * 0.085;
      va.dx = k; vb.dx = -k; va.drot = k * 0.7; vb.drot = -k * 0.7;
      if (raw >= 1) { va.dx = vb.dx = 0; va.drot = vb.drot = 0; }
    });
  }

  /* ---------- 回放一轮消除 ---------- */
  function chainText(chain) {
    var x = R.W / 2, y = R.by + R.cs * 2.6, big = clamp(0.72 + 0.07 * chain, 0.8, 1.25);
    R.fx.text('连消 x' + chain, x, y, { size: R.cs * big, fill: CHAIN_COLORS[Math.min(chain, CHAIN_COLORS.length - 1)], rainbow: chain >= 5, life: 1.15, rot: -0.06 });
  }
  function bigLaugh() {
    R.fx.bigLaugh(); R.fx.shake(R.cs * 0.22); R.fx.flash(0.25);
  }
  function spawnSpecial(s) {
    var v = addSprite(s.cell, s.c, s.r), x = R.px(s.c), y = R.py(s.r);
    v.popOn = true; v.popT = 0; v.sx = v.sy = 0; v.z = 2.5;
    R.fx.ring(x, y, { r1: R.cs * 1.25, color: '#ffd23f', life: 0.4, fill: 0.28, w: R.cs * 0.1 });
    R.fx.burst(x, y, 12, { colors: ['#ffd23f', '#fff', '#ff8fb8', '#7be06a', '#6ec6ff'], kinds: ['star', 'star', 'conf'] });
    var name = s.cell.sp === SP.RAINBOW ? '彩虹块！' : s.cell.sp === SP.BOMB ? '炸弹块！' : '条纹块！';
    R.fx.text(name, x, y - R.cs * 0.75, { size: R.cs * 0.38, fill: '#ff6b6b', life: 0.95 });
    sfx('good', s.cell.sp === SP.RAINBOW ? 6 : 3);
  }
  function fireEffect(ef) {
    var cs = R.cs, x = R.px(ef.c), y = R.py(ef.r), i;
    switch (ef.kind) {
      case 'stripeH': R.fx.beam(true, ef.r, { color: '#ffb23c' }); R.fx.shake(cs * 0.1); sfx('pop'); break;
      case 'stripeV': R.fx.beam(false, ef.c, { color: '#ffb23c' }); R.fx.shake(cs * 0.1); sfx('pop'); break;
      case 'bomb':
        R.fx.ring(x, y, { r1: cs * 2.0, color: '#ff8a3c', life: 0.45 });
        R.fx.burst(x, y, 16, { colors: ['#ff8a3c', '#ffd23f', '#fff', '#ff5c5c'], kinds: ['star', 'dot'], speed: cs * 5.5 });
        R.fx.shake(cs * 0.22); sfx('boing'); break;
      case 'cross':
        R.fx.beam(true, ef.r, { color: '#ffb23c' }); R.fx.beam(false, ef.c, { color: '#ffb23c' });
        R.fx.ring(x, y, { r1: cs * 2.2, color: '#ffb23c' }); R.fx.shake(cs * 0.3); sfx('boing'); break;
      case 'fatCross':
        R.fx.beam(true, ef.r, { color: '#ff8a3c', width: 3 }); R.fx.beam(false, ef.c, { color: '#ff8a3c', width: 3 });
        R.fx.ring(x, y, { r1: cs * 2.8, color: '#ff8a3c' }); R.fx.shake(cs * 0.4); sfx('boing'); break;
      case 'bigBomb':
        R.fx.ring(x, y, { r1: cs * 3.6, color: '#ff6b3d', life: 0.55 }); R.fx.ring(x, y, { r1: cs * 2.2, color: '#ffd23f', life: 0.4 });
        R.fx.burst(x, y, 26, { colors: ['#ff8a3c', '#ffd23f', '#fff', '#ff5c5c'], kinds: ['star', 'dot', 'conf'], speed: cs * 7 });
        R.fx.flash(0.5); R.fx.shake(cs * 0.5); sfx('boing'); break;
      case 'rainbowAll':
        R.fx.flash(0.95); R.fx.ring(x, y, { r1: cs * 6, color: '#b13bff', life: 0.7 });
        R.fx.burst(R.W / 2, R.H / 2, 40, { colors: ['#ff6b6b', '#ffd23f', '#6ec6ff', '#7be06a', '#b13bff', '#fff'], kinds: ['star', 'conf'], speed: cs * 9 });
        R.fx.shake(cs * 0.55); sfx('boing'); break;
      default:   // rainbow / rainbowColor / rainbowStripe / rainbowBomb：闪电连到每个目标
        (ef.targets || []).forEach(function (t, n) {
          after(n * 16, function () { R.fx.bolt(x, y, R.px(t.c), R.py(t.r), { color: ['#b13bff', '#2a8cff', '#ff5c8a'][n % 3] }); });
        });
        R.fx.ring(x, y, { r1: cs * 1.8, color: '#b13bff' }); R.fx.flash(0.35); R.fx.shake(cs * 0.2); sfx('boing');
    }
  }

  async function playStep(step) {
    var cs = R.cs, chain = step.chain;
    sfx('clear', chain);
    if (chain >= 2) { sfx('laugh', Math.min(1, (chain - 1) / 4)); chainText(chain); }
    if (chain >= CFG.LAUGH_CHAIN) bigLaugh();

    // 彩虹 + 条纹/炸弹：同色普通块先变身（原地换成特殊块，再依次引爆）
    step.transforms.forEach(function (t) {
      var ov = t.from.vis, nv;
      sprites.delete(t.from);
      nv = addSprite(t.to, ov ? ov.x : t.c, ov ? ov.y : t.r);
      nv.popOn = true; nv.popT = 0; nv.sx = nv.sy = 0; nv.z = 2.5;
      R.fx.burst(R.px(t.c), R.py(t.r), 5, { kinds: ['star'], colors: ['#fff', '#ffd23f'] });
    });

    // 标记要消除的块（带各自的开始时刻）
    var maxAt = 0, sr = 0, sc = 0, n = 0;
    step.cleared.forEach(function (e) {
      var v = e.cell.vis;
      if (!v) return;
      if (!v.landed) { v.landed = true; landedOne(); }          // 还在等落地的块被消掉：别让落地计数卡住
      v.dying = true; v.dieAt = e.at; v.dieT = 0; v.dieStarted = false; v.merge = e.merge; v.z = 3; v.falling = false;
      maxAt = Math.max(maxAt, e.at); sr += e.r; sc += e.c; n++;
    });
    // 特效 / 新特殊块 按各自时刻触发
    step.effects.forEach(function (ef) { after(ef.at, function () { fireEffect(ef); }); });
    var lastSpawn = 0;
    step.spawns.forEach(function (s) { lastSpawn = Math.max(lastSpawn, s.at); after(s.at, function () { spawnSpecial(s); }); });

    // 得分 + 飘字
    addScore(step.gained);
    if (n) {
      R.fx.text('+' + step.gained, R.px(sc / n), R.py(sr / n) - cs * 0.2, {
        size: cs * clamp(0.4 + n * 0.012 + chain * 0.04, 0.4, 0.78), fill: chain >= 2 ? CHAIN_COLORS[Math.min(chain, 5)] : '#ff6b6b', life: 0.9
      });
    }

    await sleep(Math.max(maxAt + CFG.CLEAR_MS * 0.55, lastSpawn + 140));
    applyDrops(step.drops);
    await waitLanded();
  }

  async function playShuffle(sh) {
    toast('没有能换的啦，奶蛙们重新站队～', 1700);
    sfx('boing');
    var items = sh.moves.map(function (m) {
      return { v: m.cell.vis, x0: m.from.c, y0: m.from.r, x1: m.to.c, y1: m.to.r, h: 0.5 + Math.random() * 0.7 };
    }).filter(function (it) { return it.v; });
    items.forEach(function (it) { it.v.z = 2; it.v.falling = false; });
    await tween(680, function (p, raw) {
      var s = Math.sin(raw * Math.PI);
      items.forEach(function (it) {
        it.v.x = lerp(it.x0, it.x1, p); it.v.y = lerp(it.y0, it.y1, p) - s * it.h;
        it.v.pulse = 0.1 * s; it.v.drot = Math.sin(raw * Math.PI * 2) * 0.18;
      });
    }, ease.inOutCubic);
    items.forEach(function (it) { it.v.x = it.x1; it.v.y = it.y1; it.v.tgtY = it.y1; it.v.z = 0; it.v.pulse = 0; it.v.drot = 0; });
    R.fx.shake(R.cs * 0.12);
  }

  async function afterMove() {
    var verdict = Logic.judgeLevel(G.levelScore, G.target, G.movesLeft);
    if (verdict === 'win') { await winLevel(); return; }
    if (verdict === 'lose') { await loseLevel(); return; }
    G.state = 'idle'; resetIdle();
  }

  async function winLevel() {
    var cs = R.cs, bonus = 0, i = 0;
    R.fx.text('目标达成！', R.W / 2, R.by + cs * 3.2, { size: cs * 1.0, rainbow: true, life: 1.6 });
    R.fx.burst(R.W / 2, R.H / 2, 36, { colors: ['#ff6b6b', '#ffd23f', '#6ec6ff', '#7be06a', '#b13bff'], kinds: ['star', 'conf'], speed: cs * 8 });
    sfx('good', 5);
    await sleep(650);
    while (G.movesLeft > 0) {                           // 剩余步数 → 奖励分，一步一步转化
      G.movesLeft -= 1; i++;
      bonus += Logic.CFG.movesBonus; addScore(Logic.CFG.movesBonus);
      var x = R.W * (0.25 + Math.random() * 0.5), y = R.by + cs * (2.5 + Math.random() * 3);
      R.fx.text('+' + Logic.CFG.movesBonus, x, y, { size: cs * 0.5, fill: '#e79a1f', life: 0.8 });
      R.fx.burst(x, y, 5, { kinds: ['star'], colors: ['#ffd23f', '#fff'] });
      sfx('good', Math.min(8, i));
      await sleep(CFG.BONUS_STEP_MS);
    }
    G.lastBonus = bonus;
    await sleep(500);
    sfx('win');
    showOverlay('win');
  }
  async function loseLevel() {
    await sleep(500);
    sfx('lose');
    showOverlay('lose');
  }

  /* ---------------- 输入：指针（鼠标 / 触屏）----------------
   * 点选一个再点相邻的 = 交换；按住拖向相邻格 = 滑动交换。 */
  var drag = null;
  function canvasPos(e) {
    var r = el.cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (R.W / (r.width || 1)), y: (e.clientY - r.top) * (R.H / (r.height || 1)) };
  }
  function adjacent(a, b) { return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1; }
  function sameCell(a, b) { return !!a && !!b && a.r === b.r && a.c === b.c; }

  var sfxReady = false;
  function sfxInit() { sfx('init'); sfxReady = true; }

  function onPointerDown(e) {
    sfxInit();
    G.kbActive = false;
    if (G.state !== 'idle') return;
    var p = canvasPos(e), cell = R.cellAt(p.x, p.y);
    if (!cell) return;
    e.preventDefault();
    try { el.cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    resetIdle();
    el.toast.classList.remove('show');                    // 开始操作了，关卡提示就别挡着棋盘了
    drag = { id: e.pointerId, r: cell.r, c: cell.c, x0: p.x, y0: p.y, moved: false, wasSelected: sameCell(G.sel, cell) };
    if (G.sel && !sameCell(G.sel, cell)) {
      if (adjacent(G.sel, cell)) { var a = G.sel; drag.moved = true; trySwap(a, cell); return; }
      G.sel = cell; sfx('click');                         // 不相邻：改选这一个
    } else if (!G.sel) { G.sel = cell; sfx('click'); }
  }
  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.id || drag.moved) return;
    var p = canvasPos(e), dx = p.x - drag.x0, dy = p.y - drag.y0, th = Math.max(10, R.cs * CFG.DRAG_THRESHOLD);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < th) return;
    drag.moved = true;
    var t = Math.abs(dx) > Math.abs(dy) ? { r: drag.r, c: drag.c + (dx > 0 ? 1 : -1) } : { r: drag.r + (dy > 0 ? 1 : -1), c: drag.c };
    if (Logic.inBounds(t.r, t.c) && G.state === 'idle') trySwap({ r: drag.r, c: drag.c }, t);
  }
  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && drag.wasSelected && G.state === 'idle') { G.sel = null; sfx('click'); }
    drag = null;
  }

  /* ---------------- 输入：键盘 ----------------
   * R 重开 / M 静音 / 方向键移动光标 / 空格·回车选中 / 选中后按方向键 = 向那个方向交换 / Esc 取消 */
  var DIRS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1], W: [-1, 0], S: [1, 0], A: [0, -1], D: [0, 1] };
  function onKeyDown(e) {
    sfxInit();
    var k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'r' || k === 'R') { e.preventDefault(); restart(); return; }
    if (k === 'm' || k === 'M') { toggleSound(); return; }
    var onBtn = e.target && e.target.closest && e.target.closest('button, a');
    if (onBtn && (k === 'Enter' || k === ' ')) return;     // 让按钮自己处理
    if (G.state !== 'idle') return;
    if (k === 'Escape') { G.sel = null; return; }
    var d = DIRS[k];
    if (d) {
      e.preventDefault(); resetIdle();
      if (!G.kbActive) { G.kbActive = true; if (!G.sel) return; }
      if (G.sel) {                                          // 已选中：朝方向交换
        var t = { r: G.sel.r + d[0], c: G.sel.c + d[1] };
        if (Logic.inBounds(t.r, t.c)) { var a = G.sel; G.kb = { r: t.r, c: t.c }; trySwap(a, t); }
        return;
      }
      G.kb = { r: clamp(G.kb.r + d[0], 0, SIZE - 1), c: clamp(G.kb.c + d[1], 0, SIZE - 1) };
      return;
    }
    if (k === ' ' || k === 'Enter') {
      e.preventDefault(); resetIdle();
      if (!G.kbActive) { G.kbActive = true; return; }
      var cur = { r: G.kb.r, c: G.kb.c };
      if (!G.sel) { G.sel = cur; sfx('click'); }
      else if (sameCell(G.sel, cur)) { G.sel = null; sfx('click'); }
      else if (adjacent(G.sel, cur)) { var s0 = G.sel; trySwap(s0, cur); }
      else { G.sel = cur; sfx('click'); }
    }
  }

  function toggleSound() {
    try { window.NaiSFX && window.NaiSFX.toggleMuted && window.NaiSFX.toggleMuted(); } catch (e) { /* ignore */ }
    syncSoundBtn(); sfx('click');
  }
  function restart() { sfxInit(); startRun(); }

  /* ---------------- 主循环 / 布局 ---------------- */
  var rafId = 0, last = 0, running = false;
  function updateIdle(dt) {
    if (G.state !== 'idle' || G.hint || !G.board) return;
    G.idle += dt;
    if (G.idle >= CFG.HINT_IDLE) {
      var h = Logic.pickHint(G.board, Math.random);
      if (h) G.hint = { a: h.a, b: h.b, t0: clock };
      G.idle = 0;
    }
  }
  function tick(dt) {
    clock += dt;
    updateTweens(dt);
    updateIdle(dt);
    updateCells(dt);
    R.fx.update(dt);
    updateHUD(dt);
    R.draw({ cells: Array.from(sprites), kb: (G.kbActive && G.state === 'idle') ? G.kb : null, clock: clock });
  }
  // 自适应画质：连续一段时间帧率低于 ~35fps，就把粒子数量降到 40%（低端手机上全场大笑也不卡）
  var slowFrames = 0, qualityDropped = false, loopErrLogged = false;
  function watchPerf(rawDt) {
    if (qualityDropped || rawDt > 0.25) return;           // 切回标签页那种超长帧不算
    slowFrames = rawDt > 0.029 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
    if (slowFrames > 40) { qualityDropped = true; R.fx.quality = 0.4; }
  }
  function frame(now) {
    rafId = requestAnimationFrame(frame);
    var raw = (now - last) / 1000;
    watchPerf(raw);
    var dt = clamp(raw, 0, 0.05);                        // 钳住：切回标签页时不会一下子跳很多
    last = now;
    try { tick(dt); } catch (err) {                      // 单帧出错不能让整个循环死掉；只记一次日志，免得刷屏
      if (!loopErrLogged && window.console) { loopErrLogged = true; console.error(err); }
    }
  }
  function startLoop() { if (running) return; running = true; last = performance.now(); rafId = requestAnimationFrame(frame); }
  function stopLoop() { running = false; cancelAnimationFrame(rafId); }

  function drawMinis() {
    R.drawMini($('miniStripe'), 2, SP.STRIPE_H);
    R.drawMini($('miniBomb'), 0, SP.BOMB);
    R.drawMini($('miniRainbow'), 0, SP.RAINBOW);
  }
  var fitTimer = 0;
  function fit() {
    fitTimer = 0;
    var r = el.wrap.getBoundingClientRect();
    var s = Math.max(160, Math.floor(Math.min(r.width, r.height)));
    var dpr = Math.min(2, window.devicePixelRatio || 1);     // 高分屏最多按 2 倍渲染：3 倍屏的手机也不会因为像素太多掉帧
    if (s === R.W && dpr === R.dpr) return;
    el.stage.style.width = s + 'px'; el.stage.style.height = s + 'px';
    R.resize(s, dpr);
    if (R.ready) drawMinis();
    if (el.overlay.classList.contains('show')) fitOverlayCard();
  }
  // 尺寸变化时合并成一次重算（用定时器而不是 rAF：页面不可见/被节流时布局也能及时更新）
  function queueFit() { if (!fitTimer) fitTimer = setTimeout(fit, 30); }

  /* ---------------- 启动 ---------------- */
  function init() {
    R.init(el.cv);
    fit();
    G.best = loadBest(); disp.best = G.best;
    syncSoundBtn();

    el.cv.addEventListener('pointerdown', onPointerDown);
    el.cv.addEventListener('pointermove', onPointerMove);
    el.cv.addEventListener('pointerup', onPointerUp);
    el.cv.addEventListener('pointercancel', onPointerUp);
    el.cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.stage.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    // 音频解锁：iOS / 微信要求在「用户手势」里才能出声，且 pointerdown 在部分 iOS 上不算解锁手势，
    // 所以 pointerdown / pointerup / touchend / click / keydown 都顺手调一次 NaiSFX.init()（幂等：已初始化只是尝试 resume）
    ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, sfxInit, { capture: true, passive: true });
    });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', queueFit);
    window.addEventListener('orientationchange', queueFit);
    if (window.ResizeObserver) { try { new ResizeObserver(queueFit).observe(el.wrap); } catch (e) { /* ignore */ } }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopLoop(); else startLoop(); });

    function pressed(btn, fn) {
      btn.addEventListener('click', function (e) { sfxInit(); fn(e); if (e.detail > 0) btn.blur(); });
    }
    pressed(el.btnSound, toggleSound);
    pressed(el.btnRestart, function () { sfx('click'); restart(); });
    pressed(el.ovPrimary, function () { sfx('click'); if (G.lastVerdict === 'win') nextLevel(); else retryLevel(); });
    pressed(el.ovSecondary, function () { sfx('click'); restart(); });
    $('btnHome').addEventListener('click', function () { sfxInit(); sfx('click'); });

    startLoop();
    R.loadImages().then(function () {
      R.start();
      drawMinis();
      el.loading.classList.add('hide');
      startRun();
    });
  }

  // 调试 / 自动化测试用入口（页面本身不依赖它）
  window.__nm3 = {
    G: G, sprites: sprites, Logic: Logic, R: R,
    advance: async function (ms) {                       // 手动推进游戏时钟（后台标签页 rAF 被暂停时也能测）
      for (var t = 0; t < ms; t += 16) { tick(0.016); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
    },
    tick: tick, trySwap: trySwap, restart: restart, nextLevel: nextLevel, retryLevel: retryLevel,
    setBoard: function (board) {                          // 直接换盘面（测试特殊块用）：所有块原地静止
      sprites.clear(); fallPending = 0; fallWaiters = []; G.board = board; G.sel = null; resetIdle();
      for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) addSprite(board[r][c], c, r);
      G.state = 'idle';
    },
    addScore: addScore, resync: resync, playShuffle: playShuffle, fit: fit
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
