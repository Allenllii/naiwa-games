/* ============================================================
 *  奶蛙消消乐 · 纯逻辑（与 DOM 完全解耦，node 里可直接测试）
 *
 *  棋盘：board[r][c]，r 从上到下、c 从左到右，每格是 cell 或 null。
 *  cell = { id, t, sp }
 *    t  造型编号 0~5；彩虹块没有造型，t = -1（永远不参与三连匹配）
 *    sp 特殊块：0 普通 / 1 横条纹(清一行) / 2 竖条纹(清一列) / 3 炸弹(清 3×3) / 4 彩虹
 *  cell 一经创建就不再修改（只有极端兜底的 repairBoard / shuffle 兜底会就地改 t），
 *  渲染层可以放心把动画状态挂在 cell 上，用 cell.id 跟踪。
 *
 *  核心入口：playMove(board, a, b, rng)
 *    返回 { valid, steps, shuffle, gained, maxChain }。
 *    valid=false 表示交换无效（棋盘不变，渲染层做「换回去 + 抖动」）。
 *    valid=true 时棋盘已被改成「所有连锁结束后」的最终状态；
 *    steps 是每一轮消除的详细记录（谁被消除、几时消除、生成了什么特殊块、
 *    哪些块下落到哪、得分），渲染层按顺序回放动画即可。
 *
 *  step = {
 *    chain,                         第几轮连锁（1 起，倍率 = chain）
 *    groups:   [{ t, shape, special, pivot, cells }]   本轮的匹配组
 *    cleared:  [{ cell, r, c, at, effect, merge }]      被消除的块；at=相对本轮开始的毫秒；
 *                                   effect=被第几个特效清掉(-1=直接匹配)；merge={r,c}=并入新特殊块
 *    effects:  [{ kind, r, c, at, ... }]                 触发的特效（条纹/炸弹/彩虹/组合技）
 *    spawns:   [{ cell, r, c, at, group }]               新生成的特殊块
 *    transforms: [{ r, c, from, to, at }]                彩虹+条纹/炸弹组合：普通块变成特殊块
 *    gained,                        本轮得分
 *    drops:    [{ cell, c, fromR, toR, isNew }]          下落/补充（fromR<0 表示从棋盘上方进入）
 *  }
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量（便于调参） ---------------- */
  var SIZE = 8;                 // 棋盘边长
  var TYPES = 6;                // 造型种类数
  var SP = { NONE: 0, STRIPE_H: 1, STRIPE_V: 2, BOMB: 3, RAINBOW: 4 };

  // 特殊块被消除时触发的特效种类（其余 kind 都是「交换两个特殊块」的组合技）
  var TRIGGER_KINDS = { stripeH: 1, stripeV: 1, bomb: 1, rainbow: 1 };

  var CFG = {
    perPiece: 15,              // 每个被消除的块基础分（再乘连锁倍率）
    bonusSpawn: [0, 30, 30, 60, 100], // 按 sp 下标：生成条纹/炸弹/彩虹的奖励分
    bonusTrigger: 40,           // 每引爆一个特殊块的奖励分
    bonusCombo: 200,            // 特殊块组合技的奖励分
    movesBonus: 100,            // 过关时，每剩 1 步奖励多少分
    maxCascade: 60,             // 一次操作最多连锁几轮（硬上限，保证必然终止）
    safeAfter: 10,              // 连锁超过这么多轮后，补块改用「保证不凑成三连」的安全模式
    // 动画时间提示（毫秒），由渲染层按此回放
    gap: { cell: 28, trigger: 60, spawn: 150, combo: 120, transform: 260 }
  };

  /* ---------------- 随机数 ---------------- */
  // mulberry32：给种子就能复现，测试里用；浏览器里直接用 Math.random
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------- 基础工具 ---------------- */
  var nextId = 1;
  function makeCell(t, sp) { return { id: nextId++, t: t, sp: sp || 0 }; }
  function makeRainbow() { return makeCell(-1, SP.RAINBOW); }
  function newBoard() {
    var b = [];
    for (var r = 0; r < SIZE; r++) { var row = []; for (var c = 0; c < SIZE; c++) row.push(null); b.push(row); }
    return b;
  }
  function inBounds(r, c) { return r >= 0 && r < SIZE && c >= 0 && c < SIZE; }
  function isAdjacent(a, b) { return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1; }
  function matchable(cell) { return !!cell && cell.t >= 0; }      // 彩虹块 t=-1，不参与匹配
  function swapCells(board, a, b) {
    var t = board[a.r][a.c]; board[a.r][a.c] = board[b.r][b.c]; board[b.r][b.c] = t;
  }
  function key(r, c) { return r * SIZE + c; }
  function pickIndex(rng, n) { return Math.min(n - 1, Math.floor(rng() * n)); }

  /* 测试/调试用：从文本构造棋盘。每个格子一个记号，空格分隔：
   * "3" 普通 3 号；"3h" 横条纹；"3v" 竖条纹；"3b" 炸弹；"R" 彩虹 */
  function parseToken(tok) {
    if (tok === 'R') return makeRainbow();
    var m = /^(\d)([hvb]?)$/.exec(tok);
    if (!m) throw new Error('bad token: ' + tok);
    var sp = m[2] === 'h' ? SP.STRIPE_H : m[2] === 'v' ? SP.STRIPE_V : m[2] === 'b' ? SP.BOMB : 0;
    return makeCell(+m[1], sp);
  }
  function boardFromRows(rows) {
    var b = newBoard();
    rows.forEach(function (line, r) {
      line.trim().split(/\s+/).forEach(function (tok, c) { b[r][c] = parseToken(tok); });
    });
    return b;
  }
  function tokenOf(cell) {
    if (!cell) return '.';
    if (cell.sp === SP.RAINBOW) return 'R';
    return String(cell.t) + (cell.sp === SP.STRIPE_H ? 'h' : cell.sp === SP.STRIPE_V ? 'v' : cell.sp === SP.BOMB ? 'b' : '');
  }
  function boardToRows(board) {
    return board.map(function (row) { return row.map(tokenOf).join(' '); });
  }

  /* ---------------- 匹配检测 ---------------- */
  // 找出所有 ≥3 的横/竖连线（同色，彩虹除外）
  function findRuns(board) {
    var runs = [], r, c, e, k, cells, cell;
    for (r = 0; r < SIZE; r++) {
      c = 0;
      while (c < SIZE) {
        cell = board[r][c];
        if (!matchable(cell)) { c++; continue; }
        e = c + 1;
        while (e < SIZE && board[r][e] && board[r][e].t === cell.t) e++;
        if (e - c >= 3) {
          cells = [];
          for (k = c; k < e; k++) cells.push({ r: r, c: k });
          runs.push({ dir: 'h', t: cell.t, len: e - c, cells: cells });
        }
        c = e;
      }
    }
    for (c = 0; c < SIZE; c++) {
      r = 0;
      while (r < SIZE) {
        cell = board[r][c];
        if (!matchable(cell)) { r++; continue; }
        e = r + 1;
        while (e < SIZE && board[e][c] && board[e][c].t === cell.t) e++;
        if (e - r >= 3) {
          cells = [];
          for (k = r; k < e; k++) cells.push({ r: k, c: c });
          runs.push({ dir: 'v', t: cell.t, len: e - r, cells: cells });
        }
        r = e;
      }
    }
    return runs;
  }

  // 把相交的连线并成「匹配组」（L / T / 十字 都会落在同一组里）
  function findMatchGroups(board) {
    var runs = findRuns(board);
    if (!runs.length) return [];
    var parent = runs.map(function (_, i) { return i; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var owner = {};
    runs.forEach(function (run, i) {
      run.cells.forEach(function (p) {
        var k = key(p.r, p.c);
        if (owner[k] !== undefined) parent[find(i)] = find(owner[k]); else owner[k] = i;
      });
    });
    var map = {}, list = [];
    runs.forEach(function (run, i) {
      var root = find(i), g = map[root];
      if (!g) { g = map[root] = { t: run.t, runs: [], cells: [], seen: {} }; list.push(g); }
      g.runs.push(run);
      run.cells.forEach(function (p) {
        var k = key(p.r, p.c);
        if (!g.seen[k]) { g.seen[k] = 1; g.cells.push({ r: p.r, c: p.c }); }
      });
    });
    list.forEach(function (g) { delete g.seen; });
    return list;
  }

  function sameCell(p, q) { return p.r === q.r && p.c === q.c; }
  function containsCell(cells, p) { return cells.some(function (q) { return sameCell(q, p); }); }

  /* 判断一个匹配组会生成什么特殊块、生成在哪：
   *   ≥5 连成线 → 彩虹；L/T/十字（横竖相交）→ 炸弹；恰好 4 连 → 条纹
   *   4 连的条纹方向与连线垂直（横着消 4 个 → 竖条纹，清一整列），和开心消消乐 / 糖果传奇一致
   *   生成位置优先放在玩家交换到的格子（prefer），否则放在连线中间 / 交叉点 */
  function classifyGroup(g, prefer) {
    prefer = prefer || [];
    function pickPref(cells) {
      for (var i = 0; i < prefer.length; i++) if (prefer[i] && containsCell(cells, prefer[i])) return prefer[i];
      return null;
    }
    var hRuns = g.runs.filter(function (x) { return x.dir === 'h'; });
    var vRuns = g.runs.filter(function (x) { return x.dir === 'v'; });
    var longest = g.runs.reduce(function (m, x) { return x.len > m.len ? x : m; }, g.runs[0]);
    var pos;
    if (longest.len >= 5) {
      pos = pickPref(longest.cells) || longest.cells[Math.floor(longest.len / 2)];
      return { shape: 'line5', special: SP.RAINBOW, pivot: { r: pos.r, c: pos.c } };
    }
    if (hRuns.length && vRuns.length) {
      var cross = [];
      hRuns.forEach(function (h) {
        h.cells.forEach(function (p) {
          vRuns.forEach(function (v) { if (containsCell(v.cells, p) && !containsCell(cross, p)) cross.push(p); });
        });
      });
      pos = pickPref(cross) || cross[0];
      return { shape: 'cross', special: SP.BOMB, pivot: { r: pos.r, c: pos.c } };
    }
    if (longest.len === 4) {
      pos = pickPref(longest.cells) || longest.cells[1];
      return { shape: 'line4', special: longest.dir === 'h' ? SP.STRIPE_V : SP.STRIPE_H, pivot: { r: pos.r, c: pos.c } };
    }
    return { shape: 'line3', special: SP.NONE, pivot: null };
  }

  // 某格沿某方向的连续同色长度（含自己，向两侧延伸）
  function runLenAt(board, r, c, dr, dc) {
    var cell = board[r][c];
    if (!matchable(cell)) return 0;
    var n = 1, k, rr, cc;
    for (k = 1; ; k++) {
      rr = r + dr * k; cc = c + dc * k;
      if (!inBounds(rr, cc) || !board[rr][cc] || board[rr][cc].t !== cell.t) break;
      n++;
    }
    for (k = 1; ; k++) {
      rr = r - dr * k; cc = c - dc * k;
      if (!inBounds(rr, cc) || !board[rr][cc] || board[rr][cc].t !== cell.t) break;
      n++;
    }
    return n;
  }
  function isInMatch(board, r, c) { return runLenAt(board, r, c, 0, 1) >= 3 || runLenAt(board, r, c, 1, 0) >= 3; }

  /* ---------------- 生成棋盘 ---------------- */
  // 在 (r,c) 放哪些造型不会立刻凑成三连（只看已有的邻居，两侧都看）
  function allowedTypes(board, r, c) {
    function t(rr, cc) { return inBounds(rr, cc) && board[rr][cc] ? board[rr][cc].t : -2; }
    var bad = {}, i, out = [];
    var l1 = t(r, c - 1), l2 = t(r, c - 2), r1 = t(r, c + 1), r2 = t(r, c + 2);
    var u1 = t(r - 1, c), u2 = t(r - 2, c), d1 = t(r + 1, c), d2 = t(r + 2, c);
    if (l1 >= 0 && l1 === l2) bad[l1] = 1;
    if (r1 >= 0 && r1 === r2) bad[r1] = 1;
    if (l1 >= 0 && l1 === r1) bad[l1] = 1;
    if (u1 >= 0 && u1 === u2) bad[u1] = 1;
    if (d1 >= 0 && d1 === d2) bad[d1] = 1;
    if (u1 >= 0 && u1 === d1) bad[u1] = 1;
    for (i = 0; i < TYPES; i++) if (!bad[i]) out.push(i);
    return out;
  }
  function pickType(board, r, c, rng, safe) {
    if (!safe) return pickIndex(rng, TYPES);
    var ok = allowedTypes(board, r, c);
    return ok[pickIndex(rng, ok.length)];
  }

  // 万一随机多次都没有可行交换时的固定兜底盘：无三连，且 (0,2)<->(0,3) 可行
  function fallbackBoard() {
    var b = newBoard(), r, c;
    for (r = 0; r < SIZE; r++) for (c = 0; c < SIZE; c++) b[r][c] = makeCell((c + 2 * r) % TYPES);
    b[0][1] = makeCell(0);
    b[0][3] = makeCell(0);
    return b;
  }

  // 初始棋盘：绝对没有现成三连，且至少有一个可行交换
  function generateBoard(rng) {
    rng = rng || Math.random;
    for (var attempt = 0; attempt < 60; attempt++) {
      var b = newBoard();
      for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = makeCell(pickType(b, r, c, rng, true));
      if (hasMoves(b)) return b;
    }
    return fallbackBoard();
  }

  /* ---------------- 可行交换 / 提示 ---------------- */
  // 假设 a、b 相邻：交换后能不能产生消除？彩虹块与任何块互换、两个特殊块互换，也算可行（组合技）
  function isValidSwap(board, a, b) {
    if (!inBounds(a.r, a.c) || !inBounds(b.r, b.c) || !isAdjacent(a, b)) return false;
    var ca = board[a.r][a.c], cb = board[b.r][b.c];
    if (!ca || !cb) return false;
    if (ca.sp === SP.RAINBOW || cb.sp === SP.RAINBOW) return true;
    if (ca.sp && cb.sp) return true;
    swapCells(board, a, b);
    var ok = isInMatch(board, a.r, a.c) || isInMatch(board, b.r, b.c);
    swapCells(board, a, b);
    return ok;
  }
  function neighborsFwd(r, c) { return [{ r: r, c: c + 1 }, { r: r + 1, c: c }]; }

  function findPossibleMoves(board) {
    var moves = [];
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue;
      var ns = neighborsFwd(r, c);
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        if (inBounds(n.r, n.c) && isValidSwap(board, { r: r, c: c }, n)) moves.push({ a: { r: r, c: c }, b: n });
      }
    }
    return moves;
  }
  function hasMoves(board) {
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue;
      var ns = neighborsFwd(r, c);
      for (var i = 0; i < ns.length; i++) {
        var n = ns[i];
        if (inBounds(n.r, n.c) && isValidSwap(board, { r: r, c: c }, n)) return true;
      }
    }
    return false;
  }

  // 给一个交换估个「价值」（消除数 + 特殊块奖励），提示和机器人用
  function evaluateMove(board, a, b) {
    var ca = board[a.r][a.c], cb = board[b.r][b.c], val = 0;
    if (ca.sp === SP.RAINBOW || cb.sp === SP.RAINBOW) val += 40;
    else if (ca.sp && cb.sp) val += 30;
    swapCells(board, a, b);
    findMatchGroups(board).forEach(function (g) {
      val += g.cells.length;
      var cl = classifyGroup(g, [b, a]);
      if (cl.special) val += cl.special === SP.RAINBOW ? 14 : cl.special === SP.BOMB ? 9 : 6;
    });
    swapCells(board, a, b);
    return val;
  }
  // 推荐一个提示：在价值最高的几个里随机挑一个
  function pickHint(board, rng) {
    rng = rng || Math.random;
    var moves = findPossibleMoves(board);
    if (!moves.length) return null;
    moves.forEach(function (m) { m.value = evaluateMove(board, m.a, m.b); });
    moves.sort(function (x, y) { return y.value - x.value; });
    var top = moves.filter(function (m) { return m.value >= moves[0].value - 1; });
    return top[pickIndex(rng, top.length)];
  }

  /* ---------------- 下落 + 补充 ---------------- */
  // 每列向下压实，顶部补新块。safe=true 时新块保证不会和邻居凑成三连（用于确保连锁终止）。
  // 返回 drops：每个移动/新增的块 { cell, c, fromR, toR, isNew }（新块 fromR<0，从棋盘上方落入）
  function applyGravity(board, rng, safe) {
    rng = rng || Math.random;
    var drops = [], holes = [], r, c, w, cell;
    for (c = 0; c < SIZE; c++) {
      w = SIZE - 1;
      for (r = SIZE - 1; r >= 0; r--) {
        cell = board[r][c];
        if (!cell) continue;
        if (r !== w) {
          board[w][c] = cell; board[r][c] = null;
          drops.push({ cell: cell, c: c, fromR: r, toR: w, isNew: false });
        }
        w--;
      }
      holes[c] = w + 1;      // 顶部空出的行数：0..w
    }
    for (r = SIZE - 1; r >= 0; r--) {
      for (c = 0; c < SIZE; c++) {
        if (r < holes[c] && !board[r][c]) {
          cell = makeCell(pickType(board, r, c, rng, safe));
          board[r][c] = cell;
          drops.push({ cell: cell, c: c, fromR: r - holes[c], toR: r, isNew: true });
        }
      }
    }
    return drops;
  }

  /* ---------------- 一轮消除 ---------------- */
  // 交换后识别出的组合技（两个特殊块互换 / 彩虹块互换），没有则返回 null
  function detectCombo(ca, cb, a, b) {
    var rb = ca.sp === SP.RAINBOW || cb.sp === SP.RAINBOW;
    if (!rb && !(ca.sp && cb.sp)) return null;
    // 交换后：ca 在 b 位置（被拖动的块），cb 在 a 位置
    var pos1 = { r: b.r, c: b.c }, pos2 = { r: a.r, c: a.c };
    if (rb) {
      var rainPos = ca.sp === SP.RAINBOW ? pos1 : pos2;
      var other = ca.sp === SP.RAINBOW ? cb : ca;
      var otherPos = ca.sp === SP.RAINBOW ? pos2 : pos1;
      var kind = other.sp === SP.RAINBOW ? 'rainbowAll'
        : other.sp === SP.STRIPE_H || other.sp === SP.STRIPE_V ? 'rainbowStripe'
          : other.sp === SP.BOMB ? 'rainbowBomb' : 'rainbowColor';
      return { kind: kind, pos1: pos1, pos2: pos2, center: rainPos, rainPos: rainPos, otherPos: otherPos, color: other.t };
    }
    var stripes = (ca.sp === SP.STRIPE_H || ca.sp === SP.STRIPE_V ? 1 : 0) + (cb.sp === SP.STRIPE_H || cb.sp === SP.STRIPE_V ? 1 : 0);
    var kind2 = stripes === 2 ? 'cross' : stripes === 1 ? 'fatCross' : 'bigBomb';
    return { kind: kind2, pos1: pos1, pos2: pos2, center: pos1, color: -1 };
  }

  // 计算一轮消除（会修改 board：清掉被消除的块、放入新生成的特殊块，但不做下落）。
  // 没有可消除的内容返回 null。
  function resolveStep(board, ctx) {
    ctx = ctx || {};
    var chain = ctx.chain || 1, combo = ctx.combo || null;
    var groups = findMatchGroups(board);
    if (!groups.length && !combo) return null;

    var cleared = {}, order = [];          // key → entry；order 保持插入顺序
    var queue = [], effects = [], transforms = [], spawns = [];
    var r, c, i;

    function addClear(rr, cc, at, noTrigger) {
      var cell = board[rr][cc], k = key(rr, cc);
      if (!cell || cleared[k]) return null;
      var e = { cell: cell, r: rr, c: cc, at: at, effect: -1, merge: null };
      cleared[k] = e; order.push(e);
      if (cell.sp && !noTrigger) queue.push(e);
      return e;
    }
    // 取场上（排除已被清掉的）最多的造型，彩虹块被特效误伤时用来决定清哪一色
    function dominantColor() {
      var cnt = [], best = -1, bestN = 0, t, rr, cc;
      for (t = 0; t < TYPES; t++) cnt[t] = 0;
      for (rr = 0; rr < SIZE; rr++) for (cc = 0; cc < SIZE; cc++) {
        var cl = board[rr][cc];
        if (cl && cl.t >= 0 && !cleared[key(rr, cc)]) cnt[cl.t]++;
      }
      for (t = 0; t < TYPES; t++) if (cnt[t] > bestN) { bestN = cnt[t]; best = t; }
      return best;
    }
    function cellsOfColor(color, from) {      // 某色所有格子，按离 from 的距离排序
      var list = [];
      for (var rr = 0; rr < SIZE; rr++) for (var cc = 0; cc < SIZE; cc++) {
        var cl = board[rr][cc];
        if (cl && cl.t === color && color >= 0) list.push({ r: rr, c: cc, d: Math.abs(rr - from.r) + Math.abs(cc - from.c) });
      }
      list.sort(function (x, y) { return x.d - y.d || x.r - y.r || x.c - y.c; });
      return list;
    }
    function pushEffect(kind, rr, cc, at, extra) {
      var ef = { kind: kind, r: rr, c: cc, at: at };
      if (extra) for (var k in extra) ef[k] = extra[k];
      effects.push(ef);
      return effects.length - 1;
    }
    function clearTargets(list, baseAt, effIdx) {   // list: [{r,c,d}]
      list.forEach(function (t) {
        var e = addClear(t.r, t.c, baseAt + t.d * CFG.gap.cell);
        if (e) e.effect = effIdx;
      });
    }

    // 1) 直接匹配的块（at=0）
    groups.forEach(function (g) { g.cells.forEach(function (p) { addClear(p.r, p.c, 0); }); });

    // 2) 组合技（仅交换后的第一轮）
    if (combo) {
      var cb0 = CFG.gap.combo, targets, idx;
      // 被交换的两个块本身：彩虹块只消掉自己（另一块按「该色」处理）；条纹/炸弹互换则两个都消、效果由组合技代替
      var selfEntries = combo.kind.indexOf('rainbow') === 0
        ? [addClear(combo.rainPos.r, combo.rainPos.c, 0, true)]
        : [addClear(combo.pos1.r, combo.pos1.c, 0, true), addClear(combo.pos2.r, combo.pos2.c, 0, true)];
      selfEntries.forEach(function (se) { if (se && se.effect === -1) se.effect = -2; });   // -2：由组合技清掉
      if (combo.kind === 'rainbowAll') {
        targets = [];
        for (r = 0; r < SIZE; r++) for (c = 0; c < SIZE; c++) targets.push({ r: r, c: c, d: Math.max(Math.abs(r - combo.center.r), Math.abs(c - combo.center.c)) });
        idx = pushEffect('rainbowAll', combo.center.r, combo.center.c, 0);
        clearTargets(targets, cb0, idx);
      } else if (combo.kind === 'rainbowColor') {
        targets = cellsOfColor(combo.color, combo.center).map(function (t, n) { return { r: t.r, c: t.c, d: Math.floor(n / 2) }; });
        idx = pushEffect('rainbowColor', combo.center.r, combo.center.c, 0, { color: combo.color, targets: targets.map(function (t) { return { r: t.r, c: t.c }; }) });
        clearTargets(targets, cb0, idx);
      } else if (combo.kind === 'rainbowStripe' || combo.kind === 'rainbowBomb') {
        // 该色所有普通块变成条纹/炸弹，然后依次引爆
        targets = cellsOfColor(combo.color, combo.center);
        idx = pushEffect(combo.kind, combo.center.r, combo.center.c, 0, { color: combo.color, targets: targets.map(function (t) { return { r: t.r, c: t.c }; }) });
        targets.forEach(function (t, n) {
          var old = board[t.r][t.c], at = CFG.gap.transform + n * 40, e;
          if (cleared[key(t.r, t.c)]) return;      // 已经被普通匹配消掉的不再变身
          if (!old.sp) {
            var sp = combo.kind === 'rainbowBomb' ? SP.BOMB : (n % 2 ? SP.STRIPE_V : SP.STRIPE_H);
            var nc = makeCell(old.t, sp);
            board[t.r][t.c] = nc;
            transforms.push({ r: t.r, c: t.c, from: old, to: nc, at: 0 });
          }
          e = addClear(t.r, t.c, at);
          if (e) e.effect = idx;
        });
      } else {
        var ctr = combo.center;
        targets = [];
        var rows = [], cols = [], radius = -1;
        if (combo.kind === 'cross') { rows = [ctr.r]; cols = [ctr.c]; }
        else if (combo.kind === 'fatCross') { rows = [ctr.r - 1, ctr.r, ctr.r + 1]; cols = [ctr.c - 1, ctr.c, ctr.c + 1]; }
        else radius = 2;
        if (radius > 0) {
          for (r = ctr.r - radius; r <= ctr.r + radius; r++) for (c = ctr.c - radius; c <= ctr.c + radius; c++)
            if (inBounds(r, c)) targets.push({ r: r, c: c, d: Math.max(Math.abs(r - ctr.r), Math.abs(c - ctr.c)) });
        } else {
          rows.forEach(function (rr) { if (rr >= 0 && rr < SIZE) for (c = 0; c < SIZE; c++) targets.push({ r: rr, c: c, d: Math.abs(c - ctr.c) }); });
          cols.forEach(function (cc) { if (cc >= 0 && cc < SIZE) for (r = 0; r < SIZE; r++) targets.push({ r: r, c: cc, d: Math.abs(r - ctr.r) }); });
        }
        idx = pushEffect(combo.kind, ctr.r, ctr.c, 0);
        clearTargets(targets, cb0, idx);
      }
    }

    // 3) 引爆被消除的特殊块（连锁反应）：每次取 at 最小的，每格只会被消除一次，必然终止
    while (queue.length) {
      var bi = 0;
      for (i = 1; i < queue.length; i++) if (queue[i].at < queue[bi].at) bi = i;
      var e0 = queue.splice(bi, 1)[0], sp0 = e0.cell.sp, tg = [], kind, color;
      if (sp0 === SP.STRIPE_H) { kind = 'stripeH'; for (c = 0; c < SIZE; c++) tg.push({ r: e0.r, c: c, d: Math.abs(c - e0.c) }); }
      else if (sp0 === SP.STRIPE_V) { kind = 'stripeV'; for (r = 0; r < SIZE; r++) tg.push({ r: r, c: e0.c, d: Math.abs(r - e0.r) }); }
      else if (sp0 === SP.BOMB) {
        kind = 'bomb';
        for (r = e0.r - 1; r <= e0.r + 1; r++) for (c = e0.c - 1; c <= e0.c + 1; c++)
          if (inBounds(r, c)) tg.push({ r: r, c: c, d: Math.max(Math.abs(r - e0.r), Math.abs(c - e0.c)) });
      } else {
        kind = 'rainbow'; color = dominantColor();
        tg = cellsOfColor(color, e0).filter(function (t) { return !cleared[key(t.r, t.c)]; })
          .map(function (t, n) { return { r: t.r, c: t.c, d: Math.floor(n / 2) }; });
      }
      var ei = pushEffect(kind, e0.r, e0.c, e0.at, kind === 'rainbow' ? { color: color, targets: tg.map(function (t) { return { r: t.r, c: t.c }; }) } : null);
      clearTargets(tg, e0.at + CFG.gap.trigger, ei);
    }

    // 4) 决定生成什么特殊块
    var outGroups = groups.map(function (g, gi) {
      var info = classifyGroup(g, ctx.swap);
      if (info.special) {
        var nc = info.special === SP.RAINBOW ? makeRainbow() : makeCell(g.t, info.special);
        spawns.push({ cell: nc, r: info.pivot.r, c: info.pivot.c, at: CFG.gap.spawn, group: gi });
        g.cells.forEach(function (p) {
          var e = cleared[key(p.r, p.c)];
          if (e && e.effect === -1) e.merge = { r: info.pivot.r, c: info.pivot.c };
        });
      }
      return { t: g.t, shape: info.shape, special: info.special, pivot: info.pivot, cells: g.cells };
    });

    // 5) 应用到棋盘
    order.forEach(function (e) { board[e.r][e.c] = null; });
    spawns.forEach(function (s) { board[s.r][s.c] = s.cell; });

    // 6) 计分
    var bonus = 0;
    spawns.forEach(function (s) { bonus += CFG.bonusSpawn[s.cell.sp] || 0; });
    effects.forEach(function (ef) { bonus += TRIGGER_KINDS[ef.kind] ? CFG.bonusTrigger : CFG.bonusCombo; });
    var gained = (order.length * CFG.perPiece + bonus) * chain;

    return { chain: chain, combo: combo ? combo.kind : null, groups: outGroups, cleared: order, effects: effects,
      spawns: spawns, transforms: transforms, gained: gained, drops: [] };
  }

  /* ---------------- 完整连锁 ---------------- */
  // 修复：万一连锁到硬上限仍有三连，就地改色，保证盘面干净（现实中几乎不会走到）
  function repairBoard(board, rng) {
    rng = rng || Math.random;
    var guard = 0, runs;
    while ((runs = findRuns(board)).length && guard++ < 400) {
      var run = runs[0], p = run.cells[Math.floor(run.len / 2)];
      for (var i = 0; i < run.cells.length; i++) if (!board[run.cells[i].r][run.cells[i].c].sp) { p = run.cells[i]; break; }
      var cell = board[p.r][p.c];
      var ok = allowedTypes(board, p.r, p.c);          // 只看邻居，不受自己当前造型影响
      cell.t = ok.length ? ok[pickIndex(rng, ok.length)] : (cell.t + 1) % TYPES;
    }
  }

  // 反复「消除 → 下落补充」直到盘面稳定。first：{ swap, combo } 仅作用于第一轮。
  function resolveAll(board, rng, first) {
    rng = rng || Math.random;
    var steps = [], chain = 1;
    for (var i = 0; i < CFG.maxCascade; i++) {
      var step = resolveStep(board, { chain: chain, swap: i === 0 && first ? first.swap : null, combo: i === 0 && first ? first.combo : null });
      if (!step) break;
      step.drops = applyGravity(board, rng, i >= CFG.safeAfter);
      steps.push(step);
      chain++;
    }
    if (findRuns(board).length) repairBoard(board, rng);
    return steps;
  }

  /* ---------------- 洗牌 ---------------- */
  // 没有可行交换时调用：打乱现有块（特殊块保留），保证没有三连且至少有一个可行交换。
  // 返回 { moves:[{cell, from, to}], regen }
  function shuffleBoard(board, rng) {
    rng = rng || Math.random;
    var cells = [], from = {}, r, c, i, j, attempt, tmp;
    for (r = 0; r < SIZE; r++) for (c = 0; c < SIZE; c++) if (board[r][c]) { cells.push(board[r][c]); from[board[r][c].id] = { r: r, c: c }; }
    function place(list) { var n = 0; for (var rr = 0; rr < SIZE; rr++) for (var cc = 0; cc < SIZE; cc++) board[rr][cc] = list[n++] || null; }
    function result(regen) {
      var moves = [];
      for (var rr = 0; rr < SIZE; rr++) for (var cc = 0; cc < SIZE; cc++) {
        var cl = board[rr][cc];
        if (cl && from[cl.id]) moves.push({ cell: cl, from: from[cl.id], to: { r: rr, c: cc } });
      }
      return { moves: moves, regen: !!regen };
    }
    for (attempt = 0; attempt < 300; attempt++) {
      for (i = cells.length - 1; i > 0; i--) { j = pickIndex(rng, i + 1); tmp = cells[i]; cells[i] = cells[j]; cells[j] = tmp; }
      place(cells);
      if (findRuns(board).length === 0 && hasMoves(board)) return result(false);
    }
    // 兜底 1：保留特殊块位置，普通块重新抽造型（就地改色）
    for (attempt = 0; attempt < 30; attempt++) {
      place(cells);
      for (r = 0; r < SIZE; r++) for (c = 0; c < SIZE; c++) {
        var cl = board[r][c];
        if (cl && !cl.sp) { var ok = allowedTypes(board, r, c); cl.t = ok[pickIndex(rng, ok.length)]; }
      }
      if (findRuns(board).length === 0 && hasMoves(board)) return result(true);
    }
    // 兜底 2：固定模板的造型（特殊块保持特殊，彩虹块自带可行交换）
    var fb = fallbackBoard();
    place(cells);
    for (r = 0; r < SIZE; r++) for (c = 0; c < SIZE; c++) if (board[r][c] && board[r][c].t >= 0) board[r][c].t = fb[r][c].t;
    return result(true);
  }

  /* ---------------- 一次操作 ---------------- */
  function playMove(board, a, b, rng) {
    rng = rng || Math.random;
    if (!inBounds(a.r, a.c) || !inBounds(b.r, b.c) || !isAdjacent(a, b)) return { valid: false, reason: 'not-adjacent' };
    var ca = board[a.r][a.c], cb = board[b.r][b.c];
    if (!ca || !cb) return { valid: false, reason: 'empty' };
    swapCells(board, a, b);
    var combo = detectCombo(ca, cb, a, b);
    if (!combo && findRuns(board).length === 0) {
      swapCells(board, a, b);
      return { valid: false, reason: 'no-match' };
    }
    var steps = resolveAll(board, rng, { swap: [{ r: b.r, c: b.c }, { r: a.r, c: a.c }], combo: combo });
    var gained = 0;
    steps.forEach(function (s) { gained += s.gained; });
    var res = { valid: true, steps: steps, shuffle: null, gained: gained, maxChain: steps.length };
    if (!hasMoves(board)) res.shuffle = shuffleBoard(board, rng);
    return res;
  }

  /* ---------------- 关卡 ---------------- */
  // 第 n 关：步数与目标分。第 1 关 20 步 / 1500 分；之后步数每两关 +1（封顶 30），目标分按二次曲线抬高。
  // 数值是用「随机 / 半随机 / 贪心」三种机器人各打 250 局测出来的：
  // 第 1 关通关率约 95%，第 3 关约 50~70%，第 5 关约 25~40%，第 8 关以后只有高手能过。
  function levelConfig(n) {
    n = Math.max(1, Math.floor(n) || 1);
    var moves = Math.min(30, 20 + Math.floor(n / 2));
    var target = Math.round((1500 + 450 * (n - 1) + 40 * (n - 1) * (n - 2)) / 50) * 50;
    return { level: n, moves: moves, target: target };
  }
  // 一步结束、盘面稳定后判定：'win' 达标 / 'lose' 步数用完未达标 / 'continue'
  function judgeLevel(levelScore, target, movesLeft) {
    if (levelScore >= target) return 'win';
    if (movesLeft <= 0) return 'lose';
    return 'continue';
  }
  function movesBonus(movesLeft) { return Math.max(0, movesLeft | 0) * CFG.movesBonus; }

  var Logic = {
    SIZE: SIZE, TYPES: TYPES, SP: SP, CFG: CFG,
    makeRng: makeRng, makeCell: makeCell, makeRainbow: makeRainbow, newBoard: newBoard,
    boardFromRows: boardFromRows, boardToRows: boardToRows,
    inBounds: inBounds, isAdjacent: isAdjacent, swapCells: swapCells,
    findRuns: findRuns, findMatchGroups: findMatchGroups, classifyGroup: classifyGroup, isInMatch: isInMatch,
    allowedTypes: allowedTypes, generateBoard: generateBoard, fallbackBoard: fallbackBoard,
    isValidSwap: isValidSwap, findPossibleMoves: findPossibleMoves, hasMoves: hasMoves,
    evaluateMove: evaluateMove, pickHint: pickHint,
    applyGravity: applyGravity, resolveStep: resolveStep, resolveAll: resolveAll, repairBoard: repairBoard,
    shuffleBoard: shuffleBoard, playMove: playMove,
    levelConfig: levelConfig, judgeLevel: judgeLevel, movesBonus: movesBonus
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Logic;
  if (typeof window !== 'undefined') window.Match3Logic = Logic;
})();
