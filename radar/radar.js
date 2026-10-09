// РАДАР.LIVE — light radar app (browser module, no Leaflet, no dark theme).
// Data: services/data.js fetchAll (NEPTUN/MAPA primary, UkraineAlarm auxiliary).
// Geometry: ./geo.js. Filters: ./filters.js. City search: services/locations.js.
import { fetchAll, shouldPoll, POLL_MS } from '../services/data.js';
import { searchUkrainianPlaces, loadSelectedPlace, saveSelectedPlace } from '../services/locations.js';
import { sourceCards, systemBadge } from '../services/overview.js';
import { classifyThreat } from '../services/threatClassify.js';
import {
  haversineKm, bearingDeg, projectRadar, formatDistanceKm, formatBearing,
  compassUk, accuracyLevel, radarPoint, rangeRings,
} from './geo.js';
import {
  KIND_FILTERS, normalizeKind, isNew, isActive, radarEvents, countByKind,
  applyFeedFilters,
} from './filters.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RANGES = [25, 50, 100, 200, 300, 500];
const KIND_LABEL = { uav: 'БпЛА', missile: 'Крилата ракета', ballistic: 'Балістика', kab: 'КАБ', aviation: 'Авіація', other: 'Інше' };
const KIND_COLOR = { uav: '#D99A00', missile: '#EF3F36', ballistic: '#D9342C', kab: '#ED8B36', aviation: '#4B80D9', other: '#657184' };
const KIND_SYMBOL = { uav: 'uav', missile: 'missile', ballistic: 'ballistic', kab: 'kab', aviation: 'aircraft', other: 'other' };
const POPULAR = ['Київ', 'Харків', 'Одеса', 'Дніпро', 'Львів'];

const state = {
  snapshot: null,
  lastSuccess: null,
  loading: false,
  lastLoadStart: 0,
  center: [49, 31],
  centerName: 'Україна',
  range: 200,
  kinds: new Set(KIND_FILTERS),
  tab: 'all',
  onlyNew: false,
  onlyActive: false,
  onlyCoords: false,
  showContours: true,
  selectedId: null,
  seenIds: new Set(),
  firstSeenAt: new Map(),
  audio: loadAudio(),
  contours: null,
};

function loadAudio() {
  try { return { enabled: false, volume: 0.65, kinds: { uav: true, missile: true, kab: true, aviation: true }, ...JSON.parse(localStorage.getItem('radar-live-audio-v1') || '{}') }; }
  catch { return { enabled: false, volume: 0.65, kinds: { uav: true, missile: true, kab: true, aviation: true } }; }
}
function saveAudio() { try { localStorage.setItem('radar-live-audio-v1', JSON.stringify(state.audio)); } catch { /* ignore */ } }
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('radar-live-prefs-v1') || '{}');
    if (RANGES.includes(p.range)) state.range = p.range;
    if (Array.isArray(p.kinds)) state.kinds = new Set(p.kinds.filter(k => KIND_FILTERS.includes(k)));
    if (state.kinds.size === 0) state.kinds = new Set(KIND_FILTERS);
    state.showContours = p.showContours !== false;
  } catch { /* ignore */ }
  try {
    const place = loadSelectedPlace();
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
      state.center = [place.lat, place.lon];
      state.centerName = place.settlement || place.oblast || 'Моє місце';
    }
  } catch { /* ignore */ }
}
function savePrefs() {
  try {
    localStorage.setItem('radar-live-prefs-v1', JSON.stringify({
      range: state.range, kinds: [...state.kinds], showContours: state.showContours,
    }));
  } catch { /* ignore */ }
}

// ── Canvas radar (light) ──────────────────────────────────────────────
const canvas = $('#rlScope');
const ctx = canvas.getContext('2d');
const spriteImgs = new Map();
let sweepDeg = 0, lastFrame = 0, rafId = 0, scopeActive = false;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureSprites() {
  if (ensureSprites.done) return;
  ensureSprites.done = true;
  fetch('../assets/brand/threat-icons.svg').then(r => r.text()).then(txt => {
    for (const [sym, color] of [
      ['shahed', KIND_COLOR.uav], ['uav', KIND_COLOR.uav],
      ['missile', KIND_COLOR.missile], ['ballistic', KIND_COLOR.ballistic],
      ['kab', KIND_COLOR.kab], ['aircraft', KIND_COLOR.aviation], ['other', KIND_COLOR.other],
    ]) {
      const m = txt.match(new RegExp(`<symbol id="${sym}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`));
      if (!m) continue;
      const img = new Image();
      img.decoding = 'async';
      // Bake the kind color via currentColor so glyphs read on the light disc.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m[1]}" width="64" height="64" color="${color}">${m[2]}</svg>`);
      spriteImgs.set(sym, img);
    }
  }).catch(() => {});
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(80, Math.round(r.width));
  canvas.width = w * dpr;
  canvas.height = w * dpr;
  return { w, dpr };
}

function currentPoints(size) {
  const events = visibleRadarEvents();
  const pts = [];
  for (const e of events) {
    const p = radarPoint(e, state.center, state.range, size);
    if (p) pts.push({ e, ...p, kind: normalizeKind(e) });
  }
  return pts;
}

function drawFrame(t) {
  if (!scopeActive) return;
  rafId = requestAnimationFrame(drawFrame);
  const dt = Math.min(100, t - (lastFrame || t));
  lastFrame = t;
  if (!reducedMotion()) sweepDeg = (sweepDeg + dt / 6000 * 360) % 360;
  const { w: cssW, dpr } = resizeCanvas();
  const W = canvas.width, H = canvas.height, size = W;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = W / 2 - 10 * dpr;

  // disc
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7);
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.strokeStyle = '#C9D2DB'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();

  // faint Ukraine contours (real boundaries, optional)
  if (state.showContours && state.contours) {
    ctx.strokeStyle = 'rgba(101,113,132,0.28)';
    ctx.lineWidth = 1 * dpr;
    for (const poly of state.contours) {
      ctx.beginPath();
      poly.forEach(([lo, la], i) => {
        const p = projectRadar(la, lo, state.center, state.range, size / dpr);
        if (!p) return;
        const x = p.x * dpr, y = p.y * dpr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  // rings + labels (outer label sits on the NE diagonal: the vertical axis
  // is taken by the Пн cardinal chip)
  const rings = rangeRings(state.range);
  ctx.font = `${11 * dpr}px system-ui`;
  ctx.fillStyle = '#657184';
  ctx.textAlign = 'left';
  rings.forEach((km, i) => {
    const r = R * ((i + 1) / rings.length);
    const outer = i === rings.length - 1;
    ctx.strokeStyle = outer ? '#EF3F36' : '#E2E7ED';
    ctx.lineWidth = (outer ? 1.8 : 1.1) * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    if (outer) {
      const dg = Math.SQRT1_2;
      ctx.fillStyle = '#EF3F36';
      ctx.textAlign = 'right';
      ctx.fillText(km + ' км', cx + r * dg - 4 * dpr, cy - r * dg + 12 * dpr);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = '#657184';
      ctx.fillText(km + ' км', cx + 5 * dpr, cy - r + 13 * dpr);
    }
  });

  // thin radials every 30° + cross
  ctx.strokeStyle = '#EDF1F5';
  ctx.lineWidth = 1 * dpr;
  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(rad) * R, cy + Math.sin(rad) * R); ctx.stroke();
  }
  ctx.strokeStyle = '#D7DEE6';
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

  // sweep (decorative only — never gates data)
  if (!reducedMotion()) {
    const a = (sweepDeg - 90) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillStyle = 'rgba(239,63,54,0.13)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.3, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(239,63,54,0.65)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.restore();
  }

  // markers
  const pts = currentPoints(size / dpr);
  state._pts = pts.map(p => ({ ...p, x: p.x * dpr, y: p.y * dpr }));
  const now = performance.now();
  for (const p of state._pts) {
    const color = KIND_COLOR[p.kind] || KIND_COLOR.other;
    const sPx = 22 * dpr;
    const born = state.firstSeenAt.get(p.id);
    let scale = 1;
    if (born && !reducedMotion()) {
      const k = Math.min(1, (now - born) / 300);
      scale = 0.6 + 0.4 * k;
    }
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.beginPath(); ctx.arc(0, 0, (sPx / 2 + 2 * dpr) * scale, 0, 7);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.6 * dpr; ctx.stroke();
    const sym = p.kind === 'uav' && /shahed/i.test([p.e.kind, p.e.subtype].join(' ')) ? 'shahed'
      : (KIND_SYMBOL[p.kind] || 'other');
    const img = spriteImgs.get(sym);
    if (img && img.complete && img.naturalWidth) {
      ctx.globalAlpha = 1;
      ctx.drawImage(img, (-sPx / 2) * scale, (-sPx / 2) * scale, sPx * scale, sPx * scale);
      // tint ring already colored; glyph drawn as-is
    } else {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(0, 0, 4 * dpr * scale, 0, 7); ctx.fill();
    }
    ctx.restore();
    if (p.id != null && String(p.id) === String(state.selectedId)) {
      ctx.strokeStyle = '#EF3F36'; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(p.x, p.y, sPx / 2 + 7 * dpr, 0, 7); ctx.stroke();
    }
  }

  // cardinals + center
  ctx.font = `700 ${12 * dpr}px system-ui`;
  ctx.fillStyle = '#172638';
  ctx.textAlign = 'center';
  ctx.fillText('Пн', cx, cy - R + 15 * dpr);
  ctx.fillText('Пд', cx, cy + R - 7 * dpr);
  ctx.fillText('Сх', cx + R - 13 * dpr, cy + 4 * dpr);
  ctx.fillText('Зх', cx - R + 13 * dpr, cy + 4 * dpr);
  ctx.fillStyle = '#4B80D9';
  ctx.beginPath(); ctx.arc(cx, cy, 4 * dpr, 0, 7); ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(cx, cy, 1.6 * dpr, 0, 7); ctx.fill();

  // empty state (honest: no plottable coords, not "no threats")
  if (!pts.length) {
    ctx.fillStyle = '#657184';
    ctx.font = `${12 * dpr}px system-ui`;
    ctx.fillText('Немає повідомлень із достатньо точними координатами', cx, cy + 26 * dpr);
    ctx.fillText('для відображення на радарі', cx, cy + 42 * dpr);
  }
  canvas.setAttribute('aria-label', `Радар: ${pts.length} цілей у радіусі ${state.range} км від ${state.centerName}`);
}

function startScope() {
  if (scopeActive) return;
  scopeActive = true;
  lastFrame = 0;
  ensureSprites();
  rafId = requestAnimationFrame(drawFrame);
}
function stopScope() { scopeActive = false; cancelAnimationFrame(rafId); }

// ── Data ──────────────────────────────────────────────────────────
function visibleRadarEvents() {
  const events = state.snapshot?.events || [];
  return radarEvents(events, {
    kinds: [...state.kinds],
    onlyNew: state.onlyNew,
    onlyActive: state.onlyActive,
  }).filter(e => {
    const p = radarPoint(e, state.center, state.range, 400);
    return !!p;
  });
}

function feedEvents() {
  const events = state.snapshot?.events || [];
  return applyFeedFilters(events, {
    kinds: [...state.kinds],
    tab: state.tab,
    onlyNew: state.onlyNew,
    onlyActive: state.onlyActive,
    onlyWithCoords: state.onlyCoords,
  });
}

async function loadContours() {
  if (state.contours !== null) return;
  try {
    const r = await fetch('../assets/data/ukraine-oblasts.geojson');
    const g = await r.json();
    const polys = [];
    for (const f of g.features || []) {
      const geom = f.geometry;
      if (!geom) continue;
      const list = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const poly of list) {
        if (poly[0] && poly[0].length > 1) polys.push(poly[0].filter(p => Array.isArray(p)));
      }
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
    trackSeen(snap.events);
    renderAll();
  } catch (err) {
    try { console.error('[radar-live] load failed', err); } catch { /* ignore */ }
    renderStatus(null, true);
  } finally {
    state.loading = false;
  }
}
function refreshIfStale(maxAgeMs = 5000) {
  const t = state.lastSuccess ? state.lastSuccess.getTime() : 0;
  if (Date.now() - t > maxAgeMs) load(true);
}

function trackSeen(events) {
  const now = performance.now();
  for (const e of events || []) {
    const id = e.trackId ?? e.id;
    if (id == null) continue;
    if (!state.seenIds.has(id)) {
      state.seenIds.add(id);
      state.firstSeenAt.set(id, now);
    }
  }
}

// ── Audio (soft blips only — never siren-like) ─────────────────────
let audioCtx = null;
function blip(freq = 660) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    const v = Math.max(0.001, state.audio.volume);
    g.gain.exponentialRampToValueAtTime(0.25 * v, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.stop(audioCtx.currentTime + 0.4);
  } catch { /* autoplay blocked until gesture */ }
}
function maybeNotify(events) {
  if (!state.audio.enabled) return;
  const fresh = (events || []).filter(e => {
    const id = e.trackId ?? e.id;
    return id != null && !state._notified?.has(id);
  });
  state._notified ||= new Set();
  const FREQ = { uav: 620, missile: 440, ballistic: 380, kab: 520, aviation: 700, other: 600 };
  for (const e of fresh.slice(0, 3)) {
    const k = normalizeKind(e);
    if (state.audio.kinds[k] === false) continue;
    state._notified.add(e.trackId ?? e.id);
    blip(FREQ[k] || 600);
  }
}

// ── Render ────────────────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}
function geoDesc(e) {
  const place = e.settlement || e.district || e.region || e.derivedRegion;
  if (place) return place;
  return 'місце невідоме';
}
function kindIcon(kind, color) {
  const sym = KIND_SYMBOL[kind] || 'other';
  return `<svg style="color:${color}" aria-hidden="true"><use href="../assets/brand/threat-icons.svg#${sym}"/></svg>`;
}

function renderFeed() {
  const list = feedEvents();
  $('#rlFeedCount').textContent = list.filter(e => !e.stale).length;
  $$('#rlTabs .rl-tab').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    const base = b.dataset.tab === 'all' ? list.length : null;
    b.querySelector('.n')?.remove();
    if (b.dataset.tab !== 'all') {
      const n = applyFeedFilters(state.snapshot?.events || [], { kinds: [...state.kinds], tab: b.dataset.tab, onlyNew: state.onlyNew, onlyActive: state.onlyActive, onlyWithCoords: state.onlyCoords }).length;
      const s = document.createElement('span');
      s.className = 'n'; s.textContent = n;
      b.appendChild(s);
    }
  });
  const box = $('#rlFeed');
  if (!list.length) {
    box.innerHTML = `<div class="rl-empty">${state.snapshot ? 'За цими фільтрами повідомлень немає.' : 'Очікування даних…'}</div>`;
    return;
  }
  box.innerHTML = list.slice(0, 40).map(e => {
    const kind = normalizeKind(e);
    const color = KIND_COLOR[kind];
    const d = (e.lat != null && e.lon != null && !e.areaOnly)
      ? `${formatDistanceKm(haversineKm(state.center[0], state.center[1], +e.lat, +e.lon))} · ${e.source || ''}`
      : `${esc(e.source || '')}`;
    const st = e.stale || e.status === 'ended' ? '<span class="st">Завершено</span>'
      : isNew(e) ? '<span class="st live">Нова</span>' : '<span class="st live">Активна</span>';
    return `<button class="rl-event" data-id="${esc(e.trackId ?? e.id ?? '')}" aria-current="${String((e.trackId ?? e.id) === state.selectedId)}">
      <time>${esc(fmtTime(e.eventTime || e.timestamp))}</time>${kindIcon(kind, color)}
      <span><b>${esc(KIND_LABEL[kind])}</b><small>${esc(geoDesc(e))} · ${esc(d)}</small></span>${st}</button>`;
  }).join('');
  box.querySelectorAll('.rl-event').forEach(b => b.onclick = () => openDetail(b.dataset.id));
}

function renderContacts() {
  // Deterministic count straight from data + current range (never from the
  // last animation frame, which would lag one interaction behind).
  const evs = visibleRadarEvents();
  const rows = evs.map(e => {
    const p = radarPoint(e, state.center, state.range, 400);
    return p ? { e, kind: normalizeKind(e), d: p.distKm, b: p.bearing } : null;
  }).filter(Boolean).sort((a, b) => a.d - b.d);
  const total = rows.length;
  $('#rlRadarCount').textContent = total
    ? `${total} ${total === 1 ? 'ціль' : total < 5 ? 'цілі' : 'цілей'} у радіусі ${state.range} км`
    : 'Цілей у радіусі немає';
  const shown = rows.slice(0, 5);
  const box = $('#rlContacts');
  box.innerHTML = shown.map(p => `
    <button class="rl-contact" data-id="${esc(p.e.trackId ?? p.e.id ?? '')}">${kindIcon(p.kind, KIND_COLOR[p.kind])}
    <span>${esc(KIND_LABEL[p.kind])}</span>
    <time>${esc(formatDistanceKm(p.d))} · ${esc(formatBearing(p.b))}</time></button>`).join('');
  box.querySelectorAll('.rl-contact').forEach(b => b.onclick = () => openDetail(b.dataset.id));
}

function renderSources() {
  const snap = state.snapshot;
  const cards = sourceCards(snap?.health);
  const dot = { ONLINE: 'online', DEGRADED: 'delayed', OFFLINE: 'offline', RECOVERING: 'recovering', STALE: 'delayed', IDLE: 'offline' };
  $('#rlSources').innerHTML = cards.map(c => `
    <div class="rl-source"><span class="rl-dot ${dot[c.state] || 'offline'}"></span>
    <span><b>${esc(c.name)}</b>
    <small>${esc(c.label)}${c.updatedAt ? ' · перевірено ' + esc(fmtTime(c.updatedAt)) : ''}</small></span></div>`).join('')
    + (snap ? `<p class="rl-muted">Зміна даних: ${snap.dataUpdatedAt ? esc(fmtTime(snap.dataUpdatedAt)) : '—'} · Публікація: ${snap.publishedAt ? esc(fmtTime(snap.publishedAt)) : '—'}</p>` : '');
  // header badge: honest liveness (primaries only)
  const age = state.lastSuccess ? Date.now() - state.lastSuccess.getTime() : null;
  const badge = systemBadge(cards, age);
  const el = $('#rlLive');
  el.textContent = badge.level === 'ok' ? 'LIVE' : badge.text.toUpperCase();
  el.classList.toggle('stale', badge.level !== 'ok');
}

function renderStatus(fetchFailed = false) {
  renderSources();
  if (fetchFailed && !state.snapshot) {
    $('#rlFeed').innerHTML = '<div class="rl-empty">Не вдалося отримати дані. Перевірте з’єднання — спробуємо знову автоматично.</div>';
    $('#rlRadarCount').textContent = 'Дані недоступні';
  }
}

function renderKindFilters() {
  const counts = countByKind((state.snapshot?.events || []).filter(e => !e.stale));
  $('#rlKindFilters').innerHTML = KIND_FILTERS.map(k => `
    <label class="rl-toggle"><input type="checkbox" data-kind="${k}" ${state.kinds.has(k) ? 'checked' : ''}>
    <span style="color:${KIND_COLOR[k]}">●</span> ${esc(KIND_LABEL[k])}<span class="n">${counts[k] || 0}</span></label>`).join('');
  $$('#rlKindFilters input').forEach(i => i.onchange = () => {
    if (i.checked) state.kinds.add(i.dataset.kind); else state.kinds.delete(i.dataset.kind);
    if (!state.kinds.size) state.kinds = new Set(KIND_FILTERS);
    savePrefs(); syncDialogKinds(); renderFeed(); renderContacts();
  });
}

function accuracyText(e) {
  const lvl = accuracyLevel(e);
  if (lvl === 1) return 'Точні координати (за даними джерела)';
  if (lvl === 2) {
    const unc = Number(e.uncertaintyKm);
    return `Приблизна зона${Number.isFinite(unc) && unc > 0 ? ` ±${unc} км` : ''} (за даними джерела)`;
  }
  if (lvl === 3) return 'Область без координат — лише стрічка';
  return 'Місце невідоме — лише стрічка';
}

function openDetail(id) {
  const e = (state.snapshot?.events || []).find(x => String(x.trackId ?? x.id) === String(id));
  if (!e) return;
  state.selectedId = e.trackId ?? e.id;
  const kind = normalizeKind(e);
  const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
  const d = hasPos ? haversineKm(state.center[0], state.center[1], +e.lat, +e.lon) : NaN;
  const b = hasPos ? bearingDeg(state.center[0], state.center[1], +e.lat, +e.lon) : NaN;
  $('#rlDetailBody').innerHTML = `
    <span class="rl-muted">ДЕТАЛЬНА ІНФОРМАЦІЯ ПРО ЗАГРОЗУ</span>
    <h2 style="margin:6px 0">${kindIcon(kind, KIND_COLOR[kind])} ${esc(KIND_LABEL[kind])}</h2>
    <p class="rl-muted">${esc(fmtTime(e.eventTime || e.timestamp))} · ${esc(e.source || '')}</p>
    <dl class="rl-kv">
      <dt>Джерело</dt><dd>${esc(e.source || '—')}</dd>
      <dt>Можливе місце</dt><dd>${esc(geoDesc(e))}</dd>
      <dt>Відстань від центру</dt><dd>${hasPos ? esc(formatDistanceKm(d)) : 'невідома (немає координат)'}</dd>
      <dt>Напрямок</dt><dd>${hasPos ? `на ${esc(compassUk(b))} (≈ ${Math.round(b)}°)` : 'недостовірний'}</dd>
      <dt>Рівень точності</dt><dd>${esc(accuracyText(e))}</dd>
      <dt>Статус</dt><dd>${e.stale || e.status === 'ended' ? 'Завершена' : 'Активна загроза'}</dd>
    </dl>
    <div class="rl-warn">Координати є приблизними. Використовуйте інформацію з офіційних джерел для прийняття рішень.</div>
    <button class="rl-btn" id="rlShowOnRadar" style="width:100%">Показати на радарі</button>`;
  $('#detailCard').hidden = false;
  renderFeed();
  $('#rlShowOnRadar').onclick = () => {
    $('#radarCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderAll() {
  renderKindFilters();
  renderFeed();
  renderContacts();
  renderSources();
  maybeNotify(state.snapshot?.events);
  tickClock();
}

// ── Clock ─────────────────────────────────────────────────────────
function tickClock() {
  try {
    const now = new Date();
    $('#rlClock').textContent = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const t = state.lastSuccess;
    $('#rlUpdated').textContent = t
      ? 'Оновлено ' + t.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : 'Оновлено —';
  } catch { /* ignore */ }
}

// ── Controls wiring ───────────────────────────────────────────────
function syncRangeButtons() {
  $$('#rlRange button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === state.range)));
}
function syncDialogKinds() {
  const map = { uav: '#rlUavDlg', missile: '#rlMissileDlg', ballistic: '#rlBallisticDlg', kab: '#rlKabDlg', aviation: '#rlAviationDlg' };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel);
    if (el) el.checked = state.kinds.has(k);
  }
}

function setupControls() {
  // range
  syncRangeButtons();
  $('#rlRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    state.range = Number(b.dataset.range) || 200;
    savePrefs(); syncRangeButtons(); renderContacts();
  });
  // tabs
  $('#rlTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.rl-tab');
    if (!b) return;
    state.tab = b.dataset.tab;
    renderFeed();
  });
  // extra filters
  $('#rlOnlyNew').onchange = (e) => { state.onlyNew = e.target.checked; renderFeed(); renderContacts(); };
  $('#rlOnlyActive').onchange = (e) => { state.onlyActive = e.target.checked; renderFeed(); renderContacts(); };
  $('#rlOnlyCoords').onchange = (e) => { state.onlyCoords = e.target.checked; renderFeed(); renderContacts(); };
  $('#rlContours').checked = state.showContours;
  $('#rlContours').onchange = (e) => { state.showContours = e.target.checked; savePrefs(); };
  // popular cities (resolved via Nominatim — never hardcoded coords)
  const pop = $('#rlPopular');
  pop.innerHTML = POPULAR.map(n => `<button class="rl-chip" data-city="${esc(n)}">${esc(n)}</button>`).join('');
  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-city]');
    if (!b) return;
    await pickCity(b.dataset.city);
  });
  // search
  const input = $('#rlCity'), box = $('#rlCityResults');
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
        box.innerHTML = `<p class="rl-muted" style="padding:10px 12px">Нічого не знайдено</p>`;
        box.hidden = false;
        return;
      }
      box.innerHTML = rows.slice(0, 6).map((r, i) => `<button data-i="${i}"><b>${esc(r.settlement || r.oblast)}</b><small>${esc(r.label)}</small></button>`).join('');
      box.hidden = false;
      box.querySelectorAll('button').forEach(btn => btn.onclick = () => {
        const r = rows[+btn.dataset.i];
        box.hidden = true;
        input.value = r.settlement || r.oblast || '';
        setCenter(r);
      });
    }, 450);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.rl-search-wrap')) box.hidden = true;
  });
  // geolocation (explicit consent via button only)
  $('#rlGeo').onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      setCenter({
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        settlement: 'Моє положення', oblast: null, raion: null,
      }, true);
    }, () => { /* denied: keep current center */ }, { timeout: 8000 });
  };
  // audio
  const a = state.audio;
  $('#rlSound').checked = a.enabled;
  $('#rlVolume').value = Math.round((a.volume ?? 0.65) * 100);
  $('#rlSound').onchange = (e) => { state.audio.enabled = e.target.checked; saveAudio(); syncAudioDlg(); if (e.target.checked) blip(660); };
  $('#rlVolume').oninput = (e) => { state.audio.volume = Number(e.target.value) / 100; saveAudio(); };
  $('#rlTestSound').onclick = () => blip(660);
  // canvas click -> detail
  canvas.style.cursor = 'pointer';
  canvas.addEventListener('click', (ev) => {
    const r = canvas.getBoundingClientRect();
    const dpr = canvas.width / r.width;
    const x = (ev.clientX - r.left) * dpr, y = (ev.clientY - r.top) * dpr;
    let best = null, bd = 24 * dpr;
    for (const p of state._pts || []) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p.e; }
    }
    if (best) openDetail(best.trackId ?? best.id);
  });
  canvas.setAttribute('tabindex', '0');
  // detail close
  $('#rlDetailClose').onclick = () => { $('#detailCard').hidden = true; state.selectedId = null; renderFeed(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#detailCard').hidden) $('#rlDetailClose').click(); });
  // nav
  const goto = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => {
    goto(b.dataset.goto);
    $$('.rl-nav button, .rl-bottomnav button[data-goto]').forEach(x => x.removeAttribute('aria-current'));
    b.setAttribute('aria-current', 'true');
    if (b.classList.contains('active') === false && b.closest('.rl-nav')) {
      $$('.rl-nav button').forEach(x => x.classList.toggle('active', x === b));
    }
  }));
  // settings dialog
  const dlg = $('#rlSettings');
  const openSettings = () => { syncAudioDlg(); if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal(); };
  $('#rlSettingsBtn').onclick = openSettings;
  $('#rlMobileSettings').onclick = openSettings;
  $('#rlSettingsClose').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#rlSoundDlg').onchange = (e) => { state.audio.enabled = e.target.checked; saveAudio(); $('#rlSound').checked = e.target.checked; };
  $('#rlVolumeDlg').oninput = (e) => { state.audio.volume = Number(e.target.value) / 100; saveAudio(); $('#rlVolume').value = e.target.value; };
  $('#rlTestSoundDlg').onclick = () => blip(660);
  $('#rlContoursDlg').onchange = (e) => { state.showContours = e.target.checked; $('#rlContours').checked = e.target.checked; savePrefs(); };
  const kindDlg = [['#rlUavDlg', 'uav'], ['#rlMissileDlg', 'missile'], ['#rlBallisticDlg', 'ballistic'], ['#rlKabDlg', 'kab'], ['#rlAviationDlg', 'aviation']];
  for (const [sel, k] of kindDlg) {
    $(sel).onchange = (e) => {
      if (e.target.checked) state.kinds.add(k); else state.kinds.delete(k);
      if (!state.kinds.size) state.kinds = new Set(KIND_FILTERS);
      savePrefs(); renderKindFilters(); renderFeed(); renderContacts();
    };
  }
  syncAudioDlg(); syncDialogKinds();
  $('#rlContoursDlg').checked = state.showContours;
}

function syncAudioDlg() {
  $('#rlSoundDlg').checked = state.audio.enabled;
  $('#rlVolumeDlg').value = Math.round((state.audio.volume ?? 0.65) * 100);
}

async function pickCity(name) {
  try {
    const rows = await searchUkrainianPlaces(name);
    const r = rows.find(x => (x.settlement || '').toLowerCase() === name.toLowerCase()) || rows[0];
    if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) setCenter(r);
  } catch { /* keep current center */ }
}

function setCenter(place, save = true) {
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return;
  state.center = [place.lat, place.lon];
  state.centerName = place.settlement || place.oblast || 'Моє положення';
  $('#rlCenterLabel').textContent = 'Центр: ' + state.centerName;
  if (save) { try { saveSelectedPlace(place); } catch { /* ignore */ } }
  renderContacts();
}

// ── Boot ──────────────────────────────────────────────────────────
loadPrefs();
$('#rlCenterLabel').textContent = 'Центр: ' + state.centerName;
setupControls();
loadContours();
startScope();
load(true);
setInterval(load, POLL_MS);
setInterval(tickClock, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
window.addEventListener('focus', () => refreshIfStale());
window.addEventListener('online', () => refreshIfStale(0));
window.addEventListener('resize', () => { /* canvas auto-resizes each frame */ });
