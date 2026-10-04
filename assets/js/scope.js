import { iconFor } from './map.js';
// Classic PPI scope: rotating sweep, phosphor afterglow, bearing readout.
// Pure math is exported for unit tests; DOM lives inside createScope.
const KM_LAT = 110.57;
export function project(lat, lon, center, rangeKm, size) {
  const kx = 111.32 * Math.cos(center[0] * Math.PI / 180);
  const dx = (lon - center[1]) * kx;
  const dy = (lat - center[0]) * KM_LAT;
  const distKm = Math.hypot(dx, dy);
  const bearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  const k = (size / 2 - 8) / rangeKm;
  return { x: size / 2 + dx * k, y: size / 2 - dy * k, distKm, bearing, inside: distKm <= rangeKm };
}
export function sweepBoost(sweepDeg, bearing) {
  let d = Math.abs(sweepDeg - bearing) % 360;
  if (d > 180) d = 360 - d;
  return d < 30 ? 1 - d / 30 : 0;
}
export function fmtAzimuth(bearing, distKm) {
  return 'А ' + String(Math.round(bearing)).padStart(3, '0') + '° · ' + (distKm < 10 ? distKm.toFixed(1).replace('.', ',') + ' км' : Math.round(distKm) + ' км');
}
export function createScope(canvas, { onSelect } = {}) {
  const ctx = canvas.getContext('2d');
  const staticC = document.createElement('canvas');
  const echoC = document.createElement('canvas');
  const sctx = staticC.getContext('2d');
  const ectx = echoC.getContext('2d');
  const S = { events: [], center: [49, 31], range: 200, guardKm: null, pin: null, pts: [] };
  let sweep = 0, last = 0, raf = 0, active = false, W = 0, H = 0, staticKey = '';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
    if (canvas.width === w * dpr && canvas.height === h * dpr) return false;
    canvas.width = w * dpr; canvas.height = h * dpr;
    for (const c of [staticC, echoC]) { c.width = w * dpr; c.height = h * dpr; }
    W = w; H = h;
    return true;
  }
  function rebuildStatic() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
    sctx.clearRect(0, 0, W, H);
    const bg = sctx.createRadialGradient(cx, cy, 10, cx, cy, R);
    bg.addColorStop(0, '#06121b'); bg.addColorStop(1, '#020609');
    sctx.fillStyle = bg;
    sctx.beginPath(); sctx.arc(cx, cy, R, 0, 7); sctx.fill();
    sctx.strokeStyle = '#66c7ff';
    [0.25, 0.5, 0.75, 1].forEach((f, i) => {
      sctx.globalAlpha = i === 3 ? 0.5 : 0.22; sctx.lineWidth = i === 3 ? 1.6 : 1;
      sctx.beginPath(); sctx.arc(cx, cy, R * f, 0, 7); sctx.stroke();
      sctx.globalAlpha = 0.75; sctx.fillStyle = '#9fd8f5'; sctx.font = '10px system-ui';
      sctx.fillText(Math.round(S.range * f) + '', cx + 4, cy - R * f - 3);
    });
    sctx.globalAlpha = 0.9;
    for (let a = 0; a < 360; a += 30) {
      const r0 = R - (a % 90 === 0 ? 9 : 5), rad = (a - 90) * Math.PI / 180;
      sctx.globalAlpha = 0.5; sctx.lineWidth = 1;
      sctx.beginPath();
      sctx.moveTo(cx + Math.cos(rad) * r0, cy + Math.sin(rad) * r0);
      sctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
      sctx.stroke();
    }
    sctx.globalAlpha = 0.14;
    sctx.beginPath(); sctx.moveTo(cx - R, cy); sctx.lineTo(cx + R, cy);
    sctx.moveTo(cx, cy - R); sctx.lineTo(cx, cy + R); sctx.stroke();
    sctx.globalAlpha = 0.85; sctx.fillStyle = '#9fc9e8'; sctx.font = 'bold 11px system-ui';
    sctx.fillText('Пн', cx - 7, cy - R + 14); sctx.fillText('Пд', cx - 7, cy + R - 6);
    sctx.globalAlpha = 1;
  }
  function drawSweep() {
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
    const a = (sweep - 90) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a);
    let g;
    if (typeof ctx.createConicGradient === 'function') {
      g = ctx.createConicGradient(-0.5, 0, 0);
      g.addColorStop(0, 'rgba(102,199,255,0)');
      g.addColorStop(0.85, 'rgba(102,199,255,0.10)');
      g.addColorStop(1, 'rgba(102,199,255,0.55)');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = 'rgba(102,199,255,0.10)';
    }
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.5, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(140,220,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.restore();
  }
  function frame(t) {
    if (!active) return;
    const dt = Math.min(100, t - (last || t));
    last = t;
    if (!reduced) sweep = (sweep + dt / 5000 * 360) % 360;
    resize();
    const key = W + 'x' + H + ':' + S.range;
    if (key !== staticKey) { staticKey = key; rebuildStatic(); }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.globalCompositeOperation = 'destination-out';
    ectx.fillStyle = 'rgba(0,0,0,0.07)';
    ectx.fillRect(0, 0, W, H);
    ectx.globalCompositeOperation = 'source-over';
    const size = Math.min(W, H);
    S.pts = [];
    const reds = [];
    const edge = [];
    let nearest = null;
    for (const e of S.events) {
      if (e.lat == null || e.lon == null) continue;
      const p = project(e.lat, e.lon, S.center, S.range, size);
      if (p.distKm < (nearest == null ? Infinity : nearest)) nearest = p.distKm;
      if (!p.inside) {
        if (p.distKm <= S.range * 3) edge.push(p);
        continue;
      }
      const ox = (W - size) / 2 + p.x, oy = (H - size) / 2 + p.y;
      const m = iconFor(e);
      const boost = sweepBoost(sweep, p.bearing);
      S.pts.push({ e, x: ox, y: oy, label: m.label });
      ectx.globalAlpha = 0.45 + 0.55 * boost;
      ectx.fillStyle = m.color;
      ectx.beginPath(); ectx.arc(ox, oy, e._lvl === 'red' ? 4.5 : 3.2, 0, 7); ectx.fill();
      if (e._lvl === 'red') reds.push([ox, oy]);
    }
    ectx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(staticC, 0, 0, W, H);
    ctx.drawImage(echoC, 0, 0, W, H);
    for (const [x, y] of reds) {
      ctx.strokeStyle = 'rgba(255,60,80,0.9)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.stroke();
    }
    if (Number.isFinite(S.guardKm) && S.guardKm > 0 && S.guardKm <= S.range) {
      const gr = S.guardKm / S.range * (size / 2 - 8);
      ctx.strokeStyle = 'rgba(255,111,125,0.55)'; ctx.setLineDash([7, 7]);
      ctx.beginPath(); ctx.arc(W / 2, H / 2, gr, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '10px system-ui';
    let labeled = 0;
    for (const p of S.pts) {
      if (labeled >= 14) break;
      labeled++;
      ctx.globalAlpha = 0.9;
      ctx.fillText(p.label, p.x + 7, p.y - 6);
    }
    ctx.globalAlpha = 1;
    const cx0 = W / 2, cy0 = H / 2, RR = Math.min(W, H) / 2 - 6;
    for (const p of edge) {
      const a = (p.bearing - 90) * Math.PI / 180;
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = '#66c7ff';
      ctx.beginPath(); ctx.arc(cx0 + Math.cos(a) * (RR - 12), cy0 + Math.sin(a) * (RR - 12), 3, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!S.pts.length) {
      ctx.fillStyle = '#9fd8f5'; ctx.font = '12px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Цілей у радіусі ' + S.range + ' км немає', cx0, cy0 - 8);
      if (nearest != null && Number.isFinite(nearest)) ctx.fillText('Найближча: ' + (nearest < 10 ? nearest.toFixed(1).replace('.', ',') : Math.round(nearest)) + ' км — збільш дальність', cx0, cy0 + 12);
      ctx.textAlign = 'left';
    }
    if (S.pin) {
      const p = project(S.pin.lat, S.pin.lon, S.center, S.range, size);
      if (p.inside) {
        const ox = (W - size) / 2 + p.x, oy = (H - size) / 2 + p.y;
        ctx.fillStyle = '#66c7ff';
        ctx.save(); ctx.translate(ox, oy); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-5, -5, 10, 10); ctx.restore();
        ctx.fillStyle = '#dff2ff'; ctx.fillText(S.pin.label || '', ox + 9, oy - 8);
      }
    }
    ctx.fillStyle = '#66c7ff';
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3.5, 0, 7); ctx.stroke();
    if (!reduced) drawSweep();
    raf = requestAnimationFrame(frame);
  }
  return {
    update(events, center, opts = {}) {
      S.events = (events || []).slice(0, 300);
      if (center) S.center = center;
      if (opts.range) S.range = opts.range;
      S.guardKm = opts.guardKm ?? null;
      S.pin = opts.pin || null;
    },
    pick(x, y) {
      let best = null, bd = 22;
      for (const p of S.pts) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = p.e; }
      }
      return best;
    },
    readout(x, y) {
      const size = Math.min(W, H);
      if (!size) return null;
      const k = S.range / (size / 2 - 8);
      const dx = (x - W / 2) * k, dy = -(y - H / 2) * k;
      const distKm = Math.hypot(dx, dy);
      if (distKm > S.range) return null;
      return fmtAzimuth((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, distKm);
    },
    setActive(on) {
      if (on && !active) { active = true; last = 0; staticKey = ''; raf = requestAnimationFrame(frame); }
      if (!on && active) { active = false; cancelAnimationFrame(raf); }
    },
  };
}
