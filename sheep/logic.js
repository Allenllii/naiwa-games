/* 奶了个奶 · 纯逻辑层（与 DOM 解耦，node 里也能跑）
 * 内容：随机数 / 关卡参数 / 牌的布局生成 / “反向构造”造型分配（保证每关有解）
 * 坐标单位 = 半张牌：一张牌是 2×2 的方块，(x,y) 为左上角，z 为层号（越大越靠上）。 */
(function (root) {
  'use strict';

  // ===================== 关键常量（调参入口）=====================
  var SLOT_CAP = 7;      // 槽位数
  var TEMP_CAP = 3;      // 暂存区容量
  var TS = 2;            // 牌的边长（半牌单位）
  var NUM_TYPES = 9;     // 造型总数（view 里有对应的图片和底色）
  var MAX_OPEN = 4;      // 解法里“同时开着”的造型上限；占用到 5 张时强制先凑齐对子，槽位占用（消除后）永远 ≤ 6
  var P_FINISH = 0.55;   // 解法里优先凑齐对子的概率（越大，解法越“规矩”，关卡越容易）
  var P_CONTINUE = 0.55; // 解法里继续已开造型（而不是开新造型）的概率

  // 每关参数：cols/rows 棋盘宽高（整张牌为单位）；types 造型数；count 总牌数（3 的倍数）；
  // layers 层数范围；k 解法里同时“开着”的造型数（越大越有迷惑性）；
  // maxAbove 每张牌最多被几张牌直接压住（控制遮挡量）；centers 牌堆数量；jitter 边缘随机度；
  // pFinish/pCont 解法的“规矩程度”（越小，同款牌在解法里散得越开）；
  // deep/shallow 同款牌的“深浅错落”（1 = 新开的造型放浅处、后续的牌放深处，要挖才能凑齐）
  var BASE_LEVELS = {
    1: { cols: 5, rows: 6,   types: 4, count: 36, layers: [3, 4], k: 1, maxAbove: 2,  centers: 1, jitter: 0.5, pFinish: 0.55, pCont: 0.55, deep: 0,   shallow: 0 },
    2: { cols: 7, rows: 7.5, types: 8, count: 72, layers: [6, 6], k: 3, maxAbove: 99, centers: 2, jitter: 0.9, pFinish: 0.5,  pCont: 0.5,  deep: 0.8, shallow: 0.8 },
    3: { cols: 7, rows: 7.5, types: 9, count: 84, layers: [7, 7], k: 4, maxAbove: 99, centers: 2, jitter: 1.0, pFinish: 0.4,  pCont: 0.4,  deep: 1,   shallow: 1 }
  };

  // ===================== 小工具 =====================
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function ri(rng, n) { return Math.floor(rng() * n); }
  function choice(rng, arr) { return arr[ri(rng, arr.length)]; }
  function shuffleInPlace(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = ri(rng, i + 1), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function overlaps(a, b) { return Math.abs(a.x - b.x) < TS && Math.abs(a.y - b.y) < TS; }

  // ===================== 关卡参数 =====================
  function levelConfig(level) {
    level = Math.max(1, level | 0);
    var c = {}, k;
    if (BASE_LEVELS[level]) {
      for (k in BASE_LEVELS[level]) c[k] = BASE_LEVELS[level][k];
    } else {
      var e = level - 3; // 第 4 关起：无尽模式，逐关递增（有上限）
      c = {
        cols: 7, rows: 7.5, types: NUM_TYPES,
        count: Math.min(132, 84 + 12 * e),
        layers: [Math.min(9, 7 + Math.floor(e / 3)), Math.min(9, 8 + Math.floor(e / 3))],
        k: 4, maxAbove: 99, centers: 3, jitter: 1.1, deep: 1, shallow: 1,
        pFinish: Math.max(0.2, 0.4 - 0.04 * e), pCont: Math.max(0.2, 0.4 - 0.04 * e),   // 越往后同款牌在解法里散得越开
        tourn: Math.min(12, 3 + 2 * e)                                                   // 越往后“浅开深收”越极端
      };
    }
    c.level = level;
    return c;
  }

  // ===================== 布局生成 =====================
  // 先决定每层放多少张（金字塔式递减），再按“离牌堆中心的距离 + 随机抖动”挑格子，
  // 同一层的牌落在整格上（互不重叠），相邻层错开半张牌（形成压叠）。
  function generateLayout(cfg, rng) {
    var BW = Math.round(cfg.cols * 2), BH = Math.round(cfg.rows * 2);
    var nLayers = cfg.layers[0] + ri(rng, cfg.layers[1] - cfg.layers[0] + 1);
    var offs = [[0, 0], [1, 1], [1, 0], [0, 1]];   // 4 种整格错位（半牌单位）
    var N = cfg.count, z, i;

    // 每层目标张数
    var w = [], sw = 0, quota = [], got = 0;
    for (z = 0; z < nLayers; z++) { w[z] = (nLayers - z) * (0.9 + 0.2 * rng()); sw += w[z]; }
    for (z = 0; z < nLayers; z++) { quota[z] = Math.round(N * w[z] / sw); got += quota[z]; }
    quota[0] += N - got;

    // 牌堆中心（半牌单位）：多个中心时互相拉开距离
    var centers = [];
    for (i = 0; i < cfg.centers; i++) {
      var best = null, bestD = -1;
      for (var tries = 0; tries < 12; tries++) {
        var cx = BW * (cfg.centers === 1 ? 0.5 + (rng() - 0.5) * 0.1 : 0.27 + rng() * 0.46);
        var cy = BH * (cfg.centers === 1 ? 0.5 + (rng() - 0.5) * 0.1 : 0.25 + rng() * 0.5);
        var d = 1e9;
        for (var j = 0; j < centers.length; j++) d = Math.min(d, Math.hypot(cx - centers[j].x, cy - centers[j].y));
        if (d > bestD) { bestD = d; best = { x: cx, y: cy, sx: 0.85 + rng() * 0.4, sy: 0.85 + rng() * 0.4 }; }
      }
      centers.push(best);
    }

    var placed = [], usedXY = {};
    var cap = cfg.maxAbove || 99;

    // 能否放下：不与已有牌同位置/同层重叠；不让任何牌被压住的张数超过 cap
    function canPlace(t, capNow) {
      var myAbove = 0;
      for (var q = 0; q < placed.length; q++) {
        var p = placed[q];
        if (!overlaps(t, p)) continue;
        if (p.z === t.z) return false;
        if (p.x === t.x && p.y === t.y) return false;
        if (p.z < t.z) { if (p.ac + 1 > capNow) return false; }
        else { myAbove++; if (myAbove > capNow) return false; }
      }
      return true;
    }
    function place(t) {
      var myAbove = 0;
      for (var q = 0; q < placed.length; q++) {
        var p = placed[q];
        if (!overlaps(t, p)) continue;
        if (p.z < t.z) p.ac++; else myAbove++;
      }
      t.ac = myAbove;
      usedXY[t.x + "," + t.y] = true;
      placed.push(t);
    }
    function cellsOf(layer, li) {                    // 第 li 种错位的整格坐标
      var o = offs[li], out = [];
      for (var x = o[0]; x <= BW - TS; x += TS)
        for (var y = o[1]; y <= BH - TS; y += TS) out.push({ x: x, y: y, z: layer });
      return out;
    }
    function freeCount(li) {                         // 这种错位里还有多少格没被（任何层）占用
      var n = 0, o = offs[li];
      for (var x = o[0]; x <= BW - TS; x += TS)
        for (var y = o[1]; y <= BH - TS; y += TS) if (!usedXY[x + ',' + y]) n++;
      return n;
    }

    // 逐层（自下而上）挑格子
    var prevLi = -1;
    for (z = 0; z < nLayers && placed.length < N; z++) {
      // 与上一层错开；在剩余空格最多的错位里选（层数多时避免同一错位被前面的层占满）
      var li = 0, bestScore = -1;
      for (var l2 = 0; l2 < 4; l2++) {
        if (l2 === prevLi) continue;
        var sc = freeCount(l2) + rng() * 4;
        if (sc > bestScore) { bestScore = sc; li = l2; }
      }
      prevLi = li;
      var cells = cellsOf(z, li), metric = rng();
      cells.forEach(function (c) {
        var best = 1e9;
        for (var m = 0; m < centers.length; m++) {
          var ux = (c.x + 1 - centers[m].x) / 2 / centers[m].sx, uy = (c.y + 1 - centers[m].y) / 2 / centers[m].sy;
          var dd = metric < 0.4 ? Math.hypot(ux, uy) : metric < 0.7 ? Math.max(Math.abs(ux), Math.abs(uy)) * 1.15 : (Math.abs(ux) + Math.abs(uy)) * 0.78;
          best = Math.min(best, dd);
        }
        c.s = best + rng() * cfg.jitter;
      });
      cells.sort(function (a, b) { return a.s - b.s; });
      var taken = 0;
      for (i = 0; i < cells.length && taken < quota[z] && placed.length < N; i++) {
        if (canPlace(cells[i], cap)) { place(cells[i]); taken++; }
      }
    }
    // 不够数：在各层空格里随机补（先守遮挡上限，实在补不满再放宽）
    for (var pass = 0; pass < 2 && placed.length < N; pass++) {
      var pool = [];
      for (z = 0; z < nLayers; z++) for (var l3 = 0; l3 < 4; l3++) pool = pool.concat(cellsOf(z, l3));
      shuffleInPlace(pool, rng);
      for (i = 0; i < pool.length && placed.length < N; i++) {
        if (canPlace(pool[i], pass === 0 ? cap : 99)) place(pool[i]);
      }
    }
    // 编号：按 层→行→列 排序，id 越大越靠上（方便绘制与调试）
    placed.sort(function (a, b) { return a.z - b.z || a.y - b.y || a.x - b.x; });
    return placed.map(function (t, id) { return { id: id, x: t.x, y: t.y, z: t.z }; });
  }

  // 压叠关系：above[i] = 压在 i 上面且与 i 相交的牌；below[i] = 被 i 压住的牌
  function computeRelations(tiles) {
    var above = tiles.map(function () { return []; }), below = tiles.map(function () { return []; });
    for (var i = 0; i < tiles.length; i++) {
      for (var j = i + 1; j < tiles.length; j++) {
        if (!overlaps(tiles[i], tiles[j])) continue;
        var hi = tiles[i].z > tiles[j].z ? i : j, lo = hi === i ? j : i;
        if (tiles[i].z === tiles[j].z) continue; // 同层不会相交；防御
        above[lo].push(hi); below[hi].push(lo);
      }
    }
    return { above: above, below: below };
  }

  // ===================== 反向构造：给牌分配造型（保证有解）=====================
  // 思路：假想玩家按某个顺序点牌——每一步只点“当前未被压住”的牌，
  // 同时“开着”的造型不超过 k 种（每种槽里最多 2 张），第 3 张一到就消除；
  // 我们边“点”边给被点的牌分配造型，于是这条点击顺序一定能通关。
  // ctx: { ids, above, below, budget[type]=要分配的张数, open[type]=槽/暂存区里已有张数, k, rng }
  function planTypes(ctx) {
    var rng = ctx.rng, k = Math.min(ctx.k || 1, MAX_OPEN), T = ctx.budget.length;
    var pFinish = ctx.pFinish == null ? P_FINISH : ctx.pFinish, pCont = ctx.pCont == null ? P_CONTINUE : ctx.pCont;
    var deep = ctx.deep || 0, shallow = ctx.shallow || 0, tourn = ctx.tourn || 3;
    var ids = ctx.ids, above = ctx.above, below = ctx.below, X, i;
    var inSet = {};
    ids.forEach(function (id) { inSet[id] = true; });
    var budget = ctx.budget.slice(), cnt = [], occ = 0;
    for (X = 0; X < T; X++) { cnt[X] = ((ctx.open && ctx.open[X]) || 0) % 3; occ += cnt[X]; }
    for (X = 0; X < T; X++) if ((budget[X] + cnt[X]) % 3 !== 0) return null; // 张数必须能凑成整组

    var blockers = {}, unc = [];
    ids.forEach(function (id) {
      var n = 0;
      for (i = 0; i < above[id].length; i++) if (inSet[above[id][i]]) n++;
      blockers[id] = n;
      if (n === 0) unc.push(id);
    });

    // 初始“挖掘深度”：要先拿走多少层牌才轮到它（偏好：新开的造型放在浅处，后续的牌放在深处 → 同款牌散在不同深度，更难）
    var chain = {};
    function chainOf(id) {
      if (chain[id] !== undefined) return chain[id];
      var m = 0;
      for (var q = 0; q < above[id].length; q++) { var a = above[id][q]; if (inSet[a]) m = Math.max(m, chainOf(a) + 1); }
      return (chain[id] = m);
    }
    ids.forEach(chainOf);

    var assign = {}, order = [], peak = occ, left = ids.length;
    while (left > 0) {
      if (!unc.length) return null;
      var singles = [], pairs = [], closed = [];
      for (X = 0; X < T; X++) {
        if (cnt[X] === 1) singles.push(X);
        else if (cnt[X] === 2) pairs.push(X);
        else if (budget[X] >= 3) closed.push(X);
      }
      var openT = singles.concat(pairs);
      var canOpen = openT.length < k && occ + 1 <= SLOT_CAP - 1 && closed.length > 0;
      var pick = -1;
      if (pairs.length && (occ >= SLOT_CAP - 2 || rng() < pFinish)) pick = choice(rng, pairs);
      else if (openT.length && (!canOpen || rng() < pCont)) pick = choice(rng, openT);
      else if (canOpen) {
        var tot = 0; closed.forEach(function (c) { tot += budget[c]; });
        var r = rng() * tot;
        for (i = 0; i < closed.length; i++) { r -= budget[closed[i]]; if (r <= 0) { pick = closed[i]; break; } }
        if (pick < 0) pick = closed[closed.length - 1];
      } else if (openT.length) pick = choice(rng, openT);
      else return null;

      // 随机挑一张当前未被压住的牌来承载这个造型
      var j = ri(rng, unc.length), cont = cnt[pick] > 0, bias = cont ? deep : shallow;
      if (bias && rng() < bias) {          // 锦标赛：多抽几张，挑最深/最浅的
        for (var tt = 1; tt < tourn; tt++) {
          var j2 = ri(rng, unc.length);
          if (cont ? chain[unc[j2]] > chain[unc[j]] : chain[unc[j2]] < chain[unc[j]]) j = j2;
        }
      }
      var id = unc[j];
      unc[j] = unc[unc.length - 1]; unc.pop();
      assign[id] = pick; order.push(id);
      budget[pick]--;
      peak = Math.max(peak, occ + 1);
      if (cnt[pick] === 2) { cnt[pick] = 0; occ -= 2; } else { cnt[pick]++; occ++; }
      for (i = 0; i < below[id].length; i++) {
        var b = below[id][i];
        if (inSet[b] && --blockers[b] === 0) unc.push(b);
      }
      left--;
    }
    return { assign: assign, order: order, peak: peak };
  }

  // 把 R 组（每组 3 张）分给 T 种造型：每种至少 1 组，其余随机，所以张数是 3/6/9/12…
  function distributeTriples(R, T, rng) {
    var c = [], w = [], i;
    for (i = 0; i < T; i++) { c[i] = 1; w[i] = 0.4 + rng(); }
    var cap = Math.max(2, Math.ceil(R / T) * 2), extra = R - T;
    while (extra > 0) {
      var tot = 0;
      for (i = 0; i < T; i++) if (c[i] < cap) tot += w[i];
      var r = rng() * tot, pick = -1;
      for (i = 0; i < T; i++) { if (c[i] >= cap) continue; pick = i; r -= w[i]; if (r <= 0) break; }
      c[pick]++; extra--;
    }
    return c.map(function (n) { return n * 3; });
  }

  // ===================== 生成整关 =====================
  function generateLevel(level, seed, override) {
    var cfg = levelConfig(level), rng = mulberry32(seed), ok;
    if (override) for (ok in override) cfg[ok] = override[ok];
    var tiles = generateLayout(cfg, rng);
    var rel = computeRelations(tiles);
    var typeIds = shuffleInPlace(range(NUM_TYPES), rng).slice(0, cfg.types);
    var budget = distributeTriples(tiles.length / 3, cfg.types, rng);
    var res = planTypes({ ids: tiles.map(function (t) { return t.id; }), above: rel.above, below: rel.below,
                          budget: budget, open: null, k: cfg.k, rng: rng,
                          pFinish: cfg.pFinish, pCont: cfg.pCont, deep: cfg.deep, shallow: cfg.shallow, tourn: cfg.tourn });
    if (!res) throw new Error('planTypes failed');
    var counts = {};
    tiles.forEach(function (t) {
      t.type = typeIds[res.assign[t.id]];
      counts[t.type] = (counts[t.type] || 0) + 1;
    });
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    tiles.forEach(function (t) {
      minX = Math.min(minX, t.x); minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + TS); maxY = Math.max(maxY, t.y + TS);
    });
    return { level: cfg.level, seed: seed, cfg: cfg, tiles: tiles, order: res.order, typeIds: typeIds,
             counts: counts, peak: res.peak, bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } };
  }
  function range(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }

  var api = {
    SLOT_CAP: SLOT_CAP, TEMP_CAP: TEMP_CAP, TS: TS, NUM_TYPES: NUM_TYPES, MAX_OPEN: MAX_OPEN,
    mulberry32: mulberry32, shuffleInPlace: shuffleInPlace, overlaps: overlaps,
    levelConfig: levelConfig, generateLayout: generateLayout, computeRelations: computeRelations,
    planTypes: planTypes, distributeTriples: distributeTriples, generateLevel: generateLevel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SheepLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
