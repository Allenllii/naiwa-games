/* 奶了个奶 · 规则引擎（纯逻辑，不碰 DOM）
 * 管：点牌入槽、同款相邻、三消、压住判定、撤回/移出/洗牌、过关/失败。
 * 时间由外部传入（秒）：牌飞入槽要 flyTime，落稳后才结算消除；测试里 flyTime=0 即瞬间落稳。 */
(function (root) {
  'use strict';
  var L = (typeof module !== 'undefined' && module.exports) ? require('./logic.js') : root.SheepLogic;

  var COMBO_WINDOW = 2.6;   // 秒：两次消除间隔小于它就算连消
  var CLEAR_SCORE = 10;     // 每消一组
  var LEVEL_BONUS = 50;     // 过关奖励 = 关卡数 × 它

  function createEngine(level, opts) {
    opts = opts || {};
    var flyTime = opts.flyTime == null ? 0.3 : opts.flyTime;
    var rel = L.computeRelations(level.tiles);
    var tiles = level.tiles.map(function (t) {
      return { id: t.id, x: t.x, y: t.y, z: t.z, type: t.type, loc: 'board', landed: true, landAt: 0, seq: 0 };
    });
    var e = {
      level: level, tiles: tiles, above: rel.above, below: rel.below, flyTime: flyTime,
      slot: [], temp: [], state: 'playing', score: opts.score || 0,
      used: { undo: false, moveOut: false, shuffle: false },
      combo: 0, lastClear: -999, seq: 0, events: []
    };

    // ---- 查询 ----
    e.isFree = function (id) {
      var t = tiles[id];
      if (t.loc !== 'board') return false;
      var a = e.above[id];
      for (var i = 0; i < a.length; i++) if (tiles[a[i]].loc === 'board') return false;
      return true;
    };
    e.remaining = function () {          // 还没消掉的牌（场上+槽+暂存）
      var n = 0; for (var i = 0; i < tiles.length; i++) if (tiles[i].loc !== 'gone') n++; return n;
    };
    e.boardCount = function () {
      var n = 0; for (var i = 0; i < tiles.length; i++) if (tiles[i].loc === 'board') n++; return n;
    };
    e.busy = function () {               // 有牌还在飞向槽
      for (var i = 0; i < e.slot.length; i++) if (!tiles[e.slot[i]].landed) return true;
      return false;
    };
    e.drain = function () { var ev = e.events; e.events = []; return ev; };

    // 同款牌紧挨着放：插在同类最后一张后面，没有同类就放最右
    function insertIndex(type) {
      for (var i = e.slot.length - 1; i >= 0; i--) if (tiles[e.slot[i]].type === type) return i + 1;
      return e.slot.length;
    }

    // ---- 点牌 ----
    e.click = function (id, now) {
      if (e.state !== 'playing') return false;
      var t = tiles[id];
      if (!t || e.slot.length >= L.SLOT_CAP) return false;
      var from = t.loc;
      if (from === 'board') { if (!e.isFree(id)) return false; }
      else if (from === 'temp') { e.temp.splice(e.temp.indexOf(id), 1); }
      else return false;
      var idx = insertIndex(t.type);
      e.slot.splice(idx, 0, id);
      t.loc = 'slot'; t.landed = false; t.landAt = now + flyTime; t.seq = ++e.seq;
      e.events.push({ t: 'place', id: id, idx: idx, from: from });
      e.tick(now);
      return true;
    };

    // ---- 时间推进：处理落稳、消除、胜负 ----
    e.tick = function (now) {
      if (e.state !== 'playing') return;
      var i, landedAny = false;
      for (i = 0; i < e.slot.length; i++) {
        var t = tiles[e.slot[i]];
        if (!t.landed && t.landAt <= now + 1e-9) { t.landed = true; landedAny = true; e.events.push({ t: 'land', id: t.id }); }
      }
      if (landedAny) resolveClears(now);
      if (e.remaining() === 0) { win(); return; }
      if (e.slot.length >= L.SLOT_CAP && !e.busy()) {
        e.state = 'lost'; e.events.push({ t: 'lose' });
      }
    };

    function resolveClears(now) {
      for (;;) {
        var byType = {}, hit = -1, i;
        for (i = 0; i < e.slot.length; i++) {
          var t = tiles[e.slot[i]];
          if (!t.landed) continue;
          (byType[t.type] = byType[t.type] || []).push(t.id);
          if (byType[t.type].length >= 3) { hit = t.type; break; }
        }
        if (hit < 0) return;
        var ids = byType[hit].slice(0, 3);
        ids.forEach(function (id) { e.slot.splice(e.slot.indexOf(id), 1); tiles[id].loc = 'gone'; });
        e.combo = (now - e.lastClear <= COMBO_WINDOW) ? e.combo + 1 : 1;
        e.lastClear = now;
        e.score += CLEAR_SCORE;
        e.events.push({ t: 'clear', ids: ids, type: hit, combo: e.combo, gain: CLEAR_SCORE });
      }
    }

    function win() {
      e.state = 'won';
      var bonus = LEVEL_BONUS * level.level;
      e.score += bonus;
      e.events.push({ t: 'win', bonus: bonus });
    }

    // ---- 道具：撤回（把最后放进槽的牌放回原位）----
    e.undo = function () {
      if (e.state !== 'playing') return { ok: false, reason: 'state' };
      if (e.used.undo) return { ok: false, reason: 'used' };
      if (e.busy()) return { ok: false, reason: 'busy' };
      var best = null;
      e.slot.forEach(function (id) { if (!best || tiles[id].seq > best.seq) best = tiles[id]; });
      if (!best) return { ok: false, reason: 'empty' };
      e.slot.splice(e.slot.indexOf(best.id), 1);
      best.loc = 'board';
      e.used.undo = true;
      e.events.push({ t: 'undo', id: best.id });
      return { ok: true };
    };

    // ---- 道具：移出（槽里最前面 3 张进暂存区）----
    e.moveOut = function () {
      if (e.state !== 'playing') return { ok: false, reason: 'state' };
      if (e.used.moveOut) return { ok: false, reason: 'used' };
      if (e.busy()) return { ok: false, reason: 'busy' };
      var n = Math.min(3, e.slot.length, L.TEMP_CAP - e.temp.length);
      if (n <= 0) return { ok: false, reason: 'empty' };
      var ids = e.slot.splice(0, n);
      ids.forEach(function (id) { tiles[id].loc = 'temp'; e.temp.push(id); });
      e.used.moveOut = true;
      e.events.push({ t: 'moveOut', ids: ids });
      return { ok: true };
    };

    // ---- 道具：洗牌（位置不动，重新分配场上牌的造型，且仍保证有解）----
    e.shuffle = function (rng) {
      if (e.state !== 'playing') return { ok: false, reason: 'state' };
      if (e.used.shuffle) return { ok: false, reason: 'used' };
      if (e.busy()) return { ok: false, reason: 'busy' };
      rng = rng || Math.random;
      var ids = [], i;
      for (i = 0; i < tiles.length; i++) if (tiles[i].loc === 'board') ids.push(i);
      if (ids.length < 2) return { ok: false, reason: 'empty' };
      var T = L.NUM_TYPES, budget = [], open = [], old = {};
      for (i = 0; i < T; i++) { budget[i] = 0; open[i] = 0; }
      ids.forEach(function (id) { budget[tiles[id].type]++; old[id] = tiles[id].type; });
      e.slot.concat(e.temp).forEach(function (id) { open[tiles[id].type]++; });
      var res = L.planTypes({ ids: ids, above: e.above, below: e.below, budget: budget, open: open,
                              k: level.cfg.k, rng: rng });
      if (res) {
        ids.forEach(function (id) { tiles[id].type = res.assign[id]; });
      } else {                              // 兜底：直接把场上造型随机打乱
        var types = ids.map(function (id) { return tiles[id].type; });
        L.shuffleInPlace(types, rng);
        ids.forEach(function (id, k) { tiles[id].type = types[k]; });
      }
      e.used.shuffle = true;
      e.events.push({ t: 'shuffle', ids: ids, old: old, order: res ? res.order : null });
      return { ok: true, order: res ? res.order : null };
    };

    return e;
  }

  var api = { createEngine: createEngine, COMBO_WINDOW: COMBO_WINDOW, CLEAR_SCORE: CLEAR_SCORE, LEVEL_BONUS: LEVEL_BONUS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SheepEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
