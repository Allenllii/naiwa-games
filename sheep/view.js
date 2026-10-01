/* 奶了个奶 · 画面层：布局、牌/槽/暂存区的绘制（带缓存）、补间动画
 * 只读引擎状态（engine.tiles/slot/temp），不改规则。 */
(function (root) {
  'use strict';

  // ===================== 外观常量（调参入口）=====================
  var IMG_DIR = '../assets/nai/';
  // 造型下标 = 引擎里的 tile.type。全是黄色素材，所以靠不同底色区分（都用明亮饱和色，避免和“被压住的暗牌”混淆）
  var TYPES = [
    { key: 'nai03-mouse',   color: '#ff8db5' },  // 粉
    { key: 'nai04-rooster', color: '#6fbbff' },  // 天蓝
    { key: 'nai05-dog',     color: '#5fcf86' },  // 绿
    { key: 'nai06-horse',   color: '#b48cff' },  // 紫
    { key: 'nai07-rabbit',  color: '#ff7a66' },  // 珊瑚红
    { key: 'nai08-sumo',    color: '#33c7c0' },  // 青
    { key: 'nai09-angel',   color: '#6c78e8' },  // 靛蓝
    { key: 'nai10-laugh',   color: '#a6d64a' },  // 青柠绿
    { key: 'nai02-stand',   color: '#e070d8' }   // 洋红
  ];
  var FACE = 0.94;        // 牌面占格子的比例（留缝，露出厚度）
  var DEPTH = 0.09;       // 牌的厚度（相对牌面边长）
  var SPRITE = 0.86;      // 造型图占牌面的比例
  var TILE_MAX = 76;      // 牌的最大像素边长
  var SLOT_MAX = 64;      // 槽格最大边长
  var FLY_ARC = 0.9;      // 飞入槽的弧线高度（相对牌边长）
  var SHIFT_TIME = 0.24;  // 槽里牌挪位的时间（秒）
  var CLEAR_TIME = 0.85;  // 消除时“大笑弹起”的总时长（秒）

  // ===================== 内部状态 =====================
  var cv, ctx, dpr = 1, W = 0, H = 0, reserve = 60, reserveL = 0, wide = false, bounds = null, lay = null, busyFlag = true;
  var imgs = [], cache = [], cacheF = 0, cacheP = 0, cacheD = 0;
  var sprites = [], needSnap = true, trayShake = 0, onImgChange = null;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutBack(t) { var c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  function mixHex(a, b, t) {
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), out = 0;
    for (var s = 16; s >= 0; s -= 8) out |= Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t) << s;
    return '#' + ('000000' + out.toString(16)).slice(-6);
  }
  function rr(c, x, y, w, h, r) {            // 圆角矩形路径
    r = Math.min(r, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // ===================== 图片加载（失败有兜底）=====================
  function loadImages(done) {
    var left = TYPES.length;
    TYPES.forEach(function (t, i) {
      var im = new Image();
      imgs[i] = { img: im, ok: false };
      im.onload = function () { imgs[i].ok = true; fin(); };
      im.onerror = function () { imgs[i].ok = false; fin(); };
      im.src = IMG_DIR + t.key + '.webp';
    });
    function fin() { if (--left === 0) { buildCache(); if (done) done(); } }
    setTimeout(function () { if (left > 0) { left = 0; buildCache(); if (done) done(); } }, 6000); // 加载太慢也不白屏
  }

  // 多次对半缩小，缩得更平滑（大图直接缩到小尺寸会有锯齿）
  function drawSmooth(c, img, dx, dy, dw, dh) {
    var src = img, sw = img.naturalWidth || img.width || dw;
    while (sw / 2 >= dw) {
      var nw = Math.floor(sw / 2), tmp = document.createElement('canvas');
      tmp.width = nw; tmp.height = nw;
      var tc = tmp.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(src, 0, 0, nw, nw);
      src = tmp; sw = nw;
    }
    c.imageSmoothingQuality = 'high'; c.drawImage(src, dx, dy, dw, dh);
  }

  // 预渲染每种造型的“牌”：厚度 + 牌面渐变 + 高光边 + 造型图
  function buildCache() {
    if (!lay) return;
    var F = Math.max(24, Math.round(Math.max(lay.t * FACE, lay.slotTile) * dpr));
    var P = Math.ceil(F * 0.03) + 1, D = Math.round(F * DEPTH), R = F * 0.17;
    cacheF = F; cacheP = P; cacheD = D;
    TYPES.forEach(function (ty, i) {
      var c = cache[i] || (cache[i] = document.createElement('canvas'));
      c.width = F + 2 * P; c.height = F + D + 2 * P;
      var g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      rr(g, P, P + D, F, F, R); g.fillStyle = mixHex(ty.color, '#2a1a10', 0.42); g.fill();          // 厚度
      var grad = g.createLinearGradient(P, P, P + F * 0.35, P + F);
      grad.addColorStop(0, mixHex(ty.color, '#ffffff', 0.38)); grad.addColorStop(1, ty.color);
      rr(g, P, P, F, F, R); g.fillStyle = grad; g.fill();                                          // 牌面
      var glow = g.createRadialGradient(P + F / 2, P + F * 0.52, F * 0.05, P + F / 2, P + F * 0.52, F * 0.5);
      glow.addColorStop(0, 'rgba(255,255,255,.42)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
      rr(g, P, P, F, F, R); g.fillStyle = glow; g.fill();                                          // 造型后面的柔光
      rr(g, P + F * 0.025, P + F * 0.025, F * 0.95, F * 0.95, R * 0.85);
      g.lineWidth = Math.max(1.5, F * 0.03); g.strokeStyle = 'rgba(255,255,255,.55)'; g.stroke();  // 高光描边
      var sz = F * SPRITE, sx = P + (F - sz) / 2, sy = P + (F - sz) / 2 + F * 0.015;
      if (imgs[i] && imgs[i].ok) drawSmooth(g, imgs[i].img, sx, sy, sz, sz);
      else {                                                                                      // 兜底：黄色圆团
        g.fillStyle = '#ffd84d'; g.beginPath(); g.arc(P + F / 2, P + F / 2 + F * 0.03, F * 0.34, 0, 6.283); g.fill();
        g.fillStyle = '#4a3325'; g.beginPath();
        g.arc(P + F * 0.4, P + F * 0.47, F * 0.04, 0, 6.283); g.arc(P + F * 0.6, P + F * 0.47, F * 0.04, 0, 6.283); g.fill();
      }
    });
  }

  // ===================== 布局 =====================
  // 竖屏：棋盘在上，暂存区一行，7 格槽一行（道具按钮 DOM 在最下面，用 reserve 留位置）
  // 横屏(wide)：槽竖排在右侧，暂存区竖排在它左边，道具按钮 DOM 竖排在左侧（reserveL 留位置）
  function relayout() {
    var pad, cell, trayW, trayH, trayX, trayY, tempCell, tempX, tempY, rL, rR, rT, rB;
    if (!wide) {
      pad = clamp(W * 0.03, 8, 16);
      cell = Math.min((W - 2 * pad - 14) / 7, SLOT_MAX);
      trayW = cell * 7 + 14; trayH = cell + 14;
      trayX = (W - trayW) / 2; trayY = H - reserve - trayH;
      tempCell = cell * 0.86; tempX = trayX + 2; tempY = trayY - tempCell - 12;
      rL = pad; rR = W - pad; rT = pad; rB = tempY - 8;
    } else {
      pad = clamp(H * 0.03, 6, 12);
      cell = Math.min((H - 2 * pad - 14) / 7, SLOT_MAX);
      trayW = cell + 14; trayH = cell * 7 + 14;
      trayX = W - pad - trayW; trayY = (H - trayH) / 2;
      tempCell = cell * 0.8; tempX = trayX - tempCell - 12; tempY = (H - (3 * tempCell + 16)) / 2;
      rL = pad + reserveL; rR = tempX - 10; rT = pad; rB = H - pad;
    }
    lay = { wide: wide, pad: pad, cell: cell, trayX: trayX, trayY: trayY, trayW: trayW, trayH: trayH,
            slotTile: cell * 0.9, tempCell: tempCell, tempTile: tempCell * 0.9, tempX: tempX, tempY: tempY,
            regionLeft: rL, regionTop: rT, regionW: Math.max(60, rR - rL), regionH: Math.max(80, rB - rT), t: 40, bx0: 0, by0: 0 };
    if (bounds) {
      var bw = (bounds.maxX - bounds.minX) / 2, bh = (bounds.maxY - bounds.minY) / 2;
      lay.t = Math.max(20, Math.min(lay.regionW / bw, lay.regionH / bh, TILE_MAX));
      lay.bx0 = rL + (lay.regionW - bw * lay.t) / 2 - bounds.minX / 2 * lay.t;
      lay.by0 = rT + (lay.regionH - bh * lay.t) * (lay.wide ? 0.5 : 0.62) - bounds.minY / 2 * lay.t;   // 竖屏略偏下，方便拇指够到
    }
    buildCache();
    needSnap = true; busyFlag = true;
  }

  function slotPos(i) {
    var dy = cacheD / dpr * 0.2;
    return lay.wide ? { x: lay.trayX + 7 + lay.cell / 2, y: lay.trayY + 7 + (i + 0.5) * lay.cell - dy }
                    : { x: lay.trayX + 7 + (i + 0.5) * lay.cell, y: lay.trayY + 7 + lay.cell / 2 - dy };
  }
  function tempPos(i) {
    var step = lay.tempCell + 8;
    return lay.wide ? { x: lay.tempX + lay.tempCell / 2, y: lay.tempY + i * step + lay.tempCell / 2 }
                    : { x: lay.tempX + i * step + lay.tempCell / 2, y: lay.tempY + lay.tempCell / 2 };
  }
  function targetOf(eng, t, slotIdx, tempIdx) {
    if (t.loc === 'slot') { var p = slotPos(slotIdx); return { x: p.x, y: p.y, s: lay.slotTile }; }
    if (t.loc === 'temp') { var q = tempPos(tempIdx); return { x: q.x, y: q.y, s: lay.tempTile }; }
    return { x: lay.bx0 + (t.x + 1) * lay.t / 2, y: lay.by0 + (t.y + 1) * lay.t / 2, s: lay.t * FACE };
  }

  // ===================== 对外：初始化 / 尺寸 / 关卡 =====================
  var View = { TYPES: TYPES };

  View.init = function (canvas) { cv = canvas; ctx = cv.getContext('2d'); };

  // reserveBottom：竖屏时底部留给道具栏的高度；isWide/reserveLeft：横屏布局及左侧留给道具栏的宽度
  View.resize = function (w, h, reserveBottom, isWide, reserveLeft) {
    var nd = Math.min(root.devicePixelRatio || 1, 2);   // 高分屏最多按 2 倍渲染，低端手机更不卡
    // 尺寸没变就不重排（手机地址栏伸缩会触发多余的 resize，别打断正在飞的牌）
    if (lay && nd === dpr && w === W && h === H && reserveBottom === reserve && !!isWide === wide && (reserveLeft || 0) === reserveL) return;
    dpr = nd;
    W = w; H = h; reserve = reserveBottom; wide = !!isWide; reserveL = reserveLeft || 0;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    relayout();
  };

  View.loadImages = loadImages;

  // 开新关：为每张牌建一个“精灵”（记录当前画面位置、动画状态）
  View.setLevel = function (eng, now) {
    bounds = eng.level.bounds;
    relayout();
    var n = eng.tiles.length, maxZ = 0, i;
    for (i = 0; i < n; i++) maxZ = Math.max(maxZ, eng.tiles[i].z);
    sprites = eng.tiles.map(function (t) {
      return { x: 0, y: 0, size: 0, loc: 'board', tw: null, tgx: -1, tgy: -1, tgs: -1, dim: 1, wasFree: false, ready: false,
               land: -1, pop: 0, shake: 0, flip: null, clear: null, air: false, hover: 0, rot: 0,
               introAt: now + 0.05 + t.z * 0.07 + Math.random() * 0.1 };
    });
    needSnap = true; trayShake = 0;
    View.introEnd = now + 0.05 + maxZ * 0.07 + 0.1 + 0.3;
  };

  // ===================== 每帧更新 =====================
  View.update = function (dt, eng, hoverId, now) {
    if (!lay) return true;
    var busy = busyFlag || trayShake > 0 || (eng.slot.length >= 6 && eng.state === 'playing');
    var slotIdx = {}, tempIdx = {}, i, sp, t;
    for (i = 0; i < eng.slot.length; i++) slotIdx[eng.slot[i]] = i;
    for (i = 0; i < eng.temp.length; i++) tempIdx[eng.temp[i]] = i;
    trayShake = Math.max(0, trayShake - dt / 0.35);
    for (i = 0; i < sprites.length; i++) {
      sp = sprites[i]; t = eng.tiles[i];
      if (sp.land >= 0) { sp.land += dt / 0.4; if (sp.land >= 1) sp.land = -1; }
      if (sp.pop > 0) sp.pop = Math.max(0, sp.pop - dt / 0.3);
      if (sp.shake > 0) sp.shake = Math.max(0, sp.shake - dt / 0.4);
      if (sp.flip) { sp.flip.t += dt; if (sp.flip.t > sp.flip.delay + 0.45) sp.flip = null; }
      if (sp.clear) { sp.clear.t += dt; if (sp.clear.t > sp.clear.delay + CLEAR_TIME) sp.clear = null; continue; }
      if (t.loc === 'gone') continue;
      var tg = targetOf(eng, t, slotIdx[i], tempIdx[i]);
      if (needSnap || !sp.ready) {
        sp.x = tg.x; sp.y = tg.y; sp.size = tg.s; sp.tw = null; sp.rot = 0; sp.air = false; sp.loc = t.loc; sp.ready = true;
      } else if (Math.abs(tg.x - sp.tgx) > 0.4 || Math.abs(tg.y - sp.tgy) > 0.4 || Math.abs(tg.s - sp.tgs) > 0.4) {
        var fly = t.loc !== sp.loc;
        var arc = !fly ? 0 : (t.loc === 'slot' || sp.loc === 'slot') && (t.loc === 'board' || sp.loc === 'board') ? lay.t * FLY_ARC : lay.cell * 0.5;
        sp.tw = { x0: sp.x, y0: sp.y, s0: sp.size, x1: tg.x, y1: tg.y, s1: tg.s, t: 0,
                  dur: fly ? eng.flyTime : SHIFT_TIME, fly: fly, arc: arc,
                  spin: fly ? (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.2) : 0 };
        sp.loc = t.loc;
      }
      sp.tgx = tg.x; sp.tgy = tg.y; sp.tgs = tg.s;
      if (sp.tw) {
        var w = sp.tw; w.t += dt;
        var p = clamp(w.t / w.dur, 0, 1), e = w.fly ? easeInOutSine(p) : easeOutBack(p);
        sp.x = lerp(w.x0, w.x1, e); sp.y = lerp(w.y0, w.y1, e) - (w.fly ? w.arc * Math.sin(Math.PI * p) : 0);
        sp.size = lerp(w.s0, w.s1, w.fly ? e : clamp(e, 0, 1.2)) * (w.fly ? 1 + 0.14 * Math.sin(Math.PI * p) : 1); sp.air = w.fly;
        sp.rot = w.spin * Math.sin(Math.PI * p);                                   // 飞行时微微转一下
        if (p >= 1) { sp.tw = null; sp.air = false; sp.rot = 0; sp.x = w.x1; sp.y = w.y1; sp.size = w.s1; }
      } else { sp.air = false; sp.rot = 0; sp.x = tg.x; sp.y = tg.y; sp.size = tg.s; }   // 没有补间时一定是正的
      // 压暗：被压住的牌变暗，露出来时轻轻“啵”一下
      var free = t.loc === 'board' && eng.isFree(i);
      var dimT = (t.loc === 'board' && !free) ? 1 : 0;
      sp.dim += (dimT - sp.dim) * Math.min(1, dt * 14);
      if (t.loc === 'board') {
        if (free && !sp.wasFree && sp.ready && sp.hadFree !== undefined) sp.pop = 1;
        sp.wasFree = free; sp.hadFree = true;
      }
      var hoverT = hoverId === i && free ? 1 : 0;
      sp.hover += (hoverT - sp.hover) * Math.min(1, dt * 16);
      if (sp.tw || Math.abs(dimT - sp.dim) > 0.01 || Math.abs(hoverT - sp.hover) > 0.01) busy = true;
      if (sp.land >= 0 || sp.pop > 0 || sp.shake > 0 || sp.flip || now < sp.introAt + 0.4) busy = true;
    }
    for (i = 0; i < sprites.length; i++) if (sprites[i].clear) { busy = true; break; }
    needSnap = false; busyFlag = false;
    return busy;                 // 还有动画在跑？空闲时 game.js 可以跳过重绘
  };
  View.invalidate = function () { busyFlag = true; };

  // ===================== 绘制 =====================
  function drawTray(eng, now) {
    var sh = trayShake > 0 ? Math.sin(trayShake * 40) * 5 * trayShake : 0;
    var x = lay.trayX, y = lay.trayY, w = lay.trayW, h = lay.trayH, i, p, half;
    ctx.save();
    ctx.translate(sh, 0);
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#d9a56b'); g.addColorStop(1, '#b5803f');
    rr(ctx, x, y + 3, w, h, 16); ctx.fillStyle = '#8a5a2a'; ctx.fill();                     // 托盘厚度
    rr(ctx, x, y, w, h, 16); ctx.fillStyle = g; ctx.fill();
    var danger = eng.slot.length >= 6 && eng.state === 'playing';
    if (danger) {
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,60,60,' + (0.45 + 0.45 * Math.sin(now * 9)) + ')';
      rr(ctx, x + 1.5, y + 1.5, w - 3, h - 3, 15); ctx.stroke();
    }
    var cs = lay.cell - 3;                     // 每个槽格的边长（格与格之间留 3px 缝）
    for (i = 0; i < 7; i++) {
      var cx0 = lay.wide ? x + 7 + 1.5 : x + 7 + i * lay.cell + 1.5;
      var cy0 = lay.wide ? y + 7 + i * lay.cell + 1.5 : y + 7 + 1.5;
      rr(ctx, cx0, cy0, cs, cs, 11); ctx.fillStyle = 'rgba(90,50,15,.30)'; ctx.fill();
      rr(ctx, cx0, cy0, cs, cs, 11); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,230,190,.35)'; ctx.stroke();
    }
    ctx.restore();
    // 暂存区的 3 个虚线格 + 标签
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(138,117,102,.6)';
    for (i = 0; i < 3; i++) {
      p = tempPos(i);
      rr(ctx, p.x - lay.tempCell / 2, p.y - lay.tempCell / 2, lay.tempCell, lay.tempCell, 10);
      ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fill(); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (!eng.temp.length) {
      ctx.fillStyle = 'rgba(138,117,102,.9)'; ctx.font = '700 11px "PingFang SC","Microsoft YaHei",sans-serif';
      if (lay.wide) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('暂存区', lay.tempX + lay.tempCell / 2, lay.tempY - 4); }
      else { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('暂存区', lay.tempX + 3 * (lay.tempCell + 8) + 2, lay.tempY + lay.tempCell / 2); }
    }
    ctx.restore();
  }

  function drawSprite(sp, t, now, shadow) {
    var type = t.type, sx = 1, sy = 1, size = sp.size, x = sp.x, y = sp.y, rot = sp.rot, alpha = 1, k;
    if (now < sp.introAt) return;
    k = clamp((now - sp.introAt) / 0.34, 0, 1);
    if (k < 1) size *= easeOutBack(k);
    if (sp.land >= 0) { var o = Math.sin(sp.land * Math.PI * 2.5) * Math.pow(1 - sp.land, 1.4); sx += 0.24 * o; sy -= 0.24 * o; }
    if (sp.pop > 0) size *= 1 + 0.13 * Math.sin((1 - sp.pop) * Math.PI);
    size *= 1 + 0.05 * sp.hover; y -= lay.t * 0.05 * sp.hover;
    if (sp.shake > 0) rot += Math.sin(sp.shake * 36) * sp.shake * 0.14;
    if (sp.flip) {
      var fp = (sp.flip.t - sp.flip.delay) / 0.4;
      if (fp >= 0 && fp < 1) { if (fp < 0.5) type = sp.flip.old; sx *= Math.max(0.04, Math.abs(Math.cos(fp * Math.PI))); y -= Math.sin(fp * Math.PI) * lay.t * 0.25; }
      else if (fp < 0) type = sp.flip.old;
    }
    if (sp.clear) {
      var c = sp.clear, p = (c.t - c.delay) / CLEAR_TIME;
      if (p < 0) { sy *= 1 + p * 0.5; sx *= 1 - p * 0.3; }       // 起跳前蓄力压扁
      else {
        var up = Math.sin(Math.min(1, p / 0.62) * Math.PI);
        y -= up * lay.t * 0.95; size *= 1 + 0.3 * up;
        rot += Math.sin(p * 44) * 0.24 * (1 - p);                // “哈哈哈”抖动
        sy *= 1 + 0.1 * Math.sin(p * 46);
        if (p > 0.62) { var sh = 1 - Math.pow((p - 0.62) / 0.38, 2); size *= Math.max(0, sh); alpha = Math.max(0, sh); }
      }
    }
    if (size < 1 || !cache[type]) return;
    var kf = size / cacheF, fx = cacheP * kf, fw = (cacheF + 2 * cacheP) * kf, fh = (cacheF + cacheD + 2 * cacheP) * kf;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sx, sy);
    if (shadow) { rr(ctx, -size / 2 + size * 0.04, -size / 2 + size * 0.1 + cacheD * kf, size, size, size * 0.17); ctx.fillStyle = 'rgba(70,40,15,.17)'; ctx.fill(); }
    ctx.drawImage(cache[type], -size / 2 - fx, -size / 2 - fx, fw, fh);
    if (sp.dim > 0.01) { rr(ctx, -size / 2, -size / 2, size, size, size * 0.17); ctx.fillStyle = 'rgba(60,38,24,' + (0.46 * sp.dim) + ')'; ctx.fill(); }
    ctx.restore();
  }

  View.draw = function (eng, now) {
    if (!lay) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawTray(eng, now);
    var i, sp, t, board = [], mid = [], air = [], clr = [];
    for (i = 0; i < sprites.length; i++) {
      sp = sprites[i]; t = eng.tiles[i];
      if (sp.clear) clr.push(i);
      else if (t.loc === 'gone') continue;
      else if (sp.air) air.push(i);
      else if (t.loc === 'board') board.push(i);
      else mid.push(i);
    }
    for (i = 0; i < board.length; i++) drawSprite(sprites[board[i]], eng.tiles[board[i]], now, true);
    for (i = 0; i < mid.length; i++) drawSprite(sprites[mid[i]], eng.tiles[mid[i]], now, false);
    for (i = 0; i < air.length; i++) drawSprite(sprites[air[i]], eng.tiles[air[i]], now, true);
    for (i = 0; i < clr.length; i++) drawSprite(sprites[clr[i]], eng.tiles[clr[i]], now, false);
  };

  // ===================== 命中检测 =====================
  // 返回 { kind:'temp'|'board'|'covered', id }。
  // 命中规则：先看暂存区；再在“没被压住”的牌里找（命中框比牌面略大，点在边缘/缝隙也算，取离手指最近的一张）；
  // 都没有时才看是不是点在被压住的牌上（kind:'covered'，只晃一下，不会入槽）。
  // 因为只在可点的牌里挑，手指点在“可点牌”与“被压住牌”的交界处时，永远命中可点的那张。
  View.hit = function (px, py, eng) {
    if (!lay) return null;
    var i, t, half, p, cx, cy, dx, dy, d;
    for (i = 0; i < eng.temp.length; i++) {
      p = tempPos(i); half = lay.tempCell / 2 + 2;
      if (Math.abs(px - p.x) <= half && Math.abs(py - p.y) <= half) return { kind: 'temp', id: eng.temp[i] };
    }
    var margin = Math.min(5, lay.t * 0.1), best = -1, bestD = 1e18;
    half = lay.t * FACE / 2 + margin;
    for (i = eng.tiles.length - 1; i >= 0; i--) {
      t = eng.tiles[i];
      if (t.loc !== 'board' || !eng.isFree(i)) continue;
      cx = lay.bx0 + (t.x + 1) * lay.t / 2; cy = lay.by0 + (t.y + 1) * lay.t / 2;
      dx = Math.abs(px - cx); dy = Math.abs(py - cy);
      if (dx <= half && dy <= half) { d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = i; } }
    }
    if (best >= 0) return { kind: 'board', id: best };
    half = lay.t * FACE / 2;
    for (i = eng.tiles.length - 1; i >= 0; i--) {
      t = eng.tiles[i];
      if (t.loc !== 'board') continue;
      cx = lay.bx0 + (t.x + 1) * lay.t / 2; cy = lay.by0 + (t.y + 1) * lay.t / 2;
      if (Math.abs(px - cx) <= half && Math.abs(py - cy) <= half) return { kind: 'covered', id: i };
    }
    return null;
  };

  // ===================== 事件钩子（game.js 调用）=====================
  View.onLand = function (id) { if (sprites[id]) sprites[id].land = 0; };
  View.shake = function (id) { if (sprites[id]) sprites[id].shake = 1; };
  View.shakeTray = function () { trayShake = 1; };
  View.startClear = function (ids) {
    ids.forEach(function (id, k) {
      var sp = sprites[id]; if (!sp) return;
      if (sp.tw) { sp.x = sp.tw.x1; sp.y = sp.tw.y1; sp.size = sp.tw.s1; sp.tw = null; }
      sp.air = false; sp.dim = 0; sp.clear = { t: 0, delay: 0.06 * k };
    });
  };
  View.onShuffle = function (ev) {
    var k = 0;
    ev.ids.forEach(function (id) { if (sprites[id]) sprites[id].flip = { t: 0, delay: (k++) * 0.012, old: ev.old[id] }; });
  };
  View.center = function (id) { var sp = sprites[id]; return sp ? { x: sp.x, y: sp.y } : { x: W / 2, y: H / 2 }; };
  View.slotCenter = function (i) { return slotPos(i); };
  View.layout = function () { return lay; };
  View.size = function () { return { w: W, h: H }; };
  View.CLEAR_TIME = CLEAR_TIME;
  View.debugSprites = function () { return sprites; };   // 自测用

  root.SheepView = View;
})(window);
