/* 奶了个奶 · 逻辑自测：node test-logic.js
 * 重点验证“每关有解”：用不同随机种子生成第 1/2/3/5 关各 200 个，
 * 全部能被“按构造顺序点击”通关，且槽不会爆、没有两张牌完全重叠。
 * 另外测规则（相邻排列/三消/连消/压住/槽满/撤回/移出/洗牌）和简单机器人的通关率（难度曲线）。 */
'use strict';
var L = require('./logic.js');
var E = require('./engine.js');

var failed = 0, passed = 0;
function ok(cond, msg) {
  if (cond) passed++; else { failed++; console.log('  [FAIL] ' + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); }
function section(s) { console.log('\n== ' + s); }

// ---------- 独立验证器：不依赖引擎，纯几何 + 计数，按构造顺序“点击”整关 ----------
function replayIndependent(level) {
  var tiles = level.tiles, removed = {}, slot = [], maxAfter = 0, maxTransient = 0, i;
  if (level.order.length !== tiles.length) return { ok: false, why: '顺序长度不对' };
  for (var s = 0; s < level.order.length; s++) {
    var id = level.order[s], t = tiles[id];
    if (!t || removed[id]) return { ok: false, why: '重复/无效牌 ' + id };
    for (i = 0; i < tiles.length; i++) {            // 被压住？上方任意未拿走的牌矩形相交即压住
      var o = tiles[i];
      if (!removed[i] && o.z > t.z && Math.abs(o.x - t.x) < 2 && Math.abs(o.y - t.y) < 2) return { ok: false, why: '第 ' + s + ' 步点了被压住的牌 ' + id };
    }
    removed[id] = true;
    if (slot.length >= 7) return { ok: false, why: '槽已满还要放牌' };
    slot.push(t.type);
    maxTransient = Math.max(maxTransient, slot.length);
    var same = slot.filter(function (x) { return x === t.type; }).length;
    if (same >= 3) { var n = 0; slot = slot.filter(function (x) { if (x === t.type && n < 3) { n++; return false; } return true; }); }
    maxAfter = Math.max(maxAfter, slot.length);
  }
  return { ok: slot.length === 0 && Object.keys(removed).length === tiles.length, why: '没清空', maxAfter: maxAfter, maxTransient: maxTransient };
}

// ---------- 用真正的引擎按构造顺序点一遍 ----------
function replayEngine(level) {
  var e = E.createEngine(level, { flyTime: 0 }), maxSlot = 0;
  for (var i = 0; i < level.order.length; i++) {
    if (!e.click(level.order[i], 0)) return { ok: false, why: '引擎拒绝了第 ' + i + ' 步', e: e };
    maxSlot = Math.max(maxSlot, e.slot.length);
    if (e.state === 'lost') return { ok: false, why: '槽满了', e: e };
  }
  return { ok: e.state === 'won', why: '状态 ' + e.state, e: e, maxSlot: maxSlot };
}

function checkLevel(level, cfg, tag) {
  var tiles = level.tiles, n = tiles.length, i, j;
  ok(n === cfg.count && n % 3 === 0, tag + ' 牌数应为 ' + cfg.count + '（实际 ' + n + '）');
  var counts = {};
  tiles.forEach(function (t) { counts[t.type] = (counts[t.type] || 0) + 1; });
  var kinds = Object.keys(counts);
  ok(kinds.length === cfg.types, tag + ' 造型种类应为 ' + cfg.types + '（实际 ' + kinds.length + '）');
  ok(kinds.every(function (k) { return counts[k] % 3 === 0 && counts[k] >= 3; }), tag + ' 每种造型张数必须是 3 的倍数');
  ok(kinds.some(function (k) { return counts[k] >= 6; }), tag + ' 不应全是刚好 3 张');
  ok(kinds.every(function (k) { return k >= 0 && k < L.NUM_TYPES; }), tag + ' 造型编号越界');
  var bw = Math.round(cfg.cols * 2), bh = Math.round(cfg.rows * 2), seen = {};
  for (i = 0; i < n; i++) {
    var a = tiles[i];
    ok(a.id === i, tag + ' id 应等于下标');
    ok(a.x >= 0 && a.y >= 0 && a.x + 2 <= bw && a.y + 2 <= bh, tag + ' 牌越出棋盘');
    var key = a.x + ',' + a.y;
    ok(!seen[key], tag + ' 两张牌完全重叠在同一位置 ' + key);   // 不论层数，坐标相同就算完全重叠
    seen[key] = true;
    for (j = i + 1; j < n; j++) {
      var b = tiles[j];
      if (a.z === b.z) ok(!(Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2), tag + ' 同层牌相交');
    }
  }
  var layers = {}; tiles.forEach(function (t) { layers[t.z] = true; });
  var nl = Object.keys(layers).length;
  ok(nl >= cfg.layers[0] && nl <= cfg.layers[1] + 1, tag + ' 层数 ' + nl + ' 不在范围');
  var rel = L.computeRelations(tiles), maxAbove = 0;
  rel.above.forEach(function (a) { maxAbove = Math.max(maxAbove, a.length); });
  if (cfg.level === 1) { ok(maxAbove <= cfg.maxAbove, tag + ' 第 1 关单张牌被压张数 ' + maxAbove + ' 超限'); ok(nl >= 3 && nl <= 4, tag + ' 第 1 关应 3~4 层'); }
  return { maxAbove: maxAbove, layers: nl };
}

// =================================================================
section('随机数确定性');
var r1 = L.mulberry32(42), r2 = L.mulberry32(42), same = true;
for (var q = 0; q < 50; q++) if (r1() !== r2()) same = false;
ok(same, '同种子同序列');
eq(L.generateLevel(2, 777).order, L.generateLevel(2, 777).order, '同种子同关卡');
ok(JSON.stringify(L.generateLevel(2, 777).tiles) !== JSON.stringify(L.generateLevel(2, 778).tiles), '不同种子关卡不同');

// =================================================================
section('每关有解：第 1/2/3/5 关各 200 个种子（按构造顺序点击）');
var SEEDS = 200, stat = {};
[1, 2, 3, 5].forEach(function (lv) {
  var cfg = L.levelConfig(lv), solved = 0, solvedEng = 0, maxAfter = 0, maxTrans = 0, maxAbove = 0, minL = 99, maxL = 0, kindsSum = 0, big = 0;
  for (var seed = 1; seed <= SEEDS; seed++) {
    var level = L.generateLevel(lv, seed), tag = 'L' + lv + ' seed' + seed;
    var info = checkLevel(level, cfg, tag);
    var r = replayIndependent(level), re = replayEngine(level);
    if (r.ok) { solved++; maxAfter = Math.max(maxAfter, r.maxAfter); maxTrans = Math.max(maxTrans, r.maxTransient); } else ok(false, tag + ' 独立验证器失败：' + r.why);
    if (re.ok) solvedEng++; else ok(false, tag + ' 引擎验证失败：' + re.why);
    if (re.ok) {
      ok(re.e.score === 10 * level.tiles.length / 3 + E.LEVEL_BONUS * lv, tag + ' 分数应为 消除分+过关奖励');
      ok(re.maxSlot <= 7, tag + ' 槽超过 7');
    }
    ok(level.peak <= 7, tag + ' 构造峰值 ' + level.peak + ' 超过 7');
    maxAbove = Math.max(maxAbove, info.maxAbove); minL = Math.min(minL, info.layers); maxL = Math.max(maxL, info.layers);
    var cs = {}; level.tiles.forEach(function (t) { cs[t.type] = (cs[t.type] || 0) + 1; });
    kindsSum += Object.keys(cs).length; if (Object.keys(cs).some(function (k) { return cs[k] > 9; })) big++;
  }
  ok(solved === SEEDS && solvedEng === SEEDS, '第 ' + lv + ' 关 ' + SEEDS + ' 个全部可通关');
  stat[lv] = { solved: solved, solvedEng: solvedEng };
  console.log('  第 ' + lv + ' 关：独立验证 ' + solved + '/' + SEEDS + '，引擎验证 ' + solvedEng + '/' + SEEDS +
    '；牌数 ' + cfg.count + '，造型 ' + cfg.types + ' 种，层数 ' + minL + '~' + maxL + '，单牌最多被压 ' + maxAbove +
    ' 张；解法里槽峰值（消除后）' + maxAfter + '、瞬时 ' + maxTrans + '（上限 7）');
});

section('更多关卡抽查（第 4/6/8/10/15 关各 60 个种子）');
[4, 6, 8, 10, 15].forEach(function (lv) {
  var cfg = L.levelConfig(lv), good = 0;
  for (var seed = 1; seed <= 60; seed++) {
    var level = L.generateLevel(lv, seed * 7 + lv), info = checkLevel(level, cfg, 'L' + lv + ' s' + seed);
    var r = replayIndependent(level), re = replayEngine(level);
    if (r.ok && re.ok && info) good++; else ok(false, 'L' + lv + ' s' + seed + ' 验证失败 ' + (r.why || re.why));
  }
  ok(good === 60, '第 ' + lv + ' 关 60 个全部可通关');
  console.log('  第 ' + lv + ' 关（' + cfg.count + ' 张 / ' + cfg.types + ' 种）：' + good + '/60 可通关');
});

// =================================================================
section('规则：同款相邻 / 三消 / 连消 / 压住 / 槽满');
function mk(spec, extra) {      // spec: [[x,y,z,type],...]
  var tiles = spec.map(function (s, i) { return { id: i, x: s[0], y: s[1], z: s[2], type: s[3] }; });
  var lv = { level: 1, cfg: { k: 1 }, tiles: tiles, order: [], bounds: null };
  if (extra) for (var k in extra) lv[k] = extra[k];
  return lv;
}
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 0], [2, 0, 0, 1], [4, 0, 0, 0], [6, 0, 0, 2], [8, 0, 0, 1], [10, 0, 0, 5]]), { flyTime: 0 });
  var types = function () { return e.slot.map(function (id) { return e.tiles[id].type; }); };
  e.click(0, 0); e.click(1, 0); e.click(3, 0); eq(types(), [0, 1, 2], '依次入槽');
  e.click(2, 0); eq(types(), [0, 0, 1, 2], '同款插到同类后面');
  e.click(4, 0); eq(types(), [0, 0, 1, 1, 2], '另一种同款也相邻');
  ok(!e.click(0, 0), '已在槽里的牌不能再点');
})();
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 3], [2, 0, 0, 3], [4, 0, 0, 3], [6, 0, 0, 4], [8, 0, 0, 4], [10, 0, 0, 4], [0, 4, 0, 5], [2, 4, 0, 5], [4, 4, 0, 5]]), { flyTime: 0 });
  e.click(0, 0); e.click(1, 0); e.click(2, 0);
  var ev = e.drain().filter(function (x) { return x.t === 'clear'; });
  eq(ev.length, 1, '三张同款触发一次消除'); eq(ev[0].combo, 1, '首次消除连击=1'); eq(e.slot.length, 0, '消除后槽清空');
  eq(e.score, 10, '每消一组 +10');
  e.click(3, 1); e.click(4, 1); e.click(5, 1);
  eq(e.drain().filter(function (x) { return x.t === 'clear'; })[0].combo, 2, '2.6 秒内再消 → 连消 2');
  e.click(6, 10); e.click(7, 10); e.click(8, 10);
  var last = e.drain().filter(function (x) { return x.t === 'clear'; })[0];
  eq(last.combo, 1, '间隔过久连消重置');
  eq(e.state, 'won', '全部清空 → 过关'); eq(e.score, 30 + E.LEVEL_BONUS, '过关加关卡奖励');
})();
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 0], [1, 1, 1, 1], [8, 8, 0, 2], [3, 1, 1, 2]]), { flyTime: 0 });
  ok(!e.isFree(0), '被上层相交的牌不可点'); ok(e.isFree(1), '最上层可点'); ok(e.isFree(2), '不相交的牌可点');
  ok(!e.click(0, 0), '点被压住的牌无效');
  ok(e.isFree(3), '仅与同层/不相交 → 可点（x=3,y=1 与 x=0,y=0 的下层牌不相交）');
  e.click(1, 0); ok(e.isFree(0), '上层拿走后下层解放');
  var e2 = E.createEngine(mk([[0, 0, 0, 0], [2, 0, 0, 1]]), { flyTime: 0 });          // 刚好相邻（边相接）不算压住
  ok(e2.isFree(0) && e2.isFree(1), '相邻不重叠的牌互不压住');
})();
(function () {
  var spec = []; for (var i = 0; i < 9; i++) spec.push([i * 2, 0, 0, i % 8]);          // 9 张牌 8 种造型，凑不出三连
  var e = E.createEngine(mk(spec), { flyTime: 0 });
  for (var k = 0; k < 6; k++) e.click(k, 0);
  eq(e.state, 'playing', '槽 6 张还没输'); e.click(6, 0);
  eq(e.state, 'lost', '槽满 7 张且无可消 → 失败'); ok(!e.click(7, 0), '失败后不能再点');
  eq(e.drain().filter(function (x) { return x.t === 'lose'; }).length, 1, '只触发一次 lose');
})();
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [6, 0, 0, 1]]), { flyTime: 0.3 });
  e.click(0, 0); e.click(1, 0.05); e.click(2, 0.1);
  ok(e.busy(), '牌在飞时 busy'); eq(e.slot.length, 3, '飞行中已占槽位');
  e.tick(0.2); eq(e.slot.length, 3, '没落稳不消除');
  e.tick(0.31); eq(e.slot.length, 3, '前两张落稳但第三张还在飞，不消');
  e.tick(0.41); eq(e.slot.length, 0, '三张都落稳后才消除'); ok(!e.busy(), '落稳后不再 busy');
  ok(e.undo().reason === 'empty', '槽空时撤回无效');
})();

// =================================================================
section('道具：撤回 / 移出');
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 0], [0, 0, 1, 1], [6, 0, 0, 2], [8, 0, 0, 3]].map(function (s, i) { return i === 1 ? [1, 1, 1, 1] : s; })), { flyTime: 0 });
  eq(e.undo().reason, 'empty', '空槽不能撤回');
  e.click(1, 0); e.click(0, 1); e.click(2, 2);
  var r = e.undo(); ok(r.ok, '撤回成功');
  eq(e.tiles[2].loc, 'board', '最后放进槽的牌回到场上'); eq([e.tiles[2].x, e.tiles[2].y], [6, 0], '回到原位置');
  eq(e.slot.length, 2, '槽里少一张'); ok(e.used.undo, '标记已用'); eq(e.undo().reason, 'used', '每关限用 1 次');
  ok(e.click(2, 3), '撤回的牌可以再点');
})();
(function () {            // 撤回后，上层牌还回去会重新压住下层
  var e = E.createEngine(mk([[0, 0, 0, 0], [1, 1, 1, 1]]), { flyTime: 0 });
  e.click(1, 0); ok(e.isFree(0), '上层拿走下层解放'); e.undo(); ok(!e.isFree(0), '上层放回，下层再次被压住'); ok(e.isFree(1), '放回的牌可点');
})();
(function () {
  var e = E.createEngine(mk([[0, 0, 0, 0], [2, 0, 0, 1], [4, 0, 0, 2], [6, 0, 0, 3], [8, 0, 0, 4]]), { flyTime: 0 });
  eq(e.moveOut().reason, 'empty', '空槽不能移出');
  for (var i = 0; i < 4; i++) e.click(i, 0);
  var r = e.moveOut(); ok(r.ok, '移出成功');
  eq(e.temp.length, 3, '暂存区 3 张'); eq(e.slot.length, 1, '槽里剩 1 张');
  eq(e.temp.map(function (id) { return e.tiles[id].type; }), [0, 1, 2], '移出的是槽里最前面的 3 张');
  eq(e.moveOut().reason, 'used', '每关限用 1 次');
  ok(e.click(e.temp[1], 1), '暂存的牌可点击放回槽'); eq(e.temp.length, 2, '暂存区少一张');
  eq(e.tiles[1].loc, 'slot', '放回槽里');
})();
(function () {            // 槽少于 3 张时，有几张移几张
  var e = E.createEngine(mk([[0, 0, 0, 0], [2, 0, 0, 1], [4, 0, 0, 2]]), { flyTime: 0 });
  e.click(0, 0); e.click(1, 0); ok(e.moveOut().ok, '2 张也能移出'); eq(e.temp.length, 2, '移出 2 张');
})();

// =================================================================
section('道具：洗牌（位置不变、造型守恒、仍然有解、不会卡死）');
function pickBot(e, rng) {        // 简单机器人：优先凑三连，否则挑可见数最多的造型
  var free = [], i;
  for (i = 0; i < e.tiles.length; i++) if (e.isFree(i)) free.push(i);
  if (!free.length) return -1;
  var sc = {}; e.slot.forEach(function (id) { var t = e.tiles[id].type; sc[t] = (sc[t] || 0) + 1; });
  var c2 = free.filter(function (id) { return sc[e.tiles[id].type] === 2; });
  if (c2.length) return c2[Math.floor(rng() * c2.length)];
  var c1 = free.filter(function (id) { return sc[e.tiles[id].type] === 1; });
  if (c1.length) return c1[Math.floor(rng() * c1.length)];
  var vis = {}; free.forEach(function (id) { var t = e.tiles[id].type; vis[t] = (vis[t] || 0) + 1; });
  var bestN = 0; Object.keys(vis).forEach(function (k) { bestN = Math.max(bestN, vis[k]); });
  var c3 = free.filter(function (id) { return vis[e.tiles[id].type] === bestN; });
  return c3[Math.floor(rng() * c3.length)];
}
(function () {
  var tested = 0, solvable = 0, skipped = 0, usedTemp = 0, planFail = 0;
  [2, 3, 5].forEach(function (lv) {
    for (var seed = 1; seed <= 120; seed++) {
      var level = L.generateLevel(lv, seed), rng = L.mulberry32(seed * 31 + lv), e = E.createEngine(level, { flyTime: 0 });
      var steps = 3 + Math.floor(rng() * 25), now = 0;
      for (var s = 0; s < steps && e.state === 'playing'; s++) { var id = pickBot(e, rng); if (id < 0) break; e.click(id, now++); }
      if (e.state !== 'playing') continue;
      if (rng() < 0.5 && e.slot.length) { var m = e.moveOut(); if (m.ok) usedTemp++; }   // 一半的局面先“移出”再洗牌
      if (rng() < 0.3 && e.slot.length) e.undo();
      var before = e.tiles.map(function (t) { return [t.x, t.y, t.z, t.loc]; });
      var bms = {}; e.tiles.forEach(function (t) { if (t.loc === 'board') bms[t.type] = (bms[t.type] || 0) + 1; });
      var sumS = e.slot.length + e.temp.length;
      var r = e.shuffle(rng);
      if (!r.ok) { skipped++; continue; }
      tested++;
      eq(e.tiles.map(function (t) { return [t.x, t.y, t.z, t.loc]; }), before, '洗牌不改位置与所在区域 L' + lv + ' s' + seed);
      var ams = {}; e.tiles.forEach(function (t) { if (t.loc === 'board') ams[t.type] = (ams[t.type] || 0) + 1; });
      var okMs = Object.keys(bms).every(function (k) { return bms[k] === ams[k]; }) && Object.keys(ams).every(function (k) { return bms[k] === ams[k]; });
      ok(okMs, '洗牌前后场上各造型张数不变 L' + lv + ' s' + seed);
      eq(e.used.shuffle, true, '洗牌标记已用'); eq(e.shuffle(rng).reason, 'used', '洗牌每关限用 1 次');
      if (!r.order) { planFail++; continue; }
      // 按洗牌给出的方案收尾：先把暂存区的牌放回槽，再按顺序点场上的牌
      if (sumS >= 7) { skipped++; continue; }
      var good = true, temps = e.temp.slice();
      for (var i = 0; i < temps.length && good; i++) good = e.click(temps[i], now++);
      for (var j = 0; j < r.order.length && good; j++) good = e.click(r.order[j], now++);
      if (good && e.state === 'won') solvable++; else ok(false, '洗牌后无法按方案通关 L' + lv + ' s' + seed + ' state=' + e.state + ' slot=' + e.slot.length + ' left=' + e.remaining());
    }
  });
  console.log('  洗牌测试 ' + tested + ' 局（其中 ' + usedTemp + ' 局带暂存区牌），方案可通关 ' + solvable + '，规划失败兜底 ' + planFail + '，跳过 ' + skipped);
  ok(tested > 100 && solvable >= tested - skipped - planFail, '洗牌后的局面应全部可按方案通关');
  ok(planFail === 0, '洗牌规划不应失败（失败时才会退化为随机打乱）');
})();

// =================================================================
section('不会卡死：随机乱点 + 随机用道具，必然走到 won / lost');
(function () {
  var stuck = 0, won = 0, lost = 0, N = 0;
  [1, 2, 3, 5].forEach(function (lv) {
    for (var seed = 1; seed <= 60; seed++) {
      var rng = L.mulberry32(seed * 977 + lv), e = E.createEngine(L.generateLevel(lv, seed), { flyTime: 0.3 }), now = 0, guard = 0;
      while (e.state === 'playing' && guard++ < 2000) {
        var roll = rng();
        if (roll < 0.04) e.undo(); else if (roll < 0.08) e.moveOut(); else if (roll < 0.11) e.shuffle(rng);
        else if (roll < 0.30 && e.temp.length) e.click(e.temp[0], now);
        else {
          var free = []; for (var i = 0; i < e.tiles.length; i++) if (e.isFree(i)) free.push(i);
          if (free.length) e.click(free[Math.floor(rng() * free.length)], now);
        }
        now += 0.1 + rng() * 0.3; e.tick(now);
        e.drain();
      }
      N++;
      if (e.state === 'won') won++; else if (e.state === 'lost') lost++; else stuck++;
      if (e.state === 'playing') {      // 若没结束：必须至少还有一步可走（有可点的牌或暂存牌，且槽没满），否则就是卡死
        var movable = e.slot.length < 7 && (e.temp.length || e.boardCount());
        ok(movable, '第 ' + lv + ' 关 seed' + seed + ' 卡死了');
      }
    }
  });
  console.log('  乱点 ' + N + ' 局：过关 ' + won + '，失败 ' + lost + '，未结束 ' + stuck);
  ok(won + lost + stuck === N, '统计一致');
})();

// =================================================================
section('难度曲线：简单机器人（只会看可见牌、不会挖深层、不用道具）的通关率');
var rates = {};
[1, 2, 3, 4, 5, 8].forEach(function (lv) {
  var n = 200, w = 0;
  for (var seed = 1; seed <= n; seed++) {
    var rng = L.mulberry32(seed * 131 + lv), e = E.createEngine(L.generateLevel(lv, seed + 1000), { flyTime: 0 }), now = 0;
    while (e.state === 'playing') { var id = pickBot(e, rng); if (id < 0) break; e.click(id, now++); }
    if (e.state === 'won') w++;
  }
  rates[lv] = w / n;
  console.log('  第 ' + lv + ' 关：机器人通关率 ' + (100 * w / n).toFixed(1) + '%');
});
ok(rates[1] >= 0.95, '第 1 关要很简单：机器人通关率应 ≥ 95%（实际 ' + (rates[1] * 100).toFixed(1) + '%）');
ok(rates[2] <= rates[1] - 0.2, '第 2 关明显更难：通关率至少低 20 个百分点（实际 ' + (rates[2] * 100).toFixed(1) + '% vs ' + (rates[1] * 100).toFixed(1) + '%）');
[3, 4, 5, 8].forEach(function (lv) { ok(rates[lv] <= rates[2] - 0.08, '第 ' + lv + ' 关比第 2 关更难（' + (rates[lv] * 100).toFixed(1) + '%）'); });
// 参数层面严格逐关递增：牌数、层数、造型数、同时开着的造型数不减；解法越来越“散”
(function () {
  var prev = L.levelConfig(1);
  for (var lv = 2; lv <= 14; lv++) {
    var c = L.levelConfig(lv);
    ok(c.count >= prev.count && c.layers[0] >= prev.layers[0] && c.types >= prev.types && c.k >= prev.k, '第 ' + lv + ' 关参数不应比上一关简单');
    ok(c.count % 3 === 0 && c.count <= 132, '第 ' + lv + ' 关牌数应为 3 的倍数且 ≤ 132');
    ok((c.pFinish == null ? 1 : c.pFinish) <= (prev.pFinish == null ? 1 : prev.pFinish) + 1e-9, '第 ' + lv + ' 关解法不应更“规矩”');
    ok((c.tourn || 3) >= (prev.tourn || 3), '第 ' + lv + ' 关深浅错落不应减弱');
    prev = c;
  }
})();

// =================================================================
console.log('\n' + (failed ? '失败 ' + failed + ' 项' : '全部通过') + '（断言 ' + (passed + failed) + ' 条，通过 ' + passed + '）');
process.exitCode = failed ? 1 : 0;
