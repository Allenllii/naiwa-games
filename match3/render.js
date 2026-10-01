/* ============================================================
 *  奶蛙消消乐 · 渲染层（只管「画」，不管规则和流程）
 *
 *  - 预加载 11 张里用到的 8 张奶蛙图，缩成「贴纸」（带白描边）再贴到彩色圆角底板上，
 *    每种 造型×特殊块 预先画进「图集」(atlas)，主循环里只做 drawImage，手机上也流畅
 *  - 棋盘底座 (tray)、选中光环、键盘光标
 *  - 特效：粒子（星星/纸屑）、冲击环、条纹光束、彩虹闪电、飘字、全屏闪光、屏幕震动、全场大笑
 *
 *  每个棋子 cell 上挂着一个 cell.vis（由 game.js 每帧更新），含：
 *    x,y 位置（以格为单位）  ox,oy 偏移  sx,sy 缩放  rot 旋转  alpha  selT 选中程度  z 层级
 * ============================================================ */
(function () {
  'use strict';

  var Logic = window.Match3Logic;
  var SP = Logic.SP;
  var SIZE = Logic.SIZE;
  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  var IMG_DIR = '../assets/nai/';

  /* ---------------- 造型与底板配色（可调） ----------------
   * 全是黄色的奶蛙，靠底板颜色区分：粉 / 蓝 / 绿 / 紫 / 橙 / 青，再加上各自不同的轮廓 */
  var FILES = ['nai03-mouse', 'nai04-rooster', 'nai05-dog', 'nai07-rabbit', 'nai08-sumo', 'nai09-angel'];
  var FILE_RAINBOW = 'nai11-god';
  var FILE_LAUGH = 'nai10-laugh';
  // 原图里的零星杂点（量过像素：sumo 右侧边缘有两小块碎屑），缩小前先擦掉。格式：[x, y, w, h]（原图像素）
  var CLEAN = { 'nai08-sumo': [[318, 268, 34, 80], [4, 318, 22, 22]] };
  var PLATES = [
    { name: '粉', top: '#ffa6c9', bot: '#ff5f9e', edge: '#c9376f', glow: '#ff7db0' },
    { name: '蓝', top: '#86c9ff', bot: '#3d8bf0', edge: '#2358c0', glow: '#62a8ff' },
    { name: '绿', top: '#9be67f', bot: '#47b94a', edge: '#2a8433', glow: '#72dc62' },
    { name: '紫', top: '#c9a8ff', bot: '#8d5cf2', edge: '#6234bd', glow: '#b087ff' },
    { name: '橙', top: '#ffb86e', bot: '#f2761f', edge: '#c24e0a', glow: '#ff9a52' },
    { name: '青', top: '#74ece2', bot: '#22b7b3', edge: '#15807e', glow: '#4fe0d6' }
  ];

  var R = window.Match3Render = {
    PLATES: PLATES, FONT: FONT, ready: false,
    W: 300, H: 300, dpr: 1, cs: 36, bx: 0, by: 0, pad: 8,
    imgOk: {}, fx: {}
  };

  var canvas = null, g = null;
  var imgs = {};               // 原始图片（失败为 null）
  var atlas = null;            // 预渲染的棋子图集
  var stickers = [];           // 6 个造型的贴纸
  var rainbowSticker = null, laughCanvas = null;
  var tray = null;             // 棋盘底座
  var glowTex = {};            // 光晕贴图缓存

  /* ---------------- 小工具 ---------------- */
  function mk(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function rr(p, x, y, w, h, r) {                      // 圆角矩形路径
    r = Math.min(r, w / 2, h / 2);
    p.beginPath(); p.moveTo(x + r, y);
    p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
    p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath();
  }
  function starPath(p, cx, cy, R1, R2, n, rot) {
    p.beginPath();
    for (var i = 0; i < n * 2; i++) {
      var a = rot + i * Math.PI / n - Math.PI / 2, rad = i % 2 ? R2 : R1;
      var x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      if (i) p.lineTo(x, y); else p.moveTo(x, y);
    }
    p.closePath();
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

  /* ---------------- 图片加载（失败有兜底，不白屏） ---------------- */
  function loadImg(name) {
    return new Promise(function (resolve) {
      var im = new Image(), done = false;
      function fin(ok) { if (done) return; done = true; resolve(ok && im.naturalWidth > 0 ? im : null); }
      im.onload = function () { fin(true); };
      im.onerror = function () { fin(false); };
      setTimeout(function () { fin(false); }, 8000);
      im.src = IMG_DIR + name + '.webp';
    });
  }
  R.loadImages = function () {
    var names = FILES.concat([FILE_RAINBOW, FILE_LAUGH]);
    return Promise.all(names.map(loadImg)).then(function (list) {
      names.forEach(function (n, i) { imgs[n] = list[i]; R.imgOk[n] = !!list[i]; });
    });
  };

  // 兜底：画个黄色圆团（有眼睛有嘴）
  function blobFallback(size) {
    var c = mk(size, size), p = c.getContext('2d'), s = size, m = s / 2;
    var gr = p.createRadialGradient(m - s * .12, m - s * .15, s * .05, m, m, s * .5);
    gr.addColorStop(0, '#fff2a8'); gr.addColorStop(1, '#ffc82e');
    p.fillStyle = gr; p.beginPath(); p.arc(m, m + s * .02, s * .44, 0, 7); p.fill();
    p.fillStyle = '#3b2a1a';
    p.beginPath(); p.arc(m - s * .15, m - s * .04, s * .05, 0, 7); p.arc(m + s * .15, m - s * .04, s * .05, 0, 7); p.fill();
    p.strokeStyle = '#3b2a1a'; p.lineWidth = Math.max(1.5, s * .035); p.lineCap = 'round';
    p.beginPath(); p.arc(m, m + s * .08, s * .11, 0.15 * Math.PI, 0.85 * Math.PI); p.stroke();
    return c;
  }

  // 擦掉原图里的杂点：画到副本上再 clearRect（不读像素，file:// 下也安全）
  function cleaned(img, rects) {
    if (!img || !rects) return img;
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, c = mk(w, h), p = c.getContext('2d');
    p.drawImage(img, 0, 0);
    rects.forEach(function (q) { p.clearRect(q[0], q[1], q[2], q[3]); });
    return c;
  }
  // 逐级减半缩小，小尺寸下依然平滑；绝不放大
  function scaledCanvas(img, w, h) {
    if (!img) return blobFallback(Math.max(w, h));
    var cur = img, cw = img.naturalWidth || img.width, ch = img.naturalHeight || img.height;
    while (cw / 2 >= w && ch / 2 >= h) {
      cw = Math.floor(cw / 2); ch = Math.floor(ch / 2);
      var t = mk(cw, ch), tg = t.getContext('2d');
      tg.imageSmoothingQuality = 'high'; tg.drawImage(cur, 0, 0, cw, ch); cur = t;
    }
    var out = mk(w, h), og = out.getContext('2d');
    og.imageSmoothingQuality = 'high'; og.drawImage(cur, 0, 0, out.width, out.height);
    return out;
  }
  // 贴纸：缩小后描一圈白边（用 source-in 做剪影，不碰 getImageData，file:// 下也安全）
  function makeSticker(img, size, outline) {
    var base = scaledCanvas(img, size, size), w = base.width, h = base.height, o = Math.ceil(outline);
    var sil = mk(w, h), sg = sil.getContext('2d');
    sg.drawImage(base, 0, 0); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = '#fff'; sg.fillRect(0, 0, w, h);
    var out = mk(w + o * 2, h + o * 2), og = out.getContext('2d');
    for (var i = 0; i < 20; i++) {
      var a = i / 20 * Math.PI * 2;
      og.drawImage(sil, o + Math.cos(a) * outline, o + Math.sin(a) * outline);
    }
    og.drawImage(base, o, o);
    return out;
  }

  /* ---------------- 图集：造型 × 特殊块 ---------------- */
  function paintPlate(p, cx, cy, P, col, u) {
    var r = P * 0.27, depth = P * 0.075, top = cy - P / 2 - depth / 2;
    p.fillStyle = 'rgba(80,40,10,.22)'; rr(p, cx - P / 2, top + depth + P * 0.035, P, P, r); p.fill();        // 投影
    p.fillStyle = col.edge; rr(p, cx - P / 2, top + depth, P, P, r); p.fill();                               // 厚度
    var gr = p.createLinearGradient(0, top, 0, top + P);
    gr.addColorStop(0, col.top); gr.addColorStop(1, col.bot);
    p.fillStyle = gr; rr(p, cx - P / 2, top, P, P, r); p.fill();                                              // 主体
    p.fillStyle = 'rgba(255,255,255,.26)'; rr(p, cx - P * 0.43, top + P * 0.05, P * 0.86, P * 0.36, r * 0.8); p.fill();   // 高光
    p.strokeStyle = 'rgba(255,255,255,.55)'; p.lineWidth = 1.6 * u; rr(p, cx - P / 2 + u, top + u, P - 2 * u, P - 2 * u, r - u); p.stroke();
    return { top: top, r: r };
  }
  function clipPlate(p, cx, top, P, r) { rr(p, cx - P / 2, top, P, P, r); p.clip(); }

  function paintBands(p, cx, top, P, r, horizontal, u) {     // 条纹块：底板上的白色条带
    p.save(); clipPlate(p, cx, top, P, r);
    p.fillStyle = 'rgba(255,255,255,.5)';
    for (var i = 0; i < 4; i++) {
      var k = (i + 0.5) / 4 * P;
      if (horizontal) p.fillRect(cx - P / 2, top + k - P * 0.04, P, P * 0.08);
      else p.fillRect(cx - P / 2 + k - P * 0.04, top, P * 0.08, P);
    }
    p.restore();
  }
  function paintRays(p, cx, top, P, r, u) {                  // 炸弹块：放射状光芒
    p.save(); clipPlate(p, cx, top, P, r);
    var mx = cx, my = top + P / 2;
    p.fillStyle = 'rgba(255,255,255,.3)';
    for (var i = 0; i < 8; i++) {
      var a0 = i * Math.PI / 4, a1 = a0 + Math.PI / 8;
      p.beginPath(); p.moveTo(mx, my);
      p.lineTo(mx + Math.cos(a0) * P, my + Math.sin(a0) * P); p.lineTo(mx + Math.cos(a1) * P, my + Math.sin(a1) * P);
      p.closePath(); p.fill();
    }
    p.restore();
  }
  function paintOutlineGlow(p, cx, top, P, r, color, u) {    // 特殊块：发光描边
    p.save();
    p.strokeStyle = color; p.globalAlpha = 0.5; p.lineWidth = 9 * u; rr(p, cx - P / 2, top, P, P, r); p.stroke();
    p.globalAlpha = 1; p.strokeStyle = '#fff'; p.lineWidth = 3.2 * u; rr(p, cx - P / 2 + u * 0.5, top + u * 0.5, P - u, P - u, r); p.stroke();
    p.restore();
  }
  function paintArrowBadge(p, x, y, rad, horizontal, col, u) {   // 条纹块角标：白底 + 双向箭头
    p.save(); p.translate(x, y);
    p.fillStyle = 'rgba(60,30,10,.25)'; p.beginPath(); p.arc(0, rad * 0.14, rad, 0, 7); p.fill();
    p.fillStyle = '#fff'; p.beginPath(); p.arc(0, 0, rad, 0, 7); p.fill();
    p.strokeStyle = col.edge; p.lineWidth = 2 * u; p.beginPath(); p.arc(0, 0, rad - u, 0, 7); p.stroke();
    if (!horizontal) p.rotate(Math.PI / 2);
    var a = rad * 0.62, h = rad * 0.3;
    p.fillStyle = col.edge; p.strokeStyle = col.edge; p.lineWidth = 2.4 * u; p.lineCap = 'round';
    p.beginPath(); p.moveTo(-a + h * 0.6, 0); p.lineTo(a - h * 0.6, 0); p.stroke();
    p.beginPath(); p.moveTo(-a - h * 0.2, 0); p.lineTo(-a + h * 1.1, -h); p.lineTo(-a + h * 1.1, h); p.closePath(); p.fill();
    p.beginPath(); p.moveTo(a + h * 0.2, 0); p.lineTo(a - h * 1.1, -h); p.lineTo(a - h * 1.1, h); p.closePath(); p.fill();
    p.restore();
  }
  function paintBombBadge(p, x, y, rad, u) {                 // 炸弹块角标：黑色小炸弹 + 引信火花
    p.save(); p.translate(x, y);
    p.fillStyle = 'rgba(60,30,10,.28)'; p.beginPath(); p.arc(0, rad * 0.14, rad, 0, 7); p.fill();
    p.fillStyle = '#fff'; p.beginPath(); p.arc(0, 0, rad, 0, 7); p.fill();
    var br = rad * 0.74;
    var gr = p.createRadialGradient(-br * .3, -br * .35, br * .1, 0, 0, br);
    gr.addColorStop(0, '#6b5a86'); gr.addColorStop(1, '#241a33');
    p.fillStyle = gr; p.beginPath(); p.arc(0, br * 0.1, br, 0, 7); p.fill();
    p.fillStyle = 'rgba(255,255,255,.75)'; p.beginPath(); p.ellipse(-br * .38, -br * .28, br * .2, br * .12, -0.6, 0, 7); p.fill();
    p.strokeStyle = '#9b7a52'; p.lineWidth = 2.2 * u; p.lineCap = 'round';
    p.beginPath(); p.moveTo(br * .35, -br * .75); p.quadraticCurveTo(br * .75, -br * 1.15, br * 1.05, -br * .9); p.stroke();
    p.fillStyle = '#ffd23f'; starPath(p, br * 1.1, -br * .95, br * .42, br * .17, 4, 0); p.fill();
    p.fillStyle = '#ff6b3d'; starPath(p, br * 1.1, -br * .95, br * .22, br * .09, 4, Math.PI / 4); p.fill();
    p.restore();
  }

  function paintCell(t, sp) {
    var A = atlas.A, P = atlas.P, D = atlas.D, u = A / 90, c = mk(D, D), p = c.getContext('2d');
    var cx = D / 2, cy = D / 2, col = PLATES[t];
    if (sp) paintOutlineGlow(p, cx, cy - P / 2 - P * 0.0375, P, P * 0.27, sp === SP.BOMB ? '#ff9a3c' : '#ffe27a', u);
    var pl = paintPlate(p, cx, cy, P, col, u);
    if (sp === SP.STRIPE_H) paintBands(p, cx, pl.top, P, pl.r, true, u);
    else if (sp === SP.STRIPE_V) paintBands(p, cx, pl.top, P, pl.r, false, u);
    else if (sp === SP.BOMB) paintRays(p, cx, pl.top, P, pl.r, u);
    var st = stickers[t];
    p.drawImage(st, cx - st.width / 2, pl.top + P / 2 - st.height / 2 - P * 0.005);
    var bx = cx + P * 0.33, by = pl.top + P * 0.16, br = P * 0.2;
    if (sp === SP.STRIPE_H) paintArrowBadge(p, bx, by, br, true, col, u);
    else if (sp === SP.STRIPE_V) paintArrowBadge(p, bx, by, br, false, col, u);
    else if (sp === SP.BOMB) paintBombBadge(p, bx, by, br, u);
    return c;
  }
  function paintRainbowTop() {                                // 彩虹块的贴纸层（底板是实时画的，会变色）
    var D = atlas.D, P = atlas.P, c = mk(D, D), p = c.getContext('2d');
    var st = rainbowSticker, top = D / 2 - P / 2 - P * 0.0375;
    p.drawImage(st, D / 2 - st.width / 2, top + P / 2 - st.height / 2);
    return c;
  }

  function buildAtlas() {
    var A = Math.max(24, Math.round(R.cs * R.dpr)), P = A * 0.9, m = Math.ceil(A * 0.17), D = A + m * 2;
    atlas = { A: A, P: P, D: D, m: m, norm: [], sh: [], sv: [], bomb: [], rainbow: null };
    var spriteSize = Math.round(P * 0.86), outline = Math.max(1.6, A * 0.03);
    stickers = FILES.map(function (f) { return makeSticker(cleaned(imgs[f], CLEAN[f]), spriteSize, outline); });
    rainbowSticker = makeSticker(imgs[FILE_RAINBOW], spriteSize, outline);
    for (var t = 0; t < PLATES.length; t++) {
      atlas.norm[t] = paintCell(t, 0);
      atlas.sh[t] = paintCell(t, SP.STRIPE_H);
      atlas.sv[t] = paintCell(t, SP.STRIPE_V);
      atlas.bomb[t] = paintCell(t, SP.BOMB);
    }
    atlas.rainbow = paintRainbowTop();
    // 大笑图：不超过原图尺寸（472），缩小时用逐级减半
    var ls = Math.min(472, Math.round(R.W * R.dpr * 0.62));
    laughCanvas = scaledCanvas(imgs[FILE_LAUGH], ls, ls);
  }
  function atlasFor(cell) {
    switch (cell.sp) {
      case SP.STRIPE_H: return atlas.sh[cell.t];
      case SP.STRIPE_V: return atlas.sv[cell.t];
      case SP.BOMB: return atlas.bomb[cell.t];
      case SP.RAINBOW: return atlas.rainbow;
      default: return atlas.norm[cell.t];
    }
  }

  /* ---------------- 棋盘底座 ---------------- */
  function buildTray() {
    var W = R.W, H = R.H, cs = R.cs, bx = R.bx, by = R.by, n = SIZE;
    var c = mk(W * R.dpr, H * R.dpr), p = c.getContext('2d');
    p.scale(R.dpr, R.dpr);
    var f = Math.max(3, Math.min(cs * 0.12, R.pad * 0.7));      // 外框厚度不超过四周留白
    // 外框
    var gr = p.createLinearGradient(0, by - f, 0, by + n * cs + f);
    gr.addColorStop(0, '#f6d8a3'); gr.addColorStop(1, '#edc58a');
    p.fillStyle = gr; rr(p, bx - f, by - f, n * cs + f * 2, n * cs + f * 2, cs * 0.42); p.fill();
    p.fillStyle = '#fdeccd'; rr(p, bx - f * 0.35, by - f * 0.35, n * cs + f * 0.7, n * cs + f * 0.7, cs * 0.34); p.fill();
    // 格子（棋盘格）
    for (var r = 0; r < n; r++) for (var q = 0; q < n; q++) {
      p.fillStyle = (r + q) % 2 ? 'rgba(244,214,164,.55)' : 'rgba(255,255,255,.55)';
      rr(p, bx + q * cs + cs * 0.03, by + r * cs + cs * 0.03, cs * 0.94, cs * 0.94, cs * 0.2); p.fill();
    }
    // 顶部内阴影
    var sh = p.createLinearGradient(0, by, 0, by + cs * 0.5);
    sh.addColorStop(0, 'rgba(160,100,40,.16)'); sh.addColorStop(1, 'rgba(160,100,40,0)');
    p.save(); rr(p, bx - f * 0.35, by - f * 0.35, n * cs + f * 0.7, n * cs + f * 0.7, cs * 0.34); p.clip();
    p.fillStyle = sh; p.fillRect(bx, by, n * cs, cs * 0.5); p.restore();
    tray = c;
  }

  /* ---------------- 布局：由 game.js 在尺寸变化时调用 ---------------- */
  var rebuildTimer = 0;
  R.init = function (cv) { canvas = cv; g = cv.getContext('2d'); };
  R.resize = function (cssSize, dpr) {
    R.dpr = dpr; R.W = R.H = cssSize;
    canvas.width = Math.round(cssSize * dpr); canvas.height = Math.round(cssSize * dpr);
    R.pad = Math.max(7, Math.round(cssSize * 0.022));          // 棋盘四周只留一圈薄边，手机上格子尽量大
    R.cs = (cssSize - R.pad * 2) / SIZE; R.bx = R.pad; R.by = R.pad;
    if (R.ready) { buildTray(); buildAtlas(); }
  };
  R.start = function () { R.ready = true; buildTray(); buildAtlas(); };
  R.px = function (c) { return R.bx + (c + 0.5) * R.cs; };       // 格坐标 → 画布 CSS 像素
  R.py = function (r) { return R.by + (r + 0.5) * R.cs; };
  R.cellAt = function (x, y) {                                    // 画布 CSS 像素 → 格坐标（棋盘外返回 null）
    var c = Math.floor((x - R.bx) / R.cs), r = Math.floor((y - R.by) / R.cs);
    return (r >= 0 && r < SIZE && c >= 0 && c < SIZE) ? { r: r, c: c } : null;
  };

  /* ---------------- 光晕 / 彩虹底板 ---------------- */
  function glow(color) {
    if (glowTex[color]) return glowTex[color];
    var c = mk(96, 96), p = c.getContext('2d'), gr = p.createRadialGradient(48, 48, 4, 48, 48, 48);
    gr.addColorStop(0, color); gr.addColorStop(0.5, color.replace(/[\d.]+\)$/, '.28)')); gr.addColorStop(1, 'rgba(255,255,255,0)');
    p.fillStyle = gr; p.fillRect(0, 0, 96, 96);
    return (glowTex[color] = c);
  }
  function drawRainbowPlate(p, P, time) {
    var r = P * 0.27, depth = P * 0.075, top = -P / 2 - depth / 2;
    p.fillStyle = 'rgba(80,40,10,.22)'; rr(p, -P / 2, top + depth + P * 0.035, P, P, r); p.fill();
    p.fillStyle = 'hsl(' + ((time * 90 + 200) % 360).toFixed(0) + ',55%,38%)'; rr(p, -P / 2, top + depth, P, P, r); p.fill();
    var gr = p.createLinearGradient(-P / 2, top, P / 2, top + P);
    for (var i = 0; i <= 5; i++) gr.addColorStop(i / 5, 'hsl(' + ((time * 90 + i * 62) % 360).toFixed(0) + ',95%,64%)');
    p.fillStyle = gr; rr(p, -P / 2, top, P, P, r); p.fill();
    // 中间压一团深紫「星云」，让金色的神奶蛙从彩虹底板上跳出来
    p.save(); rr(p, -P / 2, top, P, P, r); p.clip();
    var cy = top + P / 2, rg = p.createRadialGradient(0, cy, P * 0.04, 0, cy, P * 0.62);
    rg.addColorStop(0, 'rgba(58,18,120,.78)'); rg.addColorStop(0.55, 'rgba(70,25,140,.42)'); rg.addColorStop(1, 'rgba(70,25,140,0)');
    p.fillStyle = rg; p.fillRect(-P / 2, top, P, P);
    p.restore();
    p.fillStyle = 'rgba(255,255,255,.3)'; rr(p, -P * 0.43, top + P * 0.05, P * 0.86, P * 0.3, r * 0.8); p.fill();
    p.strokeStyle = '#fff'; p.lineWidth = Math.max(1.5, P * 0.045); rr(p, -P / 2, top, P, P, r); p.stroke();
  }

  /* ---------------- 画一个棋子 ---------------- */
  function drawCell(cell, clock) {
    var v = cell.vis, cs = R.cs;
    if (!v || v.alpha <= 0.01) return;
    var px = R.bx + (v.x + v.ox + 0.5) * cs, py = R.by + (v.y + v.oy + 0.5) * cs, sp = cell.sp;
    var pulse = sp ? 1 + 0.04 * Math.sin(clock * 5.5 + cell.id * 1.7) : 1;
    g.save();
    g.globalAlpha = v.alpha;
    g.translate(px, py); g.rotate(v.rot);
    // 特殊块的呼吸光晕
    if (sp) {
      var gl = sp === SP.BOMB ? 'rgba(255,140,40,.9)' : sp === SP.RAINBOW ? 'rgba(255,255,255,.95)' : 'rgba(255,236,120,.95)';
      var gs = cs * (1.55 + 0.12 * Math.sin(clock * 4 + cell.id));
      g.globalAlpha = v.alpha * (0.55 + 0.25 * Math.sin(clock * 4 + cell.id));
      g.drawImage(glow(gl), -gs / 2, -gs / 2, gs, gs);
      g.globalAlpha = v.alpha;
    }
    // 选中光环
    if (v.selT > 0.01) {                                   // 白色粗环 + 品牌红色脉动外环，任何底板颜色上都醒目
      var ring = cs * 1.0, pulseK = 0.5 + 0.5 * Math.sin(clock * 9);
      g.save(); g.globalAlpha = v.alpha * v.selT * (0.5 + 0.4 * pulseK);
      g.strokeStyle = '#ff6b6b'; g.lineWidth = cs * 0.075; rr(g, -ring / 2 - cs * 0.05, -ring / 2 - cs * 0.05, ring + cs * 0.1, ring + cs * 0.1, cs * 0.33); g.stroke();
      g.globalAlpha = v.alpha * v.selT;
      g.strokeStyle = '#fff'; g.lineWidth = cs * 0.085; rr(g, -ring / 2, -ring / 2, ring, ring, cs * 0.28); g.stroke();
      g.restore();
    }
    var sx = v.sx * pulse, sy = v.sy * pulse;
    g.translate(0, (1 - sy) * cs * 0.42);                  // 挤压时脚底不动
    g.scale(sx, sy);
    var s = atlas.D / R.dpr;
    if (sp === SP.RAINBOW) drawRainbowPlate(g, atlas.P / R.dpr, clock);
    g.drawImage(atlasFor(cell), -s / 2, -s / 2, s, s);
    if (sp === SP.RAINBOW) {                                // 彩虹块：绕着转的小星星
      g.fillStyle = '#fff';
      for (var i = 0; i < 3; i++) {
        var a = clock * 2.2 + i * 2.094, rad = cs * 0.42;
        g.globalAlpha = v.alpha * (0.6 + 0.4 * Math.sin(clock * 6 + i * 2));
        starPath(g, Math.cos(a) * rad, Math.sin(a) * rad * 0.9, cs * 0.09, cs * 0.035, 4, a);
        g.fill();
      }
    }
    g.restore();
  }

  function drawCursor(kb, clock) {
    var cs = R.cs, x = R.bx + kb.c * cs, y = R.by + kb.r * cs, k = 0.5 + 0.5 * Math.sin(clock * 6);
    g.save();
    g.strokeStyle = '#ff6b6b'; g.lineWidth = Math.max(2, cs * 0.05); g.setLineDash([cs * 0.16, cs * 0.1]); g.lineDashOffset = -clock * 12;
    g.globalAlpha = 0.7 + 0.3 * k;
    rr(g, x + cs * 0.02, y + cs * 0.02, cs * 0.96, cs * 0.96, cs * 0.26); g.stroke();
    g.restore();
  }

  /* ---------------- 特效系统 ---------------- */
  var parts = [], rings = [], beams = [], bolts = [], floats = [], flashA = 0, shakeAmp = 0, laugh = null;
  var fx = R.fx;
  // 特效「画质」：小屏手机粒子少一些；game.js 发现帧率掉下去时还会调低 fx.quality（0.35~1）
  fx.quality = 1;
  function fxScale() { return (R.W < 560 ? 0.62 : 1) * fx.quality; }
  function maxParts() { return Math.round((R.W < 560 ? 200 : 420) * fx.quality); }

  fx.clear = function () { parts.length = rings.length = beams.length = bolts.length = floats.length = 0; flashA = 0; shakeAmp = 0; laugh = null; };

  // 一团粒子：kinds 可选 'star' | 'conf' | 'dot'
  fx.burst = function (x, y, n, o) {
    o = o || {};
    var colors = o.colors || ['#ffd23f', '#ffffff', '#ff8fb8'], kinds = o.kinds || ['star', 'conf'];
    n = Math.max(1, Math.round(n * fxScale())); var cap = maxParts();
    for (var i = 0; i < n && parts.length < cap; i++) {
      var a = Math.random() * Math.PI * 2, sp = (o.speed || R.cs * 4.2) * (0.35 + Math.random() * 0.85);
      parts.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up === undefined ? R.cs * 1.6 : o.up),
        g: o.g === undefined ? R.cs * 11 : o.g, t: 0, max: (o.life || 0.75) * (0.7 + Math.random() * 0.6),
        size: (o.size || R.cs * 0.15) * (0.6 + Math.random() * 0.8), rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
        kind: kinds[i % kinds.length], color: colors[i % colors.length]
      });
    }
  };
  fx.ring = function (x, y, o) {
    o = o || {};
    rings.push({ x: x, y: y, t: 0, max: o.life || 0.45, r0: o.r0 || R.cs * 0.2, r1: o.r1 || R.cs * 1.8, color: o.color || '#ff9a3c', w: o.w || R.cs * 0.16, fill: o.fill === undefined ? 0.35 : o.fill });
  };
  fx.beam = function (horizontal, line, o) {         // 条纹光束：整行/整列（line 是行号/列号，o.width 单位是格）
    o = o || {};
    beams.push({ h: horizontal, line: line, t: 0, max: o.life || 0.5, w: o.width || 1, color: o.color || '#ffb23c', cx: o.cx, cy: o.cy });
  };
  fx.bolt = function (x1, y1, x2, y2, o) {           // 彩虹闪电
    o = o || {};
    var pts = [], n = 6;
    for (var i = 0; i <= n; i++) {
      var k = i / n, jit = (i === 0 || i === n) ? 0 : (Math.random() - 0.5) * R.cs * 0.7;
      var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
      pts.push({ x: x1 + dx * k - dy / len * jit, y: y1 + dy * k + dx / len * jit });
    }
    bolts.push({ pts: pts, t: 0, max: o.life || 0.42, color: o.color || '#b13bff' });
  };
  fx.text = function (str, x, y, o) {                // 飘字
    o = o || {};
    floats.push({
      s: str, x: x, y: y, t: 0, max: o.life || 0.95, size: o.size || R.cs * 0.55, fill: o.fill || '#ff6b6b', stroke: o.stroke || '#fff',
      vy: o.vy === undefined ? -R.cs * 0.9 : o.vy, pop: o.pop === undefined ? 1 : o.pop, rainbow: !!o.rainbow, rot: o.rot || 0
    });
  };
  fx.flash = function (a) { flashA = Math.max(flashA, a === undefined ? 0.6 : a); };
  fx.shake = function (amp) { shakeAmp = Math.max(shakeAmp, amp); };
  fx.bigLaugh = function () { laugh = { t: 0, max: 1.35 }; };
  fx.isLaughing = function () { return !!laugh; };
  fx.laughEnv = function () {                         // 0~1：全场抖动强度包络
    if (!laugh) return 0;
    var p = laugh.t / laugh.max;
    return p < 0.12 ? p / 0.12 : p > 0.7 ? clamp01((1 - p) / 0.3) : 1;
  };
  fx.count = function () { return parts.length + rings.length + beams.length + bolts.length + floats.length; };

  fx.update = function (dt) {
    var i, p;
    for (i = parts.length - 1; i >= 0; i--) {
      p = parts[i]; p.t += dt;
      if (p.t >= p.max) { parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.vx *= (1 - 0.8 * dt);
    }
    var lists = [rings, beams, bolts, floats];
    for (var l = 0; l < lists.length; l++) for (i = lists[l].length - 1; i >= 0; i--) {
      p = lists[l][i]; p.t += dt;
      if (p.t >= p.max) lists[l].splice(i, 1);
      else if (lists[l] === floats) p.y += p.vy * dt * (1 - p.t / p.max);
    }
    flashA = Math.max(0, flashA - dt * 1.8);
    shakeAmp = Math.max(0, shakeAmp - shakeAmp * 6 * dt - dt * 4);
    if (laugh) { laugh.t += dt; if (laugh.t >= laugh.max) laugh = null; }
  };

  function drawParticles() {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], k = p.t / p.max, a = k < 0.7 ? 1 : (1 - k) / 0.3;
      g.save(); g.globalAlpha = Math.max(0, a); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.color;
      var s = p.size * (1 - 0.35 * k);
      if (p.kind === 'star') { starPath(g, 0, 0, s, s * 0.45, 5, 0); g.fill(); }
      else if (p.kind === 'conf') { g.fillRect(-s * 0.55, -s * 0.3, s * 1.1, s * 0.6); }
      else { g.beginPath(); g.arc(0, 0, s * 0.5, 0, 7); g.fill(); }
      g.restore();
    }
  }
  function drawRings() {
    for (var i = 0; i < rings.length; i++) {
      var r = rings[i], k = easeOut(r.t / r.max), rad = r.r0 + (r.r1 - r.r0) * k, a = 1 - r.t / r.max;
      g.save(); g.globalAlpha = a * r.fill; g.fillStyle = r.color; g.beginPath(); g.arc(r.x, r.y, rad, 0, 7); g.fill();
      g.globalAlpha = a; g.strokeStyle = r.color; g.lineWidth = Math.max(1, r.w * (1 - k * 0.7)); g.beginPath(); g.arc(r.x, r.y, rad, 0, 7); g.stroke();
      g.globalAlpha = a * 0.9; g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, r.w * 0.35 * (1 - k)); g.beginPath(); g.arc(r.x, r.y, rad * 0.94, 0, 7); g.stroke();
      g.restore();
    }
  }
  function drawBeams() {
    var cs = R.cs, len = cs * SIZE;
    for (var i = 0; i < beams.length; i++) {
      var b = beams[i], k = b.t / b.max, grow = easeOut(Math.min(1, k / 0.25)), thick = cs * b.w * (0.92 * (1 - Math.pow(k, 2.2)) + 0.1), a = 1 - Math.pow(k, 3);
      var cx = b.h ? (b.cx === undefined ? R.bx + len / 2 : b.cx) : R.px(b.line), cy = b.h ? R.py(b.line) : (b.cy === undefined ? R.by + len / 2 : b.cy);
      var half = len * grow;
      g.save(); g.globalAlpha = a; g.translate(cx, cy);
      if (!b.h) g.rotate(Math.PI / 2);
      var gr = g.createLinearGradient(0, -thick / 2, 0, thick / 2);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.25, b.color); gr.addColorStop(0.5, '#fff'); gr.addColorStop(0.75, b.color); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(-half, -thick / 2, half * 2, thick);
      g.restore();
    }
  }
  function drawBolts() {
    for (var i = 0; i < bolts.length; i++) {
      var b = bolts[i], a = 1 - b.t / b.max;
      g.save(); g.globalAlpha = a; g.lineJoin = 'round'; g.lineCap = 'round';
      for (var pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass ? '#fff' : b.color; g.lineWidth = pass ? R.cs * 0.07 : R.cs * 0.2;
        g.globalAlpha = pass ? a : a * 0.55;
        g.beginPath(); g.moveTo(b.pts[0].x, b.pts[0].y);
        for (var j = 1; j < b.pts.length; j++) g.lineTo(b.pts[j].x, b.pts[j].y);
        g.stroke();
      }
      g.restore();
    }
  }
  function drawFloats(clock) {
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i], k = f.t / f.max;
      var sc = f.pop ? (k < 0.18 ? 0.4 + 0.9 * easeOut(k / 0.18) : k < 0.3 ? 1.3 - 0.3 * ((k - 0.18) / 0.12) : 1) : 1;
      var a = k > 0.72 ? (1 - k) / 0.28 : 1;
      g.save(); g.globalAlpha = Math.max(0, a); g.translate(f.x, f.y); g.rotate(f.rot); g.scale(sc, sc);
      g.font = '900 ' + f.size.toFixed(1) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = f.size * 0.2; g.strokeStyle = f.stroke; g.strokeText(f.s, 0, 0);
      if (f.rainbow) {
        var w = g.measureText(f.s).width, gr = g.createLinearGradient(-w / 2, 0, w / 2, 0);
        for (var j = 0; j <= 4; j++) gr.addColorStop(j / 4, 'hsl(' + ((clock * 200 + j * 70) % 360).toFixed(0) + ',95%,58%)');
        g.fillStyle = gr;
      } else g.fillStyle = f.fill;
      g.fillText(f.s, 0, 0);
      g.restore();
    }
  }
  function drawLaugh(clock) {
    if (!laugh || !laughCanvas) return;
    var p = laugh.t / laugh.max, sz = laughCanvas.width / R.dpr;
    var x = -sz * 0.55 + (R.W + sz * 1.1) * easeInOutSine(p);
    var y = R.H * 0.5 + Math.sin(laugh.t * 8) * R.H * 0.035;
    var a = p < 0.1 ? p / 0.1 : p > 0.88 ? (1 - p) / 0.12 : 1;
    var sc = 1 + 0.05 * Math.sin(laugh.t * 22);
    g.save(); g.globalAlpha = 0.93 * clamp01(a); g.translate(x, y); g.rotate(Math.sin(laugh.t * 9) * 0.16); g.scale(sc, sc);
    var halo = sz * 1.3;                                    // 先垫一团暖白光，把原图自带的半透明光晕融进去
    g.globalAlpha = 0.85 * clamp01(a); g.drawImage(glow('rgba(255,246,214,.96)'), -halo / 2, -halo / 2, halo, halo);
    g.globalAlpha = 0.93 * clamp01(a);
    g.drawImage(laughCanvas, -sz / 2, -sz / 2, sz, sz);
    g.restore();
    g.save(); g.globalAlpha = clamp01(a); g.translate(x, y - sz * 0.5 - R.cs * 0.2); g.rotate(Math.sin(laugh.t * 9 + 1) * 0.1);
    g.font = '900 ' + (R.cs * 0.8).toFixed(1) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = R.cs * 0.18; g.strokeStyle = '#fff'; g.strokeText('哦齁齁齁～', 0, 0);
    g.fillStyle = '#ff5c8a'; g.fillText('哦齁齁齁～', 0, 0);
    g.restore();
  }

  /* ---------------- 整帧绘制 ----------------
   * view = { cells:[cell...], kb:{r,c}|null, clock } */
  R.draw = function (view) {
    if (!g) return;
    var dpr = R.dpr, clock = view.clock;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, R.W, R.H);
    if (!R.ready || !atlas) return;
    g.save();
    if (shakeAmp > 0.1) g.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);
    g.drawImage(tray, 0, 0, R.W, R.H);
    if (view.kb) drawCursor(view.kb, clock);
    // 棋子：只在棋盘范围内显示，补充的新块从顶部边缘「钻」进来
    g.save();
    var cs = R.cs, f = cs * 0.12;
    rr(g, R.bx - f, R.by - f * 0.2, SIZE * cs + f * 2, SIZE * cs + f * 1.2, cs * 0.3); g.clip();
    var list = view.cells.slice().sort(function (a, b) { return a.vis.z - b.vis.z; });
    for (var i = 0; i < list.length; i++) drawCell(list[i], clock);
    g.restore();
    drawRings(); drawBeams(); drawBolts(); drawParticles();
    if (flashA > 0.01) { g.save(); g.globalAlpha = clamp01(flashA); g.fillStyle = '#fff'; rr(g, R.bx - f, R.by - f, SIZE * cs + f * 2, SIZE * cs + f * 2, cs * 0.4); g.fill(); g.restore(); }
    drawLaugh(clock);
    drawFloats(clock);
    g.restore();
  };

  /* 图例里的小图标（把图集里的棋子缩小画到指定 canvas 上） */
  R.drawMini = function (el, t, sp) {
    if (!atlas) return;
    var s = el.clientWidth || 40, d = Math.min(3, window.devicePixelRatio || 1), p = el.getContext('2d');
    el.width = Math.round(s * d); el.height = Math.round(s * d);
    p.clearRect(0, 0, el.width, el.height);
    var img = sp === SP.RAINBOW ? null : atlasFor({ t: t, sp: sp });
    if (sp === SP.RAINBOW) {
      var P = el.width * 0.62, c = mk(el.width, el.height), cg = c.getContext('2d');
      cg.translate(el.width / 2, el.height / 2); drawRainbowPlate(cg, P, 1.5); cg.setTransform(1, 0, 0, 1, 0, 0);
      p.drawImage(c, 0, 0); p.drawImage(atlas.rainbow, 0, 0, el.width, el.height);
    } else p.drawImage(img, 0, 0, el.width, el.height);
  };
})();
