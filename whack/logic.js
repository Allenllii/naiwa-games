/*
 * 打奶蛙 · 核心规则（纯逻辑：不碰 DOM / Canvas / 系统时钟 / Math.random 以外的随机源）
 * ---------------------------------------------------------------------------------
 * - 浏览器里用 <script src="logic.js"> 加载，挂在 window.WhackLogic；
 * - Node 里 require('./logic.js') 即可，test-logic.js 就是这么跑的。
 * - 一局游戏的所有可变数据都在一个 state 对象里；所有函数都是 (state, ...) -> 结果。
 * - 随机数通过参数 rng 传入（默认 Math.random），测试时可以换成固定种子，结果可复现。
 *
 * 画面层（game.js）只负责"把 state 画出来 + 把点击翻译成 hit(state, 洞号)"，
 * 规则（刷怪、计分、连击、大块头两下、金奶蛙加时……）全部在这里。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root && typeof window !== 'undefined') { root.WhackLogic = api; }
})(this, function () {
  'use strict';

  /* =====================================================================
   * 可调参数（集中放这里，想调手感/难度只改这一块）
   * ===================================================================== */
  var CONFIG = {
    // —— 棋盘 ——
    COLS: 4,
    ROWS: 4,                      // 4x4 = 16 个洞

    // —— 时间 ——
    GAME_TIME: 60,                // 一局 60 秒
    GOD_TIME_BONUS: 2,            // 打中金色神奶蛙，剩余时间 +2 秒

    // —— 计分 ——
    POINTS: { normal: 1, sumo: 3, god: 5, angel: -3 },
    COMBO_PER_LEVEL: 5,           // 每 5 连击，倍率 +1
    MULT_MAX: 4,                  // 倍率最高 x4
    SUMO_HP: 2,                   // 大块头要打 2 下
    SUMO_REPRIEVE: 0.7,           // 大块头挨了第一下后，至少再留这么久（秒），给你补第二下

    // —— 单只奶蛙的动画时长（秒）——
    // 注意：判定是"按下的瞬间"完成的，但画面上要等锤子砸下去（约 0.12 秒）才开始演受击动画，
    // 所以下面三个"被打后停留"的时长都比单纯的动画长了约 0.13 秒。
    RISE_TIME: 0.2,               // 冒头
    FALL_TIME: 0.2,               // 缩回
    HIT_TIME: 0.55,               // 被打趴后"大笑"的时长，之后再缩回
    GOD_HIT_TIME: 0.68,           // 金奶蛙被打后"升天"的时长
    ANGEL_HIT_TIME: 0.55,         // 天使被误伤后的"懵"时长
    END_FALL_TIME: 0.25,          // 时间到时，场上所有奶蛙统一缩回的时长
    HIT_MIN_HEIGHT: 0.15,         // 露出的高度低于这个比例就算"已经没了"，点上去算打空

    // —— 点击命中区（相对格子尺寸的比例）——
    // 每个格子的命中区 = 奶蛙冒头时图片占据的那一块：格子上部，从格子顶端一直到洞口中线（略往下一点点）。
    // 点在洞口前沿 / 下半部分 / 两格之间的缝隙里，都不算命中任何格子。
    HIT: {
      PAD_X: 0.05,                // 横向：两侧各缩进 5% 格宽（相邻两格之间留 10% 的缝，防误触邻格）
      PIT_BELOW: 0.27,            // 洞口中线到格子底边的距离（格宽的 27%）——画面里土坑就画在这个位置
      BOTTOM_EXTRA: 0.05          // 命中区下沿 = 洞口中线再往下 5% 格宽（盖住完全冒出时奶蛙的脚）
    },

    // —— 难度曲线：按"已玩时间"从 0 到 GAME_TIME 线性插值 [开局, 终局] ——
    CAP_STEPS: [[0, 3], [14, 4], [34, 5]],   // [从第几秒起, 同时在场上的奶蛙上限]（最高 5 只）
    GAP: [0.40, 0.18],            // 两次冒头之间的最短间隔（秒）。16 个洞比较空，所以刷得勤
    GAP_JITTER: [0.6, 1.4],       // 间隔随机倍率
    LULL_CHANCE: 0.12,            // 偶尔来个小停顿（间隔 x2），让节奏不那么机械
    FIRST_SPAWN_DELAY: 0.35,      // 开局后多久出第一只
    STAY: {                       // 停留时长（秒）= 完全冒出来之后待多久 [开局, 终局]
      normal: [1.45, 0.65],
      sumo:   [2.00, 1.10],
      angel:  [1.50, 0.95],
      god:    [0.95, 0.75]        // 金奶蛙：稀有、停留很短
    },
    STAY_JITTER: 0.18,            // 停留时长随机 ±18%
    WEIGHTS: {                    // 出现权重 [开局, 终局]（金奶蛙另有保底规则）
      normal: [0.74, 0.62],
      sumo:   [0.10, 0.14],
      angel:  [0.12, 0.18],
      god:    [0.03, 0.04]
    },
    GOD_FIRST_AT: 6,              // 开局这么久之内不出金奶蛙
    GOD_MIN_GAP: 10,              // 两只金奶蛙之间至少隔这么久
    GOD_MAX_GAP: 22,              // 隔太久没出就保底来一只
    MAX_ANGELS: 2,                // 场上最多同时 2 只天使
    HOLE_COOLDOWN: 0.6,           // 一个洞刚空出来，这么久内尽量别在同一个洞再冒头
    SKINS: ['mouse', 'rooster', 'dog', 'horse'],   // 普通奶蛙的 4 种造型

    // —— 开始界面的"演示"模式（只刷怪、不计分、不出声）——
    DEMO_ELAPSED: 6,              // 按第几秒的难度来演示
    DEMO_CAP: 3
  };
  CONFIG.HOLES = CONFIG.COLS * CONFIG.ROWS;

  /* =====================================================================
   * 小工具
   * ===================================================================== */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutBack(x) { var c1 = 1.70158, c3 = c1 + 1, u = x - 1; return 1 + c3 * u * u * u + c1 * u * u; }

  /* =====================================================================
   * 连击与计分
   * ===================================================================== */

  // 连击倍率：每 5 连击 +1 倍，最高 x4。combo 指"这一下命中之后"的连击数。
  function comboMultiplier(combo) {
    return Math.min(CONFIG.MULT_MAX, 1 + Math.floor(Math.max(0, combo) / CONFIG.COMBO_PER_LEVEL));
  }

  /* =====================================================================
   * 难度曲线
   * ===================================================================== */

  // 同时在场上的奶蛙上限（阶梯式）
  function capAt(elapsed) {
    var cap = CONFIG.CAP_STEPS[0][1];
    for (var i = 0; i < CONFIG.CAP_STEPS.length; i++) {
      if (elapsed >= CONFIG.CAP_STEPS[i][0]) cap = CONFIG.CAP_STEPS[i][1];
    }
    return cap;
  }

  // 某类奶蛙在进度 p(0~1) 时的"完整停留时长"（秒，未加随机）
  function stayFor(type, p) {
    var s = CONFIG.STAY[type];
    return lerp(s[0], s[1], p);
  }

  // 已玩 elapsed 秒时的整体难度
  function difficultyAt(elapsed) {
    var p = clamp(elapsed / CONFIG.GAME_TIME, 0, 1);
    var w = {};
    for (var k in CONFIG.WEIGHTS) { w[k] = lerp(CONFIG.WEIGHTS[k][0], CONFIG.WEIGHTS[k][1], p); }
    return { p: p, cap: capAt(elapsed), gap: lerp(CONFIG.GAP[0], CONFIG.GAP[1], p), weights: w };
  }

  /* =====================================================================
   * 状态
   * ===================================================================== */

  // mode: 'idle'(开始前，只演示) | 'playing' | 'over'
  function createState() {
    var s = { mode: 'idle', clock: 0 };   // clock：单调递增的内部时钟（任何模式都走），用来做"洞冷却"和动画
    resetRun(s);
    return s;
  }

  function resetRun(s) {
    s.elapsed = 0;                         // 已经玩了多久（只在 playing 时增加；用来决定难度）
    s.timeLeft = CONFIG.GAME_TIME;         // 剩余时间（打中金奶蛙会加）
    s.timeAdded = 0;                       // 本局累计加了多少秒
    s.score = 0;
    s.combo = 0;
    s.maxCombo = 0;
    s.stats = { kills: 0, partials: 0, swings: 0, misses: 0, angelHits: 0, godHits: 0 };
    s.holes = [];                          // 每个洞里当前的奶蛙（null = 空洞）
    s.vacatedAt = [];                      // 每个洞最近一次空出来的时刻（clock）
    for (var i = 0; i < CONFIG.HOLES; i++) { s.holes.push(null); s.vacatedAt.push(-1e9); }
    s.spawnTimer = CONFIG.FIRST_SPAWN_DELAY;
    s.lastGodAt = 0;
    s.nextId = 1;
  }

  function startGame(s) { resetRun(s); s.mode = 'playing'; }

  // 把场上所有奶蛙统一缩回去（时间到）
  function endGame(s) {
    if (s.mode === 'over') return;
    s.mode = 'over';
    if (s.timeLeft < 0) s.timeLeft = 0;
    for (var i = 0; i < s.holes.length; i++) {
      var m = s.holes[i];
      if (m && m.phase !== 'fall' && m.phase !== 'gone') {
        var h = monsterHeight(m);
        m.phase = 'fall';
        m.fallTime = CONFIG.END_FALL_TIME;
        m.t = Math.sqrt(clamp(1 - h, 0, 1)) * m.fallTime;   // 从当前高度接着缩，画面不跳
      }
    }
  }

  function occupiedCount(s) {
    var n = 0;
    for (var i = 0; i < s.holes.length; i++) if (s.holes[i]) n++;
    return n;
  }

  function countType(s, type) {
    var n = 0;
    for (var i = 0; i < s.holes.length; i++) if (s.holes[i] && s.holes[i].type === type) n++;
    return n;
  }

  /* =====================================================================
   * 单只奶蛙的生命周期
   *   rise(冒头) -> up(停留) -> fall(缩回) -> gone
   *   被打中：-> hit(笑/升天/懵) -> fall -> gone
   * ===================================================================== */

  // 当前露出来的比例：0 = 完全缩在洞里，1 = 完全冒出来（冒头时会略微冲过头，做弹性）
  function monsterHeight(m) {
    switch (m.phase) {
      case 'rise': return easeOutBack(clamp(m.t / m.riseTime, 0, 1));
      case 'up':
      case 'hit': return 1;
      case 'fall': { var x = clamp(m.t / m.fallTime, 0, 1); return 1 - x * x; }
      default: return 0;
    }
  }

  // 现在能不能被打中（已经被打趴的、几乎缩没了的都不行）
  function isHittable(m) {
    if (!m) return false;
    if (m.phase === 'rise' || m.phase === 'up' || m.phase === 'fall') {
      return monsterHeight(m) >= CONFIG.HIT_MIN_HEIGHT;
    }
    return false;
  }

  function stepMonster(m, dt) {
    m.age += dt;
    m.t += dt;
    for (var guard = 0; guard < 8; guard++) {   // 允许一个很大的 dt 连跳好几个阶段
      if (m.phase === 'rise') {
        if (m.t < m.riseTime) break;
        m.t -= m.riseTime; m.phase = 'up';
      } else if (m.phase === 'up') {
        if (m.t < m.stay) break;
        m.t -= m.stay; m.phase = 'fall';
      } else if (m.phase === 'hit') {
        if (m.t < m.hitTime) break;
        m.t -= m.hitTime; m.phase = 'fall';
      } else if (m.phase === 'fall') {
        if (m.t < m.fallTime) break;
        m.phase = 'gone'; break;
      } else { break; }
    }
  }

  function makeMonster(s, type, hole, rng) {
    var diff = difficultyAt(currentElapsed(s));
    var jitter = 1 + (rng() * 2 - 1) * CONFIG.STAY_JITTER;
    var hp = type === 'sumo' ? CONFIG.SUMO_HP : 1;
    return {
      id: s.nextId++,
      hole: hole,
      type: type,                                   // 'normal' | 'sumo' | 'god' | 'angel'
      skin: type === 'normal' ? CONFIG.SKINS[Math.floor(rng() * CONFIG.SKINS.length) % CONFIG.SKINS.length] : null,
      hp: hp, maxHp: hp,
      hitCount: 0,                                  // 挨了几下
      defeated: false,                              // 是否已经被"打趴"（进入 hit 阶段）
      phase: 'rise', t: 0, age: 0,                  // t = 在当前阶段里已经过了多久
      riseTime: CONFIG.RISE_TIME,
      stay: stayFor(type, diff.p) * jitter,
      fallTime: CONFIG.FALL_TIME,
      hitTime: 0,
      spawnedAt: s.clock,
      hitAt: -1e9                                   // 最近一次挨打的时刻（clock），画面用它做受击动画
    };
  }

  /* =====================================================================
   * 刷怪
   * ===================================================================== */

  // 难度按哪个时间算：游戏中用已玩时间；开始界面用固定的演示难度
  function currentElapsed(s) { return s.mode === 'playing' ? s.elapsed : CONFIG.DEMO_ELAPSED; }

  // 挑一个空洞（绝不会挑到被占用的洞）；没有空洞返回 -1。优先避开刚空出来的洞。
  function pickHole(s, rng) {
    rng = rng || Math.random;
    var fresh = [], cooling = [];
    for (var i = 0; i < s.holes.length; i++) {
      if (s.holes[i]) continue;
      if (s.clock - s.vacatedAt[i] < CONFIG.HOLE_COOLDOWN) cooling.push(i); else fresh.push(i);
    }
    var pool = fresh.length ? fresh : cooling;
    if (!pool.length) return -1;
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }

  // 按权重挑种类；金奶蛙有"间隔 + 保底"规则；天使场上最多 MAX_ANGELS 只
  function pickType(s, rng) {
    rng = rng || Math.random;
    var d = difficultyAt(currentElapsed(s));
    var w = { normal: d.weights.normal, sumo: d.weights.sumo, angel: d.weights.angel, god: d.weights.god };

    var sinceGod = s.elapsed - s.lastGodAt;
    var godAllowed = s.mode === 'playing' && countType(s, 'god') === 0 &&
      s.elapsed >= CONFIG.GOD_FIRST_AT && sinceGod >= CONFIG.GOD_MIN_GAP;
    if (godAllowed && sinceGod >= CONFIG.GOD_MAX_GAP) return 'god';   // 太久没出：保底
    if (!godAllowed) w.god = 0;
    if (countType(s, 'angel') >= CONFIG.MAX_ANGELS) w.angel = 0;

    var r = rng() * (w.normal + w.sumo + w.angel + w.god);
    if ((r -= w.normal) < 0) return 'normal';
    if ((r -= w.sumo) < 0) return 'sumo';
    if ((r -= w.angel) < 0) return 'angel';
    return w.god > 0 ? 'god' : 'normal';
  }

  // 冒一只出来。没有空洞时返回 null。注意：这里不检查上限，上限由 tick 的调度负责。
  function spawnOne(s, rng) {
    rng = rng || Math.random;
    var hole = pickHole(s, rng);
    if (hole < 0) return null;
    var type = pickType(s, rng);
    var m = makeMonster(s, type, hole, rng);
    s.holes[hole] = m;
    if (type === 'god') s.lastGodAt = s.elapsed;
    return m;
  }

  /* =====================================================================
   * 每帧推进
   * 返回事件数组：{type:'spawn', monster} | {type:'gone', monster, escaped} | {type:'over'}
   * ===================================================================== */
  function tick(s, dt, rng) {
    rng = rng || Math.random;
    var events = [];
    if (!(dt > 0)) return events;
    s.clock += dt;
    if (s.mode === 'playing') { s.elapsed += dt; s.timeLeft -= dt; }

    // 1) 推进场上的奶蛙，缩没了的清掉
    for (var i = 0; i < s.holes.length; i++) {
      var m = s.holes[i];
      if (!m) continue;
      stepMonster(m, dt);
      if (m.phase === 'gone') {
        s.holes[i] = null;
        s.vacatedAt[i] = s.clock;
        events.push({ type: 'gone', monster: m, escaped: !m.defeated });
      }
    }

    // 2) 刷怪：场上数量 < 上限、且离上一次冒头够久了，才冒一只
    if (s.mode !== 'over') {
      var d = difficultyAt(currentElapsed(s));
      var cap = s.mode === 'idle' ? Math.min(d.cap, CONFIG.DEMO_CAP) : d.cap;
      s.spawnTimer -= dt;
      for (var guard = 0; guard < 4 && s.spawnTimer <= 0 && occupiedCount(s) < cap; guard++) {
        var nm = spawnOne(s, rng);
        if (!nm) break;
        events.push({ type: 'spawn', monster: nm });
        var gap = d.gap * lerp(CONFIG.GAP_JITTER[0], CONFIG.GAP_JITTER[1], rng());
        if (rng() < CONFIG.LULL_CHANCE) gap *= 2;
        s.spawnTimer += gap;
      }
      // 场上已满时，别攒"欠账"：有空位了只等一个很短的随机延迟，保持场面不空
      if (occupiedCount(s) >= cap) s.spawnTimer = Math.max(s.spawnTimer, rng() * d.gap * 0.3);
      else if (s.spawnTimer < 0) s.spawnTimer = 0;
    }

    // 3) 时间到
    if (s.mode === 'playing' && s.timeLeft <= 0) {
      endGame(s);
      events.push({ type: 'over' });
    }
    return events;
  }

  /* =====================================================================
   * 点击坐标 -> 洞号（纯函数：画面层和测试共用同一套）
   *
   * layout = { bx, by, cw, ch, cols, rows }：棋盘左上角、单格宽高、列数/行数（舞台坐标，单位 px）
   * 每个格子的命中区（闭区间，边界上的点算命中）：
   *   横向：格子左右各缩进 HIT.PAD_X * cw
   *   纵向：从格子顶端，到「洞口中线 + HIT.BOTTOM_EXTRA * cw」
   *        洞口中线 = 格子底边往上 HIT.PIT_BELOW * cw
   * 命中区之外（洞口前沿/下半部分、格间缝隙、棋盘外）一律返回 -1，不会被误判成邻格。
   * ===================================================================== */
  function hitRect(layout, index) {
    var cols = layout.cols || CONFIG.COLS;
    var c = index % cols, r = Math.floor(index / cols);
    var x = layout.bx + c * layout.cw, y = layout.by + r * layout.ch;
    var cy = y + layout.ch - CONFIG.HIT.PIT_BELOW * layout.cw;        // 洞口中线
    return {
      x0: x + CONFIG.HIT.PAD_X * layout.cw,
      x1: x + layout.cw - CONFIG.HIT.PAD_X * layout.cw,
      y0: y,
      y1: cy + CONFIG.HIT.BOTTOM_EXTRA * layout.cw,
      cy: cy                                                           // 洞口中线（调试画线用）
    };
  }

  function holeAtPoint(layout, x, y) {
    var cols = layout.cols || CONFIG.COLS, rows = layout.rows || CONFIG.ROWS;
    if (!(isFinite(x) && isFinite(y) && layout.cw > 0 && layout.ch > 0)) return -1;
    var c0 = Math.floor((x - layout.bx) / layout.cw), r0 = Math.floor((y - layout.by) / layout.ch);
    // 先估个大概格子，再在它周围 3x3 里按"矩形"精确查找：命中区是互不重叠的闭区间，
    // 这样即使点正好落在边线上、除法取整有浮点误差，也不会被算到别的格子去
    for (var r = r0 - 1; r <= r0 + 1; r++) {
      if (r < 0 || r >= rows) continue;
      for (var c = c0 - 1; c <= c0 + 1; c++) {
        if (c < 0 || c >= cols) continue;
        var idx = r * cols + c, z = hitRect(layout, idx);
        if (x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1) return idx;
      }
    }
    return -1;
  }

  // 一次"点击坐标"的完整处理：先查命中区，命中某个格子才调用 hit()；
  // 点在命中区之外（前沿/缝隙/棋盘外）不做任何判定（不算打空，连击也不会被清掉）。
  function clickAt(s, layout, x, y) {
    var hole = holeAtPoint(layout, x, y);
    if (hole < 0) return { hole: -1, res: null };
    return { hole: hole, res: hit(s, hole) };
  }

  /* =====================================================================
   * 点击判定：一次点击/按键 = 调用一次 hit(state, 洞号)
   *
   * 返回 res.kind：
   *   'inactive' 不在游戏中，没有任何效果
   *   'miss'     打空（空洞/刚缩没的洞）：连击清零，不扣分
   *   'ignored'  点在一只已经被打趴、正在笑的奶蛙上：不重复判定，也不算打空
   *   'partial'  大块头挨了第一下：没有分，但算一次命中（连击 +1）
   *   'kill'     普通/大块头被打趴：得分 x 连击倍率
   *   'god'      金奶蛙：得分 x 倍率，并加时
   *   'angel'    误伤天使：-3 分（不低于 0），连击清零
   * ===================================================================== */
  function hit(s, hole) {
    var res = {
      kind: 'inactive', hole: hole, monster: null,
      points: 0,            // 这一下"名义上"加/扣了多少分
      delta: 0,             // 分数实际变化（扣分不会扣到 0 以下）
      comboBefore: s.combo, combo: s.combo,
      mult: comboMultiplier(s.combo), multUp: false,
      brokeCombo: false, timeBonus: 0, killed: false,
      score: s.score
    };
    if (s.mode !== 'playing') return res;

    var m = (hole >= 0 && hole < s.holes.length) ? s.holes[hole] : null;
    if (m && m.phase === 'hit') { res.kind = 'ignored'; res.monster = m; return res; }

    s.stats.swings++;

    // 打空
    if (!m || !isHittable(m)) {
      res.kind = 'miss';
      res.brokeCombo = s.combo > 0;
      s.combo = 0;
      s.stats.misses++;
      res.combo = 0; res.mult = 1;
      return res;
    }

    // 命中
    res.monster = m;
    m.hitAt = s.clock;
    m.hitCount++;
    var before = s.combo;

    if (m.type === 'angel') {
      var old = s.score;
      s.score = Math.max(0, s.score + CONFIG.POINTS.angel);
      res.points = CONFIG.POINTS.angel;
      res.delta = s.score - old;
      s.combo = 0;
      res.brokeCombo = before > 0;
      res.kind = 'angel';
      s.stats.angelHits++;
      m.defeated = true; m.phase = 'hit'; m.t = 0; m.hitTime = CONFIG.ANGEL_HIT_TIME;
    } else {
      s.combo++;
      if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      var mult = comboMultiplier(s.combo);
      res.mult = mult;
      res.multUp = mult > comboMultiplier(before);
      m.hp--;
      if (m.hp > 0) {
        // 大块头的第一下：没有分，但给它一点时间让你补第二下（正在缩回时不续命）
        res.kind = 'partial';
        s.stats.partials++;
        if (m.phase === 'up') m.stay = Math.max(m.stay, m.t + CONFIG.SUMO_REPRIEVE);
        else if (m.phase === 'rise') m.stay = Math.max(m.stay, CONFIG.SUMO_REPRIEVE);
      } else {
        var pts = CONFIG.POINTS[m.type] * mult;
        s.score += pts;
        res.points = pts; res.delta = pts; res.killed = true;
        s.stats.kills++;
        m.defeated = true; m.phase = 'hit'; m.t = 0;
        if (m.type === 'god') {
          m.hitTime = CONFIG.GOD_HIT_TIME;
          s.timeLeft += CONFIG.GOD_TIME_BONUS;
          s.timeAdded += CONFIG.GOD_TIME_BONUS;
          res.timeBonus = CONFIG.GOD_TIME_BONUS;
          res.kind = 'god';
          s.stats.godHits++;
        } else {
          m.hitTime = CONFIG.HIT_TIME;
          res.kind = 'kill';
        }
      }
    }
    res.combo = s.combo;
    res.score = s.score;
    return res;
  }

  return {
    CONFIG: CONFIG,
    clamp: clamp, lerp: lerp, easeOutBack: easeOutBack,
    comboMultiplier: comboMultiplier,
    capAt: capAt, stayFor: stayFor, difficultyAt: difficultyAt,
    createState: createState, resetRun: resetRun, startGame: startGame, endGame: endGame,
    occupiedCount: occupiedCount, countType: countType,
    monsterHeight: monsterHeight, isHittable: isHittable, stepMonster: stepMonster,
    makeMonster: makeMonster, pickHole: pickHole, pickType: pickType, spawnOne: spawnOne,
    tick: tick, hit: hit,
    hitRect: hitRect, holeAtPoint: holeAtPoint, clickAt: clickAt
  };
});
