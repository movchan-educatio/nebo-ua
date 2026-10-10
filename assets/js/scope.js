import { iconFor, getThreatVisual, rangeRings } from './map.js';
import { shouldShowHeading } from '../../services/threatClassify.js';
import { regionName } from '../../services/regions.js';
// Classic PPI scope: rotating sweep, phosphor afterglow, bearing readout.
// Pure math is exported for unit tests; DOM lives inside createScope.
// Distance uses Haversine (geodesic), bearing is geographic — so a target at
// 5 km with range=10 km renders at ~50% of the radius (TZ §31).
// Targets are drawn with the SAME SVG silhouettes as the Leaflet map
// (shared getThreatVisual registry) — never generic dots.
const KM_LAT = 110.57;
// Sprite location is module-relative: works from /, /nebo-ua/, /dev/, ... .
const THREAT_SPRITE_URL = new URL('../brand/threat-icons.svg', import.meta.url).href;
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
export function project(lat, lon, center, rangeKm, size) {
  const kx = 111.32 * Math.cos(center[0] * Math.PI / 180);
  const dx = (lon - center[1]) * kx;
  const dy = (lat - center[0]) * KM_LAT;
  const distKm = haversineKm(center[0], center[1], lat, lon);
  const bearing = bearingDeg(center[0], center[1], lat, lon);
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
  let sweep = 0, prevSweep = 0, last = 0, raf = 0, active = false, W = 0, H = 0, staticKey = '';
  // Per-contact illumination time: a target stays dark until the beam
  // sweeps past its bearing, then fades — a real PPI-style detection.
  const litAt = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let pw = 0, ph = 0;
  // ── Shared SVG sprites (same silhouettes as the map) ─────────────────────
  // The sprite is fetched once, each symbol rasterized per kind with its own
  // threat color baked in (currentColor). Until loaded, dots are drawn.
  const spriteImgs = new Map();
  let spriteLoading = false;
  function ensureSprites() {
    if (spriteLoading || typeof fetch !== 'function') return;
    spriteLoading = true;
    fetch(THREAT_SPRITE_URL).then((r) => r.text()).then((txt) => {
      for (const kind of ['shahed', 'uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'aviation', 'other']) {
        try {
          const v = getThreatVisual(kind);
          const m = txt.match(new RegExp('<symbol id="' + kind + '" viewBox="([^"]+)">([\\s\\S]*?)</symbol>'));
          if (!m) continue;
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + m[1] + '" width="64" height="64" color="' + v.color + '">' + m[2] + '</svg>';
          const img = new Image();
          img.decoding = 'async';
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          spriteImgs.set(kind, img);
        } catch (e) {}
      }
    }).catch(() => {});
  }
  function spriteFor(kind) {
    const img = spriteImgs.get(kind);
    return img && img.complete && img.naturalWidth ? img : null;
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
    if (canvas.width === w * dpr && canvas.height === h * dpr) { pw = 0; ph = 0; W = w; H = h; return false; }
    if (w === pw && h === ph) {
      canvas.width = w * dpr; canvas.height = h * dpr;
      for (const c of [staticC, echoC]) { c.width = w * dpr; c.height = h * dpr; }
      W = w; H = h; pw = 0; ph = 0; staticKey = '';
      return true;
    }
    pw = w; ph = h;
    return false;
  }
  function rebuildStatic() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
    sctx.clearRect(0, 0, W, H);
    const bg = sctx.createRadialGradient(cx, cy, Math.min(10, Math.max(0, R - 1)), cx, cy, Math.max(1, R));
    bg.addColorStop(0, '#EAF7F0'); bg.addColorStop(1, '#D6EEE0');
    sctx.fillStyle = bg;
    sctx.beginPath(); sctx.arc(cx, cy, R, 0, 7); sctx.fill();
    try{sctx.save();
    sctx.beginPath(); sctx.arc(cx, cy, R, 0, 7); sctx.clip();
    for (const feat of (S.geo && S.geo.features) || []) {
      const polys = feat.geometry && feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : (feat.geometry && feat.geometry.coordinates) || [];
      for (const poly of polys) {
        for (const ring of poly) {
          sctx.beginPath();
          ring.forEach((pt, idx) => {
            const p = project(pt[1], pt[0], S.center, S.range, Math.min(W, H));
            const ox = (W - Math.min(W, H)) / 2 + p.x, oy = (H - Math.min(W, H)) / 2 + p.y;
            if (idx === 0) sctx.moveTo(ox, oy); else sctx.lineTo(ox, oy);
          });
          sctx.closePath();
          sctx.strokeStyle = 'rgba(22,163,106,0.24)';
          sctx.lineWidth = 0.8;
          sctx.stroke();
        }
      }
    }
    for (const rf of S.raionFills || []) {
      for (const poly of rf.polys || []) {
        sctx.beginPath();
        poly.forEach((pt, idx) => {
          const p = project(pt[1], pt[0], S.center, S.range, Math.min(W, H));
          const ox = (W - Math.min(W, H)) / 2 + p.x, oy = (H - Math.min(W, H)) / 2 + p.y;
          if (idx === 0) sctx.moveTo(ox, oy); else sctx.lineTo(ox, oy);
        });
        sctx.closePath();
        sctx.fillStyle = 'rgba(255,60,80,0.16)';
        sctx.fill();
        sctx.strokeStyle = 'rgba(255,140,155,0.85)';
        sctx.lineWidth = 1.1;
        sctx.stroke();
      }
    }
    sctx.restore();}catch(_g){}
    // Range rings follow the selected range exactly (1/3/5/10/25/100 presets).
    const ringSet = rangeRings(S.range);
    sctx.font = '10px system-ui';
    ringSet.forEach((km, i) => {
      const f = km / S.range;
      const outer = i === ringSet.length - 1;
      sctx.globalAlpha = outer ? 1 : 0.7;
      sctx.strokeStyle = outer ? 'rgba(15,122,78,0.92)' : 'rgba(22,163,106,0.5)';
      sctx.lineWidth = outer ? 1.6 : 1.1;
      sctx.beginPath(); sctx.arc(cx, cy, R * f, 0, 7); sctx.stroke();
      sctx.globalAlpha = outer ? 0.75 : 0.5;
      sctx.fillStyle = outer ? 'rgba(238,255,245,0.95)' : 'rgba(220,255,236,0.72)';
      if (outer) {
        // Outer range label sits just INSIDE the ring on the NE diagonal:
        // on the vertical axis it was clipped by the canvas edge and collided
        // with the Пн cardinal chip.
        const dg = Math.SQRT1_2;
        sctx.textAlign = 'right';
        sctx.fillText(km + ' км', cx + R * dg - 3, cy - R * dg + 12);
        sctx.textAlign = 'left';
      } else {
        sctx.fillText(String(km), cx + 4, cy - R * f - 3);
      }
    });
    // Diagonal guides (45°): reference CRT grid.
    sctx.globalAlpha = 0.3; sctx.lineWidth = 1; sctx.strokeStyle = 'rgba(224,255,240,0.7)';
    const DG = Math.SQRT1_2;
    for (const [dx, dy] of [[DG, DG], [DG, -DG], [-DG, DG], [-DG, -DG]]) {
      sctx.beginPath(); sctx.moveTo(cx, cy); sctx.lineTo(cx + R * dx, cy + R * dy); sctx.stroke();
    }
    sctx.globalAlpha = 0.35;
    for (let a = 0; a < 360; a += 10) {
      const major = a % 30 === 0;
      const r0 = R - (a % 90 === 0 ? 9 : major ? 6 : 3), rad = (a - 90) * Math.PI / 180;
      sctx.globalAlpha = 0.55; sctx.lineWidth = 1;
      sctx.strokeStyle = 'rgba(15,122,78,0.82)';
      sctx.beginPath();
      sctx.moveTo(cx + Math.cos(rad) * r0, cy + Math.sin(rad) * r0);
      sctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R);
      sctx.stroke();
    }
    sctx.globalAlpha = 0.5;
    sctx.strokeStyle = 'rgba(224,255,240,0.65)';
    sctx.beginPath(); sctx.moveTo(cx - R, cy); sctx.lineTo(cx + R, cy);
    sctx.moveTo(cx, cy - R); sctx.lineTo(cx, cy + R); sctx.stroke();
    sctx.globalAlpha = 0.9; sctx.fillStyle = 'rgba(240,255,247,0.95)'; sctx.font = 'bold 11px system-ui';
    sctx.beginPath(); sctx.arc(cx, cy, 3, 0, 7); sctx.fill();
    // Cardinal letters are drawn on the LIVE layer (after blips) so they are
    // never covered — see frameBody. Nothing here to avoid duplicates.
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
      g.addColorStop(0, 'rgba(22,163,106,0)');
      g.addColorStop(0.85, 'rgba(22,163,106,0.14)');
      g.addColorStop(1, 'rgba(230,255,243,0.5)');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = 'rgba(22,163,106,0.10)';
    }
    // Sector beam ≈20°: bright leading edge, gradual fade behind.
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.35, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(22,163,106,0.75)'; ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(15,122,78,0.82)'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  const seenErrors = new Set();
  function frame(t) {
    if (!active) return;
    // Schedule the next frame FIRST: a drawing exception must never kill
    // the loop permanently (e.g. degenerate canvas size on first open).
    raf = requestAnimationFrame(frame);
    try {
      frameBody(t);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (!seenErrors.has(msg)) { seenErrors.add(msg); console.error('[scope]', err); }
    }
  }
  function frameBody(t) {
    const dt = Math.min(100, t - (last || t));
    last = t;
    if (!reduced) sweep = (sweep + dt / 5000 * 360) % 360;
    resize();
    // Degenerate size (e.g. view just opened, layout pending): skip this
    // frame, the loop stays alive and draws as soon as layout settles.
    if (Math.min(W, H) < 40) return;
    const key = W + 'x' + H + ':' + S.range + ':' + (S.geoSig || '');
    if (key !== staticKey) { staticKey = key; rebuildStatic(); }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ectx.globalCompositeOperation = 'destination-out';
    ectx.fillStyle = 'rgba(20,38,61,0.14)';
    ectx.fillRect(0, 0, W, H);
    ectx.globalCompositeOperation = 'source-over';
    const size = Math.min(W, H);
    S.pts = [];
    const reds = [];
    const edge = [];
    ensureSprites();
    // Priority order + cap: missiles/ballistic first so the scope never turns
    // into an unreadable cloud of drone dots. In-radius eligible contacts are
    // selected BEFORE the cap, so an out-of-range or non-radar record can
    // never take a slot from a real, plottable target.
    const PR = { ballistic: 1, missile: 2, shahed: 3, kab: 4, aviation: 5, fpv: 6, uav: 7, recon: 8, explosion: 99, other: 9 };
    const eligible = [];
    for (const e of S.events) {
      if (e.lat == null || e.lon == null) continue;
      const p = project(e.lat, e.lon, S.center, S.range, size);
      // Out-of-range contacts are NOT plotted: the operator selected a radius
      // and the scope shows exactly that radius.
      if (!p.inside) continue;
      const v = getThreatVisual(e);
      // Event reports (e.g. media explosions) are never radar targets.
      if (v.radarEligible === false) continue;
      eligible.push({ e, p, v, prio: PR[v.kind] || 9 });
    }
    eligible.sort((a, b) => a.prio - b.prio);
    const ordered = eligible.slice(0, 25);
    // Beam arc covered since the previous frame. A contact is detected when
    // the beam CROSSES its bearing — checking only the current angle could
    // skip contacts forever on slow frames (a 3° window < one 5° step).
    const stepArc = reduced ? 0 : ((sweep - prevSweep) % 360 + 360) % 360;
    for (const { e, p, v } of ordered) {
      const ox = (W - size) / 2 + p.x, oy = (H - size) / 2 + p.y;
      // ── True radar detection ─────────────────────────────────────────────
      // A contact is invisible until the sweeping beam passes its bearing.
      // After the first pass it keeps a phosphor afterglow that dims but
      // stays readable until the next revolution re-illuminates it.
      const key = e.trackId || e.id || (p.bearing + ':' + p.distKm);
      const diff = ((sweep - p.bearing) % 360 + 360) % 360;
      const fromPrev = ((p.bearing - prevSweep) % 360 + 360) % 360;
      if (diff < 3 || fromPrev <= stepArc) litAt.set(key, t);
      const seen = litAt.get(key);
      const decayMs = 4800;
      const intensity = reduced
        ? 0.85
        : (seen == null ? 0 : Math.max(0.4, 1 - (t - seen) / decayMs));
      if (intensity <= 0.04) continue; // not yet detected
      const boost = sweepBoost(sweep, p.bearing);
      S.pts.push({ e, x: ox, y: oy, label: v.label, distKm: p.distKm, a: intensity });
      const glow = (0.55 + 0.45 * boost) * intensity;
      // Same SVG silhouette as the map, rotated by reliable heading only.
      const img = spriteFor(v.kind);
      const sPx = Math.max(20, Math.min(26, v.size));
      if (img) {
        ectx.save();
        ectx.globalAlpha = glow;
        ectx.translate(ox, oy);
        if (shouldShowHeading(e)) ectx.rotate(Number(e.heading) * Math.PI / 180);
        if (e._lvl === 'red') { ectx.shadowColor = v.color; ectx.shadowBlur = 10; }
        ectx.drawImage(img, -sPx / 2, -sPx / 2, sPx, sPx);
        ectx.restore();
      } else {
        const R0 = e._lvl === 'red' ? 4.5 : 3.2;
        ectx.globalAlpha = glow * 0.22;
        ectx.fillStyle = v.color;
        ectx.beginPath(); ectx.arc(ox, oy, R0 * 2.6, 0, 7); ectx.fill();
        ectx.globalAlpha = glow;
        ectx.beginPath(); ectx.arc(ox, oy, R0, 0, 7); ectx.fill();
        ectx.fillStyle = '#fff';
        ectx.globalAlpha = 0.5 + 0.5 * boost;
        ectx.beginPath(); ectx.arc(ox, oy, 1.1, 0, 7); ectx.fill();
        const hd = Number(e.heading);
        if (shouldShowHeading(e)) {
          const hr = (hd - 90) * Math.PI / 180;
          ectx.globalAlpha = 0.85; ectx.strokeStyle = v.color; ectx.lineWidth = 1.4;
          ectx.beginPath(); ectx.moveTo(ox, oy); ectx.lineTo(ox + Math.cos(hr) * 9, oy + Math.sin(hr) * 9); ectx.stroke();
        }
      }
      if (e._lvl === 'red') reds.push([ox, oy]);
    }
    prevSweep = sweep;
    ectx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(staticC, 0, 0, W, H);
    ctx.drawImage(echoC, 0, 0, W, H);
    for (const [x, y] of reds) {
      ctx.strokeStyle = 'rgba(255,60,80,0.9)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 7); ctx.stroke();
    }
    if (reds.length) {
      ctx.strokeStyle = 'rgba(255,60,80,' + (0.22 + 0.18 * Math.sin(t / 300)) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 3, 0, 7); ctx.stroke();
    }
    if (Number.isFinite(S.guardKm) && S.guardKm > 0 && S.guardKm <= S.range) {
      const gr = S.guardKm / S.range * (size / 2 - 8);
      ctx.strokeStyle = 'rgba(255,111,125,0.55)'; ctx.setLineDash([7, 7]);
      ctx.beginPath(); ctx.arc(W / 2, H / 2, gr, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = '#14263D';
    ctx.font = '10px system-ui';
    // No text labels on the scope: the legend already explains the iconography,
    // and the map/detail cards carry the names. Keeps the radar clean.
    ctx.globalAlpha = 1;
    // Cardinal marks drawn ON TOP with a dark chip so blips never hide them.
    const cxm = W / 2, cym = H / 2, Rm = Math.min(W, H) / 2 - 6;
    ctx.font = 'bold 11px system-ui';
    for (const [txt, x, y] of [['Пн', cxm, cym - Rm + 12], ['Пд', cxm, cym + Rm - 6], ['Сх', cxm + Rm - 12, cym + 4], ['Зх', cxm - Rm + 5, cym + 4]]) {
      const w = ctx.measureText(txt).width + 8;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x - w / 2, y - 10, w, 15);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#14263D';
      ctx.fillText(txt, x - w / 2 + 4, y + 1);
    }
    const cx0 = W / 2, cy0 = H / 2, RR = Math.min(W, H) / 2 - 6;
    // Distance of the nearest contact OUTSIDE the selected radius — shown as
    // a text hint only (no edge icons: the scope shows exactly the radius).
    let edgeNear = null;
    for (const { p, e } of edge) {
      const v = getThreatVisual(e);
      if (v.radarEligible === false) continue;
      if (!edgeNear || p.distKm < edgeNear.p.distKm) edgeNear = { p, e };
    }
    if (edgeNear) {
      const { p } = edgeNear;
      ctx.globalAlpha = 0.85; ctx.fillStyle = '#14263D'; ctx.font = '10px system-ui';
      const t = (p.distKm < 10 ? p.distKm.toFixed(1).replace('.', ',') : Math.round(p.distKm)) + ' км';
      ctx.textAlign = 'center';
      ctx.fillText('Найближча поза радіусом: ' + t, cx0, cy0 + RR - 10);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
    if (!S.pts.length) {
      // No caption on the scope: the panel below already states the count and
      // the contacts list. Keeps the radar clean and readable.
    }
    if (S.pin) {
      const p = project(S.pin.lat, S.pin.lon, S.center, S.range, size);
      if (p.inside) {
        const ox = (W - size) / 2 + p.x, oy = (H - size) / 2 + p.y;
        ctx.fillStyle = '#477FE0';
        ctx.save(); ctx.translate(ox, oy); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-5, -5, 10, 10); ctx.restore();
        ctx.fillStyle = '#14263D'; ctx.fillText(S.pin.label || '', ox + 9, oy - 8);
      }
    }
    // Own position: small cyan/white dot with a subtle pulse. Never a big glow.
    const pulse = reduced ? 0 : (0.5 + 0.5 * Math.sin(t / 600));
    ctx.fillStyle = '#477FE0';
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 3.5, 0, 7); ctx.stroke();
    ctx.strokeStyle = `rgba(71,127,224,${0.2 + 0.25 * pulse})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 8 + 3 * pulse, 0, 7); ctx.stroke();
    if (!reduced) drawSweep();
  }
  return {
    update(events, center, opts = {}) {
      S.events = (events || []).slice(0, 300);
      // Center is stored as [lat, lon] (project() reads center[0]/center[1]).
      // Callers may pass either an array or a {lat, lon} object — normalize,
      // otherwise every projection becomes NaN and nothing gets plotted.
      if (center) {
        const pair = Array.isArray(center) ? center : [Number(center.lat), Number(center.lon)];
        if (Number.isFinite(pair[0]) && Number.isFinite(pair[1])) S.center = pair;
      }
      if (opts.range) S.range = opts.range;
      S.guardKm = opts.guardKm ?? null;
      S.pin = opts.pin || null;
      S.geo = opts.geo || null;
      S.alertRegions = opts.alertRegions || [];
      S.geoSig = opts.geoSig || '';
      S.raionFills = opts.raionFills || [];
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
      let best = null, bd = 22;
      for (const p of S.pts) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) {
        const m = iconFor(best.e);
        const dd = best.distKm != null ? (best.distKm < 10 ? best.distKm.toFixed(1).replace('.', ',') : Math.round(best.distKm)) + ' км' : '';
        return m.label + (dd ? ' · ' + dd : '');
      }
      const k = S.range / (size / 2 - 8);
      const dx = (x - W / 2) * k, dy = -(y - H / 2) * k;
      const distKm = Math.hypot(dx, dy);
      if (distKm > S.range) return null;
      return fmtAzimuth((Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, distKm);
    },
    setActive(on) {
      if (on && !active) { active = true; last = 0; staticKey = ''; resize(); raf = requestAnimationFrame(frame); }
      if (!on && active) { active = false; cancelAnimationFrame(raf); }
    },
  };
}
