/*
 * 打奶蛙 · 核心规则测试（只在 Node 里跑，浏览器页面不加载它）
 * 用法：node test-logic.js
 * 只用 Node 自带的 assert，不依赖任何第三方包。
 */
'use strict';
var assert = require('assert');
var L = require('./logic.js');
var C = L.CONFIG;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        ')); }
}
function section(t) { console.log('\n[' + t + ']'); }

// 固定种子的随机数（mulberry32），让每次测试结果可复现
function rngOf(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 往指定洞里直接放一只指定种类的奶蛙，并让它直接进入"完全冒出"阶段（方便测计分）
function put(s, hole, type) {
  var m = L.makeMonster(s, type, hole, rngOf(hole + 1));
  m.phase = 'up'; m.t = 0; m.stay = 99;
  s.holes[hole] = m;
  return m;
}
function freshPlaying() { var s = L.createState(); L.startGame(s); s.spawnTimer = 999; return s; }  // 关掉自动刷怪，手动摆放

/* ------------------------------------------------------------------ */
section('连击倍率');

test('每 5 连击 +1 倍，最高 x4', function () {
  var expect = { 0: 1, 1: 1, 4: 1, 5: 2, 9: 2, 10: 3, 14: 3, 15: 4, 19: 4, 20: 4, 99: 4 };
  Object.keys(expect).forEach(function (k) { assert.strictEqual(L.comboMultiplier(+k), expect[k], 'combo=' + k); });
});

test('负数/异常连击当作 0', function () { assert.strictEqual(L.comboMultiplier(-3), 1); });

/* ------------------------------------------------------------------ */
section('难度曲线');

test('同时在场上限：开局 3、中段 4、后段 5，不会超过 5', function () {
  assert.strictEqual(L.difficultyAt(0).cap, 3);
  assert.strictEqual(L.difficultyAt(13.9).cap, 3);
  assert.strictEqual(L.difficultyAt(14).cap, 4);
  assert.strictEqual(L.difficultyAt(34).cap, 5);
  assert.strictEqual(L.difficultyAt(60).cap, 5);
  assert.strictEqual(L.difficultyAt(500).cap, 5);
});

test('随时间推进：停留变短、间隔变短、上限不降', function () {
  var prevCap = 0, prevStay = Infinity, prevGap = Infinity;
  for (var t = 0; t <= 60; t += 0.5) {
    var d = L.difficultyAt(t);
    assert.ok(d.cap >= prevCap, 'cap 不应下降 @' + t);
    assert.ok(L.stayFor('normal', d.p) <= prevStay + 1e-9, 'stay 不应变长 @' + t);
    assert.ok(d.gap <= prevGap + 1e-9, 'gap 不应变长 @' + t);
    prevCap = d.cap; prevStay = L.stayFor('normal', d.p); prevGap = d.gap;
  }
  assert.ok(L.stayFor('normal', 0) > L.stayFor('normal', 1) * 1.8, '终局停留应明显短于开局');
});

test('金奶蛙停留最短（稀有、转瞬即逝）', function () {
  [0, 0.5, 1].forEach(function (p) {
    assert.ok(L.stayFor('god', p) < L.stayFor('normal', 0), 'god 比开局的普通短');
    assert.ok(L.stayFor('god', p) <= L.stayFor('angel', p) + 1e-9);
  });
});

/* ------------------------------------------------------------------ */
section('刷怪调度');

test('pickHole：从不挑被占用的洞；全满返回 -1', function () {
  var rng = rngOf(7);
  for (var round = 0; round < 300; round++) {
    var s = freshPlaying();
    var n = Math.floor(rng() * (C.HOLES + 1));            // 随机占用 0~16 个洞
    var taken = {};
    while (Object.keys(taken).length < n) { var h = Math.floor(rng() * C.HOLES); taken[h] = true; put(s, h, 'normal'); }
    var pick = L.pickHole(s, rng);
    if (n === C.HOLES) assert.strictEqual(pick, -1);
    else { assert.ok(pick >= 0 && pick < C.HOLES); assert.ok(!taken[pick], '挑到了被占用的洞 ' + pick); }
  }
});

test('spawnOne：洞全满时返回 null，且不改动任何奶蛙', function () {
  var s = freshPlaying();
  for (var i = 0; i < C.HOLES; i++) put(s, i, 'normal');
  var ids = s.holes.map(function (m) { return m.id; }).join();
  assert.strictEqual(L.spawnOne(s, rngOf(1)), null);
  assert.strictEqual(s.holes.map(function (m) { return m.id; }).join(), ids);
});

test('pickHole：刚空出来的洞会被避开（还有别的空洞时）', function () {
  var s = freshPlaying();
  s.clock = 10;
  s.vacatedAt[5] = 9.9;                                    // 洞 5 刚空出来
  for (var round = 0; round < 200; round++) assert.notStrictEqual(L.pickHole(s, rngOf(round)), 5);
  for (var i = 0; i < C.HOLES; i++) if (i !== 5) put(s, i, 'normal');
  assert.strictEqual(L.pickHole(s, rngOf(3)), 5, '只剩它时仍可使用');
});

// 整局模拟，每一帧检查不变量
function simulate(seed, dt, opts) {
  opts = opts || {};
  var s = L.createState();
  if (opts.idle !== true) L.startGame(s);
  var rng = rngOf(seed);
  var maxOcc = 0, spawns = 0, usedHoles = {}, types = { normal: 0, sumo: 0, god: 0, angel: 0 }, skins = {};
  var occByThird = [0, 0, 0], occSamples = [0, 0, 0];
  var steps = Math.ceil((opts.seconds || 70) / dt);
  for (var i = 0; i < steps; i++) {
    var before = s.holes.map(function (m) { return !!m; });
    var evs = L.tick(s, dt, rng);
    // 不变量 1：每个洞最多一只，且 monster.hole 与下标一致
    var seen = {};
    s.holes.forEach(function (m, idx) {
      if (!m) return;
      assert.strictEqual(m.hole, idx, '奶蛙记录的洞号与所在洞不一致');
      assert.ok(!seen[m.id], '同一只奶蛙出现在两个洞');
      seen[m.id] = true;
    });
    // 不变量 2：新冒头的奶蛙，所在洞之前是空的（tick 内先清理缩没的再刷，所以用事件对照）
    evs.forEach(function (e) {
      if (e.type !== 'spawn') return;
      spawns++; usedHoles[e.monster.hole] = true; types[e.monster.type]++;
      if (e.monster.skin) skins[e.monster.skin] = true;
      assert.strictEqual(s.holes[e.monster.hole], e.monster, '刚冒头的奶蛙应在它的洞里');
    });
    // 不变量 3：同时在场数量不超过当前难度的上限（游戏中）
    var occ = L.occupiedCount(s);
    if (s.mode === 'playing') {
      assert.ok(occ <= L.difficultyAt(s.elapsed).cap, '超过同时冒头上限：' + occ + ' > ' + L.difficultyAt(s.elapsed).cap + ' @' + s.elapsed.toFixed(2));
      var third = Math.min(2, Math.floor(s.elapsed / 20));
      occByThird[third] += occ; occSamples[third]++;
    }
    assert.ok(occ <= 5, '任何时刻都不应超过 5 只');
    if (occ > maxOcc) maxOcc = occ;
    if (s.mode === 'over' && occ === 0) break;
  }
  return { s: s, maxOcc: maxOcc, spawns: spawns, usedHoles: Object.keys(usedHoles).length, types: types, skins: Object.keys(skins).length,
           avgOcc: occByThird.map(function (v, i) { return occSamples[i] ? v / occSamples[i] : 0; }) };
}

test('整局模拟（多种子 x 多种帧长）：永不重复占洞、永不超过上限', function () {
  [1 / 60, 1 / 30, 0.05, 0.1].forEach(function (dt) {
    for (var seed = 1; seed <= 12; seed++) {
      var r = simulate(seed * 101 + 5, dt);
      assert.strictEqual(r.s.mode, 'over', '60 秒后应结束');
      assert.ok(r.maxOcc <= 5);
    }
  });
});

test('密度：16 个洞也不会太空（开局常驻 3 只，后段常驻 5 只左右）', function () {
  var r = simulate(2024, 1 / 60);
  assert.ok(r.avgOcc[0] >= 2.3, '前 20 秒平均在场数偏少：' + r.avgOcc[0].toFixed(2));
  assert.ok(r.avgOcc[1] >= 3.3, '中段平均在场数偏少：' + r.avgOcc[1].toFixed(2));
  assert.ok(r.avgOcc[2] >= 4.2, '后段平均在场数偏少：' + r.avgOcc[2].toFixed(2));
  assert.strictEqual(r.maxOcc, 5, '后段应能达到 5 只同时冒头');
  console.log('        平均在场数 (0-20s / 20-40s / 40-60s): ' + r.avgOcc.map(function (v) { return v.toFixed(2); }).join(' / ') + '，共刷出 ' + r.spawns + ' 只');
});

test('16 个洞都会被用到；4 种普通造型都会出现', function () {
  var r = simulate(99, 1 / 60);
  assert.strictEqual(r.usedHoles, 16);
  assert.strictEqual(r.skins, 4);
});

test('4 类奶蛙都会出现；金奶蛙稀有且有保底，天使不会堆满', function () {
  var godTotal = 0, runs = 20, angelOverCap = 0;
  for (var seed = 1; seed <= runs; seed++) {
    var s = L.createState(); L.startGame(s);
    var rng = rngOf(seed * 7), maxAngels = 0, godTimes = [];
    for (var i = 0; i < 4200; i++) {
      var evs = L.tick(s, 1 / 60, rng);
      evs.forEach(function (e) { if (e.type === 'spawn' && e.monster.type === 'god') godTimes.push(s.elapsed); });
      maxAngels = Math.max(maxAngels, L.countType(s, 'angel'));
      assert.ok(L.countType(s, 'god') <= 1, '场上最多 1 只金奶蛙');
      if (s.mode === 'over') break;
    }
    assert.ok(maxAngels <= C.MAX_ANGELS, '天使超过上限');
    assert.ok(godTimes.length >= 2 && godTimes.length <= 6, '一局金奶蛙数量应为 2~6，实际 ' + godTimes.length + '（seed ' + seed + '）');
    for (var k = 1; k < godTimes.length; k++) assert.ok(godTimes[k] - godTimes[k - 1] >= C.GOD_MIN_GAP - 0.05, '金奶蛙间隔过短');
    assert.ok(godTimes[0] >= C.GOD_FIRST_AT - 0.05, '开局太早出金奶蛙');
    assert.ok(godTimes[0] <= C.GOD_MAX_GAP + 1, '第一只金奶蛙保底失效：' + godTimes[0]);
    godTotal += godTimes.length;
  }
  var r = simulate(5, 1 / 60);
  assert.ok(r.types.normal > r.types.sumo && r.types.normal > r.types.angel, '普通应占大多数');
  assert.ok(r.types.sumo > 0 && r.types.angel > 0 && r.types.god > 0, '特殊种类都应出现');
  console.log('        金奶蛙平均每局 ' + (godTotal / runs).toFixed(1) + ' 只；本局种类分布 ' + JSON.stringify(r.types));
});

test('开始界面（idle）只演示：刷怪但不计时，且不超过演示上限', function () {
  var s = L.createState(), rng = rngOf(3), maxOcc = 0;
  for (var i = 0; i < 1200; i++) { L.tick(s, 1 / 60, rng); maxOcc = Math.max(maxOcc, L.occupiedCount(s)); }
  assert.strictEqual(s.mode, 'idle');
  assert.strictEqual(s.elapsed, 0);
  assert.strictEqual(s.timeLeft, C.GAME_TIME);
  assert.ok(maxOcc >= 1 && maxOcc <= C.DEMO_CAP);
  // 演示模式点击没有任何效果
  var r = L.hit(s, 0);
  assert.strictEqual(r.kind, 'inactive'); assert.strictEqual(s.score, 0);
});

test('大 dt（卡顿一下）也不会让奶蛙卡在中间阶段，也不会同帧刷出超量', function () {
  var s = freshPlaying(), rng = rngOf(11);
  s.spawnTimer = 0;
  for (var i = 0; i < 40; i++) {
    L.tick(s, 0.7, rng);
    assert.ok(L.occupiedCount(s) <= L.difficultyAt(s.elapsed).cap);
    if (s.mode === 'over') break;
  }
});

/* ------------------------------------------------------------------ */
section('单只奶蛙的生命周期');

test('冒头 -> 停留 -> 缩回 -> 消失，高度连续且在 [0, ~1.1] 内', function () {
  var s = freshPlaying();
  var m = L.makeMonster(s, 'normal', 3, rngOf(1)); s.holes[3] = m; m.stay = 1;
  var total = m.riseTime + m.stay + m.fallTime, t = 0, prevH = -1, phases = [];
  while (s.holes[3] && t < 5) {
    var h = L.monsterHeight(m);
    assert.ok(h >= 0 && h <= 1.15, '高度越界 ' + h);
    if (phases[phases.length - 1] !== m.phase) phases.push(m.phase);
    L.tick(s, 1 / 120, rngOf(1)); t += 1 / 120; s.spawnTimer = 999;
  }
  assert.deepStrictEqual(phases, ['rise', 'up', 'fall']);
  assert.ok(Math.abs(t - total) < 0.03, '总时长应≈ rise+stay+fall：' + t + ' vs ' + total);
  assert.strictEqual(s.holes[3], null);
});

test('刚冒头一点点、快缩没了，都不算"可打中"', function () {
  var s = freshPlaying(); var m = put(s, 0, 'normal');
  m.phase = 'rise'; m.t = 0; assert.ok(!L.isHittable(m));
  m.t = m.riseTime * 0.3; assert.ok(L.isHittable(m));
  m.phase = 'fall'; m.t = m.fallTime * 0.98; assert.ok(!L.isHittable(m));
  m.phase = 'hit'; assert.ok(!L.isHittable(m));
});

/* ------------------------------------------------------------------ */
section('计分与连击');

test('普通 +1：前 4 连击 x1，第 5 连击起 x2（该下即按 x2 计）', function () {
  var s = freshPlaying(), total = 0;
  for (var i = 0; i < 5; i++) {
    put(s, i, 'normal');
    var r = L.hit(s, i);
    assert.strictEqual(r.kind, 'kill');
    assert.strictEqual(r.combo, i + 1);
    assert.strictEqual(r.points, i < 4 ? 1 : 2, '第 ' + (i + 1) + ' 下');
    assert.strictEqual(r.multUp, i === 4, '第 5 下倍率升级');
    total += r.points;
  }
  assert.strictEqual(s.score, total); assert.strictEqual(total, 6);
  assert.strictEqual(s.combo, 5); assert.strictEqual(s.maxCombo, 5);
});

test('连击到 15 以上封顶 x4', function () {
  var s = freshPlaying(); s.combo = 30;
  put(s, 0, 'normal');
  var r = L.hit(s, 0);
  assert.strictEqual(r.mult, 4); assert.strictEqual(r.points, 4); assert.strictEqual(r.multUp, false);
});

test('打空：连击清零、不扣分、返回 brokeCombo；本来就是 0 连击则不算打断', function () {
  var s = freshPlaying(); s.score = 10; s.combo = 7;
  var r = L.hit(s, 4);               // 空洞
  assert.strictEqual(r.kind, 'miss'); assert.strictEqual(r.brokeCombo, true);
  assert.strictEqual(s.combo, 0); assert.strictEqual(s.score, 10);
  r = L.hit(s, 4);
  assert.strictEqual(r.kind, 'miss'); assert.strictEqual(r.brokeCombo, false);
  assert.strictEqual(s.score, 10);
  assert.strictEqual(s.stats.misses, 2);
});

test('打空之后倍率重新从 x1 开始', function () {
  var s = freshPlaying(); s.combo = 12;
  L.hit(s, 0);                       // 空洞，清零
  put(s, 1, 'normal');
  var r = L.hit(s, 1);
  assert.strictEqual(r.mult, 1); assert.strictEqual(r.points, 1);
});

test('洞号越界/非法：当作打空，不会抛异常', function () {
  var s = freshPlaying();
  assert.doesNotThrow(function () { L.hit(s, -1); L.hit(s, 99); L.hit(s, NaN); });
  assert.strictEqual(s.score, 0);
});

test('点在已经被打趴、正在笑的奶蛙上：忽略，不算打空、不重复得分', function () {
  var s = freshPlaying(); put(s, 2, 'normal'); s.combo = 3;
  var r1 = L.hit(s, 2), score = s.score;
  var r2 = L.hit(s, 2);
  assert.strictEqual(r1.kind, 'kill'); assert.strictEqual(r2.kind, 'ignored');
  assert.strictEqual(s.score, score); assert.strictEqual(s.combo, 4);
  assert.strictEqual(s.stats.kills, 1);
});

test('天使：-3 分、连击清零、不吃倍率；分数不会低于 0', function () {
  var s = freshPlaying(); s.score = 10; s.combo = 16;
  put(s, 0, 'angel');
  var r = L.hit(s, 0);
  assert.strictEqual(r.kind, 'angel'); assert.strictEqual(r.points, -3); assert.strictEqual(r.delta, -3);
  assert.strictEqual(s.score, 7); assert.strictEqual(s.combo, 0); assert.strictEqual(r.brokeCombo, true);
  assert.strictEqual(s.maxCombo, 0 + s.maxCombo);   // 最高连击记录不被清掉
  s.score = 1; put(s, 1, 'angel');
  r = L.hit(s, 1);
  assert.strictEqual(s.score, 0); assert.strictEqual(r.delta, -1);
  assert.strictEqual(s.stats.angelHits, 2);
});

test('maxCombo 记录的是历史最高，不随清零下降', function () {
  var s = freshPlaying();
  for (var i = 0; i < 6; i++) { put(s, i, 'normal'); L.hit(s, i); }
  L.hit(s, 15);                      // 打空
  assert.strictEqual(s.combo, 0); assert.strictEqual(s.maxCombo, 6);
});

test('未开始/已结束时点击没有任何效果', function () {
  var s = L.createState();
  assert.strictEqual(L.hit(s, 0).kind, 'inactive');
  L.startGame(s); s.spawnTimer = 999; put(s, 0, 'normal');
  L.endGame(s);
  var sc = s.score;
  assert.strictEqual(L.hit(s, 0).kind, 'inactive'); assert.strictEqual(s.score, sc);
  assert.strictEqual(s.stats.swings, 0);
});

/* ------------------------------------------------------------------ */
section('大块头：要打 2 下');

test('第 1 下没分但算命中（连击 +1），第 2 下 +3 x 倍率，然后进入"笑"阶段', function () {
  var s = freshPlaying(); var m = put(s, 6, 'sumo');
  var r1 = L.hit(s, 6);
  assert.strictEqual(r1.kind, 'partial'); assert.strictEqual(r1.points, 0); assert.strictEqual(s.score, 0);
  assert.strictEqual(s.combo, 1); assert.strictEqual(m.hp, 1); assert.strictEqual(m.phase, 'up');
  var r2 = L.hit(s, 6);
  assert.strictEqual(r2.kind, 'kill'); assert.strictEqual(r2.points, 3); assert.strictEqual(s.score, 3);
  assert.strictEqual(s.combo, 2); assert.strictEqual(m.phase, 'hit'); assert.ok(m.defeated);
  assert.strictEqual(L.hit(s, 6).kind, 'ignored');   // 第 3 下无效
  assert.strictEqual(s.score, 3);
});

test('大块头击杀吃连击倍率：x2 时 +6，x4 时 +12', function () {
  var s = freshPlaying(); s.combo = 8;                // 命中第 1 下 -> 9；第 2 下 -> 10（x3）
  put(s, 0, 'sumo'); L.hit(s, 0);
  var r = L.hit(s, 0);
  assert.strictEqual(r.mult, 3); assert.strictEqual(r.points, 9);
  s = freshPlaying(); s.combo = 20; put(s, 0, 'sumo'); L.hit(s, 0);
  assert.strictEqual(L.hit(s, 0).points, 12);
});

test('第 1 下会续一点命：不让它在你补第二下之前缩回去', function () {
  var s = freshPlaying(); var m = put(s, 6, 'sumo');
  m.phase = 'up'; m.t = 0; m.stay = 0.1;               // 本来马上要走
  L.hit(s, 6);
  assert.ok(m.stay >= C.SUMO_REPRIEVE, '应至少续到 ' + C.SUMO_REPRIEVE + 's，实际 ' + m.stay);
  for (var i = 0; i < 30; i++) { L.tick(s, 0.01, rngOf(1)); s.spawnTimer = 999; }   // 过 0.3 秒，仍在场上
  assert.strictEqual(m.phase, 'up');
  assert.strictEqual(L.hit(s, 6).kind, 'kill');
});

test('只打了一下就缩回去了：没有分，但连击不被打断', function () {
  var s = freshPlaying(); var m = put(s, 6, 'sumo'); m.stay = 0.05;
  L.hit(s, 6); m.stay = 0.05; m.t = 0;                 // 让它尽快走（取消续命，模拟"终局很短的停留"）
  for (var i = 0; i < 200 && s.holes[6]; i++) { L.tick(s, 0.01, rngOf(1)); s.spawnTimer = 999; }
  assert.strictEqual(s.holes[6], null);
  assert.strictEqual(s.score, 0); assert.strictEqual(s.combo, 1);
});

/* ------------------------------------------------------------------ */
section('金色神奶蛙：+5 并加时 2 秒');

test('命中：+5 x 倍率、剩余时间 +2、记录累计加时', function () {
  var s = freshPlaying(); put(s, 9, 'god');
  s.timeLeft = 30;
  var r = L.hit(s, 9);
  assert.strictEqual(r.kind, 'god'); assert.strictEqual(r.points, 5); assert.strictEqual(s.score, 5);
  assert.strictEqual(r.timeBonus, 2); assert.strictEqual(s.timeLeft, 32); assert.strictEqual(s.timeAdded, 2);
  assert.strictEqual(s.combo, 1); assert.strictEqual(s.stats.godHits, 1);
  s.combo = 14; put(s, 10, 'god');
  r = L.hit(s, 10);                                   // 第 15 连击 -> x4
  assert.strictEqual(r.points, 20);
});

test('加时真的让游戏多撑 2 秒：只剩 0.5 秒时打中，不会结束', function () {
  var s = freshPlaying(); s.timeLeft = 0.5; put(s, 9, 'god');
  L.hit(s, 9);
  assert.ok(Math.abs(s.timeLeft - 2.5) < 1e-9);
  var rng = rngOf(2), t = 0, over = false;
  while (t < 2.4) { var evs = L.tick(s, 0.05, rng); t += 0.05; s.spawnTimer = 999; if (evs.some(function (e) { return e.type === 'over'; })) over = true; }
  assert.strictEqual(over, false, '2.4 秒内不应结束');
  assert.strictEqual(s.mode, 'playing');
  L.tick(s, 0.2, rng);
  assert.strictEqual(s.mode, 'over');
});

test('加时可叠加；难度按"已玩时间"走，不因加时回退', function () {
  var s = freshPlaying(); s.timeLeft = 10;
  put(s, 0, 'god'); put(s, 1, 'god');
  L.hit(s, 0); L.hit(s, 1);
  assert.strictEqual(s.timeLeft, 14); assert.strictEqual(s.timeAdded, 4);
  s.elapsed = 59; L.tick(s, 0.5, rngOf(1));
  assert.ok(Math.abs(s.elapsed - 59.5) < 1e-9);
  assert.strictEqual(L.difficultyAt(s.elapsed).cap, 5);
});

test('打天使/打空都不加时', function () {
  var s = freshPlaying(); s.timeLeft = 20; put(s, 0, 'angel');
  L.hit(s, 0); L.hit(s, 1);
  assert.strictEqual(s.timeLeft, 20);
});

/* ------------------------------------------------------------------ */
section('时间到');

test('走满 60 秒：恰好结束一次，场上奶蛙全部缩回，之后不再刷怪、点击无效', function () {
  var s = L.createState(); L.startGame(s);
  var rng = rngOf(8), overs = 0, spawnsAfter = 0, t = 0;
  while (t < 66) {
    var wasOver = s.mode === 'over';
    var evs = L.tick(s, 1 / 60, rng); t += 1 / 60;
    evs.forEach(function (e) { if (e.type === 'over') overs++; if (e.type === 'spawn' && wasOver) spawnsAfter++; });
    if (s.mode === 'over') { for (var i = 0; i < 16; i++) assert.ok(!s.holes[i] || s.holes[i].phase === 'fall' || s.holes[i].phase === 'gone'); }
  }
  assert.strictEqual(overs, 1); assert.strictEqual(spawnsAfter, 0);
  assert.strictEqual(s.mode, 'over'); assert.strictEqual(s.timeLeft, 0);
  assert.strictEqual(L.occupiedCount(s), 0);
  assert.ok(s.elapsed >= 59.9 && s.elapsed <= 60.1, 'elapsed=' + s.elapsed);
});

test('startGame 重开：分数/连击/时间/场上奶蛙全部清零', function () {
  var s = L.createState(); L.startGame(s);
  var rng = rngOf(4);
  for (var i = 0; i < 300; i++) L.tick(s, 1 / 60, rng);
  s.score = 77; s.combo = 9; s.timeLeft = 3; s.timeAdded = 4;
  L.startGame(s);
  assert.strictEqual(s.mode, 'playing'); assert.strictEqual(s.score, 0); assert.strictEqual(s.combo, 0);
  assert.strictEqual(s.timeLeft, C.GAME_TIME); assert.strictEqual(s.timeAdded, 0);
  assert.strictEqual(L.occupiedCount(s), 0); assert.strictEqual(s.elapsed, 0);
});

/* ------------------------------------------------------------------ */
section('点击坐标 -> 格子判定（命中区 = 格子上部：奶蛙冒头那一块）');

var H = C.HIT;
// 三种典型布局：手机竖屏 / 桌面 / 很小的横屏手机
var LAYOUTS = [
  { name: '手机竖屏', bx: 12.4, by: 66.9, cw: 82.5, ch: 107.3, cols: 4, rows: 4 },
  { name: '桌面',     bx: 40.7, by: 56,   cw: 141.2, ch: 163.8, cols: 4, rows: 4 },
  { name: '小横屏',   bx: 20,   by: 44,   cw: 61,    ch: 71,    cols: 4, rows: 4 }
];
function cellOrigin(lo, i) { return { x: lo.bx + (i % 4) * lo.cw, y: lo.by + Math.floor(i / 4) * lo.ch }; }
var EPS = 1e-6;

test('配置：横向两侧各缩进 5%，洞口中线在格子底边上方 27% 格宽处，命中区下沿在中线下方 5% 格宽', function () {
  assert.strictEqual(H.PAD_X, 0.05); assert.strictEqual(H.PIT_BELOW, 0.27); assert.strictEqual(H.BOTTOM_EXTRA, 0.05);
});

test('hitRect：范围 = 格子宽度中间 90%，纵向从格子顶端到洞口中线再往下 5% 格宽', function () {
  LAYOUTS.forEach(function (lo) {
    for (var i = 0; i < 16; i++) {
      var o = cellOrigin(lo, i), z = L.hitRect(lo, i);
      assert.ok(Math.abs(z.x0 - (o.x + 0.05 * lo.cw)) < EPS);
      assert.ok(Math.abs(z.x1 - (o.x + 0.95 * lo.cw)) < EPS);
      assert.ok(Math.abs(z.y0 - o.y) < EPS, '纵向从格子顶端开始');
      assert.ok(Math.abs(z.cy - (o.y + lo.ch - 0.27 * lo.cw)) < EPS, '洞口中线');
      assert.ok(Math.abs(z.y1 - (z.cy + 0.05 * lo.cw)) < EPS);
      assert.ok(z.y1 < o.y + lo.ch, '命中区不会伸到格子底边之外');
    }
  });
});

test('上半部分任意点都算命中：每个格子的命中区里取 9x9 网格点（含四角和边线），全部判给这个格子', function () {
  LAYOUTS.forEach(function (lo) {
    for (var i = 0; i < 16; i++) {
      var z = L.hitRect(lo, i);
      for (var a = 0; a <= 8; a++) for (var b = 0; b <= 8; b++) {
        // 端点直接取矩形的边（避免自己算网格点时多出一个浮点 ulp）
        var x = a === 8 ? z.x1 : z.x0 + (z.x1 - z.x0) * a / 8, y = b === 8 ? z.y1 : z.y0 + (z.y1 - z.y0) * b / 8;
        assert.strictEqual(L.holeAtPoint(lo, x, y), i, lo.name + ' 洞' + i + ' 点(' + x.toFixed(2) + ',' + y.toFixed(2) + ')');
      }
      // 洞口中线本身、以及中线以上的洞口上半部分，都算
      assert.strictEqual(L.holeAtPoint(lo, (z.x0 + z.x1) / 2, z.cy), i);
    }
  });
});

test('命中区边界：边线上算命中（闭区间），刚出去一点点就不算', function () {
  LAYOUTS.forEach(function (lo) {
    var i = 5, z = L.hitRect(lo, i), midY = (z.y0 + z.y1) / 2, midX = (z.x0 + z.x1) / 2;
    assert.strictEqual(L.holeAtPoint(lo, z.x0, midY), i);          // 左边线
    assert.strictEqual(L.holeAtPoint(lo, z.x1, midY), i);          // 右边线
    assert.strictEqual(L.holeAtPoint(lo, midX, z.y0), i);          // 上边线（= 格子顶端）
    assert.strictEqual(L.holeAtPoint(lo, midX, z.y1), i);          // 下边线
    assert.strictEqual(L.holeAtPoint(lo, z.x0 - 0.01, midY), -1);  // 左边线外：落在缝隙里
    assert.strictEqual(L.holeAtPoint(lo, z.x1 + 0.01, midY), -1);  // 右边线外：缝隙
    assert.strictEqual(L.holeAtPoint(lo, midX, z.y1 + 0.01), -1);  // 下边线外：洞口前沿
  });
});

test('格间缝隙：相邻两格之间 10% 格宽的缝里，点哪都不算（不会误判成左邻或右邻）', function () {
  LAYOUTS.forEach(function (lo) {
    for (var r = 0; r < 4; r++) for (var c = 0; c < 3; c++) {
      var left = L.hitRect(lo, r * 4 + c), right = L.hitRect(lo, r * 4 + c + 1);
      var gap = right.x0 - left.x1;
      assert.ok(Math.abs(gap - 0.1 * lo.cw) < 1e-6, '缝宽应为 10% 格宽');
      for (var k = 1; k < 10; k++) {
        var x = left.x1 + gap * k / 10, y = left.y0 + (left.y1 - left.y0) * 0.5;
        if (k < 10) assert.strictEqual(L.holeAtPoint(lo, x, y), -1, lo.name + ' 缝隙 ' + k);
      }
      // 格子分界线（正好在缝隙中央）
      assert.strictEqual(L.holeAtPoint(lo, left.x1 + gap / 2, left.y0 + 1), -1);
    }
  });
});

test('洞口前沿 / 下半部分不算命中：命中区下沿以下一直到格子底边都是 -1，也不会被算成下一行的格子', function () {
  LAYOUTS.forEach(function (lo) {
    for (var i = 0; i < 16; i++) {
      var o = cellOrigin(lo, i), z = L.hitRect(lo, i), mid = (z.x0 + z.x1) / 2;
      var ys = [z.y1 + 0.01, z.cy + 0.08 * lo.cw, z.cy + 0.15 * lo.cw /* 洞口最底 */, o.y + lo.ch - 0.27 * lo.cw + 0.2 * lo.cw, o.y + lo.ch - 0.01];
      ys.forEach(function (y) {
        assert.strictEqual(L.holeAtPoint(lo, mid, y), -1, lo.name + ' 洞' + i + ' y=' + y.toFixed(2) + ' 应不算');
        assert.strictEqual(L.holeAtPoint(lo, z.x0, y), -1);
        assert.strictEqual(L.holeAtPoint(lo, z.x1, y), -1);
      });
    }
  });
});

test('行与行之间：上一行命中区下沿到下一行命中区上沿之间是一整条"死区"，点哪都不算', function () {
  LAYOUTS.forEach(function (lo) {
    for (var r = 0; r < 3; r++) {
      var up = L.hitRect(lo, r * 4 + 1), down = L.hitRect(lo, (r + 1) * 4 + 1);
      assert.ok(down.y0 > up.y1, '下一行的命中区在上一行命中区之下');
      for (var k = 0; k <= 10; k++) {
        var y = up.y1 + (down.y0 - up.y1) * k / 10, x = (up.x0 + up.x1) / 2;
        if (k > 0 && k < 10) assert.strictEqual(L.holeAtPoint(lo, x, y), -1);
      }
    }
  });
});

test('棋盘外一律 -1（含 NaN / Infinity）', function () {
  LAYOUTS.forEach(function (lo) {
    var right = lo.bx + 4 * lo.cw, bottom = lo.by + 4 * lo.ch;
    [[lo.bx - 5, lo.by + 10], [right + 5, lo.by + 10], [lo.bx + 20, lo.by - 5], [lo.bx + 20, bottom + 5], [-100, -100], [1e9, 1e9], [NaN, 10], [10, NaN], [Infinity, 10]]
      .forEach(function (p) { assert.strictEqual(L.holeAtPoint(lo, p[0], p[1]), -1, JSON.stringify(p)); });
  });
});

test('命中区之间互不重叠；每个命中区够大（手指好点：宽 >= 0.9 格宽，高 >= 0.94 格宽）', function () {
  LAYOUTS.forEach(function (lo) {
    var zs = []; for (var i = 0; i < 16; i++) zs.push(L.hitRect(lo, i));
    for (var a = 0; a < 16; a++) {
      assert.ok(zs[a].x1 - zs[a].x0 >= 0.9 * lo.cw - 1e-6, '宽');
      assert.ok(zs[a].y1 - zs[a].y0 >= 0.94 * lo.cw - 1e-6 * 0 || lo.ch / lo.cw < 1.16, '高');
      for (var b = a + 1; b < 16; b++) {
        var overlap = zs[a].x0 <= zs[b].x1 && zs[b].x0 <= zs[a].x1 && zs[a].y0 <= zs[b].y1 && zs[b].y0 <= zs[a].y1;
        assert.ok(!overlap, '命中区 ' + a + ' 与 ' + b + ' 重叠');
      }
    }
  });
  // 手机竖屏（375 宽）：命中区至少 ~74px 宽、~85px 高，远大于 60px
  var m = LAYOUTS[0], z0 = L.hitRect(m, 0);
  assert.ok(z0.x1 - z0.x0 > 70 && z0.y1 - z0.y0 > 80, '手机竖屏命中区 ' + (z0.x1 - z0.x0).toFixed(0) + 'x' + (z0.y1 - z0.y0).toFixed(0));
});

test('随机模糊：2 万个随机点，holeAtPoint 的结果与"逐个命中区暴力比对"完全一致', function () {
  var rng = rngOf(77), bad = 0, hits = 0;
  LAYOUTS.forEach(function (lo) {
    var zs = []; for (var i = 0; i < 16; i++) zs.push(L.hitRect(lo, i));
    for (var n = 0; n < 7000; n++) {
      var x = lo.bx - 10 + rng() * (4 * lo.cw + 20), y = lo.by - 10 + rng() * (4 * lo.ch + 20);
      var expect = -1;
      for (var k = 0; k < 16; k++) if (x >= zs[k].x0 && x <= zs[k].x1 && y >= zs[k].y0 && y <= zs[k].y1) { expect = k; break; }
      var got = L.holeAtPoint(lo, x, y);
      if (got !== expect) bad++;
      if (got >= 0) hits++;
    }
  });
  assert.strictEqual(bad, 0);
  assert.ok(hits > 5000, '一部分点应落在命中区里，实际 ' + hits);
});

test('clickAt：命中区里点中奶蛙 = 命中；点空格子 = 打空（清连击）；点洞口前沿 / 缝隙 = 完全不判定', function () {
  var lo = LAYOUTS[0], s = freshPlaying();
  function zc(i) { var z = L.hitRect(lo, i); return { x: (z.x0 + z.x1) / 2, y: z.y0 + (z.y1 - z.y0) * 0.5, z: z }; }
  put(s, 5, 'normal'); put(s, 6, 'sumo'); put(s, 9, 'angel'); put(s, 10, 'god');
  var p = zc(5), out = L.clickAt(s, lo, p.x, p.y);                 // 点在 5 号洞命中区（奶蛙脑袋位置）
  assert.strictEqual(out.hole, 5); assert.strictEqual(out.res.kind, 'kill'); assert.strictEqual(s.score, 1);
  p = zc(6); out = L.clickAt(s, lo, p.x, p.y + 10);                // 大块头第一下
  assert.strictEqual(out.res.kind, 'partial');
  p = zc(6); out = L.clickAt(s, lo, p.z.x0 + 1, p.z.y0 + 1);       // 命中区最左上角也算（大块头第二下）
  assert.strictEqual(out.res.kind, 'kill'); assert.strictEqual(s.score, 1 + 3 * L.comboMultiplier(s.combo));
  // 空格子：打空
  var comboBefore = s.combo, scoreBefore = s.score;
  p = zc(0); out = L.clickAt(s, lo, p.x, p.y);
  assert.strictEqual(out.hole, 0); assert.strictEqual(out.res.kind, 'miss'); assert.strictEqual(s.combo, 0); assert.strictEqual(s.score, scoreBefore);
  assert.ok(comboBefore > 0 && out.res.brokeCombo);
  // 重新攒连击，然后点洞口前沿 / 缝隙：不判定，连击和计数都不变
  s.combo = 7; var swings = s.stats.swings, score2 = s.score;
  var z9 = L.hitRect(lo, 9);                                       // 9 号洞里有天使
  var front = L.clickAt(s, lo, (z9.x0 + z9.x1) / 2, z9.y1 + 0.02 * lo.cw);   // 洞口前沿：刚好在命中区下沿之外
  assert.strictEqual(front.hole, -1); assert.strictEqual(front.res, null);
  var gap = L.clickAt(s, lo, z9.x1 + 0.02 * lo.cw, z9.y0 + 20);    // 缝隙
  assert.strictEqual(gap.hole, -1); assert.strictEqual(gap.res, null);
  var outside = L.clickAt(s, lo, -50, -50);
  assert.strictEqual(outside.res, null);
  assert.strictEqual(s.combo, 7, '没判定就不该清连击'); assert.strictEqual(s.stats.swings, swings); assert.strictEqual(s.score, score2);
  assert.strictEqual(s.holes[9].phase, 'up', '天使没被碰到');
  // 点命中区里的天使：-3 并清连击；点金奶蛙：+5 并加时
  p = zc(9); out = L.clickAt(s, lo, p.x, p.y); assert.strictEqual(out.res.kind, 'angel'); assert.strictEqual(s.combo, 0);
  var tl = s.timeLeft; p = zc(10); out = L.clickAt(s, lo, p.x, p.y); assert.strictEqual(out.res.kind, 'god'); assert.strictEqual(s.timeLeft, tl + 2);
  // 点已经被打趴、正在笑的奶蛙：忽略
  p = zc(10); out = L.clickAt(s, lo, p.x, p.y); assert.strictEqual(out.res.kind, 'ignored');
});

test('已结束 / 未开始时 clickAt 命中区内也不产生任何效果', function () {
  var lo = LAYOUTS[0], s = L.createState(), z = L.hitRect(lo, 3);
  var out = L.clickAt(s, lo, (z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2);
  assert.strictEqual(out.hole, 3); assert.strictEqual(out.res.kind, 'inactive'); assert.strictEqual(s.stats.swings, 0);
});

console.log('        命中区（相对格子）：横向 5%~95%（宽 90%），纵向从格子顶端到洞口中线下 5% 格宽；手机竖屏 82x107 的格子 -> 命中区约 '
  + (L.hitRect(LAYOUTS[0], 0).x1 - L.hitRect(LAYOUTS[0], 0).x0).toFixed(0) + 'x' + (L.hitRect(LAYOUTS[0], 0).y1 - L.hitRect(LAYOUTS[0], 0).y0).toFixed(0) + ' px，'
  + '占格高 ' + Math.round((L.hitRect(LAYOUTS[0], 0).y1 - L.hitRect(LAYOUTS[0], 0).y0) / LAYOUTS[0].ch * 100) + '%');

/* ------------------------------------------------------------------ */
section('平衡性冒烟测试（机器人模拟人类玩家，仅做数量级检查）');

// 机器人：反应时间 reaction 秒后才会去打；两次动作至少间隔 interval 秒；有 errRate 概率点错（点空洞）
function runBot(seed, reaction, interval, errRate) {
  var s = L.createState(); L.startGame(s);
  var rng = rngOf(seed), brng = rngOf(seed + 4242), dt = 1 / 60, t = 0, nextAct = reaction;
  while (s.mode === 'playing' && t < 200) {
    L.tick(s, dt, rng); t += dt;
    if (s.mode !== 'playing' || t < nextAct) continue;
    var best = null, bestScore = -1;
    for (var i = 0; i < s.holes.length; i++) {
      var m = s.holes[i];
      if (!m || m.type === 'angel' || !L.isHittable(m) || m.phase === 'hit' || m.age < reaction) continue;
      var pr = (m.type === 'god' ? 100 : m.type === 'sumo' ? 10 : 0) + (1 - Math.min(1, (m.stay - m.t) / 2));
      if (pr > bestScore) { bestScore = pr; best = m; }
    }
    if (best) {
      if (brng() < errRate) L.hit(s, Math.floor(brng() * 16)); else L.hit(s, best.hole);
      nextAct = t + interval * (0.8 + 0.4 * brng());
    }
  }
  return s;
}
function avgScore(reaction, interval, err) {
  var sum = 0, n = 12, kills = 0, maxc = 0;
  for (var i = 0; i < n; i++) { var s = runBot(1000 + i * 17, reaction, interval, err); sum += s.score; kills += s.stats.kills; maxc += s.maxCombo; }
  return { score: sum / n, kills: kills / n, maxCombo: maxc / n };
}

test('菜鸟/普通/高手的平均得分递增，且都在合理范围', function () {
  var casual = avgScore(0.70, 1.15, 0.12), normal = avgScore(0.50, 0.80, 0.07), expert = avgScore(0.35, 0.55, 0.04);
  console.log('        菜鸟 ' + casual.score.toFixed(0) + ' 分(命中 ' + casual.kills.toFixed(0) + ', 最高连击 ' + casual.maxCombo.toFixed(0) + ')'
    + ' | 普通 ' + normal.score.toFixed(0) + ' 分(命中 ' + normal.kills.toFixed(0) + ', 最高连击 ' + normal.maxCombo.toFixed(0) + ')'
    + ' | 高手 ' + expert.score.toFixed(0) + ' 分(命中 ' + expert.kills.toFixed(0) + ', 最高连击 ' + expert.maxCombo.toFixed(0) + ')');
  assert.ok(casual.score < normal.score && normal.score < expert.score, '得分应随水平递增');
  assert.ok(casual.score >= 15, '菜鸟也应该能拿到几分');
  assert.ok(expert.kills <= 160, '命中数不可能超过总刷出数');
});

console.log('\n' + (failed ? 'FAILED' : 'ALL PASSED') + ': ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
