/* 奶蛙跳一跳 · 核心规则测试
 * 运行：node test-logic.js
 * 只依赖 node 自带模块，浏览器页面不会加载这个文件。 */
'use strict';
var assert = require('assert');
var L = require('./logic.js');
var CFG = L.CFG;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
}
function near(a, b, eps, msg) { assert.ok(Math.abs(a - b) <= (eps || 1e-9), (msg || '') + ' 期望 ' + b + ' 实际 ' + a); }
/** 临时改 CFG 跑一段（用「二进制整数分数」常量，边界才能精确相等），跑完恢复 */
function withCfg(over, fn) {
  var old = {}, k;
  for (k in over) { old[k] = CFG[k]; CFG[k] = over[k]; }
  try { fn(); } finally { for (k in old) CFG[k] = old[k]; }
}

var cube = function (x, z, size) { return L.makePlatform(x, z, size, 'cube', 0); };
var cyl = function (x, z, size) { return L.makePlatform(x, z, size, 'cylinder', 0); };

console.log('蓄力 → 距离');

test('蓄力 0 秒跳 0 距离；线性增长；封顶', function () {
  assert.strictEqual(L.jumpDistance(0), 0);
  near(L.jumpDistance(0.5), CFG.CHARGE_SPEED * 0.5);
  near(L.jumpDistance(1), CFG.CHARGE_SPEED);
  var cap = CFG.CHARGE_SPEED * CFG.MAX_CHARGE_TIME;
  near(L.jumpDistance(CFG.MAX_CHARGE_TIME), cap);
  near(L.jumpDistance(CFG.MAX_CHARGE_TIME + 0.001), cap);
  near(L.jumpDistance(60), cap, 1e-9, '按一分钟也只跳到上限');
  near(L.jumpDistance(Infinity), cap);
  near(L.maxJumpDistance(), cap);
});

test('非法蓄力（负数 / NaN / undefined）当 0', function () {
  assert.strictEqual(L.jumpDistance(-1), 0);
  assert.strictEqual(L.jumpDistance(NaN), 0);
  assert.strictEqual(L.jumpDistance(undefined), 0);
  assert.strictEqual(L.clampChargeTime(-5), 0);
});

test('距离随蓄力单调不减（扫 0~3 秒）', function () {
  var prev = -1;
  for (var t = 0; t <= 3; t += 0.01) {
    var d = L.jumpDistance(t);
    assert.ok(d >= prev - 1e-12, 't=' + t);
    prev = d;
  }
});

test('蓄力上限是个合理有限值，且上限处进度 = 1', function () {
  assert.ok(isFinite(CFG.MAX_CHARGE_TIME) && CFG.MAX_CHARGE_TIME > 0.5 && CFG.MAX_CHARGE_TIME <= 3);
  near(L.chargeRatio(CFG.MAX_CHARGE_TIME), 1);
  near(L.chargeRatio(CFG.MAX_CHARGE_TIME * 10), 1);
  near(L.chargeRatio(CFG.MAX_CHARGE_TIME / 2), 0.5);
  assert.strictEqual(L.chargeRatio(-1), 0);
});

test('chargeTimeForDistance 与 jumpDistance 互为反函数（上限内）', function () {
  for (var d = 0; d <= L.maxJumpDistance(); d += 0.37) near(L.jumpDistance(L.chargeTimeForDistance(d)), d, 1e-9);
  assert.ok(L.chargeTimeForDistance(L.maxJumpDistance() + 1) > CFG.MAX_CHARGE_TIME, '够不着的距离要能被识别出来');
});

test('滞空运动学：抛物线首尾为 0、最高点居中；时间/高度随距离单调；翻转圈数', function () {
  near(L.arcHeight(2, 0), 0); near(L.arcHeight(2, 1), 0); near(L.arcHeight(2, 0.5), 2);
  assert.ok(L.arcHeight(2, 1.2) < 0, '过了落点继续往下掉');
  assert.ok(L.jumpDuration(5) > L.jumpDuration(1));
  assert.ok(L.jumpHeight(5) > L.jumpHeight(1));
  assert.ok(L.jumpHeight(99) <= CFG.H_MAX + 1e-12);
  assert.strictEqual(L.flipCount(1), 0);
  assert.strictEqual(L.flipCount(CFG.FLIP1_DIST), 1);
  assert.strictEqual(L.flipCount(CFG.FLIP2_DIST), 2);
});

console.log('\n落点判定（方块）');

test('方块：中心 = 完美；台内 = 普通；台边上 = 普通（算台内）', function () {
  var p = cube(0, 0, 2); // 半边长 1
  assert.strictEqual(L.judgeLanding(p, { x: 0, z: 0 }).type, 'perfect');
  assert.strictEqual(L.judgeLanding(p, { x: 0.6, z: 0 }).type, 'normal');
  assert.strictEqual(L.judgeLanding(p, { x: 1, z: 0 }).type, 'normal', '恰好压在台边');
  assert.strictEqual(L.judgeLanding(p, { x: 1, z: 1 }).type, 'normal', '恰好压在角上');
});

test('方块：完美半径边界（精确值）', function () {
  withCfg({ PERFECT_R: 0.5, SLIP_MARGIN: 0.25, EDGE_BAND: 0.125 }, function () {
    var p = cube(0, 0, 4);
    assert.strictEqual(L.judgeLanding(p, { x: 0.5, z: 0 }).type, 'perfect', '恰好等于半径 = 完美');
    assert.strictEqual(L.judgeLanding(p, { x: 0.5 + 1e-9, z: 0 }).type, 'normal', '多一点点 = 普通');
    assert.strictEqual(L.judgeLanding(p, { x: 0.3, z: 0.4 }).type, 'perfect', '斜着量也按欧氏距离（0.5）');
    assert.strictEqual(L.judgeLanding(p, { x: 0.4, z: 0.4 }).type, 'normal', '0.566 > 0.5');
  });
});

test('方块：滑落 / 掉落边界（精确值）', function () {
  withCfg({ PERFECT_R: 0.5, SLIP_MARGIN: 0.25, EDGE_BAND: 0.125 }, function () {
    var p = cube(0, 0, 2); // 半边长 1，台边在 x = ±1
    assert.strictEqual(L.judgeLanding(p, { x: 1 + 1e-9, z: 0 }).type, 'slip', '刚出台边 = 滑落');
    assert.strictEqual(L.judgeLanding(p, { x: 1.25, z: 0 }).type, 'slip', '恰好等于 SLIP_MARGIN = 滑落');
    assert.strictEqual(L.judgeLanding(p, { x: 1.25 + 1e-9, z: 0 }).type, 'miss', '再远一点 = 直接掉');
    assert.strictEqual(L.judgeLanding(p, { x: 3, z: 0 }).type, 'miss');
    assert.strictEqual(L.judgeLanding(p, { x: -1.2, z: 0 }).type, 'slip', '近端一侧同理');
    // 斜角：离角的欧氏距离才算数
    assert.strictEqual(L.judgeLanding(p, { x: 1.15, z: 1.15 }).type, 'slip', '距角 0.212 < 0.25');
    assert.strictEqual(L.judgeLanding(p, { x: 1.2, z: 1.2 }).type, 'miss', '距角 0.283 > 0.25');
  });
});

test('方块：险过（贴边 EDGE_BAND 以内 wobble=true）边界', function () {
  withCfg({ PERFECT_R: 0.25, SLIP_MARGIN: 0.25, EDGE_BAND: 0.125 }, function () {
    var p = cube(0, 0, 4); // 台边 x = ±2
    var j1 = L.judgeLanding(p, { x: 1.875, z: 0 });
    assert.strictEqual(j1.type, 'normal'); assert.strictEqual(j1.wobble, true, '离台边恰好 0.125 → 险过');
    var j2 = L.judgeLanding(p, { x: 1.874, z: 0 });
    assert.strictEqual(j2.wobble, false, '离台边 0.126 → 稳稳站住');
    assert.strictEqual(L.judgeLanding(p, { x: 2, z: 0 }).wobble, true, '压在台边上也算险过');
    assert.strictEqual(L.judgeLanding(p, { x: 0, z: 0 }).wobble, false);
  });
});

test('用真实常量验证边界两侧（±1e-6）', function () {
  var p = cube(0, 0, 2);
  assert.strictEqual(L.judgeLanding(p, { x: CFG.PERFECT_R - 1e-6, z: 0 }).type, 'perfect');
  assert.strictEqual(L.judgeLanding(p, { x: CFG.PERFECT_R + 1e-6, z: 0 }).type, 'normal');
  assert.strictEqual(L.judgeLanding(p, { x: 1 - 1e-6, z: 0 }).type, 'normal');
  assert.strictEqual(L.judgeLanding(p, { x: 1 + 1e-6, z: 0 }).type, 'slip');
  assert.strictEqual(L.judgeLanding(p, { x: 1 + CFG.SLIP_MARGIN - 1e-6, z: 0 }).type, 'slip');
  assert.strictEqual(L.judgeLanding(p, { x: 1 + CFG.SLIP_MARGIN + 1e-6, z: 0 }).type, 'miss');
});

console.log('\n落点判定（圆柱）');

test('圆柱：完美 / 普通 / 台边 / 滑落 / 掉落', function () {
  withCfg({ PERFECT_R: 0.5, SLIP_MARGIN: 0.25, EDGE_BAND: 0.125 }, function () {
    var p = cyl(2, -1, 2); // 半径 1，圆心 (2,-1)
    assert.strictEqual(L.judgeLanding(p, { x: 2, z: -1 }).type, 'perfect');
    assert.strictEqual(L.judgeLanding(p, { x: 2.5, z: -1 }).type, 'perfect');
    assert.strictEqual(L.judgeLanding(p, { x: 2.5 + 1e-9, z: -1 }).type, 'normal');
    assert.strictEqual(L.judgeLanding(p, { x: 3, z: -1 }).type, 'normal', '恰好在圆边上');
    assert.strictEqual(L.judgeLanding(p, { x: 3 + 1e-9, z: -1 }).type, 'slip');
    assert.strictEqual(L.judgeLanding(p, { x: 3.25, z: -1 }).type, 'slip');
    assert.strictEqual(L.judgeLanding(p, { x: 3.25 + 1e-9, z: -1 }).type, 'miss');
  });
});

test('圆柱：方块的角在圆柱上不算台面（斜 45° 的点）', function () {
  var c = cyl(0, 0, 2), b = cube(0, 0, 2);
  var pt = { x: 0.85, z: 0.85 }; // 离中心 1.202 > 1：圆柱外，方块内
  assert.strictEqual(L.judgeLanding(b, pt).type, 'normal');
  assert.notStrictEqual(L.judgeLanding(c, pt).type, 'normal');
});

test('滑落方向：落点在中心哪一侧，就往哪一侧滑', function () {
  var p = cube(5, 0, 2);
  assert.strictEqual(L.slipDirection(p, 0, { x: 6.1, z: 0 }), 1);
  assert.strictEqual(L.slipDirection(p, 0, { x: 3.9, z: 0 }), -1);
  var q = cube(0, 5, 2);
  assert.strictEqual(L.slipDirection(q, 1, { x: 0, z: 3.9 }), -1);
});

console.log('\n一次起跳的完整结果');

test('刚好蓄到中心 → 跳到下一个台子 + 完美；蓄短/蓄长 → 滑落或掉落', function () {
  var cur = cube(0, 0, 2), next = cube(4, 0, 2);
  var start = { x: 0, z: 0 };
  var tCenter = L.chargeTimeForDistance(4);
  var r = L.resolveJump(cur, next, start, 0, tCenter);
  assert.strictEqual(r.outcome, 'next'); assert.strictEqual(r.quality, 'perfect');
  near(r.landing.x, 4); near(r.landing.z, 0);

  r = L.resolveJump(cur, next, start, 0, tCenter + 0.5 / CFG.CHARGE_SPEED); // 多跳 0.5：台内普通
  assert.strictEqual(r.outcome, 'next'); assert.strictEqual(r.quality, 'normal');

  r = L.resolveJump(cur, next, start, 0, L.chargeTimeForDistance(3.9)); // 离近边 3.0 差 -0.1... 台面 [3,5]，3.9 在台内
  assert.strictEqual(r.outcome, 'next');

  r = L.resolveJump(cur, next, start, 0, L.chargeTimeForDistance(2.9)); // 离近边 0.1：滑落，往后滑
  assert.strictEqual(r.outcome, 'slip'); assert.strictEqual(r.onPlatform, 'next'); assert.strictEqual(r.slipDir, -1);

  r = L.resolveJump(cur, next, start, 0, L.chargeTimeForDistance(5.1)); // 远边外 0.1：滑落，往前滑
  assert.strictEqual(r.outcome, 'slip'); assert.strictEqual(r.slipDir, 1);

  r = L.resolveJump(cur, next, start, 0, L.chargeTimeForDistance(6.0)); // 过头太多：直接掉
  assert.strictEqual(r.outcome, 'miss'); assert.strictEqual(r.slipDir, 0);

  r = L.resolveJump(cur, next, start, 0, L.chargeTimeForDistance(2.0)); // 在空隙正中：直接掉（原台 [-1,1]，新台 [3,5]）
  assert.strictEqual(r.outcome, 'miss');
});

test('点一下（蓄力极短）→ 还站在原台子上，不算失败也不得分', function () {
  var cur = cube(0, 0, 2), next = cube(4, 0, 2);
  var r = L.resolveJump(cur, next, { x: 0, z: 0 }, 0, 0.03);
  assert.strictEqual(r.outcome, 'stay'); assert.strictEqual(r.quality, null);
  r = L.resolveJump(cur, next, { x: 0, z: 0 }, 0, 0);
  assert.strictEqual(r.outcome, 'stay');
});

test('站在台子最前端再点一下 → 跳出原台边：滑落', function () {
  var cur = cube(0, 0, 2), next = cube(4, 0, 2);
  var r = L.resolveJump(cur, next, { x: 0.95, z: 0 }, 0, L.chargeTimeForDistance(0.2)); // 落点 1.15，出台边 0.15
  assert.strictEqual(r.outcome, 'slip'); assert.strictEqual(r.onPlatform, 'cur'); assert.strictEqual(r.slipDir, 1);
});

test('沿轴 1（左上）同样成立；蓄力超过上限不会跳得更远', function () {
  var cur = cyl(0, 0, 2), next = cyl(0, 4, 2);
  var r = L.resolveJump(cur, next, { x: 0, z: 0 }, 1, L.chargeTimeForDistance(4));
  assert.strictEqual(r.outcome, 'next'); assert.strictEqual(r.quality, 'perfect');
  near(r.landing.z, 4); near(r.landing.x, 0);
  var r1 = L.resolveJump(cur, next, { x: 0, z: 0 }, 1, CFG.MAX_CHARGE_TIME);
  var r2 = L.resolveJump(cur, next, { x: 0, z: 0 }, 1, CFG.MAX_CHARGE_TIME * 5);
  near(r1.distance, r2.distance);
});

console.log('\n计分（还原原版）');

test('普通 +1；连续完美 +2、+4、+6…；普通落地打断连击', function () {
  var streak = 0, total = 0, seq = [], step = function (q) {
    var r = L.scoreLanding(q, streak); streak = r.streak; total += r.points; seq.push(r.points);
  };
  step('normal'); step('perfect'); step('perfect'); step('perfect'); step('normal'); step('perfect'); step('perfect');
  assert.deepStrictEqual(seq, [1, 2, 4, 6, 1, 2, 4]);
  assert.strictEqual(total, 20); assert.strictEqual(streak, 2);
  assert.deepStrictEqual(L.scoreLanding('normal', 5), { points: 1, streak: 0 });
  assert.deepStrictEqual(L.scoreLanding('perfect', 0), { points: 2, streak: 1 });
  assert.deepStrictEqual(L.scoreLanding('perfect', 9), { points: 20, streak: 10 });
});

console.log('\n难度曲线');

test('难度随分数单调上升并封顶；台子变小、空隙变大', function () {
  assert.strictEqual(L.difficulty(0), 0);
  assert.strictEqual(L.difficulty(CFG.DIFF_FULL_SCORE), 1);
  assert.strictEqual(L.difficulty(10000), 1);
  var prev = L.sizeRange(0), prevG = L.gapRange(0);
  for (var s = 1; s <= 200; s++) {
    var sr = L.sizeRange(s), gr = L.gapRange(s);
    assert.ok(sr[0] <= prev[0] + 1e-12 && sr[1] <= prev[1] + 1e-12, '台子不会变大 s=' + s);
    assert.ok(gr[0] >= prevG[0] - 1e-12 && gr[1] >= prevG[1] - 1e-12, '空隙不会变小 s=' + s);
    assert.ok(sr[0] <= sr[1] && gr[0] <= gr[1]);
    prev = sr; prevG = gr;
  }
  assert.ok(L.sizeRange(0)[1] > L.sizeRange(150)[1] && L.gapRange(0)[1] < L.gapRange(150)[1]);
  assert.ok(L.sizeRange(9999)[0] >= 1.0, '台子再小也比奶蛙的脚大得多');
  assert.ok(CFG.MIN_GAP >= 2 * CFG.SLIP_MARGIN, '相邻两台的滑落区不会重叠');
  assert.ok(L.sizeRange(9999)[0] / 2 > CFG.PERFECT_R, '完美圈一定落在最小台子内部');
});

test('「缓慢」增加：分数 30 时难度不到 25%', function () {
  assert.ok(L.difficulty(30) < 0.25);
});

console.log('\n台子生成（性质测试）');

/** 在当前台子上随机选一个「玩家可能站的位置」（沿跳跃轴方向 ±curHalf，涵盖最近端/最远端） */
function randomPlayerSpot(cur, axis, rng, extreme) {
  var half = cur.size / 2;
  var e = extreme === 'near' ? -half : extreme === 'far' ? half : (rng() * 2 - 1) * half;
  return axis === 0 ? { x: cur.x + e, z: cur.z } : { x: cur.x, z: cur.z + e };
}

test('任意生成的下一个台子都在可达的蓄力范围内（含完美区），且蓄力不超上限', function () {
  var rng = L.createRng(12345);
  var cnt = 0, maxD = 0, minD = 1e9, maxT = 0;
  var scores = [0, 1, 5, 20, 50, 100, 149, 150, 300, 5000];
  var extremes = ['near', 'far', 'rand', 'rand'];
  for (var i = 0; i < 6000; i++) {
    var score = scores[i % scores.length];
    var axis = rng() < 0.5 ? 0 : 1;
    // 当前台子：整个合法尺寸范围内都试（含最大的 2.6）
    var curSize = lerpRange(rng, CFG.SIZE_HARD[0], CFG.SIZE_EASY[1]);
    var cur = L.makePlatform((rng() - 0.5) * 40, (rng() - 0.5) * 40, curSize, rng() < 0.5 ? 'cube' : 'cylinder', 0);
    var player = randomPlayerSpot(cur, axis, rng, extremes[i % extremes.length]);
    var nxt = L.planNextPlatform({ cur: cur, player: player, axis: axis, score: score, rng: rng, prevColor: 0 });

    assert.ok(nxt.distance > 0, '台子在前方');
    assert.ok(L.isReachable(nxt.distance), '够得着 distance=' + nxt.distance);
    var tNeed = L.chargeTimeForDistance(nxt.distance);                         // 蹦到台子正中心要的蓄力
    var tPerfectFar = L.chargeTimeForDistance(nxt.distance + CFG.PERFECT_R);  // 完美区最远处
    assert.ok(tNeed <= CFG.MAX_CHARGE_TIME, '蓄力时长不超上限');
    assert.ok(tPerfectFar <= CFG.MAX_CHARGE_TIME + 1e-9, '完美区最远端也在上限内 t=' + tPerfectFar);
    assert.ok(nxt.distance <= L.reachLimit() + 1e-9);

    // 玩家落点 → 台子近边的距离也应该 > 0（台子不压在脚下）
    var half = nxt.size / 2;
    assert.ok(nxt.distance - half >= CFG.MIN_GAP - 1e-9, '近边离玩家 ≥ MIN_GAP');
    // 与当前台子的空隙不小于 MIN_GAP（沿跳跃轴）
    var along = axis === 0 ? 'x' : 'z';
    var gapReal = (nxt[along] - half) - (cur[along] + cur.size / 2);
    assert.ok(gapReal >= CFG.MIN_GAP - 1e-9, '台边空隙 ≥ MIN_GAP, 实际 ' + gapReal);
    near(gapReal, nxt.gap, 1e-9);
    // 侧向与玩家对齐
    var lat = axis === 0 ? 'z' : 'x';
    near(nxt[lat], player[lat], 1e-12, '侧向对齐玩家');
    assert.strictEqual(nxt.axis, axis);

    // 尺寸落在当前难度范围内
    var sr = L.sizeRange(score);
    assert.ok(nxt.size >= sr[0] - 1e-9 && nxt.size <= sr[1] + 1e-9);
    assert.ok(nxt.shape === 'cube' || nxt.shape === 'cylinder');
    assert.ok(nxt.colorIdx >= 0 && nxt.colorIdx < CFG.PALETTE_SIZE && nxt.colorIdx !== 0, '不和上一个撞色');
    cnt++; maxD = Math.max(maxD, nxt.distance); minD = Math.min(minD, nxt.distance); maxT = Math.max(maxT, tPerfectFar);
  }
  console.log('       （' + cnt + ' 个台子；跳距 ' + minD.toFixed(2) + '~' + maxD.toFixed(2) + 'u；完美区最远端蓄力最长 ' + maxT.toFixed(3) + 's / 上限 ' + CFG.MAX_CHARGE_TIME + 's）');
});

function lerpRange(rng, a, b) { return a + (b - a) * rng(); }

test('兜底：就算上一个台子特别大，下一个也在可达范围内', function () {
  var rng = L.createRng(7);
  var cur = cube(0, 0, 2.7); // 比任何正常台子都大
  for (var i = 0; i < 500; i++) {
    var axis = i % 2;
    var p = L.planNextPlatform({ cur: cur, player: randomPlayerSpot(cur, axis, rng, 'near'), axis: axis, score: 150, rng: rng });
    assert.ok(L.isReachable(p.distance));
  }
});

test('生成是可复现的：同一个种子 → 同样的台子序列；不同种子不同', function () {
  function run(seed) {
    var rng = L.createRng(seed), cur = cube(0, 0, 2.4), pl = { x: 0, z: 0 }, axis = 0, run = 0, out = [];
    for (var i = 0; i < 20; i++) {
      var na = L.chooseAxis(axis, run, rng); run = na === axis ? run + 1 : 1; axis = na;
      var p = L.planNextPlatform({ cur: cur, player: pl, axis: axis, score: i * 5, rng: rng, prevColor: cur.colorIdx });
      out.push([p.x, p.z, p.size, p.shape, p.colorIdx]);
      cur = p; pl = { x: p.x, z: p.z };
    }
    return JSON.stringify(out);
  }
  assert.strictEqual(run(99), run(99));
  assert.notStrictEqual(run(99), run(100));
});

test('方向：偏向左右交替，同方向最多连续 MAX_SAME_RUN 次，两个方向都会出现', function () {
  var rng = L.createRng(2024), axis = 0, run = 1, maxRun = 1, switches = 0, n = 5000, used = [0, 0];
  for (var i = 0; i < n; i++) {
    var na = L.chooseAxis(axis, run, rng);
    assert.ok(na === 0 || na === 1);
    if (na === axis) run++; else { run = 1; switches++; }
    maxRun = Math.max(maxRun, run); axis = na; used[na]++;
  }
  assert.ok(maxRun <= CFG.MAX_SAME_RUN, '最长同向连续 ' + maxRun);
  assert.ok(switches / n > 0.6 && switches / n < 0.85, '换向比例 ' + (switches / n).toFixed(2));
  assert.ok(used[0] > n * 0.3 && used[1] > n * 0.3, '左右都有');
  assert.ok([0, 1].indexOf(L.chooseAxis(undefined, 0, rng)) >= 0, '开局第一次随机');
});

console.log('\n整局模拟');

/** 「机器人」玩家：按目标中心算蓄力，可以加误差。返回 {score, jumps, fell, perfects, maxCharge} */
function playBot(seed, errSd, maxJumps, startScore) {
  var rng = L.createRng(seed);
  function gauss() { return (rng() + rng() + rng() + rng() - 2) * 1.7; } // 近似正态，sd≈1
  var cur = L.makePlatform(0, 0, 2.4, 'cube', 0), pos = { x: 0, z: 0 };
  var axis = L.chooseAxis(undefined, 0, rng), run = 1;
  var next = L.planNextPlatform({ cur: cur, player: pos, axis: axis, score: startScore || 0, rng: rng, prevColor: 0 });
  var score = startScore || 0, streak = 0, jumps = 0, perfects = 0, maxCharge = 0, fell = false;
  var minGap = 1e9;
  while (jumps < maxJumps) {
    var tNeed = L.chargeTimeForDistance(next.axis === 0 ? next.x - pos.x : next.z - pos.z);
    maxCharge = Math.max(maxCharge, tNeed);
    var t = Math.max(0, tNeed + gauss() * errSd);
    var r = L.resolveJump(cur, next, pos, next.axis, t);
    jumps++;
    if (r.outcome === 'miss' || r.outcome === 'slip') { fell = true; break; }
    if (r.outcome === 'stay') { pos = r.landing; continue; }
    var sc = L.scoreLanding(r.quality, streak); streak = sc.streak; score += sc.points;
    if (r.quality === 'perfect') perfects++;
    minGap = Math.min(minGap, next.gap);
    cur = next; pos = r.landing;
    var na = L.chooseAxis(axis, run, rng); run = na === axis ? run + 1 : 1; axis = na;
    next = L.planNextPlatform({ cur: cur, player: pos, axis: axis, score: score, rng: rng, prevColor: cur.colorIdx });
    assert.ok(L.isReachable(Math.abs(axis === 0 ? next.x - pos.x : next.z - pos.z)), '第 ' + jumps + ' 跳之后的目标够得着');
  }
  return { score: score, jumps: jumps, fell: fell, perfects: perfects, maxCharge: maxCharge, minGap: minGap };
}

test('完美机器人连跳 2000 次不会失败，且每次都是完美；所需蓄力始终 ≤ 上限', function () {
  for (var seed = 1; seed <= 5; seed++) {
    var r = playBot(seed, 0, 2000, 0);
    assert.strictEqual(r.fell, false); assert.strictEqual(r.jumps, 2000);
    assert.strictEqual(r.perfects, 2000);
    assert.ok(r.maxCharge <= CFG.MAX_CHARGE_TIME, '最大所需蓄力 ' + r.maxCharge);
    assert.ok(r.minGap >= CFG.MIN_GAP - 1e-9);
  }
});

test('从高分（满难度）起步，完美机器人也能一直跳', function () {
  var r = playBot(42, 0, 1500, 5000);
  assert.strictEqual(r.fell, false);
});

test('有误差的玩家：误差小能跳很久，误差大会掉下去（难度合理）', function () {
  var good = 0, bad = 0, N = 40;
  for (var s = 1; s <= N; s++) {
    good += playBot(s, 0.02, 300, 0).jumps;   // 误差 ±20ms：几乎不会失败
    bad += playBot(s, 0.35, 300, 0).jumps;    // 误差 ±350ms：很快失败
  }
  console.log('       （误差 20ms 平均跳 ' + (good / N).toFixed(1) + ' 次；误差 350ms 平均跳 ' + (bad / N).toFixed(1) + ' 次）');
  assert.ok(good / N > 100);
  assert.ok(bad / N < 15);
});

console.log('\n' + passed + ' 通过, ' + failed + ' 失败');
if (failed) process.exit(1);
