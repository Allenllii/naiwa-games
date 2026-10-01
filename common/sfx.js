/* ============================================================
 *  奶蛙小游戏 · 共用音效 (NaiSFX)
 *  笑声：播放用户提供的「奶蛙捧腹大笑」真实录音（common/laugh-data.js，自动加载）；
 *        录音还没加载好 / 解码失败时，退回现场合成的近似笑声，游戏照常能玩。
 *  其它音效：全部用 Web Audio 现场合成，没有音频文件，file:// 下也能用。
 *
 *  用法：
 *    <script src="../common/sfx.js"></script>
 *    在第一次用户操作（pointerdown / keydown）里调一次 NaiSFX.init()。
 *    之后随时调 NaiSFX.laugh(level) 等；静音 / 浏览器不支持时都是空操作，不会报错。
 *
 *  API：
 *    init()                     初始化 / 恢复音频（需在用户手势里调）
 *    setMuted(b) isMuted() toggleMuted()   静音开关，记在 localStorage 的 nai_muted
 *    laugh(level)               奶蛙大笑，level 0~1：越大越长、越快、越尖
 *                               <0.34 短促一声  0.34~0.7 一小段  ≥0.7 长笑（带开头那声「哦～」）
 *    laughReady()               真实录音是否已解码就绪（调试用）
 *    pop()                      冒头 / 弹出的“啵”
 *    click()                    轻点
 *    good(n)                    命中 / 加分的上扬提示，n=连击数，越大音越高
 *    bad()                      失误 / 扣分的下坠音
 *    boing()                    弹簧“嘣”（起跳、落地）
 *    swap()                     交换 / 移动
 *    clear(n)                   消除，n=连消数，越大音越高
 *    win() lose()               过关 / 失败的小旋律
 *    tone(freq, dur, type, vol, slideTo, delay)   自定义单音
 *    noise(dur, vol, hpFreq, delay)               自定义噪声
 * ============================================================ */
(function (root) {
  'use strict';

  var AC = root.AudioContext || root.webkitAudioContext;
  var SELF_SRC = (document.currentScript && document.currentScript.src) || '';   // 本文件的地址，用来找同目录的 laugh-data.js
  var ctx = null;          // AudioContext
  var master = null;       // 总音量（静音时为 0）
  var noiseBuf = null;     // 1 秒白噪声：做“气声”和打击感
  var muted = false;
  var MASTER_VOL = 0.8;
  var MIN_LAUGH_GAP = 0.1; // 两次笑声最短间隔（秒），避免连击时叠成一团噪音
  var MAX_LAUGH_VOICES = 3;// 真实笑声最多同时播几个，超过就把最老的快速淡出
  var lastLaughAt = -1;

  // 真实笑声
  var laughData = root.NAI_LAUGH || null;  // { mime, b64 }，由 laugh-data.js 提供
  var laughBuf = null;                     // 解码后的 AudioBuffer
  var laughCues = null;                    // 笑声里每个“哈”之间的凹谷时刻（秒），在这些位置裁切不会有爆音
  var laughDecoding = false;
  var laughVoices = [];                    // 正在播的真实笑声：[{ src, steal, endAt }]

  try { muted = root.localStorage.getItem('nai_muted') === '1'; } catch (e) {}

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function makeNoise(c) {
    var b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    var d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* ---------- 真实笑声：加载 / 解码 / 找切点 ---------- */
  function b64ToBuf(b64) {
    var bin = atob(b64.replace(/\s+/g, '')), n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  function decodeBuffer(c, ab) {
    return new Promise(function (resolve, reject) {
      var p = c.decodeAudioData(ab, resolve, reject);   // 老 Safari 只支持回调写法
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // 找出笑声里每个“哈”之间的凹谷（包络的局部极小）。直接在解码后的数据上找，
  // 这样不管不同浏览器怎么处理 MP3 的编码延迟，切点都对得上。
  function findValleys(buf) {
    var d = buf.getChannelData(0), sr = buf.sampleRate;
    var hop = Math.max(1, Math.round(sr * 0.004));       // 4ms 一格
    var win = Math.max(hop, Math.round(sr * 0.012));     // 12ms 平滑窗
    var n = Math.floor(d.length / hop), env = new Float32Array(n), i, j;
    for (i = 0; i < n; i++) {
      var a = i * hop, b = Math.min(d.length, a + win), s = 0;
      for (j = a; j < b; j++) s += Math.abs(d[j]);
      env[i] = 20 * Math.log10(s / (b - a) + 1e-6);
    }
    var R = 15, cues = [0];                              // ±60ms 内最小，且比范围内最大值低 2.5dB 以上
    for (var k = R; k < n - R; k++) {
      var m = env[k], mx = -1e9, isMin = true;
      for (var q = k - R; q <= k + R; q++) {
        if (env[q] < m) { isMin = false; break; }
        if (env[q] > mx) mx = env[q];
      }
      if (isMin && mx - m >= 2.5 && m > -80) {
        var tt = (k * hop + win / 2) / sr;
        if (tt - cues[cues.length - 1] > 0.05) cues.push(tt);
      }
    }
    cues.push(d.length / sr);
    return cues;
  }

  function prepareLaugh() {
    if (!ctx || !laughData || laughBuf || laughDecoding) return;
    laughDecoding = true;
    try {
      decodeBuffer(ctx, b64ToBuf(laughData.b64)).then(function (buf) {
        laughCues = findValleys(buf);
        laughBuf = buf;
      }, function () { /* 解码失败就一直用合成笑声 */ }).then(function () { laughDecoding = false; });
    } catch (e) { laughDecoding = false; }
  }

  // 页面一加载就去拉数据文件（同目录的 laugh-data.js），不需要每个游戏页面单独引用
  function loadLaughScript() {
    if (laughData || !SELF_SRC) return;
    try {
      var s = document.createElement('script');
      s.async = true;
      s.src = SELF_SRC.replace(/[^\/]*(\?.*)?$/, 'laugh-data.js');
      s.onload = function () { laughData = root.NAI_LAUGH || null; prepareLaugh(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  /* ---------- 音频上下文 ---------- */
  function init() {
    if (!AC) return false;
    try {
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOL;
        var comp = ctx.createDynamicsCompressor();   // 多个声音叠加时压一下，防爆音
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        comp.attack.value = 0.003;
        comp.release.value = 0.12;
        master.connect(comp);
        comp.connect(ctx.destination);
        noiseBuf = makeNoise(ctx);
      }
      if (ctx.state === 'suspended') {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      prepareLaugh();
      return true;
    } catch (e) {
      return false;
    }
  }

  function setMuted(b) {
    muted = !!b;
    try { root.localStorage.setItem('nai_muted', muted ? '1' : '0'); } catch (e) {}
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ctx.currentTime, 0.02);
    return muted;
  }

  /* ---------- 底层积木：都接收 S = { c: 上下文, out: 输出节点, noise: 噪声缓冲, laughBuf, laughCues }，
   *            这样既能实时播放，也能用 OfflineAudioContext 离线渲染做测试 ---------- */

  // 单音：可带滑音
  function bTone(S, t, freq, dur, type, vol, slideTo) {
    var c = S.c, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t + Math.min(0.012, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(S.out);
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // 噪声：高通后做“咔哒/沙沙”
  function bNoise(S, t, dur, vol, hp) {
    var c = S.c, n = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    n.buffer = S.noise;
    n.loop = true;
    f.type = 'highpass';
    f.frequency.value = hp || 1000;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f);
    f.connect(g);
    g.connect(S.out);
    n.start(t);
    n.stop(t + dur + 0.03);
  }

  // 一声“齁”：先一点气声(h)，再接带共振峰的元音(o / a)   —— 合成版笑声（真实录音没就绪时的备用）
  var FORMANTS = {
    o: [[520, 1.0, 7], [900, 0.7, 9], [2400, 0.25, 10]],
    a: [[800, 1.0, 7], [1220, 0.7, 9], [2600, 0.25, 10]]
  };
  function bHo(S, t, f0, dur, vol, vowel) {
    var c = S.c, F = FORMANTS[vowel] || FORMANTS.o;

    // 声带：锯齿波，基频略微下滑（像“哈↘”）
    var o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 1.1, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.88, t + dur);
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.025);
    g.gain.setValueAtTime(1, t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);

    // 共振峰：几个并联的带通滤波器，决定“o”还是“a”的音色
    var mix = c.createGain();
    mix.gain.value = vol;
    F.forEach(function (p) {
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = p[0];
      bp.Q.value = p[2];
      var pg = c.createGain();
      pg.gain.value = p[1] * 2.6;      // 带通会衰减很多，这里补回来
      g.connect(bp);
      bp.connect(pg);
      pg.connect(mix);
    });
    mix.connect(S.out);
    o.start(t);
    o.stop(t + dur + 0.03);

    // 气声“h”：每一声开头一小撮噪声
    var n = c.createBufferSource();
    n.buffer = S.noise;
    var nf = c.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = F[1][0] * 1.3;
    nf.Q.value = 0.9;
    var ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(vol * 0.5, t + 0.012);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + Math.min(dur * 0.7, 0.1));
    n.connect(nf);
    nf.connect(ng);
    ng.connect(S.out);
    n.start(t);
    n.stop(t + 0.14);
  }

  // 合成版整段笑声：一声拖长的“哦～”，再跟若干声急促的“齁齁齁”
  function bLaugh(S, t, level) {
    level = clamp(+level || 0, 0, 1);
    var base = 175 + level * 90 + (Math.random() * 16 - 8);   // 基频：越疯越尖
    var n = 3 + Math.round(level * 3);                         // 后面跟几声“齁”
    var gap = 0.165 - level * 0.055;                           // 间隔：越疯越快
    var tt = t;
    bHo(S, tt, base * 0.92, 0.26, 0.55, 'o');
    tt += 0.25;
    for (var i = 0; i < n; i++) {
      bHo(S, tt, base * (i % 2 ? 1.06 : 0.97), gap * 0.8, 0.5 * (1 - i * 0.06), i % 3 === 2 ? 'a' : 'o');
      tt += gap;
    }
    if (level > 0.7) {                                         // 笑到岔气：结尾拖一声上扬的“嘻～”
      bTone(S, tt, base * 3, 0.2, 'sine', 0.07, base * 4.4);
    }
  }

  // 真实笑声：从完整录音里按 level 截一段。起点/终点都吸附到「哈」与「哈」之间的凹谷，不会切在字中间。
  function pickExcerpt(cues, want, opening) {
    var total = cues[cues.length - 1], start = 0, i;
    if (!opening) {                                            // 随机挑一个起点（避开最开头 0.3 秒，且后面要放得下）
      var cand = [];
      for (i = 0; i < cues.length; i++) if (cues[i] >= 0.3 && cues[i] + want <= total - 0.2) cand.push(cues[i]);
      if (cand.length) start = cand[(Math.random() * cand.length) | 0];
    }
    var target = start + want, end = target, best = want * 0.25;
    for (i = 0; i < cues.length; i++) {                        // 终点吸附到目标附近最近的凹谷
      var d = Math.abs(cues[i] - target);
      if (cues[i] > start + 0.15 && d <= best) { best = d; end = cues[i]; }
    }
    return [start, Math.min(end, total)];
  }

  function bRealLaugh(S, t, level) {
    level = clamp(+level || 0, 0, 1);
    var want, opening, fade;
    if (level < 0.34)     { want = 0.42 + Math.random() * 0.2;  opening = Math.random() < 0.5;  fade = 0.04; }   // 短促一声
    else if (level < 0.7) { want = 0.9 + Math.random() * 0.45;  opening = Math.random() < 0.6;  fade = 0.06; }   // 一小段
    else                  { want = 2.0 + Math.random() * 1.0;   opening = Math.random() < 0.85; fade = 0.12; }   // 长笑，多半带开头那声“哦～”
    var ex = pickExcerpt(S.laughCues, want, opening), off = ex[0], len = ex[1] - ex[0];
    var rate = 1 + level * 0.08 + (Math.random() * 0.06 - 0.03);   // 越疯略快略尖，再加一点随机，免得每次一模一样
    var dur = len / rate, vol = 0.42 + level * 0.1;
    var c = S.c, src = c.createBufferSource(), env = c.createGain(), steal = c.createGain();
    src.buffer = S.laughBuf;
    src.playbackRate.value = rate;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(vol, t + 0.006);
    env.gain.setValueAtTime(vol, Math.max(t + 0.006, t + dur - fade));
    env.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(env);
    env.connect(steal);
    steal.connect(S.out);
    src.start(t, off, len);
    return { src: src, steal: steal, endAt: t + dur };
  }

  /* ---------- 其它音效 ---------- */
  function bPop(S, t)   { bTone(S, t, 320, 0.09, 'sine', 0.25, 760); bNoise(S, t, 0.04, 0.05, 3000); }
  function bClick(S, t) { bTone(S, t, 700, 0.04, 'triangle', 0.15, 520); }
  function bGood(S, t, n) {
    var f = 520 * Math.pow(1.0595, Math.min(+n || 0, 8) * 2);
    bTone(S, t, f, 0.1, 'triangle', 0.22);
    bTone(S, t + 0.07, f * 1.5, 0.16, 'triangle', 0.2);
  }
  function bBad(S, t)   { bTone(S, t, 300, 0.28, 'sawtooth', 0.14, 110); }
  function bBoing(S, t) { bTone(S, t, 180, 0.28, 'sine', 0.3, 520); bTone(S, t + 0.03, 360, 0.24, 'sine', 0.12, 140); }
  function bSwap(S, t)  { bTone(S, t, 440, 0.07, 'sine', 0.15, 660); }
  function bClear(S, t, n) {
    var f = 440 * Math.pow(1.0595, Math.min(+n || 1, 8) * 2);
    bTone(S, t, f, 0.12, 'triangle', 0.2);
    bTone(S, t + 0.06, f * 1.26, 0.12, 'triangle', 0.18);
    bTone(S, t + 0.12, f * 1.5, 0.2, 'triangle', 0.18);
    bNoise(S, t, 0.06, 0.03, 5000);
  }
  function bWin(S, t) {
    [523, 659, 784, 1047, 784, 1047].forEach(function (f, i) { bTone(S, t + i * 0.11, f, 0.18, 'triangle', 0.22); });
  }
  function bLose(S, t) {
    [392, 330, 262, 196].forEach(function (f, i) { bTone(S, t + i * 0.16, f, 0.24, 'sawtooth', 0.12, f * 0.96); });
  }

  /* ---------- 对外 API ---------- */
  function sink() { return { c: ctx, out: master, noise: noiseBuf, laughBuf: laughBuf, laughCues: laughCues }; }

  function play(build, a, b) {
    if (muted || !init() || ctx.state !== 'running') return;
    try {
      build(sink(), ctx.currentTime + 0.005, a, b);
    } catch (e) { /* 音效出错绝不能影响游戏 */ }
  }

  function playRealLaugh(level) {
    if (muted || !init() || ctx.state !== 'running') return;
    try {
      var now = ctx.currentTime;
      laughVoices = laughVoices.filter(function (v) { return v.endAt > now; });
      while (laughVoices.length >= MAX_LAUGH_VOICES) {         // 同时最多 3 个声部，最老的快速淡出
        var old = laughVoices.shift();
        old.steal.gain.setTargetAtTime(0, now, 0.012);
        try { old.src.stop(now + 0.1); } catch (e) {}
      }
      laughVoices.push(bRealLaugh(sink(), now + 0.005, level));
    } catch (e) { /* 出错就当没播 */ }
  }

  root.NaiSFX = {
    version: 2,
    init: init,
    setMuted: setMuted,
    isMuted: function () { return muted; },
    toggleMuted: function () { return setMuted(!muted); },

    laugh: function (level) {
      if (ctx && ctx.currentTime - lastLaughAt < MIN_LAUGH_GAP) return;
      if (ctx) lastLaughAt = ctx.currentTime;
      if (laughBuf && laughCues) playRealLaugh(level);
      else play(bLaugh, level);                                // 真实录音还没就绪：先用合成笑声顶着
    },
    laughReady: function () { return !!laughBuf; },
    pop:   function () { play(bPop); },
    click: function () { play(bClick); },
    good:  function (n) { play(bGood, n); },
    bad:   function () { play(bBad); },
    boing: function () { play(bBoing); },
    swap:  function () { play(bSwap); },
    clear: function (n) { play(bClear, n); },
    win:   function () { play(bWin); },
    lose:  function () { play(bLose); },
    tone: function (freq, dur, type, vol, slideTo, delay) {
      play(function (S, t) { bTone(S, t + (delay || 0), freq, dur || 0.1, type, vol, slideTo); });
    },
    noise: function (dur, vol, hp, delay) {
      play(function (S, t) { bNoise(S, t + (delay || 0), dur || 0.1, vol, hp); });
    },

    // 仅供离线测试（用 OfflineAudioContext 渲染后检查音量/时长/切点）
    _build: {
      makeNoise: makeNoise, tone: bTone, noise: bNoise, ho: bHo, laugh: bLaugh, realLaugh: bRealLaugh,
      pop: bPop, click: bClick, good: bGood, bad: bBad, boing: bBoing,
      swap: bSwap, clear: bClear, win: bWin, lose: bLose
    },
    _laugh: {
      data: function () { return laughData; },
      b64ToBuf: b64ToBuf, decodeBuffer: decodeBuffer, findValleys: findValleys, pickExcerpt: pickExcerpt,
      cues: function () { return laughCues; }
    }
  };

  loadLaughScript();
})(window);
