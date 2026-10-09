// РАДАР.LIVE embed mode — compact radar for framing (e.g. WAR LIVE UA).
// Same real data and geo math as the full page (services/* + radar/geo.js,
// radar/filters.js). Deliberately WITHOUT: audio, geolocation, push,
// Service Worker registration, ads, bottom nav.
import { fetchAll, shouldPoll, POLL_MS } from '../../services/data.js';
import { searchUkrainianPlaces } from '../../services/locations.js';
import { sourceCards, systemBadge } from '../../services/overview.js';
import {
  haversineKm, bearingDeg, projectRadar, formatDistanceKm, formatBearing,
  compassUk, accuracyLevel, radarPoint, rangeRings, clusterPoints,
} from '../../radar/geo.js';
import {
  KIND_LABEL, KIND_COLOR, KIND_SYMBOL, normalizeKind, isNew,
  radarEvents, statusBadge,
} from '../../radar/filters.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  snapshot: null, lastSuccess: null, loading: false, lastLoadStart: 0,
  center: [49, 31], centerName: 'Україна (приблизно)', range: 200,
  selectedId: null, firstSeenAt: new Map(), contours: null,
};
try {
  const p = JSON.parse(localStorage.getItem('radar-live-embed-v1') || '{}');
  if ([25, 50, 100, 200, 300, 500].includes(p.range)) state.range = p.range;
} catch { /* storage may be blocked in sandbox */ }
function savePrefs() { try { localStorage.setItem('radar-live-embed-v1', JSON.stringify({ range: state.range })); } catch { /* ignore */ } }

// ── Canvas (light, static cache + dynamic sweep/markers) ─────────────
const canvas = $('#emScope');
const ctx = canvas.getContext('2d');
const staticC = document.createElement('canvas');
const sctx = staticC.getContext('2d');
let staticKey = '', sweepDeg = 0, lastFrame = 0, rafId = 0, active = false;
const spriteImgs = new Map();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function ensureSprites() {
  if (ensureSprites.done) return;
  ensureSprites.done = true;
  fetch('../../assets/brand/threat-icons.svg').then(r => r.text()).then(txt => {
    for (const [sym, color] of [['shahed', KIND_COLOR.uav], ['uav', KIND_COLOR.uav], ['missile', KIND_COLOR.missile], ['ballistic', KIND_COLOR.ballistic], ['kab', KIND_COLOR.kab], ['aircraft', KIND_COLOR.aviation], ['other', KIND_COLOR.other]]) {
      const m = txt.match(new RegExp(`<symbol id="${sym}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`));
      if (!m) continue;
      const img = new Image();
      img.decoding = 'async';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m[1]}" width="64" height="64" color="${color}">${m[2]}</svg>`);
      spriteImgs.set(sym, img);
    }
  }).catch(() => {});
}
function symOf(kind, e) {
  if (kind === 'uav' && /shahed/i.test([e?.kind, e?.subtype].join(' '))) return 'shahed';
  return KIND_SYMBOL[kind] || 'other';
}
function rebuildStatic(W, H, dpr, css) {
  staticC.width = W; staticC.height = H;
  const c = sctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = W / 2 - 8 * dpr;
  c.beginPath(); c.arc(cx, cy, R, 0, 7);
  c.fillStyle = '#FFFFFF'; c.fill();
  c.strokeStyle = '#CBD5E1'; c.lineWidth = 1.5 * dpr; c.stroke();
  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip();
  if (state.contours?.length) {
    c.strokeStyle = 'rgba(100,116,139,0.22)';
    c.lineWidth = 1 * dpr;
    for (const poly of state.contours) {
      c.beginPath();
      poly.forEach(([lo, la], i) => {
        const p = projectRadar(la, lo, state.center, state.range, css);
        if (!p) return;
        if (i === 0) c.moveTo(p.x * dpr, p.y * dpr); else c.lineTo(p.x * dpr, p.y * dpr);
      });
      c.stroke();
    }
  }
  const rings = rangeRings(state.range);
  c.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
  rings.forEach((km, i) => {
    const r = R * ((i + 1) / rings.length);
    const outer = i === rings.length - 1;
    c.strokeStyle = outer ? '#EF3F36' : '#E2E8F0';
    c.lineWidth = (outer ? 1.6 : 1) * dpr;
    c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
    if (outer) {
      const dg = Math.SQRT1_2;
      c.fillStyle = '#EF3F36'; c.textAlign = 'right';
      c.fillText(km + ' км', cx + r * dg - 4 * dpr, cy - r * dg + 11 * dpr);
      c.textAlign = 'left';
    } else {
      c.fillStyle = '#64748B';
      c.fillText(km + ' км', cx + 4 * dpr, cy - r + 11 * dpr);
    }
  });
  c.strokeStyle = '#EDF1F5'; c.lineWidth = 1 * dpr;
  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * Math.PI / 180;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R); c.stroke();
  }
  c.font = `700 ${11 * dpr}px system-ui`;
  c.fillStyle = '#172638'; c.textAlign = 'center';
  c.fillText('Пн', cx, cy - R + 13 * dpr);
  c.fillText('Пд', cx, cy + R - 6 * dpr);
  c.fillText('Сх', cx + R - 11 * dpr, cy + 4 * dpr);
  c.fillText('Зх', cx - R + 11 * dpr, cy + 4 * dpr);
  c.fillStyle = '#4B80D9';
  c.beginPath(); c.arc(cx, cy, 3.5 * dpr, 0, 7); c.fill();
  c.font = `700 ${11 * dpr}px system-ui`;
  c.lineWidth = 3 * dpr; c.strokeStyle = '#FFFFFF';
  c.strokeText(state.centerName, cx, cy + 16 * dpr);
  c.fillStyle = '#172638';
  c.fillText(state.centerName, cx, cy + 16 * dpr);
  c.restore();
}
function points(css) {
  const out = [];
  for (const e of radarEvents(state.snapshot?.events || [], {})) {
    const p = radarPoint(e, state.center, state.range, css);
    if (p) out.push({ e, ...p, kind: normalizeKind(e) });
  }
  return out;
}
function frame(t) {
  if (!active) return;
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(100, t - (lastFrame || t));
  lastFrame = t;
  const animate = !reduced();
  if (animate) sweepDeg = (sweepDeg + dt / 6000 * 360) % 360;
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Square buffer only: identical X/Y scale keeps the ring circular.
  const css = Math.max(80, Math.round(Math.min(r.width, r.height || r.width)));
  canvas.width = css * dpr; canvas.height = css * dpr;
  const W = canvas.width, H = canvas.height;
  const key = [css, dpr, state.range, state.center.join(','), state.centerName, state.contours?.length || 0].join('|');
  if (key !== staticKey) { staticKey = key; rebuildStatic(W, H, dpr, css); }
  const cx = W / 2, cy = H / 2, R = W / 2 - 8 * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(staticC, 0, 0);
  if (animate) {
    const a = (sweepDeg - 90) * Math.PI / 180;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillStyle = 'rgba(239,63,54,0.10)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.3, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  const pts = points(css);
  const clusters = clusterPoints(pts.map(p => ({ x: p.x * dpr, y: p.y * dpr, data: p })), 26 * dpr);
  state._clusters = clusters;
  const sPx = (css < 420 ? 19 : 22) * dpr;
  const now = performance.now();
  for (const c of clusters) {
    if (c.members.length === 1) {
      const p = c.members[0].data;
      const born = state.firstSeenAt.get(p.id);
      let scale = 1;
      if (born && animate) scale = 0.6 + 0.4 * Math.min(1, (now - born) / 300);
      const img = spriteImgs.get(symOf(p.kind, p.e));
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, c.x - (sPx / 2) * scale, c.y - (sPx / 2) * scale, sPx * scale, sPx * scale);
      } else {
        ctx.fillStyle = KIND_COLOR[p.kind] || KIND_COLOR.other;
        ctx.beginPath(); ctx.arc(c.x, c.y, 4 * dpr * scale, 0, 7); ctx.fill();
      }
      if (p.id != null && String(p.id) === String(state.selectedId)) {
        ctx.strokeStyle = '#EF3F36'; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(c.x, c.y, sPx / 2 + 5 * dpr, 0, 7); ctx.stroke();
      }
    } else {
      ctx.beginPath(); ctx.arc(c.x, c.y, 10 * dpr, 0, 7);
      ctx.fillStyle = '#EF3F36'; ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 ${10 * dpr}px system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.min(99, c.members.length)), c.x, c.y + 3.5 * dpr);
    }
  }
  if (!pts.length) {
    ctx.fillStyle = '#64748B';
    ctx.font = `${11 * dpr}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('Немає повідомлень із точними координатами', cx, cy + 24 * dpr);
  }
  canvas.setAttribute('aria-label', `Радар: ${pts.length} цілей у радіусі ${state.range} км`);
}

// ── Data ──────────────────────────────────────────────────────────
async function loadContours() {
  if (state.contours !== null) return;
  try {
    const g = await (await fetch('../../assets/data/ukraine-oblasts.geojson')).json();
    const polys = [];
    for (const f of g.features || []) {
      const geom = f.geometry;
      if (!geom) continue;
      const list = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const poly of list) if (poly[0]?.length > 1) polys.push(poly[0]);
    }
    state.contours = polys;
  } catch { state.contours = []; }
}
async function load(force = false) {
  if (state.loading) return;
  if (!force && !shouldPoll({ hidden: document.hidden, loading: state.loading, lastStart: state.lastLoadStart || 0, nowMs: Date.now(), intervalMs: POLL_MS })) return;
  state.lastLoadStart = Date.now();
  state.loading = true;
  try {
    const snap = await fetchAll(new AbortController().signal);
    state.snapshot = snap;
    state.lastSuccess = snap.receivedAt ? new Date(snap.receivedAt) : (snap.pipelineCheckedAt ? new Date(snap.pipelineCheckedAt) : new Date());
    const now = performance.now();
    for (const e of snap.events || []) {
      const id = e.trackId ?? e.id;
      if (id != null && !state.firstSeenAt.has(id)) state.firstSeenAt.set(id, now);
    }
    renderAll();
  } catch {
    renderStatus();
  } finally {
    state.loading = false;
  }
}
function refreshIfStale(maxAgeMs = 5000) {
  const t = state.lastSuccess ? state.lastSuccess.getTime() : 0;
  if (Date.now() - t > maxAgeMs) load(true);
}

// ── Render ────────────────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '—';
}
function pipeStale() {
  const t = Date.parse(state.snapshot?.pipelineCheckedAt || '');
  return !(Number.isFinite(t)) || Date.now() - t > 5 * 60000;
}
function renderAll() {
  // count + top-3 nearest (compact; not a duplicate of any full feed)
  const evs = (state.snapshot?.events || []).map(e => {
    const p = radarPoint(e, state.center, state.range, 400);
    return p ? { e, kind: normalizeKind(e), d: p.distKm, b: p.bearing } : null;
  }).filter(Boolean).sort((a, b) => a.d - b.d);
  $('#emCount').textContent = evs.length
    ? `${evs.length} ${evs.length === 1 ? 'ціль' : evs.length < 5 ? 'цілі' : 'цілей'} у радіусі ${state.range} км`
    : (state.snapshot ? 'Цілей у радіусі немає' : 'Очікування даних…');
  $('#emContacts').innerHTML = evs.slice(0, 3).map(p => `
    <button class="rl-contact" data-id="${esc(p.e.trackId ?? p.e.id ?? '')}">
    <svg style="color:${KIND_COLOR[p.kind]}" aria-hidden="true"><use href="../../assets/brand/threat-icons.svg#${KIND_SYMBOL[p.kind] || 'other'}"/></svg>
    <span>${esc(KIND_LABEL[p.kind])}</span>
    <time>${esc(formatDistanceKm(p.d))} · ${esc(formatBearing(p.b))}</time></button>`).join('');
  $('#emContacts').querySelectorAll('.rl-contact').forEach(b => b.onclick = () => openDetail(b.dataset.id));
  renderStatus();
}
function renderStatus() {
  const snap = state.snapshot;
  const cards = sourceCards(snap?.health);
  const age = state.lastSuccess ? Date.now() - state.lastSuccess.getTime() : null;
  const badge = systemBadge(cards, age);
  const el = $('#emLive');
  el.textContent = badge.level === 'ok' ? 'LIVE' : badge.text.toUpperCase();
  el.title = badge.text;
  el.classList.toggle('stale', badge.level !== 'ok');
  $('#emUpdated').textContent = state.lastSuccess
    ? 'Оновлено ' + state.lastSuccess.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const dot = (s) => s === 'ONLINE' ? 'ok' : 'bad';
  $('#emSources').innerHTML = cards.map(c => {
    const h = snap?.health?.[c.key];
    const checked = h?.checkedAt || h?.updatedAt;
    return `<span><span class="${dot(c.state)}">●</span> ${esc(c.name)}${checked ? ' ' + esc(fmtTime(checked)) : ''}</span>`;
  }).join('');
  if (!snap) {
    $('#emCount').textContent = 'Дані недоступні — перевірте з’єднання';
  }
}
function geoDesc(e) {
  return e.settlement || e.district || e.region || e.derivedRegion || 'місце невідоме';
}
function openDetail(id) {
  const e = (state.snapshot?.events || []).find(x => String(x.trackId ?? x.id) === String(id));
  if (!e) return;
  state.selectedId = e.trackId ?? e.id;
  const kind = normalizeKind(e);
  const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
  const badge = statusBadge(e, { pipeStale: pipeStale() });
  $('#emDetailBody').innerHTML = `
    <p style="margin:0 0 4px"><b>${esc(KIND_LABEL[kind])}</b> · ${esc(fmtTime(e.eventTime || e.timestamp))} · ${esc(e.source || '')}</p>
    <p class="rl-muted" style="margin:0 0 4px">${esc(geoDesc(e))}${hasPos ? ` · ${esc(formatDistanceKm(haversineKm(state.center[0], state.center[1], +e.lat, +e.lon)))}` : ''}</p>
    <p style="margin:0"><span class="${badge.live ? 'st live' : 'st'} rl-event" style="cursor:default">${esc(badge.text)}</span>
    <a class="rl-embed-full" href="../" target="_blank" rel="noopener" style="margin-left:8px">Детальніше ↗</a></p>`;
  $('#emDetail').hidden = false;
}
function openClusterList(members) {
  const rows = members.map(e => {
    const p = radarPoint(e, state.center, state.range, 400);
    return { e, kind: normalizeKind(e), d: p ? p.distKm : NaN };
  }).sort((a, b) => (a.d || Infinity) - (b.d || Infinity));
  $('#emDetailBody').innerHTML = `<p style="margin:0 0 6px"><b>Поруч ${rows.length} повідомлень</b> — координати не зміщено:</p>` +
    rows.map(({ e, kind, d }) => `
    <button class="rl-contact" data-id="${esc(e.trackId ?? e.id ?? '')}">
    <svg style="color:${KIND_COLOR[kind]}" aria-hidden="true"><use href="../../assets/brand/threat-icons.svg#${KIND_SYMBOL[kind] || 'other'}"/></svg>
    <span>${esc(KIND_LABEL[kind])}</span>
    <time>${Number.isFinite(d) ? esc(formatDistanceKm(d)) : '—'}</time></button>`).join('');
  $('#emDetail').hidden = false;
  $('#emDetailBody').querySelectorAll('.rl-contact').forEach(b => b.onclick = () => openDetail(b.dataset.id));
}

// ── Controls ──────────────────────────────────────────────────────
function setCenter(place) {
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  state.center = [place.lat, place.lon];
  state.centerName = place.settlement || place.oblast || 'Місце';
  renderCountOnly();
}
function renderCountOnly() {
  const evs = (state.snapshot?.events || []).filter(e => radarPoint(e, state.center, state.range, 400));
  $('#emCount').textContent = state.snapshot
    ? (evs.length ? `${evs.length} у радіусі ${state.range} км` : 'Цілей у радіусі немає')
    : 'Очікування даних…';
}
function setupControls() {
  document.querySelectorAll('#emRange button').forEach(b => {
    if (Number(b.dataset.range) === state.range) b.setAttribute('aria-pressed', 'true');
    b.onclick = () => {
      state.range = Number(b.dataset.range) || 200;
      savePrefs();
      document.querySelectorAll('#emRange button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderAll();
    };
  });
  const input = $('#emCity'), box = $('#emCityResults');
  let deb = 0, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(deb);
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) { box.hidden = true; return; }
    deb = setTimeout(async () => {
      let rows = [];
      try { rows = await searchUkrainianPlaces(q); } catch { rows = []; }
      if (my !== seq) return;
      if (!rows.length) {
        box.innerHTML = '<p class="rl-muted" style="padding:8px 11px">Нічого не знайдено</p>';
        box.hidden = false;
        return;
      }
      box.innerHTML = rows.slice(0, 6).map((r, i) => `<button data-i="${i}"><b>${esc(r.settlement || r.oblast)}</b><small>${esc(r.label)}</small></button>`).join('');
      box.hidden = false;
      box.querySelectorAll('button').forEach(btn => btn.onclick = () => {
        const r = rows[+btn.dataset.i];
        box.hidden = true;
        input.value = '';
        input.placeholder = 'Центр: ' + (r.settlement || r.oblast || '');
        setCenter(r);
      });
    }, 450);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.rl-embed-search')) box.hidden = true; });
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const x = (ev.clientX - r.left) * dpr, y = (ev.clientY - r.top) * dpr;
    let best = null, bd = 24 * dpr;
    for (const c of state._clusters || []) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return;
    if (best.members.length === 1) openDetail(best.members[0].data.trackId ?? best.members[0].data.id);
    else openClusterList(best.members.map(m => m.data));
  });
  $('#emDetailClose').onclick = () => { $('#emDetail').hidden = true; state.selectedId = null; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#emDetail').hidden) $('#emDetailClose').click(); });
}

// ── Boot (no geolocation, no audio, no push, no SW here) ──────────
setupControls();
loadContours();
ensureSprites();
active = true;
rafId = requestAnimationFrame(frame);
(async () => {
  try {
    const rows = await searchUkrainianPlaces('Київ');
    const r = rows.find(x => (x.settlement || '').toLowerCase() === 'київ') || rows[0];
    if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
      state.center = [r.lat, r.lon];
      state.centerName = 'Київ';
    }
  } catch { /* keep approximate fallback */ }
})();
load(true);
setInterval(load, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', () => refreshIfStale());
window.addEventListener('online', () => refreshIfStale(0));
