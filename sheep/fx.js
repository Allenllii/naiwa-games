/* 奶了个奶 · 特效：小星星/纸屑粒子、飘字、冲击圈（只管画，不碰规则） */
(function (root) {
  'use strict';

  var COLORS = ['#ffd84d', '#ff8db5', '#6fbbff', '#5fcf86', '#b48cff', '#ff9a4d', '#ffffff'];
  var maxParts = 400;              // 粒子上限，防止低端机卡顿（手机上会调小）
  var parts = [], texts = [], rings = [];

  function rnd(a, b) { return a + Math.random() * (b - a); }

  // 迸发：kind = 'star' 星星 / 'conf' 纸屑
  function burst(x, y, n, o) {
    o = o || {};
    for (var i = 0; i < n && parts.length < maxParts; i++) {
      var a = rnd(0, Math.PI * 2), sp = rnd(o.speedMin || 80, o.speed || 260);
      var kind = o.kind || (Math.random() < 0.55 ? 'star' : 'conf');
      parts.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.up || 90),
        g: o.gravity == null ? 620 : o.gravity, size: rnd(o.sizeMin || 6, o.size || 13),
        rot: rnd(0, 6.28), vr: rnd(-9, 9), life: 0, max: rnd(0.55, o.life || 1.0), kind: kind,
        color: o.colors ? o.colors[(Math.random() * o.colors.length) | 0] : COLORS[(Math.random() * COLORS.length) | 0]
      });
    }
  }

  // 飘字：弹出放大再上浮淡出
  function text(x, y, str, o) {
    o = o || {};
    texts.push({ x: x, y: y, str: str, color: o.color || '#ff6b6b', size: o.size || 24, life: 0, max: o.life || 1.0,
                 rise: o.rise == null ? 54 : o.rise, delay: o.delay || 0, stroke: o.stroke || '#fff' });
  }

  // 冲击圈
  function ring(x, y, r, color) { rings.push({ x: x, y: y, r: r, life: 0, max: 0.45, color: color || '#ffffff' }); }

  function update(dt) {
    var i, p;
    for (i = parts.length - 1; i >= 0; i--) {
      p = parts[i]; p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; p.vx *= (1 - 0.8 * dt);
    }
    for (i = texts.length - 1; i >= 0; i--) {
      p = texts[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.life += dt;
      if (p.life >= p.max) texts.splice(i, 1);
    }
    for (i = rings.length - 1; i >= 0; i--) { rings[i].life += dt; if (rings[i].life >= rings[i].max) rings.splice(i, 1); }
  }

  function star(c, r) {
    c.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
      c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    c.closePath();
  }

  function draw(c) {
    var i, p, k;
    for (i = 0; i < rings.length; i++) {
      p = rings[i]; k = p.life / p.max;
      c.globalAlpha = (1 - k) * 0.8; c.strokeStyle = p.color; c.lineWidth = 5 * (1 - k) + 1;
      c.beginPath(); c.arc(p.x, p.y, p.r * (0.3 + 0.9 * k), 0, 6.283); c.stroke();
    }
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; k = p.life / p.max;
      c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
      c.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      c.fillStyle = p.color;
      if (p.kind === 'star') { star(c, p.size); c.fill(); c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1.2; c.stroke(); }
      else c.fillRect(-p.size * 0.5, -p.size * 0.28, p.size, p.size * 0.56);
      c.restore();
    }
    c.globalAlpha = 1;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    for (i = 0; i < texts.length; i++) {
      p = texts[i];
      if (p.delay > 0) continue;
      k = p.life / p.max;
      var pop = k < 0.18 ? 0.5 + 0.9 * (k / 0.18) : k < 0.3 ? 1.4 - 0.4 * ((k - 0.18) / 0.12) : 1;
      c.save(); c.translate(p.x, p.y - p.rise * (1 - Math.pow(1 - k, 2))); c.scale(pop, pop);
      c.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      c.font = '800 ' + p.size + 'px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      c.lineWidth = Math.max(4, p.size * 0.22); c.strokeStyle = p.stroke; c.strokeText(p.str, 0, 0);
      c.fillStyle = p.color; c.fillText(p.str, 0, 0);
      c.restore();
    }
    c.globalAlpha = 1;
  }

  function clear() { parts.length = 0; texts.length = 0; rings.length = 0; }
  function active() { return parts.length + texts.length + rings.length > 0; }
  function setLimit(n) { maxParts = n; }

  root.SheepFX = { burst: burst, text: text, ring: ring, update: update, draw: draw, clear: clear, active: active, setLimit: setLimit, COLORS: COLORS };
})(window);
