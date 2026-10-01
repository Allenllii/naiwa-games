/* 奶蛙消消乐 · 核心规则测试：node test-logic.js
 * （浏览器页面不会加载本文件）
 *
 * 约定：造型 5 专门留给「构造场景」用——底盘只用 0~4，所以 5 号块出现在哪、
 * 连成什么形状完全由测试决定，不会误凑出别的三连。 */
'use strict';
var assert = require('assert');
var L = require('./logic.js');
var SIZE = L.SIZE, TYPES = L.TYPES, SP = L.SP;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
}

/* ---------- 测试辅助 ---------- */
// 底盘：造型 (c + 2r) % 5，只用 0~4，没有任何三连
function base() {
  var rows = [];
  for (var r = 0; r < SIZE; r++) { var row = []; for (var c = 0; c < SIZE; c++) row.push(String((c + 2 * r) % 5)); rows.push(row.join(' ')); }
  return L.boardFromRows(rows);
}
function put(b, r, c, tok) { b[r][c] = L.boardFromRows([tok])[0][0]; return b[r][c]; }
function at(b, r, c) { return b[r][c]; }
function countCells(b) { var n = 0; b.forEach(function (row) { row.forEach(function (x) { if (x) n++; }); }); return n; }
// 盘面健康检查：满的、没有重复 id、没有三连、至少有一个可行交换、造型合法
function assertHealthy(b, msg) {
  var seen = {};
  for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
    var cell = b[r][c];
    assert.ok(cell, (msg || '') + ' 有空格 ' + r + ',' + c);
    assert.ok(!seen[cell.id], (msg || '') + ' id 重复');
    seen[cell.id] = 1;
    assert.ok(cell.t === -1 ? cell.sp === SP.RAINBOW : (cell.t >= 0 && cell.t < TYPES), (msg || '') + ' 造型非法');
  }
  assert.strictEqual(L.findRuns(b).length, 0, (msg || '') + ' 盘面仍有三连');
  assert.ok(L.hasMoves(b), (msg || '') + ' 没有可行交换');
}
function keyset(entries) { var s = {}; entries.forEach(function (e) { s[e.r + ',' + e.c] = (s[e.r + ',' + e.c] || 0) + 1; }); return s; }
function assertUniqueCleared(step) {
  var s = keyset(step.cleared);
  Object.keys(s).forEach(function (k) { assert.strictEqual(s[k], 1, '同一格被消除多次 ' + k); });
}
// 对抗型随机数：总是同一个值，或者规律循环
function constRng(v) { return function () { return v; }; }
function cycRng() { var i = 0; return function () { i = (i * 7 + 3) % 97; return i / 97; }; }

console.log('\n[基础检测]');
test('底盘没有三连', function () { assert.strictEqual(L.findRuns(base()).length, 0); });
test('横 3 / 竖 3 / 4 连 / 5 连都能找到', function () {
  var b = base();
  put(b, 1, 0, '5'); put(b, 1, 1, '5'); put(b, 1, 2, '5');          // 横 3
  put(b, 3, 6, '5'); put(b, 4, 6, '5'); put(b, 5, 6, '5'); put(b, 6, 6, '5');   // 竖 4
  var runs = L.findRuns(b);
  assert.strictEqual(runs.length, 2);
  var h = runs.filter(function (x) { return x.dir === 'h'; })[0], v = runs.filter(function (x) { return x.dir === 'v'; })[0];
  assert.strictEqual(h.len, 3); assert.strictEqual(v.len, 4);
  put(b, 7, 0, '5'); put(b, 7, 1, '5'); put(b, 7, 2, '5'); put(b, 7, 3, '5'); put(b, 7, 4, '5');
  assert.ok(L.findRuns(b).some(function (x) { return x.dir === 'h' && x.len === 5; }));
});
test('两连不算，彩虹块不参与匹配', function () {
  var b = base();
  put(b, 2, 0, '5'); put(b, 2, 1, '5');
  assert.strictEqual(L.findRuns(b).length, 0);
  put(b, 2, 2, 'R');
  assert.strictEqual(L.findRuns(b).length, 0);
});
test('带特殊标记的块照常参与匹配', function () {
  var b = base();
  put(b, 2, 0, '5h'); put(b, 2, 1, '5v'); put(b, 2, 2, '5b');
  assert.strictEqual(L.findRuns(b).length, 1);
});

console.log('\n[特殊块生成规则]');
function swapAndGroups(b, a, c) { L.swapCells(b, a, c); return L.findMatchGroups(b); }
test('横向 4 连 → 竖条纹，生成在玩家交换到的格子', function () {
  var b = base();
  put(b, 3, 1, '5'); put(b, 3, 2, '5'); put(b, 3, 4, '5'); put(b, 4, 3, '5');
  var gs = swapAndGroups(b, { r: 4, c: 3 }, { r: 3, c: 3 });
  assert.strictEqual(gs.length, 1);
  var info = L.classifyGroup(gs[0], [{ r: 3, c: 3 }, { r: 4, c: 3 }]);
  assert.strictEqual(info.special, SP.STRIPE_V); assert.deepStrictEqual(info.pivot, { r: 3, c: 3 });
});
test('竖向 4 连 → 横条纹', function () {
  var b = base();
  put(b, 1, 3, '5'); put(b, 2, 3, '5'); put(b, 4, 3, '5'); put(b, 3, 4, '5');
  var gs = swapAndGroups(b, { r: 3, c: 4 }, { r: 3, c: 3 });
  assert.strictEqual(gs.length, 1);
  var info = L.classifyGroup(gs[0], [{ r: 3, c: 3 }]);
  assert.strictEqual(info.special, SP.STRIPE_H); assert.deepStrictEqual(info.pivot, { r: 3, c: 3 });
});
test('5 连成线 → 彩虹块', function () {
  var b = base();
  put(b, 3, 0, '5'); put(b, 3, 1, '5'); put(b, 3, 3, '5'); put(b, 3, 4, '5'); put(b, 4, 2, '5');
  var gs = swapAndGroups(b, { r: 4, c: 2 }, { r: 3, c: 2 });
  assert.strictEqual(gs.length, 1); assert.strictEqual(gs[0].cells.length, 5);
  var info = L.classifyGroup(gs[0], [{ r: 3, c: 2 }]);
  assert.strictEqual(info.special, SP.RAINBOW); assert.deepStrictEqual(info.pivot, { r: 3, c: 2 });
});
test('没有交换位置时（连锁产生的 4 连）生成在连线靠中间', function () {
  var b = base();
  put(b, 5, 2, '5'); put(b, 5, 3, '5'); put(b, 5, 4, '5'); put(b, 5, 5, '5');
  var info = L.classifyGroup(L.findMatchGroups(b)[0], null);
  assert.strictEqual(info.special, SP.STRIPE_V); assert.deepStrictEqual(info.pivot, { r: 5, c: 3 });
});
test('L 形（5 块相交）→ 炸弹，生成在拐角', function () {
  var b = base();
  put(b, 3, 4, '5'); put(b, 3, 5, '5'); put(b, 4, 3, '5'); put(b, 5, 3, '5'); put(b, 2, 3, '5');
  var gs = swapAndGroups(b, { r: 2, c: 3 }, { r: 3, c: 3 });
  assert.strictEqual(gs.length, 1); assert.strictEqual(gs[0].cells.length, 5);
  var info = L.classifyGroup(gs[0], [{ r: 3, c: 3 }]);
  assert.strictEqual(info.special, SP.BOMB); assert.deepStrictEqual(info.pivot, { r: 3, c: 3 });
});
test('T 形 → 炸弹，生成在交叉点', function () {
  var b = base();
  put(b, 3, 2, '5'); put(b, 3, 4, '5'); put(b, 4, 3, '5'); put(b, 5, 3, '5'); put(b, 2, 3, '5');
  var gs = swapAndGroups(b, { r: 2, c: 3 }, { r: 3, c: 3 });
  assert.strictEqual(gs.length, 1);
  var info = L.classifyGroup(gs[0], null);
  assert.strictEqual(info.special, SP.BOMB); assert.deepStrictEqual(info.pivot, { r: 3, c: 3 });
});
test('十字形 → 炸弹；普通三连不生成特殊块', function () {
  var b = base();
  put(b, 3, 2, '5'); put(b, 3, 3, '5'); put(b, 3, 4, '5'); put(b, 2, 3, '5'); put(b, 4, 3, '5');
  var info = L.classifyGroup(L.findMatchGroups(b)[0], null);
  assert.strictEqual(info.special, SP.BOMB); assert.deepStrictEqual(info.pivot, { r: 3, c: 3 });
  var b2 = base();
  put(b2, 6, 1, '5'); put(b2, 6, 2, '5'); put(b2, 6, 3, '5');
  assert.strictEqual(L.classifyGroup(L.findMatchGroups(b2)[0], null).special, SP.NONE);
});
test('resolveStep：4 连消除 3 个、在交换位置留下条纹块', function () {
  var b = base();
  put(b, 3, 1, '5'); put(b, 3, 2, '5'); put(b, 3, 4, '5'); put(b, 4, 3, '5');
  L.swapCells(b, { r: 4, c: 3 }, { r: 3, c: 3 });
  var step = L.resolveStep(b, { chain: 1, swap: [{ r: 3, c: 3 }, { r: 4, c: 3 }] });
  assert.strictEqual(step.spawns.length, 1);
  assert.strictEqual(at(b, 3, 3).sp, SP.STRIPE_V); assert.strictEqual(at(b, 3, 3).t, 5);
  assert.strictEqual(step.cleared.length, 4);        // 4 个原块都消失（其中 1 个原地被特殊块取代）
  assert.strictEqual(countCells(b), 61);             // 64 - 4 + 1
  var merged = step.cleared.filter(function (e) { return e.merge; }).length;
  assert.strictEqual(merged, 4);                     // 全部并入新块的位置
  assert.strictEqual(step.gained, 4 * L.CFG.perPiece + L.CFG.bonusSpawn[SP.STRIPE_V]);
});
test('resolveStep：5 连留下彩虹块，t=-1', function () {
  var b = base();
  put(b, 3, 0, '5'); put(b, 3, 1, '5'); put(b, 3, 3, '5'); put(b, 3, 4, '5'); put(b, 4, 2, '5');
  L.swapCells(b, { r: 4, c: 2 }, { r: 3, c: 2 });
  var step = L.resolveStep(b, { chain: 1, swap: [{ r: 3, c: 2 }, { r: 4, c: 2 }] });
  assert.strictEqual(at(b, 3, 2).sp, SP.RAINBOW); assert.strictEqual(at(b, 3, 2).t, -1);
  assert.strictEqual(step.spawns[0].cell.sp, SP.RAINBOW);
});
test('resolveStep：L 形留下炸弹', function () {
  var b = base();
  put(b, 3, 4, '5'); put(b, 3, 5, '5'); put(b, 4, 3, '5'); put(b, 5, 3, '5'); put(b, 2, 3, '5');
  L.swapCells(b, { r: 2, c: 3 }, { r: 3, c: 3 });
  var step = L.resolveStep(b, { chain: 1, swap: [{ r: 3, c: 3 }, { r: 2, c: 3 }] });
  assert.strictEqual(at(b, 3, 3).sp, SP.BOMB);
  assert.strictEqual(step.cleared.length, 5);
});

console.log('\n[特殊块效果与连锁引爆]');
test('横条纹被匹配 → 清掉整行', function () {
  var b = base();
  put(b, 3, 1, '5h'); put(b, 3, 2, '5'); put(b, 3, 3, '5');
  var step = L.resolveStep(b, { chain: 1 });
  assert.strictEqual(step.cleared.length, 8);
  assert.strictEqual(step.effects.length, 1); assert.strictEqual(step.effects[0].kind, 'stripeH');
  for (var c = 0; c < SIZE; c++) assert.strictEqual(at(b, 3, c), null);
  assertUniqueCleared(step);
});
test('竖条纹被匹配 → 清掉整列', function () {
  var b = base();
  put(b, 1, 2, '5v'); put(b, 2, 2, '5'); put(b, 3, 2, '5');
  var step = L.resolveStep(b, { chain: 1 });
  assert.strictEqual(step.cleared.length, 8);
  for (var r = 0; r < SIZE; r++) assert.strictEqual(at(b, r, 2), null);
});
test('炸弹被匹配 → 清掉周围 3×3', function () {
  var b = base();
  put(b, 3, 3, '5b'); put(b, 3, 4, '5'); put(b, 3, 5, '5');
  var step = L.resolveStep(b, { chain: 1 });
  // 匹配 3 个 + 炸弹 3×3(9 格，其中 3 格已在匹配里：(3,3)(3,4) 之外 (3,5) 不在 3×3 内) → 并集
  var expect = {};
  [[3, 3], [3, 4], [3, 5]].forEach(function (p) { expect[p[0] + ',' + p[1]] = 1; });
  for (var r = 2; r <= 4; r++) for (var c = 2; c <= 4; c++) expect[r + ',' + c] = 1;
  assert.strictEqual(step.cleared.length, Object.keys(expect).length);
  assertUniqueCleared(step);
});
test('特殊块连锁引爆：条纹扫到炸弹，炸弹继续爆', function () {
  var b = base();
  put(b, 3, 0, '5h'); put(b, 3, 1, '5'); put(b, 3, 2, '5'); put(b, 3, 6, '2b');
  var step = L.resolveStep(b, { chain: 1 });
  assert.strictEqual(step.cleared.length, 8 + 6);       // 整行 8 + 炸弹波及上下两行各 3 格
  var kinds = step.effects.map(function (e) { return e.kind; }).sort();
  assert.deepStrictEqual(kinds, ['bomb', 'stripeH']);
  var bomb = step.effects.filter(function (e) { return e.kind === 'bomb'; })[0];
  var stripe = step.effects.filter(function (e) { return e.kind === 'stripeH'; })[0];
  assert.ok(bomb.at > stripe.at, '炸弹应晚于条纹引爆');
  assertUniqueCleared(step);
});
test('彩虹块被特效误伤 → 清掉场上最多的那一色', function () {
  var b = base();
  put(b, 3, 0, '5h'); put(b, 3, 1, '5'); put(b, 3, 2, '5'); put(b, 3, 6, 'R');
  var step = L.resolveStep(b, { chain: 1 });
  var rb = step.effects.filter(function (e) { return e.kind === 'rainbow'; });
  assert.strictEqual(rb.length, 1);
  assert.ok(rb[0].color >= 0 && rb[0].color <= 4);
  // 清完以后场上不应该再有该色
  for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) if (at(b, r, c)) assert.notStrictEqual(at(b, r, c).t, rb[0].color);
  assertUniqueCleared(step);
});
test('4 连里带着条纹：旧条纹引爆、新条纹照样生成', function () {
  var b = base();
  put(b, 3, 1, '5h'); put(b, 3, 2, '5'); put(b, 3, 4, '5'); put(b, 4, 3, '5');
  L.swapCells(b, { r: 4, c: 3 }, { r: 3, c: 3 });
  var step = L.resolveStep(b, { chain: 1, swap: [{ r: 3, c: 3 }, { r: 4, c: 3 }] });
  assert.strictEqual(step.effects[0].kind, 'stripeH');
  assert.strictEqual(at(b, 3, 3).sp, SP.STRIPE_V);          // 新块在整行被清之后依然留下
  assertUniqueCleared(step);
});

console.log('\n[特殊块组合技（交换两个特殊块）]');
function comboBoard() {
  var b = base();
  return b;
}
test('彩虹 + 普通块：清掉该色全部 + 彩虹自己', function () {
  var b = comboBoard();
  put(b, 3, 3, 'R'); put(b, 3, 4, '2');
  var n2 = 0; b.forEach(function (row) { row.forEach(function (x) { if (x && x.t === 2) n2++; }); });
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(1));
  assert.ok(res.valid);
  var st = res.steps[0];
  assert.strictEqual(st.combo, 'rainbowColor');
  assert.strictEqual(st.cleared.length, n2 + 1);
  assertUniqueCleared(st);
  assertHealthy(b);
});
test('彩虹 + 彩虹：全场清空', function () {
  var b = comboBoard();
  put(b, 3, 3, 'R'); put(b, 3, 4, 'R');
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(2));
  assert.strictEqual(res.steps[0].cleared.length, 64);
  assert.strictEqual(res.steps[0].combo, 'rainbowAll');
  assertHealthy(b);
});
test('条纹 + 条纹：十字（整行 + 整列）', function () {
  var b = comboBoard();
  put(b, 3, 3, '1h'); put(b, 3, 4, '2v');
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(3));
  var st = res.steps[0];
  assert.strictEqual(st.combo, 'cross');
  assert.strictEqual(st.cleared.length, 15);
  assertUniqueCleared(st);
});
test('条纹 + 炸弹：三行三列', function () {
  var b = comboBoard();
  put(b, 3, 3, '1h'); put(b, 3, 4, '2b');
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(4));
  assert.strictEqual(res.steps[0].combo, 'fatCross');
  assert.strictEqual(res.steps[0].cleared.length, 39);
});
test('炸弹 + 炸弹：5×5', function () {
  var b = comboBoard();
  put(b, 3, 3, '1b'); put(b, 3, 4, '2b');
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(5));
  assert.strictEqual(res.steps[0].combo, 'bigBomb');
  assert.strictEqual(res.steps[0].cleared.length, 25);
});
test('彩虹 + 条纹：该色全部变条纹并引爆', function () {
  var b = comboBoard();
  put(b, 3, 3, 'R'); put(b, 3, 4, '2h');
  var plain = 0; b.forEach(function (row) { row.forEach(function (x) { if (x && x.t === 2 && !x.sp) plain++; }); });
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(6));
  var st = res.steps[0];
  assert.strictEqual(st.combo, 'rainbowStripe');
  assert.strictEqual(st.transforms.length, plain);
  st.transforms.forEach(function (t) { assert.ok(t.to.sp === SP.STRIPE_H || t.to.sp === SP.STRIPE_V); assert.strictEqual(t.to.t, 2); });
  assert.ok(st.cleared.length >= 30, '应当清掉大片: ' + st.cleared.length);
  assertUniqueCleared(st); assertHealthy(b);
});
test('彩虹 + 炸弹：该色全部变炸弹并引爆', function () {
  var b = comboBoard();
  put(b, 3, 3, 'R'); put(b, 3, 4, '2b');
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(7));
  var st = res.steps[0];
  assert.strictEqual(st.combo, 'rainbowBomb');
  st.transforms.forEach(function (t) { assert.strictEqual(t.to.sp, SP.BOMB); });
  assertUniqueCleared(st); assertHealthy(b);
});
test('特殊块与普通块互换但没凑成三连 → 无效', function () {
  var b = comboBoard();
  put(b, 3, 3, '1h');
  assert.strictEqual(L.isValidSwap(b, { r: 3, c: 3 }, { r: 3, c: 4 }), false);
  var res = L.playMove(b, { r: 3, c: 3 }, { r: 3, c: 4 }, L.makeRng(8));
  assert.strictEqual(res.valid, false);
  assert.strictEqual(at(b, 3, 3).sp, SP.STRIPE_H);     // 棋盘没变
});

console.log('\n[生成棋盘 / 可行交换 / 洗牌]');
test('初始棋盘：600 个种子都没有现成三连、至少一个可行交换', function () {
  for (var s = 1; s <= 600; s++) {
    var b = L.generateBoard(L.makeRng(s));
    assertHealthy(b, 'seed ' + s);
    assert.strictEqual(countCells(b), 64);
  }
});
test('对抗型随机数（恒定值/循环）生成的初始棋盘照样合格', function () {
  [constRng(0), constRng(0.999999), constRng(0.5), cycRng()].forEach(function (rng, i) {
    assertHealthy(L.generateBoard(rng), 'adversarial ' + i);
  });
});
test('兜底模板本身：无三连且有可行交换', function () { assertHealthy(L.fallbackBoard(), 'fallback'); });
test('findPossibleMoves 找到的交换都有效，且恰好等于全部有效交换', function () {
  for (var s = 1; s <= 80; s++) {
    var b = L.generateBoard(L.makeRng(1000 + s));
    var found = L.findPossibleMoves(b), count = 0;
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) {
      [[0, 1], [1, 0]].forEach(function (d) {
        var a = { r: r, c: c }, n = { r: r + d[0], c: c + d[1] };
        if (!L.inBounds(n.r, n.c)) return;
        // 暴力：真的交换一下看有没有三连
        L.swapCells(b, a, n);
        var real = L.findRuns(b).length > 0;
        L.swapCells(b, a, n);
        assert.strictEqual(L.isValidSwap(b, a, n), real, '交换判定与暴力结果不符');
        if (real) count++;
      });
    }
    assert.strictEqual(found.length, count);
    found.forEach(function (m) { assert.ok(L.isValidSwap(b, m.a, m.b)); });
  }
});
test('死局盘面：hasMoves=false；洗牌后无三连且有可行交换，块都还在', function () {
  var b = base();
  // 底盘 (c+2r)%5 的纯斜纹盘面理应没有可行交换（先确认，不是则换一个死局构造）
  var dead = !L.hasMoves(b);
  if (!dead) { b = L.fallbackBoard(); for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell((c + 2 * r) % 6); dead = !L.hasMoves(b); }
  assert.ok(dead, '需要一个死局盘面来测洗牌');
  var ids = []; b.forEach(function (row) { row.forEach(function (x) { ids.push(x.id); }); });
  var res = L.shuffleBoard(b, L.makeRng(9));
  assertHealthy(b, 'shuffled');
  var ids2 = []; b.forEach(function (row) { row.forEach(function (x) { ids2.push(x.id); }); });
  assert.deepStrictEqual(ids.slice().sort(function (x, y) { return x - y; }), ids2.slice().sort(function (x, y) { return x - y; }));
  assert.strictEqual(res.moves.length, 64);
  res.moves.forEach(function (m) { assert.strictEqual(b[m.to.r][m.to.c], m.cell); });
});
test('洗牌保留特殊块；300 个种子的死局盘面都能洗出可玩的局面', function () {
  for (var s = 1; s <= 300; s++) {
    var rng = L.makeRng(5000 + s);
    var b = L.generateBoard(rng);
    // 造一个死局：整盘用斜纹，再撒几个条纹/炸弹（不放彩虹，彩虹本身就保证有可行交换）
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell((c + 2 * r) % 5);
    b[2][2] = L.makeCell(b[2][2].t, SP.STRIPE_H); b[5][6] = L.makeCell(b[5][6].t, SP.BOMB);
    L.shuffleBoard(b, rng);
    assertHealthy(b, 'seed ' + s);
    var sp = 0; b.forEach(function (row) { row.forEach(function (x) { if (x.sp) sp++; }); });
    assert.strictEqual(sp, 2, '洗牌弄丢了特殊块');
  }
});
test('洗牌兜底：对抗型随机数也不死循环、结果合格', function () {
  [constRng(0), constRng(0.9999), cycRng()].forEach(function (rng, i) {
    var b = L.newBoard();
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell((c + 2 * r) % 5);
    L.shuffleBoard(b, rng);
    assertHealthy(b, 'adv shuffle ' + i);
  });
});

console.log('\n[下落与补充]');
test('applyGravity：压实、补满、drops 记录自洽', function () {
  var b = base();
  var gone = [[7, 2], [6, 2], [7, 5], [0, 0], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7]];
  gone.forEach(function (p) { b[p[0]][p[1]] = null; });
  var before = {}; b.forEach(function (row, r) { row.forEach(function (x, c) { if (x) before[x.id] = { r: r, c: c }; }); });
  var drops = L.applyGravity(b, L.makeRng(11), false);
  assert.strictEqual(countCells(b), 64);
  drops.forEach(function (d) {
    assert.strictEqual(b[d.toR][d.c], d.cell);
    if (d.isNew) assert.ok(d.fromR < 0, '新块应从棋盘上方进入'); else { assert.ok(d.toR > d.fromR); assert.deepStrictEqual(before[d.cell.id], { r: d.fromR, c: d.c }); }
  });
  assert.strictEqual(drops.filter(function (d) { return d.isNew; }).length, gone.length);
  // 第 7 列下半截（第 3~7 行）被清掉：5 个新块依次叠在棋盘上方，剩下的 3 个旧块各自下落 5 行
  var col7New = drops.filter(function (d) { return d.c === 7 && d.isNew; }).map(function (d) { return d.fromR; }).sort(function (x, y) { return x - y; });
  assert.deepStrictEqual(col7New, [-5, -4, -3, -2, -1]);
  var col7Old = drops.filter(function (d) { return d.c === 7 && !d.isNew; });
  assert.strictEqual(col7Old.length, 3);
  col7Old.forEach(function (d) { assert.strictEqual(d.toR - d.fromR, 5); });
  // 列内相对顺序不变（不穿插）
  for (var c = 0; c < SIZE; c++) {
    var olds = []; for (var r = 0; r < SIZE; r++) if (before[b[r][c].id] && before[b[r][c].id].c === c) olds.push(before[b[r][c].id].r);
    for (var i = 1; i < olds.length; i++) assert.ok(olds[i] > olds[i - 1], '列内顺序被打乱');
  }
});
test('safe 模式补块：新块永远不会和邻居凑出三连（即使随机数恒定）', function () {
  [constRng(0), constRng(0.5), constRng(0.999), cycRng()].forEach(function (rng, i) {
    var b = base();
    for (var r = 0; r < 5; r++) for (var c = 0; c < SIZE; c++) b[r][c] = null;
    L.applyGravity(b, rng, true);
    assert.strictEqual(L.findRuns(b).length, 0, '安全补块仍凑出三连 ' + i);
  });
});

console.log('\n[级联循环必然终止]');
test('随机乱盘（满是三连）：连锁必然结束，盘面稳定可玩，轮数不超上限', function () {
  var maxSteps = 0;
  for (var s = 1; s <= 400; s++) {
    var rng = L.makeRng(9000 + s), b = L.newBoard();
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell(Math.floor(rng() * 3));   // 只用 3 种造型 → 三连遍地
    var steps = L.resolveAll(b, rng, null);
    assert.ok(steps.length <= L.CFG.maxCascade);
    maxSteps = Math.max(maxSteps, steps.length);
    assert.strictEqual(countCells(b), 64);
    assert.strictEqual(L.findRuns(b).length, 0);
    steps.forEach(function (st, i) { assert.strictEqual(st.chain, i + 1); assert.ok(st.gained > 0); assertUniqueCleared(st); });
  }
  console.log('       （最长连锁 ' + maxSteps + ' 轮）');
});
test('对抗型随机数（补块永远同色）：连锁照样终止', function () {
  [constRng(0), constRng(0.3), constRng(0.999999), cycRng()].forEach(function (rng, i) {
    var b = L.newBoard();
    for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell(0);
    var steps = L.resolveAll(b, rng, null);
    assert.ok(steps.length <= L.CFG.maxCascade, 'adv ' + i + ' 轮数 ' + steps.length);
    assert.strictEqual(L.findRuns(b).length, 0, 'adv ' + i + ' 盘面仍有三连');
    assert.strictEqual(countCells(b), 64);
  });
});
test('硬上限：把上限压到 2 轮，repairBoard 兜底后盘面依然干净', function () {
  var saved = L.CFG.maxCascade; L.CFG.maxCascade = 2;
  try {
    for (var s = 1; s <= 100; s++) {
      var rng = L.makeRng(777 + s), b = L.newBoard();
      for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) b[r][c] = L.makeCell(Math.floor(rng() * 2));
      var steps = L.resolveAll(b, rng, null);
      assert.ok(steps.length <= 2);
      assert.strictEqual(L.findRuns(b).length, 0);
    }
  } finally { L.CFG.maxCascade = saved; }
});

console.log('\n[一次完整操作 playMove]');
test('无效交换：返回 valid=false，棋盘原样', function () {
  var rng = L.makeRng(21), b = L.generateBoard(rng);
  var snapshot = L.boardToRows(b).join('|');
  var tried = 0;
  for (var r = 0; r < SIZE && tried < 20; r++) for (var c = 0; c < SIZE - 1 && tried < 20; c++) {
    if (!L.isValidSwap(b, { r: r, c: c }, { r: r, c: c + 1 })) {
      var res = L.playMove(b, { r: r, c: c }, { r: r, c: c + 1 }, rng);
      assert.strictEqual(res.valid, false); assert.strictEqual(L.boardToRows(b).join('|'), snapshot); tried++;
    }
  }
  assert.ok(tried > 0);
  assert.strictEqual(L.playMove(b, { r: 0, c: 0 }, { r: 2, c: 0 }, rng).valid, false);   // 不相邻
  assert.strictEqual(L.playMove(b, { r: 0, c: 0 }, { r: 1, c: 1 }, rng).valid, false);   // 斜着
  assert.strictEqual(L.playMove(b, { r: -1, c: 0 }, { r: 0, c: 0 }, rng).valid, false);  // 越界
});
test('随机机器人连玩 1500 步：每步之后盘面都健康，分数递增', function () {
  var rng = L.makeRng(31337), b = L.generateBoard(rng), total = 0, moves = 0, spStats = {}, maxChain = 0, shuffles = 0;
  for (var i = 0; i < 1500; i++) {
    var ms = L.findPossibleMoves(b);
    assert.ok(ms.length > 0, '没有可行交换');
    var m = ms[Math.floor(rng() * ms.length)];
    var res = L.playMove(b, m.a, m.b, rng);
    assert.ok(res.valid);
    assert.ok(res.gained > 0);
    total += res.gained; moves++;
    maxChain = Math.max(maxChain, res.maxChain);
    if (res.shuffle) shuffles++;
    res.steps.forEach(function (st) { st.spawns.forEach(function (sp) { spStats[sp.cell.sp] = (spStats[sp.cell.sp] || 0) + 1; }); assertUniqueCleared(st); });
    assertHealthy(b, 'move ' + i);
  }
  assert.ok(spStats[SP.STRIPE_H] > 0 && spStats[SP.STRIPE_V] > 0, '应当出现条纹块');
  assert.ok(spStats[SP.BOMB] > 0, '应当出现炸弹块');
  assert.ok(spStats[SP.RAINBOW] > 0, '应当出现彩虹块');
  console.log('       （总分 ' + total + '，最长连锁 ' + maxChain + '，洗牌 ' + shuffles + ' 次，特殊块生成 ' + JSON.stringify(spStats) + '）');
});
test('同一个种子，结果完全一致（可复现）', function () {
  function run() {
    var rng = L.makeRng(4242), b = L.generateBoard(rng), out = [];
    for (var i = 0; i < 40; i++) { var m = L.findPossibleMoves(b)[0]; var r = L.playMove(b, m.a, m.b, rng); out.push(r.gained + ':' + r.steps.length); }
    return out.join(',') + '|' + L.boardToRows(b).join('/');
  }
  assert.strictEqual(run(), run());
});
test('steps 记录自洽：被消除的块、新块、下落合起来恰好等于棋盘变化', function () {
  for (var s = 1; s <= 60; s++) {
    var rng = L.makeRng(300 + s), b = L.generateBoard(rng);
    var m = L.findPossibleMoves(b)[0];
    var alive = {}; b.forEach(function (row) { row.forEach(function (x) { alive[x.id] = x; }); });
    var res = L.playMove(b, m.a, m.b, rng);
    res.steps.forEach(function (st) {
      st.transforms.forEach(function (t) { delete alive[t.from.id]; alive[t.to.id] = t.to; });
      st.cleared.forEach(function (e) { assert.ok(alive[e.cell.id], '消除了不存在的块'); delete alive[e.cell.id]; });
      st.spawns.forEach(function (sp) { alive[sp.cell.id] = sp.cell; });
      st.drops.forEach(function (d) { if (d.isNew) alive[d.cell.id] = d.cell; else assert.ok(alive[d.cell.id], '移动了不存在的块'); });
    });
    var ids = Object.keys(alive).map(Number).sort(function (x, y) { return x - y; });
    var ids2 = []; b.forEach(function (row) { row.forEach(function (x) { ids2.push(x.id); }); });
    ids2.sort(function (x, y) { return x - y; });
    if (!res.shuffle) assert.deepStrictEqual(ids, ids2, 'seed ' + s + ' 回放后的块集合与最终棋盘不一致');
  }
});

console.log('\n[关卡与提示]');
test('关卡配置：第 1 关 20 步，目标分、步数随关卡单调不降', function () {
  var c1 = L.levelConfig(1);
  assert.strictEqual(c1.moves, 20);
  var prev = c1;
  for (var n = 2; n <= 40; n++) {
    var c = L.levelConfig(n);
    assert.ok(c.target > prev.target); assert.ok(c.moves >= prev.moves); assert.ok(c.moves <= 30);
    assert.strictEqual(c.level, n); prev = c;
  }
  assert.strictEqual(L.levelConfig(0).level, 1);
});
test('judgeLevel：达标即过关，步数用完才失败，达标优先于步数用完', function () {
  assert.strictEqual(L.judgeLevel(1500, 1500, 5), 'win');
  assert.strictEqual(L.judgeLevel(1500, 1500, 0), 'win');
  assert.strictEqual(L.judgeLevel(1499, 1500, 0), 'lose');
  assert.strictEqual(L.judgeLevel(100, 1500, 3), 'continue');
  assert.strictEqual(L.movesBonus(7), 7 * L.CFG.movesBonus);
  assert.strictEqual(L.movesBonus(-2), 0);
});
test('pickHint：给出的提示一定是有效交换；死局返回 null', function () {
  for (var s = 1; s <= 100; s++) {
    var rng = L.makeRng(60 + s), b = L.generateBoard(rng);
    var h = L.pickHint(b, rng);
    assert.ok(h && L.isValidSwap(b, h.a, h.b));
  }
  var d = L.newBoard();
  for (var r = 0; r < SIZE; r++) for (var c = 0; c < SIZE; c++) d[r][c] = L.makeCell((c + 2 * r) % 5);
  if (!L.hasMoves(d)) assert.strictEqual(L.pickHint(d, L.makeRng(1)), null);
});
test('提示优先推荐价值更高的交换（能凑出 4 连的优先于普通三连）', function () {
  var b = base();
  put(b, 3, 1, '5'); put(b, 3, 2, '5'); put(b, 3, 4, '5'); put(b, 4, 3, '5');   // 一个能凑 4 连的交换
  var h = L.pickHint(b, L.makeRng(1));
  var v = L.evaluateMove(b, h.a, h.b);
  assert.ok(v >= 4, '提示价值应至少为 4: ' + v);
});

console.log('\n' + (failed ? '失败 ' + failed + ' 项，' : '全部通过：') + passed + ' 项通过');
process.exit(failed ? 1 : 0);
