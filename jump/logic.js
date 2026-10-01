/* ==========================================================================
 * 奶蛙跳一跳 · 核心规则（纯函数，不碰 DOM，浏览器和 node 都能直接用）
 *
 * 坐标约定
 *   世界坐标 (x, z) 在地面上，y 向上。长度单位叫 u：
 *   台子边长约 1.15~2.6u，奶蛙身高约 1.5u。
 *   跳跃轴 axis：0 = 沿 +x 走（屏幕上是「右上」），1 = 沿 +z 走（屏幕上是「左上」）。
 *
 * 这里只管三件事：
 *   1. 蓄力时长 → 跳多远（含蓄力上限）
 *   2. 落点判定：完美 / 普通 / 险过 / 滑落 / 掉下去
 *   3. 下一个台子怎么生成（保证玩家一定够得着）
 * ========================================================================== */
(function (root) {
  'use strict';

  /* ---------------------- 关键常量（想调手感改这里） ---------------------- */
  var CFG = {
    // —— 蓄力 → 距离 ——
    CHARGE_SPEED: 4.4,        // 每蓄力 1 秒能跳多远（u）。距离 = CHARGE_SPEED × 蓄力秒数
    MAX_CHARGE_TIME: 1.5,     // 蓄力时长上限（秒），再久也不会跳得更远

    // —— 落点判定（单位 u，量的是「脚底落点」到台面的距离）——
    PERFECT_R: 0.32,          // 离台面中心 ≤ 此值 = 完美
    SLIP_MARGIN: 0.28,        // 落在台外、但离台边 ≤ 此值 = 「半个身子在台外」→ 先滑一下再掉
    EDGE_BAND: 0.12,          // 落在台内、但离台边 ≤ 此值 = 险过（晃一下，不扣分）

    // —— 台子生成 ——
    SIZE_EASY: [1.9, 2.6],    // 开局时台子边长/直径的随机范围
    SIZE_HARD: [1.15, 1.75],  // 满难度时的范围（台子变小）
    GAP_EASY: [0.65, 1.5],    // 开局时「台边到台边」的空隙范围
    GAP_HARD: [1.25, 2.7],    // 满难度时的空隙范围（距离变大）
    DIFF_FULL_SCORE: 150,     // 分数到这个值时达到满难度，之前线性缓慢上升
    MIN_GAP: 0.6,             // 两个台子之间最小空隙（≥ 2 × SLIP_MARGIN，避免一脚踩两个台边）
    REACH_MARGIN: 0.25,       // 台子中心离「可达上限」至少再留的余量
    CUBE_RATIO: 0.5,          // 方块 : 圆柱 的比例
    PALETTE_SIZE: 9,          // 台子颜色种类数（具体颜色在 game.js 里）

    // —— 方向（右上 / 左上）——
    SWITCH_PROB: 0.7,         // 下一个台子换方向的概率（偏向交替，但保留随机）
    MAX_SAME_RUN: 3,          // 同一方向最多连续几次，超过就强制换

    // —— 滞空（只影响动画，也做成纯函数方便测）——
    AIR_BASE: 0.28,           // 滞空时间 = AIR_BASE + AIR_PER_U × 距离（秒）
    AIR_PER_U: 0.075,
    H_BASE: 0.55,             // 抛物线最高点 = H_BASE + H_PER_U × 距离（u）
    H_PER_U: 0.26,
    H_MAX: 2.4,
    FLIP1_DIST: 3.0,          // 跳得 ≥ 此距离，空中翻一圈
    FLIP2_DIST: 5.4           // 跳得 ≥ 此距离，翻两圈
  };

  /* ------------------------------ 小工具 ------------------------------ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** 可复现的随机数（mulberry32）。游戏里用 Math.random，测试里用它，保证结果稳定 */
  function createRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------- 1. 蓄力 → 起跳距离 ------------------------- */

  /** 蓄力时间夹到 [0, MAX_CHARGE_TIME]；传入 NaN / 负数当 0 */
  function clampChargeTime(t) {
    if (!(t > 0)) return 0;
    return t > CFG.MAX_CHARGE_TIME ? CFG.MAX_CHARGE_TIME : t;
  }

  /** 蓄力进度 0~1（用来驱动「越压越扁」「音调上升」） */
  function chargeRatio(t) { return clampChargeTime(t) / CFG.MAX_CHARGE_TIME; }

  /** 蓄力 t 秒能跳多远（u）。线性，超过上限就封顶 */
  function jumpDistance(t) { return CFG.CHARGE_SPEED * clampChargeTime(t); }

  /** 想跳 d（u）需要蓄力多久（秒）。注意：可能 > MAX_CHARGE_TIME，说明够不着 */
  function chargeTimeForDistance(d) { return d / CFG.CHARGE_SPEED; }

  /** 蓄满能跳的最远距离（u） */
  function maxJumpDistance() { return CFG.CHARGE_SPEED * CFG.MAX_CHARGE_TIME; }

  /**
   * 「保证可达」的距离上限：台子中心离玩家落点不能超过它。
   * 比蓄满还要再少 PERFECT_R + REACH_MARGIN，这样连「完美区」最远处也够得着，
   * 玩家不必卡着蓄力上限去跳。
   */
  function reachLimit() { return maxJumpDistance() - CFG.PERFECT_R - CFG.REACH_MARGIN; }

  /* ------------------------ 滞空动画用的运动学 ------------------------ */
  function jumpDuration(d) { return CFG.AIR_BASE + CFG.AIR_PER_U * d; }
  function jumpHeight(d) { return Math.min(CFG.H_MAX, CFG.H_BASE + CFG.H_PER_U * d); }
  /** 空中翻几圈：近处 0 圈，远处 1 圈，特别远 2 圈 */
  function flipCount(d) { return d >= CFG.FLIP2_DIST ? 2 : (d >= CFG.FLIP1_DIST ? 1 : 0); }
  /** 抛物线高度：tau = 0..1 为滞空过程，tau > 1 沿同一条抛物线继续下坠（用于掉落） */
  function arcHeight(h, tau) { return 4 * h * tau * (1 - tau); }

  /* ----------------------------- 2. 落点判定 ----------------------------- */

  /** 沿轴起跳 dist 后的落点 */
  function landingPoint(start, axis, dist) {
    return { x: start.x + (axis === 0 ? dist : 0), z: start.z + (axis === 1 ? dist : 0) };
  }

  /** 点到台面的「有符号距离」：<0 在台面内，=0 在边上，>0 在台面外 */
  function signedDistance(p, x, z) {
    var dx = x - p.x, dz = z - p.z, h = p.size / 2;
    if (p.shape === 'cylinder') return Math.sqrt(dx * dx + dz * dz) - h;
    var qx = Math.abs(dx) - h, qz = Math.abs(dz) - h;
    var ox = Math.max(qx, 0), oz = Math.max(qz, 0);
    return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0);
  }

  /** 点到台面中心的距离 */
  function centerDistance(p, x, z) {
    var dx = x - p.x, dz = z - p.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * 单个台子的落点判定。
   *   perfect ：落在台内，且离中心 ≤ PERFECT_R
   *   normal  ：落在台内（wobble=true 表示贴着台边，险过）
   *   slip    ：在台外，但离台边 ≤ SLIP_MARGIN，半个身子还在台上 → 先滑落再失败
   *   miss    ：离台边更远，直接掉下去
   * 台边上（距离恰好为 0）算台内；SLIP_MARGIN 恰好相等算滑落。
   */
  function judgeLanding(p, pt) {
    var sd = signedDistance(p, pt.x, pt.z);
    var cd = centerDistance(p, pt.x, pt.z);
    if (sd > CFG.SLIP_MARGIN) return { type: 'miss', sd: sd, cd: cd, wobble: false };
    if (sd > 0) return { type: 'slip', sd: sd, cd: cd, wobble: false };
    if (cd <= CFG.PERFECT_R) return { type: 'perfect', sd: sd, cd: cd, wobble: false };
    return { type: 'normal', sd: sd, cd: cd, wobble: -sd <= CFG.EDGE_BAND };
  }

  /** 滑落往哪边：沿跳跃轴，落点在台子中心的哪一侧（+1 = 往前/远处，-1 = 往后/近处） */
  function slipDirection(p, axis, pt) {
    var d = axis === 0 ? pt.x - p.x : pt.z - p.z;
    return d < 0 ? -1 : 1;
  }

  /**
   * 一次起跳的完整结果。
   * @param cur   当前台子（起跳时脚下的台子）
   * @param next  目标台子
   * @param start 起跳点 {x,z}（玩家当前站的位置，不一定是台子中心）
   * @param axis  0 | 1
   * @param chargeTime 蓄力秒数（会被夹到上限）
   * @returns {
   *   distance, landing:{x,z},
   *   outcome: 'next'（跳到下一个台子）| 'stay'（太短，还在原台子）| 'slip'（滑落）| 'miss'（直接掉下去）,
   *   quality: 'perfect' | 'normal' | null,
   *   judge, onPlatform: 'cur' | 'next' | null, slipDir: ±1 | 0
   * }
   */
  function resolveJump(cur, next, start, axis, chargeTime) {
    var distance = jumpDistance(chargeTime);
    var landing = landingPoint(start, axis, distance);
    var jn = judgeLanding(next, landing);
    if (jn.type === 'perfect' || jn.type === 'normal') {
      return { distance: distance, landing: landing, outcome: 'next', quality: jn.type, judge: jn, onPlatform: 'next', slipDir: 0 };
    }
    var jc = judgeLanding(cur, landing);
    if (jc.type === 'perfect' || jc.type === 'normal') {
      return { distance: distance, landing: landing, outcome: 'stay', quality: null, judge: jc, onPlatform: 'cur', slipDir: 0 };
    }
    if (jn.type === 'slip') {
      return { distance: distance, landing: landing, outcome: 'slip', quality: null, judge: jn, onPlatform: 'next', slipDir: slipDirection(next, axis, landing) };
    }
    if (jc.type === 'slip') {
      return { distance: distance, landing: landing, outcome: 'slip', quality: null, judge: jc, onPlatform: 'cur', slipDir: slipDirection(cur, axis, landing) };
    }
    return { distance: distance, landing: landing, outcome: 'miss', quality: null, judge: jn, onPlatform: null, slipDir: 0 };
  }

  /* ------------------------------ 计分（还原原版） ------------------------------ */
  /**
   * 普通落地 +1，并打断连击；
   * 连续完美：第 1 次 +2，第 2 次 +4，第 3 次 +6 …… 每多一次多 2 分。
   * @returns {{points:number, streak:number}} streak = 落地后的连续完美数
   */
  function scoreLanding(quality, streak) {
    if (quality === 'perfect') {
      var s = (streak > 0 ? streak : 0) + 1;
      return { points: 2 * s, streak: s };
    }
    return { points: 1, streak: 0 };
  }

  /* ----------------------------- 3. 台子生成 ----------------------------- */

  /** 难度 0~1，随分数缓慢上升 */
  function difficulty(score) { return clamp(score / CFG.DIFF_FULL_SCORE, 0, 1); }

  function sizeRange(score) {
    var d = difficulty(score);
    return [lerp(CFG.SIZE_EASY[0], CFG.SIZE_HARD[0], d), lerp(CFG.SIZE_EASY[1], CFG.SIZE_HARD[1], d)];
  }

  function gapRange(score) {
    var d = difficulty(score);
    return [lerp(CFG.GAP_EASY[0], CFG.GAP_HARD[0], d), lerp(CFG.GAP_EASY[1], CFG.GAP_HARD[1], d)];
  }

  /** 下一个台子往哪个方向：偏向交替（右上/左上），同方向最多连续 MAX_SAME_RUN 次 */
  function chooseAxis(prevAxis, run, rng) {
    rng = rng || Math.random;
    if (prevAxis !== 0 && prevAxis !== 1) return rng() < 0.5 ? 0 : 1;
    if (run >= CFG.MAX_SAME_RUN) return 1 - prevAxis;
    return rng() < CFG.SWITCH_PROB ? 1 - prevAxis : prevAxis;
  }

  function makePlatform(x, z, size, shape, colorIdx) {
    return { x: x, z: z, size: size, shape: shape, colorIdx: colorIdx };
  }

  /**
   * 生成下一个台子。
   * 台子的「侧向」坐标对齐玩家当前所站位置（所以只要距离蓄对了就能落在中线上，
   * 不会被上一次落点的偏差带偏），「前进方向」按台边间隙 gap 摆放。
   * 距离 distance = 玩家落点到新台子中心（沿跳跃轴）。
   * 保证：distance ≤ reachLimit()，也就是任意位置出发都够得着，且完美区也够得着。
   *
   * @param a { cur, player:{x,z}, axis, score, rng, prevColor }
   */
  function planNextPlatform(a) {
    var rng = a.rng || Math.random;
    var sr = sizeRange(a.score), gr = gapRange(a.score);
    var size = lerp(sr[0], sr[1], rng());
    var shape = rng() < CFG.CUBE_RATIO ? 'cube' : 'cylinder';
    var gap = lerp(gr[0], gr[1], rng());
    var half = size / 2, curHalf = a.cur.size / 2;

    // 兜底：玩家最坏站在当前台子最近端，距离 = 2×curHalf + gap + half，必须 ≤ reachLimit
    var maxGap = reachLimit() - 2 * curHalf - half;
    if (gap > maxGap) gap = maxGap;
    if (gap < CFG.MIN_GAP) gap = CFG.MIN_GAP;

    var along = a.axis === 0 ? 'x' : 'z';
    var lat = a.axis === 0 ? 'z' : 'x';
    var c = { x: 0, z: 0 };
    c[along] = a.cur[along] + curHalf + gap + half;
    c[lat] = a.player[lat];
    var distance = c[along] - a.player[along];

    // 颜色：随机，但不和上一个台子撞色
    var colorIdx = Math.floor(rng() * CFG.PALETTE_SIZE) % CFG.PALETTE_SIZE;
    if (a.prevColor === colorIdx) colorIdx = (colorIdx + 1 + Math.floor(rng() * (CFG.PALETTE_SIZE - 1))) % CFG.PALETTE_SIZE;

    var p = makePlatform(c.x, c.z, size, shape, colorIdx);
    p.axis = a.axis;       // 跳到它要沿哪根轴
    p.gap = gap;           // 与当前台子的台边间隙
    p.distance = distance; // 玩家落点 → 台子中心 的跳跃距离
    return p;
  }

  /** 一个跳跃距离是不是「保证够得着」：蓄力时长在上限内，连完美区最远处也行 */
  function isReachable(distance) {
    return distance > 0 && chargeTimeForDistance(distance + CFG.PERFECT_R) <= CFG.MAX_CHARGE_TIME + 1e-9;
  }

  /* ------------------------------ 导出 ------------------------------ */
  var api = {
    CFG: CFG,
    clamp: clamp, lerp: lerp, createRng: createRng,
    clampChargeTime: clampChargeTime, chargeRatio: chargeRatio,
    jumpDistance: jumpDistance, chargeTimeForDistance: chargeTimeForDistance,
    maxJumpDistance: maxJumpDistance, reachLimit: reachLimit,
    jumpDuration: jumpDuration, jumpHeight: jumpHeight, flipCount: flipCount, arcHeight: arcHeight,
    landingPoint: landingPoint, signedDistance: signedDistance, centerDistance: centerDistance,
    judgeLanding: judgeLanding, slipDirection: slipDirection, resolveJump: resolveJump,
    scoreLanding: scoreLanding,
    difficulty: difficulty, sizeRange: sizeRange, gapRange: gapRange,
    chooseAxis: chooseAxis, makePlatform: makePlatform, planNextPlatform: planNextPlatform,
    isReachable: isReachable
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JumpLogic = api;
})(typeof window !== 'undefined' ? window : this);
