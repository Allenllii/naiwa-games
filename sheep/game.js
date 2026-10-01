/* 奶了个奶 · 主控：输入、界面（数据卡/道具/浮层）、主循环、把引擎事件翻译成动画+音效 */
(function () {
  'use strict';
  var L = window.SheepLogic, E = window.SheepEngine, V = window.SheepView, FX = window.SheepFX;

  // ===================== 关键常量（调参入口）=====================
  var BEST_KEY = 'nai_best_sheep';
  var FLY_TIME = 0.3;                 // 牌飞进槽的时间（秒）
  var LAUGH = ['哦齁齁齁~', '哈哈哈！', '齁齁齁！', '笑死~', '奶~']; // 消除时冒的笑声

  // ===================== 工具 =====================
  function $(id) { return document.getElementById(id); }
  function sfx(name, a, b) {                                   // 音效缺失也能玩
    try { var s = window.NaiSFX; if (s && typeof s[name] === 'function') s[name](a, b); } catch (e) {}
  }
  function loadBest() {
    try { var v = parseInt(window.localStorage.getItem(BEST_KEY), 10); return isFinite(v) && v > 0 ? v : 0; } catch (e) { return 0; }
  }
  function saveBest(v) { try { window.localStorage.setItem(BEST_KEY, String(v)); } catch (e) {} }
  function rndSeed() { return (Math.random() * 4294967296) >>> 0; }

  var stage = $('stage'), cv = $('cv'), powerbar = $('powerbar'), overlay = $('overlay'), hintEl = $('hint');
  var ctx = cv.getContext('2d');
  var hud = { level: $('hudLevel'), left: $('hudLeft'), score: $('hudScore'), best: $('hudBest') }, hudVals = {};
  var powerBtns = [].slice.call(document.querySelectorAll('.pw'));

  // ===================== 状态 =====================
  var best = loadBest(), bestAtRunStart = best;
  var run = { level: 1, scoreStart: 0, seed: rndSeed() };
  var eng = null, time = 0, paused = false, lastTs = 0, hoverId = -1;
  var timers = [], queuedPower = null, overlayOpen = false, sfxReady = false, drawNext = true, hintShown = false;

  function later(sec, fn) { timers.push({ at: time + sec, fn: fn }); }
  // 音频必须在用户手势里启动：第一次 pointerdown/touchstart/keydown 调一次 init；
  // 手机（iOS/微信）要等手势“结束”才算数，所以第一次 pointerup/touchend/click 时再补调一次（只此两次）
  var initCalls = 0;
  function callInit() { try { if (window.NaiSFX && NaiSFX.init) NaiSFX.init(); } catch (e) {} }
  function sfxInit() { if (initCalls >= 1) return; initCalls = 1; sfxReady = true; callInit(); }
  function sfxInit2() { if (initCalls >= 2) return; initCalls = 2; sfxReady = true; callInit(); }

  // ===================== 数据卡 =====================
  function setHud(key, val, noPop) {
    if (hudVals[key] === val) return;
    var first = hudVals[key] === undefined;
    hudVals[key] = val;
    var el = hud[key]; el.textContent = val;
    if (!first && !noPop) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }
  function updateHud() {
    if (!eng) return;
    setHud('level', eng.level.level); setHud('left', eng.boardCount() + eng.temp.length);   // 还没入槽的牌（场上 + 暂存区）
    setHud('score', eng.score); setHud('best', best);
  }
  function syncBest() { if (eng && eng.score > best) { best = eng.score; saveBest(best); } }
  function refreshPower() {
    powerBtns.forEach(function (b) {
      var used = eng ? eng.used[b.dataset.pw] : false;
      b.classList.toggle('used', used); b.disabled = used;
    });
  }
  function updateSoundBtn() {
    var m = false; try { m = !!(window.NaiSFX && NaiSFX.isMuted && NaiSFX.isMuted()); } catch (e) {}
    var b = $('btnSound'); b.firstChild.nodeValue = m ? '🔇' : '🔊';
    b.querySelector('.tx').textContent = m ? ' 音效关' : ' 音效开';
  }

  // ===================== 开局 / 过关 / 重来 =====================
  function newLevel() {
    FX.clear(); timers = []; queuedPower = null; hoverId = -1; hideOverlay(); hideHint();
    var lv = null, seed = run.seed;
    for (var tries = 0; tries < 8 && !lv; tries++) {
      try { lv = L.generateLevel(run.level, seed); } catch (e) { seed = rndSeed(); }
    }
    run.seed = seed;
    eng = E.createEngine(lv, { flyTime: FLY_TIME, score: run.scoreStart });
    V.setLevel(eng, time);
    refreshPower(); updateHud();
    if (run.level === 1 && !hintShown) {             // 新手提示：手机上没有侧栏说明，页面打开后提示一次
      hintShown = true;
      later(1.1, function () { hintEl.classList.add('show'); });
      later(7, hideHint);
    }
    later(0.2, function () { FX.text(V.size().w / 2, 46, '第 ' + run.level + ' 关', { size: 30, color: '#ff6b6b', life: 1.3, rise: 18 }); });
  }
  function restartRun() { run = { level: 1, scoreStart: 0, seed: rndSeed() }; bestAtRunStart = best; newLevel(); }
  function nextLevel() { run = { level: run.level + 1, scoreStart: eng.score, seed: rndSeed() }; newLevel(); }
  function retryLevel() { newLevel(); }

  // ===================== 浮层 =====================
  function showOverlay(kind, bonus) {
    overlayOpen = true;
    var win = kind === 'win', isNew = eng.score > bestAtRunStart && eng.score > 0;
    $('ovEmoji').textContent = win ? '🎉' : '😆';
    $('ovTitle').textContent = win ? '过关！' : '槽满了！';
    $('ovSub').textContent = win ? '第 ' + eng.level.level + ' 关完成 · 过关奖励 +' + bonus : '哦齁齁齁… 槽里塞满啦，换个思路再来！';
    $('ovScore').textContent = eng.score; $('ovBest').textContent = best;
    $('ovNew').classList.toggle('show', isNew);
    var main = $('ovMain'), alt = $('ovAlt');
    main.textContent = win ? '下一关 ▶' : '重试本关';
    alt.hidden = win; alt.textContent = '再来一局（从第 1 关）';
    main.onclick = win ? nextLevel : retryLevel; alt.onclick = restartRun;
    overlay.classList.add('show');
    try { main.focus({ preventScroll: true }); } catch (e) {}
  }
  function hideOverlay() { overlayOpen = false; overlay.classList.remove('show'); }
  function hideHint() { hintEl.classList.remove('show'); }

  // ===================== 引擎事件 → 动画 + 音效 =====================
  function clampX(x) { var w = V.size().w; return Math.max(60, Math.min(w - 60, x)); }
  function pump() {
    var evs = eng.drain();
    for (var i = 0; i < evs.length; i++) {
      var ev = evs[i], c, w = V.size().w, h = V.size().h;
      switch (ev.t) {
        case 'place': sfx('pop'); break;
        case 'land':
          V.onLand(ev.id); sfx('click');
          c = V.center(ev.id); FX.burst(c.x, c.y + 8, 4, { speed: 90, up: 40, size: 6, sizeMin: 3, life: 0.5, kind: 'conf', colors: ['#fff3df', '#ffd84d'] });
          break;
        case 'clear': onClear(ev); break;
        case 'undo': sfx('swap'); c = V.center(ev.id); FX.burst(c.x, c.y, 8, { speed: 150 }); break;
        case 'moveOut': sfx('boing'); break;
        case 'shuffle': V.onShuffle(ev); sfx('swap'); FX.text(w / 2, h * 0.38, '洗牌！', { size: 34, color: '#9a68f0', life: 1.1 }); break;
        case 'win':
          sfx('win'); syncBest();
          for (var k = 0; k < 6; k++) (function (k) { later(k * 0.12, function () { FX.burst(w * (0.15 + 0.14 * k), h * 0.45, 22, { speed: 380, up: 220, life: 1.5, size: 15 }); }); })(k);
          (function (bonus) { later(1.1, function () { showOverlay('win', bonus); }); })(ev.bonus);   // 事件对象会被循环复用，先把奖励存下来
          break;
        case 'lose':
          sfx('lose'); syncBest(); V.shakeTray();
          later(0.9, function () { showOverlay('lose'); });
          break;
      }
    }
  }
  function onClear(ev) {
    var cx = 0, cy = 0;
    ev.ids.forEach(function (id) { var p = V.center(id); cx += p.x / 3; cy += p.y / 3; });
    V.startClear(ev.ids);
    sfx('clear', ev.combo); sfx('laugh', Math.min(0.8, 0.3 + 0.1 * (ev.combo - 1)));
    if (ev.combo >= 2) sfx('good', ev.combo);
    cx = clampX(cx); cy = Math.max(90, cy);
    later(0.2, function () { FX.burst(cx, cy - 20, 16 + 4 * Math.min(ev.combo, 5), { speed: 300, up: 160, life: 1.1 }); FX.ring(cx, cy - 10, 80, '#ffd84d'); });
    FX.text(cx, cy - 34, LAUGH[(Math.random() * LAUGH.length) | 0], { size: 26, color: '#ff6b6b', delay: 0.18, life: 1.1 });
    FX.text(cx, cy - 66, '+' + ev.gain, { size: 22, color: '#e79a1f', delay: 0.18, life: 1.0 });
    if (ev.combo >= 2) FX.text(cx, cy - 96, '连消 ×' + ev.combo + '！', { size: 22, color: '#b13bff', delay: 0.24, life: 1.2 });
    syncBest();
  }

  // ===================== 道具 =====================
  function usePower(name) {
    if (!eng || eng.state !== 'playing' || overlayOpen || time < V.introEnd) return;
    sfxInit();
    var res = name === 'shuffle' ? eng.shuffle(Math.random) : eng[name]();
    if (res.ok) { refreshPower(); return; }
    if (res.reason === 'busy') { queuedPower = { name: name, until: time + 1.2 }; return; }  // 牌还在飞，落稳后再执行
    var btn = powerBtns.filter(function (b) { return b.dataset.pw === name; })[0];
    if (btn) { btn.classList.remove('nope'); void btn.offsetWidth; btn.classList.add('nope'); }
    if (res.reason === 'empty') {
      var lay = V.layout();
      FX.text(V.size().w / 2, lay.trayY - 20, name === 'shuffle' ? '没有可洗的牌' : '槽里还没有牌', { size: 18, color: '#8a7566', life: 1.0 });
    }
    sfx('bad');
  }

  // ===================== 输入 =====================
  function canvasPoint(e) {
    var r = cv.getBoundingClientRect(), s = V.size();
    return { x: (e.clientX - r.left) * (s.w / r.width), y: (e.clientY - r.top) * (s.h / r.height) };
  }
  cv.addEventListener('pointerdown', function (e) {
    sfxInit();
    if (!eng || overlayOpen || eng.state !== 'playing' || time < V.introEnd) return;
    e.preventDefault();
    var p = canvasPoint(e), h = V.hit(p.x, p.y, eng);
    if (!h) return;
    if (h.kind === 'covered') { V.shake(h.id); sfx('click'); return; }                        // 点在被压住的牌上：晃一下，不入槽
    if (!eng.click(h.id, time)) { V.shakeTray(); sfx('bad'); } else hideHint();                // 槽满了点不进
    hoverId = -1; V.invalidate();
  });
  cv.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || !eng || overlayOpen) return;
    var p = canvasPoint(e), h = V.hit(p.x, p.y, eng);
    hoverId = h && h.kind === 'board' ? h.id : -1;
    cv.style.cursor = h && h.kind !== 'covered' ? 'pointer' : 'default';
  });
  cv.addEventListener('pointerleave', function () { hoverId = -1; });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (n) { document.addEventListener(n, sfxInit, { capture: true, passive: true }); });
  ['pointerup', 'touchend', 'click'].forEach(function (n) { document.addEventListener(n, sfxInit2, { capture: true, passive: true }); });

  powerBtns.forEach(function (b) { b.addEventListener('click', function () { usePower(b.dataset.pw); }); });
  $('btnRestart').addEventListener('click', function () { sfxInit(); restartRun(); });
  $('btnSound').addEventListener('click', function () {
    sfxInit(); try { if (window.NaiSFX) NaiSFX.toggleMuted(); } catch (e) {}
    updateSoundBtn(); sfx('click');
  });
  window.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    sfxInit();
    var k = e.key;
    if (k === 'r' || k === 'R') restartRun();
    else if (k === 'm' || k === 'M') $('btnSound').click();
    else if (k === '1') usePower('undo');
    else if (k === '2') usePower('moveOut');
    else if (k === '3') usePower('shuffle');
    else if ((k === 'Enter' || k === ' ') && overlayOpen) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); $('ovMain').click(); }
    }
  });

  // ===================== 尺寸 / 可见性 / 主循环 =====================
  // 道具栏：竖屏/桌面在舞台底部；横屏矮窗口挪进侧栏。返回当前是否横屏布局
  var mqLand = window.matchMedia ? window.matchMedia('(min-aspect-ratio: 5/4) and (max-height: 560px)') : { matches: false };
  var panelEl = document.querySelector('.panel'), btnsEl = document.querySelector('.btns');
  function placePowerbar() {
    var inPanel = powerbar.parentNode === panelEl;
    if (mqLand.matches && !inPanel) panelEl.insertBefore(powerbar, btnsEl.nextSibling);
    else if (!mqLand.matches && inPanel) stage.insertBefore(powerbar, overlay);
    return mqLand.matches;
  }
  function onResize() {
    var isWide = placePowerbar();                                       // 横屏矮窗口：槽竖排在右侧，道具栏挪进侧栏
    var r = stage.getBoundingClientRect();
    var w = Math.max(200, Math.floor(r.width)), h = Math.max(200, Math.floor(r.height));
    FX.setLimit(w < 520 ? 160 : 400);                                   // 手机上少放点粒子
    if (isWide) V.resize(w, h, 0, true, 0);
    else V.resize(w, h, powerbar.offsetHeight + (parseFloat(getComputedStyle(powerbar).bottom) || 10) + 10, false, 0);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', function () { setTimeout(onResize, 120); });
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(stage);
  document.addEventListener('visibilitychange', function () { paused = document.hidden; lastTs = 0; });

  function frame(ts) {
    requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    var dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000)); lastTs = ts;
    if (paused || !eng) return;
    step(dt);
  }
  // 推进 dt 秒：更新规则、动画、特效并重绘（自测时也可手动调用 __sheep.step）
  var errLogged = false;
  function step(dt) {
    try { stepInner(dt); } catch (e) { if (!errLogged) { errLogged = true; try { console.error(e); } catch (e2) {} } }
  }
  function stepInner(dt) {
    time += dt;
    for (var i = timers.length - 1; i >= 0; i--) {
      if (timers[i].at <= time) { var f = timers[i].fn; timers.splice(i, 1); f(); }
    }
    eng.tick(time); pump();
    if (queuedPower && !eng.busy()) { var q = queuedPower; queuedPower = null; if (time <= q.until) usePower(q.name); }
    var busy = V.update(dt, eng, hoverId, time);
    FX.update(dt);
    var need = busy || FX.active();
    if (need || drawNext) { V.draw(eng, time); FX.draw(ctx); drawNext = need; }          // 没动画时不重绘，省电
    updateHud();
  }

  // ===================== 启动 =====================
  var qs = (function () { try { return new URLSearchParams(location.search); } catch (e) { return { get: function () { return null; } }; } })();
  var q0 = parseInt(qs.get('level'), 10), s0 = parseInt(qs.get('seed'), 10);
  if (q0 > 0) run.level = q0;
  if (s0 > 0) run.seed = s0 >>> 0;

  V.init(cv);
  onResize();
  V.loadImages();
  updateSoundBtn();
  newLevel();
  requestAnimationFrame(frame);

  // 调试/自测入口：浏览器里可用 __sheep.solve() 自动按构造顺序点完一关
  window.__sheep = {
    get eng() { return eng; }, get time() { return time; }, get run() { return run; }, get best() { return best; },
    solve: function (gap) {
      gap = gap || 0.4;
      eng.level.order.forEach(function (id, i) { later(i * gap, function () { eng.click(id, time); }); });
    },
    go: function (level, seed) { run = { level: level, scoreStart: 0, seed: seed || rndSeed() }; newLevel(); },
    step: function (n, dt) { for (var i = 0; i < (n || 1); i++) step(dt || 1 / 60); },   // 页面不可见时 rAF 会停，自测用它手动走帧
    // 自测：重新布局后返回关键尺寸（牌面大小、各控件位置、是否溢出视口）
    metrics: function () {
      window.dispatchEvent(new Event('resize')); step(2 / 60);
      var lay = V.layout(), vw = window.innerWidth, vh = window.innerHeight, out = { vw: vw, vh: vh, wide: lay.wide };
      function box(el) { var b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; }
      out.face = Math.round(lay.t * 0.94 * 10) / 10; out.slotTile = Math.round(lay.slotTile * 10) / 10; out.tempTile = Math.round(lay.tempTile * 10) / 10;
      out.stage = box(stage); out.panel = box(document.querySelector('.panel'));
      out.buttons = ['btnSound', 'btnRestart', 'btnHome'].map(function (id) { return box($(id)); });
      out.powers = powerBtns.map(box);
      out.tray = { x: Math.round(lay.trayX), y: Math.round(lay.trayY), w: Math.round(lay.trayW), h: Math.round(lay.trayH) };
      out.scroll = [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
      var all = [].slice.call(document.querySelectorAll('.stat, .btn, .pw, .foot, .foot-m, .head h1')).filter(function (e) { return e.offsetParent !== null; });
      out.overflow = all.filter(function (e) { var b = e.getBoundingClientRect(); return b.right > vw + 0.5 || b.bottom > vh + 0.5 || b.left < -0.5 || b.top < -0.5; }).map(function (e) { return e.className || e.id; });
      return out;
    }
  };
})();
