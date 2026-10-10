// РАДАР.LIVE — light radar app (browser module, no Leaflet, no dark theme).
// Data: services/data.js fetchAll. NEPTUN and MAPA are the two sources.
// Geometry: ./geo.js. Filters: ./filters.js. City search: services/locations.js.
import { fetchAll, shouldPoll, POLL_MS } from '../services/data.js';
import { searchUkrainianPlaces, loadSelectedPlace, saveSelectedPlace } from '../services/locations.js';
import { findLocalPlace, searchLocalPlaces } from '../services/ukraine-places.js';
import { sourceCards, systemBadge } from '../services/overview.js';
import { classifyThreat } from '../services/threatClassify.js';
import {
  haversineKm, bearingDeg, projectRadar, formatDistanceKm, formatBearing,
  compassUk, accuracyLevel, radarPoint, rangeRings, clusterPoints,
} from './geo.js';
import {
  makeFix, planTransition, interpolateFix, tweenProgress, headingFor,
} from './motion.js';
import { shouldShowHeading } from '../services/threatClassify.js';
import {
  KIND_FILTERS, KIND_LABEL, KIND_COLOR, KIND_SYMBOL, normalizeKind, isNew, isActive, radarEvents, countByKind,
  applyFeedFilters, statusBadge,
} from './filters.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RANGES = [25, 50, 100, 200, 300, 500];
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
  // 'idle' (not started) | 'loading' | 'ready' | 'error'. Kept separate from
  // `contours` so the scope can say what is happening instead of showing an
  // empty disc that looks finished, and so a failure can be retried.
  // Starts as 'idle', NOT 'loading': loadContours() guards on 'loading', so
  // initialising it there would skip the fetch and never draw the map.
  contourStatus: 'idle',
  contourError: null,
  animOn: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  cityLabels: [],
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
    if (['all', 'new', 'active', 'completed'].includes(p.tab)) state.tab = p.tab;
    state.onlyNew = p.onlyNew === true;
    state.onlyActive = p.onlyActive === true;
    state.onlyCoords = p.onlyCoords === true;
    if (typeof p.animOn === 'boolean') state.animOn = p.animOn;
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
      tab: state.tab, onlyNew: state.onlyNew, onlyActive: state.onlyActive,
      onlyCoords: state.onlyCoords, animOn: state.animOn,
    }));
  } catch { /* ignore */ }
}

// ── Canvas radar (light) ──────────────────────────────────────────────
const canvas = $('#rlScope');
const ctx = canvas.getContext('2d');
const spriteImgs = new Map();
// Last CONFIRMED fix per stable track id. Bounded and pruned every frame, so a
// vanished track can never accumulate memory.
const lastFix = new Map();
// Transitions currently gliding between two confirmed fixes.
const liveMoves = new Map();
// Track ids seen this frame; everything else is pruned below.
let seenTrackIds = null;
let sweepDeg = 0, lastFrame = 0, rafId = 0, scopeActive = false;
const FIX_HISTORY_MAX = 400;

// Reconcile the confirmed-fix store against the frames we actually draw.
function rememberFix(event) {
  const fix = makeFix(event);
  if (!fix) return null;
  const prev = lastFix.get(fix.id);
  if (prev && prev.atMs >= fix.atMs) return prev;      // never move backwards
  lastFix.set(fix.id, fix);
  return prev || null;
}
function pruneFixes() {
  if (!seenTrackIds) return;
  if (lastFix.size <= FIX_HISTORY_MAX) return;
  for (const id of lastFix.keys()) {
    if (seenTrackIds.has(id)) continue;
    lastFix.delete(id);
    liveMoves.delete(id);
  }
}
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureSprites() {
  if (ensureSprites.done) return;
  ensureSprites.done = true;
  fetch('../assets/threats/sprite.svg').then(r => r.text()).then(txt => {
    for (const sym of ['shahed', 'uav', 'missile', 'ballistic', 'kab', 'aircraft', 'other']) {
      const m = txt.match(new RegExp(`<symbol id="${sym}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`));
      if (!m) continue;
      const img = new Image();
      img.decoding = 'async';
      // V5 artwork is self-coloured (fill + dark outline), rendered at 4x the
      // largest on-screen size so it stays crisp when rotated.
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m[1]}" width="128" height="128">${m[2]}</svg>`);
      spriteImgs.set(sym, img);
    }
  }).catch(() => {});
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Square buffer only: identical X/Y scale so the outer ring can never
  // become an oval even if CSS is constrained. Uses the smaller side.
  const side = Math.max(80, Math.round(Math.min(r.width, r.height || r.width)));
  canvas.width = side * dpr;
  canvas.height = side * dpr;
  return { w: side, dpr };
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

const staticC = document.createElement('canvas');
let staticKey = '';
const sctx = staticC.getContext('2d');

// The key MUST include the contour payload. Without it the first frame
// caches a contour-less disc while the GeoJSON is still in flight; when the
// fetch resolves nothing changes the key, so the disc is never rebuilt and the
// map stays missing for the rest of the session. Measured: 8 of 20 reloads
// drew the map, the rest did not. The embed radar already keyed on this.
function staticCacheKey(cssSize, dpr) {
  return [cssSize, dpr, state.range,
    state.center[0].toFixed(3), state.center[1].toFixed(3), state.centerName,
    state.showContours ? 1 : 0, state.contourStatus, (state.contours || []).length,
    (state.cityLabels || []).length,
  ].join('|');
}

// Static layer (cached): disc, contours, rings, radials, cardinals, center,
// city labels. Rebuilt only when size/range/center/overlays change — never
// per animation frame.
function rebuildStatic(W, H, dpr, cssSize) {
  staticC.width = W;
  staticC.height = H;
  const c = sctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = W / 2 - 10 * dpr;

  c.beginPath(); c.arc(cx, cy, R, 0, 7);
  c.fillStyle = '#FBFAF7'; c.fill();
  c.strokeStyle = '#DDE3EA'; c.lineWidth = 1.5 * dpr; c.stroke();
  c.save();
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip();

  // Oblast contours: filled, very light, so the disc reads as a map backdrop
  // without ever competing with the markers. Purely presentational — the same
  // geojson that already drew the outlines, no new data.
  if (state.showContours && state.contours?.length) {
    for (const poly of state.contours) {
      c.beginPath();
      let started = false;
      for (const [lo, la] of poly) {
        const p = projectRadar(la, lo, state.center, state.range, cssSize);
        if (!p) continue;
        const x = p.x * dpr, y = p.y * dpr;
        if (!started) { c.moveTo(x, y); started = true; } else c.lineTo(x, y);
      }
      c.closePath();
      c.fillStyle = '#F0EDE6';
      c.fill();
      c.strokeStyle = '#DCD5C7';
      c.lineWidth = 1 * dpr;
      c.stroke();
    }
  }

  // Never present an empty disc as finished: while the GeoJSON is in flight,
  // or after it failed, the disc says which of the two it is.
  if (state.showContours && state.contourStatus !== 'ready') {
    c.fillStyle = '#9AA5B4';
    c.font = `${12 * dpr}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.fillText(state.contourStatus === 'error' ? 'Контури карти недоступні' : 'Завантаження карти…', cx, cy - R * 0.55);
  }

  const rings = rangeRings(state.range);
  c.font = `${11 * dpr}px Inter, system-ui, sans-serif`;
  c.textAlign = 'center';
  rings.forEach((km, i) => {
    const r = R * ((i + 1) / rings.length);
    const outer = i === rings.length - 1;
    c.setLineDash(outer ? [] : [4 * dpr, 5 * dpr]);
    c.strokeStyle = outer ? '#EF3F36' : '#D8DEE6';
    c.lineWidth = (outer ? 1.4 : 1) * dpr;
    c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke();
    c.setLineDash([]);
    // Range label along the north spoke, as on the approved mockup.
    c.fillStyle = outer ? '#EF3F36' : '#8A94A3';
    c.fillText(km + ' км', cx, cy - r + 14 * dpr);
  });

  // Faint crosshair axes only — the dashed rings carry the scale.
  c.strokeStyle = '#E4E8EE';
  c.lineWidth = 1 * dpr;
  c.setLineDash([3 * dpr, 5 * dpr]);
  c.beginPath(); c.moveTo(cx - R, cy); c.lineTo(cx + R, cy); c.moveTo(cx, cy - R); c.lineTo(cx, cy + R); c.stroke();
  c.setLineDash([]);

  // city labels (real geocoded positions, faint; skipped when unavailable)
  if (state.cityLabels?.length) {
    c.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
    c.textAlign = 'center';
    for (const city of state.cityLabels) {
      const p = projectRadar(city.lat, city.lon, state.center, state.range, cssSize);
      if (!p || !p.inside) continue;
      if (Math.hypot(p.x * dpr - cx, p.y * dpr - cy) < 20 * dpr) continue;
      c.fillStyle = 'rgba(100,116,139,0.85)';
      c.fillText(city.name, p.x * dpr, p.y * dpr - 4 * dpr);
    }
  }

  // Cardinal points (Пн/Пд/Сх/Зх) are DOM elements positioned OUTSIDE the
  // disc, so they stay crisp and never overlap the map or the rings.
  // Center marker: red dot with a white halo ring, as on the mockup.
  c.fillStyle = '#FFFFFF';
  c.beginPath(); c.arc(cx, cy, 5.5 * dpr, 0, 7); c.fill();
  c.fillStyle = '#EF3F36';
  c.beginPath(); c.arc(cx, cy, 3.4 * dpr, 0, 7); c.fill();
  // center name under the dot (halo keeps rings/labels readable)
  c.font = `700 ${12.5 * dpr}px Inter, system-ui, sans-serif`;
  c.textAlign = 'center';
  c.lineWidth = 3.5 * dpr;
  c.strokeStyle = '#FFFFFF';
  c.strokeText(state.centerName, cx, cy + 19 * dpr);
  c.fillStyle = '#14263D';
  c.fillText(state.centerName, cx, cy + 19 * dpr);
  c.restore();
}

function glyphSymbol(kind, e) {
  if (kind === 'uav' && /shahed/i.test([e?.kind, e?.subtype].join(' '))) return 'shahed';
  return KIND_SYMBOL[kind] || 'other';
}

function drawFrame(t) {
  if (!scopeActive) return;
  rafId = requestAnimationFrame(drawFrame);
  // No motion work at all while the tab is hidden: requestAnimationFrame is
  // already throttled, but we also drop any in-flight glide so a marker never
  // reappears mid-path when the user comes back.
  if (typeof document !== 'undefined' && document.hidden) {
    liveMoves.clear();
    return;
  }
  const dt = Math.min(100, t - (lastFrame || t));
  lastFrame = t;
  const animate = state.animOn && !reducedMotion();
  if (animate) sweepDeg = (sweepDeg + dt / 6000 * 360) % 360;
  const { w: cssW, dpr } = resizeCanvas();
  const W = canvas.width, H = canvas.height;
  const key = staticCacheKey(cssW, dpr);
  if (key !== staticKey) { staticKey = key; rebuildStatic(W, H, dpr, cssW); }
  const cx = W / 2, cy = H / 2, R = W / 2 - 10 * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(staticC, 0, 0);

  // sweep (decorative only — never gates data)
  if (animate) {
    const a = (sweepDeg - 90) * Math.PI / 180;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(a);
    ctx.fillStyle = 'rgba(239,63,54,0.10)';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R, -0.3, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(239,63,54,0.55)'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.restore();
  }

  // markers: bare glyphs (no discs), clustered when overlapping
  const pts = currentPoints(cssW);
  const clusters = clusterPoints(pts.map(p => ({ x: p.x * dpr, y: p.y * dpr, data: p })), 30 * dpr);
  state._clusters = clusters;
  // Premium sizes: desktop 23px, mobile 20px, selected ring 27px equivalent.
  const sPx = (cssW < 420 ? 20 : 23) * dpr;
  const now = performance.now();
  const wall = Date.now();
  seenTrackIds = new Set();
  for (const c of clusters) {
    if (c.members.length === 1) {
      const p = c.members[0].data;
      const born = state.firstSeenAt.get(p.id);
      let scale = 1;
      if (born && animate) {
        const k = Math.min(1, (now - born) / 300);
        scale = 0.6 + 0.4 * k;
      }

      // ── V5 motion ──────────────────────────────────────────────────────
      // Reconcile the track's confirmed fixes. A glide is only ever started
      // between two fixes of the SAME track that both passed every guard in
      // planTransition(); otherwise the marker simply sits on the confirmed
      // coordinate. No prediction, no continuation, no orbit.
      const fix = makeFix(p.e);
      if (fix) {
        seenTrackIds.add(fix.id);
        const prevFix = rememberFix(p.e);
        const plan = (prevFix && animate && !reducedMotion())
          ? planTransition(prevFix, fix, { nowMs: wall })
          : null;
        if (plan) liveMoves.set(fix.id, { plan, fromFix: prevFix });
        else {
          // No legal transition (new track, stale, no prior fix, or a data jump):
          // any in-flight glide ends here and the marker sits exactly on the
          // confirmed coordinate from this frame on.
          liveMoves.delete(fix.id);
        }
      }
      const move = fix ? liveMoves.get(fix.id) : null;
      let drawX = c.x, drawY = c.y;
      let turnFrom = null, t = 1;
      if (move && fix) {
        t = tweenProgress(move.plan, wall);
        if (t < 1 && move.fromFix) {
          // Glide in project space between the two CONFIRMED fixes.
          const a = projectRadar(move.fromFix.lat, move.fromFix.lon, state.center, state.range, cssW);
          const b = projectRadar(fix.lat, fix.lon, state.center, state.range, cssW);
          if (a && b) {
            const ip = interpolateFix(a, b, t);
            drawX = ip.x * dpr; drawY = ip.y * dpr;
          }
          turnFrom = move.fromFix.heading;
        } else if (t >= 1) {
          // Transition finished: the marker rests exactly on the new confirmed
          // fix and stays there until new data arrives.
          liveMoves.delete(fix.id);
        }
      }

      const img = spriteImgs.get(glyphSymbol(p.kind, p.e));
      const halo = KIND_COLOR[p.kind] || KIND_COLOR.other;
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(drawX, drawY, sPx * 0.78 * scale, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(drawX, drawY, sPx * 0.6 * scale, 0, 7); ctx.fill();
      ctx.restore();

      if (img && img.complete && img.naturalWidth) {
        // Orientation comes ONLY from the source heading. headingFor returns
        // null when the source has no heading, in which case the glyph stays
        // neutral (north-up) instead of guessing a direction.
        // An unidentified contact is never rotated: its marker is a neutral
        // plate, and a spinning plate would imply a direction we do not have.
        const rotatable = p.kind !== 'other';
        const rawHeading = rotatable && shouldShowHeading(p.e) ? Number(p.e.heading) : null;
        const deg = headingFor(rotatable ? turnFrom : null, rawHeading, t);
        ctx.save();
        ctx.translate(drawX, drawY);
        if (deg != null) ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(img, (-sPx / 2) * scale, (-sPx / 2) * scale, sPx * scale, sPx * scale);
        ctx.restore();
      } else {
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(drawX, drawY, 4 * dpr * scale, 0, 7); ctx.fill();
      }
      if (p.id != null && String(p.id) === String(state.selectedId)) {
        // Selected: soft white halo + red ring (26–28px visual weight).
        ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 4 * dpr;
        ctx.beginPath(); ctx.arc(drawX, drawY, sPx / 2 + 4 * dpr, 0, 7); ctx.stroke();
        ctx.strokeStyle = '#EF3F36'; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(drawX, drawY, sPx / 2 + 4 * dpr, 0, 7); ctx.stroke();
      }
    } else {
      // compact cluster badge with honest count; tap opens the member list
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = '#EF3F36';
      ctx.beginPath(); ctx.arc(c.x, c.y, 17 * dpr, 0, 7); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(c.x, c.y, 11 * dpr, 0, 7);
      ctx.fillStyle = '#EF3F36'; ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 ${11 * dpr}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.min(99, c.members.length)), c.x, c.y + 4 * dpr);
    }
  }

  // empty state: distinguish "no coords at all" from "stale pipeline" from
  // "nothing inside this radius" — never "no threats".
  if (!pts.length) {
    const evs = state.snapshot?.events || [];
    const anyCoord = evs.some(e => e.lat != null && e.lon != null && !e.areaOnly);
    const pipeT = Date.parse(state.snapshot?.pipelineCheckedAt || '');
    const pipeStale = !Number.isFinite(pipeT) || Date.now() - pipeT > 5 * 60000;
    const lines = !evs.length || !state.snapshot
      ? ['Очікування даних…', '']
      : pipeStale && anyCoord
        ? ['Немає підтверджених цілей — останні дані застаріли', '']
        : anyCoord
          ? ['У цьому радіусі цілей немає', '']
          : ['Немає повідомлень із достатньо точними координатами', 'для відображення на радарі'];
    ctx.fillStyle = '#64748B';
    ctx.font = `${12 * dpr}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(lines[0], cx, cy + 26 * dpr);
    if (lines[1]) ctx.fillText(lines[1], cx, cy + 42 * dpr);
  }
  pruneFixes();
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

async function loadContours(force = false) {
  if (!force && (state.contourStatus === 'loading' || state.contourStatus === 'ready')) return;
  state.contourStatus = 'loading';
  state.contourError = null;
  renderMapState();
  try {
    const r = await fetch('../assets/data/ukraine-oblasts.geojson');
    if (!r.ok) throw new Error('HTTP ' + r.status);
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
    // An empty result is a failure, not a map with no outlines: say so rather
    // than presenting a blank disc as finished.
    if (!polys.length) throw new Error('порожній файл');
    state.contours = polys;
    state.contourStatus = 'ready';
  } catch (err) {
    state.contourStatus = 'error';
    state.contourError = String(err && err.message ? err.message : err).slice(0, 120);
  }
  renderMapState();
}

// Honest map state. The radar keeps working either way: contours are context,
// never a dependency of the data path.
function renderMapState() {
  const el = $('#rlMapState');
  if (!el) return;
  if (state.contourStatus === 'ready') { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  if (state.contourStatus === 'error') {
    el.className = 'rl-map-state rl-map-state-error';
    el.innerHTML = '<span>Не вдалося завантажити контури карти'
      + (state.contourError ? ' (' + esc(state.contourError) + ')' : '')
      + '. Дані джерел працюють.</span> <button type="button" class="rl-map-retry">Спробувати ще</button>';
    const b = el.querySelector('.rl-map-retry');
    if (b) b.onclick = () => loadContours(true);
  } else {
    el.className = 'rl-map-state rl-map-state-loading';
    el.innerHTML = '<span class="rl-map-spin" aria-hidden="true"></span> Завантаження контурів карти…';
  }
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
// Movement heading straight from the source. Returns null when the source did
// not report one — that is a different statement from "flying north".
function sourceHeading(e) {
  if (!shouldShowHeading(e)) return null;
  const h = Number(e.heading);
  if (!Number.isFinite(h)) return null;
  return ((h % 360) + 360) % 360;
}
const COMPASS16 = ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'];
function fmtHeading(e) {
  const h = sourceHeading(e);
  if (h === null) return 'невідомий (джерело не передало)';
  return `${COMPASS16[Math.round(h / 22.5) % 8]} · ${Math.round(h)}°`;
}
// Speed only when the source reported a plausible value.
function fmtSpeed(e) {
  const v = Number(e.speed);
  if (!Number.isFinite(v) || v <= 0 || v > 12_000) return 'невідома (джерело не передало)';
  return `${Math.round(v)} км/год`;
}

function fmtFullTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString('uk-UA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'long', year: 'numeric' });
}

// Mini-map in the detail panel: an OBLIQUE context view centred on the target.
// Reuses the same projection as the scope; it adds NO coordinate of its own.
function renderMiniMap(e, distKm) {
  const cv = $('#rlMiniMap');
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(r.width), H = Math.round(r.height);
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#FBFAF7'; c.fillRect(0, 0, W, H);

  const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
  if (!hasPos) {
    c.fillStyle = '#64748B';
    c.font = '12px Inter, system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('Немає координат — лише стрічка', W / 2, H / 2);
    return;
  }
  const ctxCenter = hasPos ? [+e.lat, +e.lon] : state.center;
  const span = Math.max(1, Math.min(600, (Number(distKm) || 0) * 2 + 60));
  const size = Math.min(W, H);
  const pad = 14;
  // Reuse projectRadar with a local range so the disc fits the box.
  const kx = 111.32 * Math.cos(ctxCenter[0] * Math.PI / 180);
  const dx = (0 * kx), dy = 0;
  void dx; void dy;
  const k = (size / 2 - pad) / span;
  const px = (lat, lon) => ({
    x: W / 2 + (lon - ctxCenter[1]) * kx * k,
    y: H / 2 - (lat - ctxCenter[0]) * 110.57 * k,
  });

  // oblast outlines as context (same geojson the scope uses)
  if (state.contours?.length) {
    c.strokeStyle = '#DCD5C7';
    c.lineWidth = 1;
    for (const poly of state.contours) {
      c.beginPath();
      let started = false;
      for (const [lo, la] of poly) {
        const p = px(la, lo);
        if (!started) { c.moveTo(p.x, p.y); started = true; } else c.lineTo(p.x, p.y);
      }
      c.stroke();
    }
  }
  // radius ring around the target
  const rad = Math.min(W, H) / 2 - pad;
  c.strokeStyle = 'rgba(239,63,54,.45)';
  c.setLineDash([4, 4]);
  c.beginPath(); c.arc(W / 2, H / 2, rad, 0, 7); c.stroke();
  c.setLineDash([]);
  // red beam from the observation centre toward the target
  const from = px(state.center[0], state.center[1]);
  if (Number.isFinite(from.x)) {
    const grad = c.createLinearGradient(from.x, from.y, W / 2, H / 2);
    grad.addColorStop(0, 'rgba(239,63,54,0)');
    grad.addColorStop(1, 'rgba(239,63,54,.28)');
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(W / 2 - 9, H / 2 + 5); c.lineTo(W / 2 + 9, H / 2 + 5);
    c.closePath(); c.fill();
  }
  // target marker
  c.fillStyle = '#EF3F36';
  c.beginPath(); c.arc(W / 2, H / 2, 4.5, 0, 7); c.fill();
  c.strokeStyle = '#FFFFFF'; c.lineWidth = 1.6;
  c.beginPath(); c.arc(W / 2, H / 2, 4.5, 0, 7); c.stroke();
  // place label
  c.fillStyle = '#64748B';
  c.font = '11px Inter, system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText(geoDesc(e), W / 2, H - 8);
}

function geoDesc(e) {
  const place = e.settlement || e.district || e.region || e.derivedRegion;
  if (place) return place;
  return 'місце невідоме';
}
function kindIcon(kind, color) {
  const sym = KIND_SYMBOL[kind] || 'other';
  return `<svg class="rl-ev-ico" style="color:${color}" aria-hidden="true"><use href="../assets/threats/sprite.svg#${sym}"/></svg>`;
}

function pipeAgeMs() {
  const t = Date.parse(state.snapshot?.pipelineCheckedAt || '');
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
}
function confirmAgeText() {
  const age = pipeAgeMs();
  if (age == null) return 'час перевірки невідомий';
  if (age < 60000) return 'підтверджено щойно';
  return `підтверджено ${Math.round(age / 60000)} хв тому`;
}

function renderFeed() {
  const list = feedEvents();
  const pipeStale = (pipeAgeMs() ?? Infinity) > 5 * 60000;
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
    const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
    const dist = hasPos ? formatDistanceKm(haversineKm(state.center[0], state.center[1], +e.lat, +e.lon)) : '—';
    // Honest per-event status: green "active" only with context. When the
    // pipeline itself is stale, the badge says so instead of implying a
    // fresh confirmation. The dense row shows the short form; the full
    // wording always stays in the title so nothing is hidden.
    const badge = statusBadge(e, { pipeStale });
    const short = badge.text.split(' · ')[0];
    const stTitle = badge.text + (badge.title ? ' — ' + badge.title : '');
    const st = `<span class="${badge.live ? 'st live' : 'st'}">${esc(short)}</span>`;
    return `<button class="rl-event" data-id="${esc(e.trackId ?? e.id ?? '')}" aria-current="${String((e.trackId ?? e.id) === state.selectedId)}" title="${esc(stTitle)}">
      <time>${esc(fmtTime(e.eventTime || e.timestamp))}</time>${kindIcon(kind, color)}
      <span class="rl-ev-main"><b style="color:${color}">${esc(KIND_LABEL[kind])}</b><em>${esc(geoDesc(e))}</em></span>
      <span class="rl-ev-meta"><span class="rl-ev-dist">${esc(dist)}</span><span class="rl-ev-src">${esc(e.source || '')}</span></span>${st}</button>`;
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
  const pipeT = Date.parse(state.snapshot?.pipelineCheckedAt || '');
  const pipeStale = state.snapshot ? (!Number.isFinite(pipeT) || Date.now() - pipeT > 5 * 60000) : false;
  const anyStale = (state.snapshot?.events || []).some(e => e.stale || e.status === 'ended');
  $('#rlRadarCount').textContent = total
    ? `${total} ${total === 1 ? 'ціль' : total < 5 ? 'цілі' : 'цілей'} у радіусі ${state.range} км`
    : !state.snapshot ? 'Очікування даних…'
    : pipeStale && anyStale ? 'Підтверджених цілей немає (дані застаріли)'
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
  const shortErr = (c) => {
    const e = String(c.error || '');
    if (!e) return 'Очікування';
    return e.length > 60 ? e.slice(0, 60) + '…' : e;
  };
  const cls = { ONLINE: 'ok', DEGRADED: 'warn', STALE: 'warn', RECOVERING: 'ok', OFFLINE: 'bad', IDLE: 'bad' };
  $('#rlSources').innerHTML = `<div class="rl-source-grid">` + cards.map(c => {
    // A source failure stays visible but human-readable: the raw HTTP
    // status lives behind an expandable technical block, never as the headline.
    const k = cls[c.state] || 'bad';
    const notes = [];
    if (c.updatedAt) notes.push('Оновлено ' + esc(fmtTime(c.updatedAt)));
    if (c.state === 'OFFLINE' && !c.updatedAt) notes.push('Джерело тимчасово недоступне');
    const ms = Number(c.latencyMs);
    if (Number.isFinite(ms) && ms > 0) notes.push('Затримка ' + (ms < 1000 ? Math.round(ms) + ' мс' : (ms / 1000).toFixed(0) + ' с'));
    const tech = c.error ? `<details class="rl-tech"><summary>Технічні деталі</summary>${esc(c.error)}</details>` : '';
    return `
    <div class="rl-source-mini" title="${esc(c.error || c.label)}">
      <span class="rl-src-ico ${k}"><svg aria-hidden="true"><use href="../assets/brand/icons.svg#i-source"/></svg></span>
      <span class="rl-src-name">${esc(c.name)}</span>
      <span class="rl-src-state ${k}">${esc(c.label)}</span>
      <span class="rl-src-note">${notes.join(' · ') || esc(shortErr(c))}</span>${tech}</div>`;
  }).join('') + `</div>`
    + (snap ? `<p class="rl-muted">Зміна даних: ${snap.dataUpdatedAt ? esc(fmtTime(snap.dataUpdatedAt)) : '—'} · Публікація: ${snap.publishedAt ? esc(fmtTime(snap.publishedAt)) : '—'}</p>` : '');
  // header badge: honest liveness (primaries only)
  const age = state.lastSuccess ? Date.now() - state.lastSuccess.getTime() : null;
  const badge = systemBadge(cards, age);
  const el = $('#rlLive');
  el.textContent = badge.level === 'ok' ? 'LIVE' : badge.text.toUpperCase();
  el.title = badge.text;
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
  const total = KIND_FILTERS.reduce((s, k) => s + (counts[k] || 0), 0);
  const allOn = KIND_FILTERS.every(k => state.kinds.has(k));
  $('#rlKindFilters').innerHTML = `
    <label class="rl-kind"><input class="rl-kind-sw" type="checkbox" data-kind="__all" ${allOn ? 'checked' : ''}>
    <span class="rl-kind-dot" style="background:#64748B;color:#64748B"></span>
    <span class="rl-kind-label">Усі загрози</span><span class="n">${total}</span></label>`
    + KIND_FILTERS.map(k => `
    <label class="rl-kind"><input class="rl-kind-sw" type="checkbox" data-kind="${k}" ${state.kinds.has(k) ? 'checked' : ''}>
    <span class="rl-kind-dot" style="background:${KIND_COLOR[k]};color:${KIND_COLOR[k]}"></span>
    <span class="rl-kind-label">${esc(KIND_LABEL[k])}</span><span class="n">${counts[k] || 0}</span></label>`).join('');
  $$('#rlKindFilters input').forEach(i => i.onchange = () => {
    if (i.dataset.kind === '__all') {
      // Master switch: enables every kind. At least one kind always stays on.
      state.kinds = new Set(KIND_FILTERS);
    } else {
      if (i.checked) state.kinds.add(i.dataset.kind); else state.kinds.delete(i.dataset.kind);
      if (!state.kinds.size) state.kinds = new Set(KIND_FILTERS);
    }
    savePrefs(); syncDialogKinds(); renderKindFilters(); renderFeed(); renderContacts();
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

const SEVERITY = {
  missile: 'Висока небезпека', ballistic: 'Висока небезпека',
  kab: 'Підвищена небезпека', uav: 'Моніторинг', aviation: 'Моніторинг', other: 'Моніторинг',
};

// Header is the panel's identity row: icon, label, severity, time and source.
// One helper so opening a threat and opening the cluster picker cannot drift.
function setDetailHead({ icon = '', title = '', sev = '', sub = '' } = {}) {
  const ic = $('#rlDetailIcon'), ti = $('#rlDetailTitle');
  const sv = $('#rlDetailSev'), sb = $('#rlDetailSub');
  if (ic) ic.innerHTML = icon;
  if (ti) ti.textContent = title;
  if (sv) { sv.hidden = !sev; sv.className = 'rl-sev' + (sv.hidden ? '' : (sev.endsWith('mid') ? ' mid' : sev.endsWith('low') ? ' low' : '')); sv.textContent = sev; }
  if (sb) sb.textContent = sub;
}

// The mobile sheet detaches from the layout, so it needs a backdrop of its
// own; on wider screens the scrim stays hidden and this is a no-op.
function setSheetOpen(open) {
  const scrim = $('#rlSheetScrim');
  if (scrim) scrim.hidden = !open;
}

function openDetail(id) {
  const e = (state.snapshot?.events || []).find(x => String(x.trackId ?? x.id) === String(id));
  if (!e) return;
  state.selectedId = e.trackId ?? e.id;
  const kind = normalizeKind(e);
  const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
  const d = hasPos ? haversineKm(state.center[0], state.center[1], +e.lat, +e.lon) : NaN;
  const b = hasPos ? bearingDeg(state.center[0], state.center[1], +e.lat, +e.lon) : NaN;
  const confirmed = e.eventTime || e.timestamp;
  // The header owns identity; the body starts straight at the facts, so no
  // space is spent on a title block duplicated above the scroll area.
  setDetailHead({
    icon: kindIcon(kind, KIND_COLOR[kind]),
    title: KIND_LABEL[kind],
    sev: SEVERITY[kind],
    sub: fmtFullTime(confirmed) + (e.source ? ' · ' + e.source : ''),
  });
  $('#rlDetailBody').innerHTML = `
    <dl class="rl-kv">
      <dt>Джерело</dt><dd>${esc(e.source || '—')}</dd>
      <dt>Можливе місцезнаходження</dt><dd>${esc(geoDesc(e))}</dd>
      <dt>Відстань від центру</dt><dd>${hasPos ? esc(formatDistanceKm(d)) : 'невідома (немає координат)'}</dd>
      <dt>Напрямок</dt><dd>${hasPos ? `на ${esc(compassUk(b))} (≈ ${Math.round(b)}°)` : 'недостовірний'}</dd>
      <dt>Напрямок руху</dt><dd>${esc(fmtHeading(e))}</dd>
      <dt>Швидкість</dt><dd>${esc(fmtSpeed(e))}</dd>
      <dt>Рівень точності</dt><dd>${esc(accuracyText(e))}</dd>
      <dt>Статус</dt><dd class="${e.stale || e.status === 'ended' ? '' : 'ok'}">${e.stale || e.status === 'ended' ? 'Завершена' : 'Активна загроза'}</dd>
      <dt>Актуальність</dt><dd>${(pipeAgeMs() ?? Infinity) > 5 * 60000 ? 'Потребує повторної перевірки (' + esc(confirmAgeText()) + ')' : esc(confirmAgeText())}</dd>
      <dt>Останнє підтвердження</dt><dd>${confirmed ? esc(fmtTime(confirmed)) : 'час не передано'}</dd>
    </dl>
    <div class="rl-minimap"><canvas id="rlMiniMap" aria-label="Міні-карта положення загрози"></canvas></div>
    <div class="rl-warn"><svg aria-hidden="true"><use href="../assets/brand/icons.svg#i-warning"/></svg><span>Координати є приблизними. Використовуйте інформацію з офіційних джерел для прийняття рішень.</span></div>
    <div class="rl-btn-row"><button class="rl-btn primary" id="rlWatchKind" style="flex:1"><svg aria-hidden="true"><use href="../assets/brand/icons.svg#i-bell"/></svg>Стежити за цією загрозою</button>
    <button class="rl-btn" id="rlShowOnRadar" style="flex:none">На радарі</button></div>
    <p class="rl-muted" id="rlWatchNote" style="margin:6px 0 0"></p>`;
  $('#detailCard').hidden = false;
  setSheetOpen(true);
  const ph = $('#detailPlaceholder');
  if (ph) ph.hidden = true;
  renderFeed();
  renderMiniMap(e, d);
  $('#rlShowOnRadar').onclick = () => {
    $('#radarCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#rlWatchKind').onclick = (ev) => {
    state.audio.enabled = true;
    state.audio.kinds[kind] = true;
    saveAudio(); syncAudioUI();
    blip(660);
    const note = $('#rlWatchNote');
    if (note) note.textContent = `Звук увімкнено для типу «${KIND_LABEL[kind]}». Сигнал м'який, не сирена.`;
    ev.target.disabled = true;
  };
  $('#detailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Cluster tap: honest member list (real positions untouched) to pick from.
function openClusterList(members) {
  state.selectedId = null;
  const rows = members.map(e => {
    const kind = normalizeKind(e);
    const hasPos = e.lat != null && e.lon != null && !e.areaOnly;
    const d = hasPos ? haversineKm(state.center[0], state.center[1], +e.lat, +e.lon) : NaN;
    return { e, kind, d };
  }).sort((a, b) => (a.d || Infinity) - (b.d || Infinity));
  setDetailHead({
    title: `Виберіть загрозу (${rows.length})`,
    sub: 'Маркери накладаються — координати не зміщено.',
  });
  $('#rlDetailBody').innerHTML = `
    <div class="rl-cluster-list">${rows.map(({ e, kind, d }) => `
      <button class="rl-contact" data-id="${esc(e.trackId ?? e.id ?? '')}">${kindIcon(kind, KIND_COLOR[kind])}
      <span>${esc(KIND_LABEL[kind])} · ${esc(geoDesc(e))}</span>
      <time>${Number.isFinite(d) ? esc(formatDistanceKm(d)) : '—'}</time></button>`).join('')}</div>`;
  $('#detailCard').hidden = false;
  setSheetOpen(true);
  const ph2 = $('#detailPlaceholder');
  if (ph2) ph2.hidden = true;
  $('#rlDetailBody').querySelectorAll('.rl-contact').forEach(b => b.onclick = () => openDetail(b.dataset.id));
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
    const time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const day = now.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
    $('#rlClock').textContent = day + ', ' + time;
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
    savePrefs();
    renderFeed();
  });
  // extra filters + contours + sweep animation live in the settings dialog
  const extra = [
    ['#rlOnlyNewDlg', 'onlyNew'], ['#rlOnlyActiveDlg', 'onlyActive'], ['#rlOnlyCoordsDlg', 'onlyCoords'],
  ];
  for (const [sel, key] of extra) {
    const el = $(sel);
    if (el) { el.checked = !!state[key]; el.onchange = (e) => { state[key] = e.target.checked; savePrefs(); renderFeed(); renderContacts(); }; }
  }
  const animDlg = $('#rlAnimDlg');
  if (animDlg) { animDlg.checked = state.animOn; animDlg.onchange = (e) => { state.animOn = e.target.checked; savePrefs(); }; }
  // oblast select (real coords via Nominatim on choice — nothing hardcoded)
  const OBLASTS = ['Вінницька область', 'Волинська область', 'Дніпропетровська область', 'Донецька область', 'Житомирська область', 'Закарпатська область', 'Запорізька область', 'Івано-Франківська область', 'Київська область', 'Кіровоградська область', 'Луганська область', 'Львівська область', 'Миколаївська область', 'Одеська область', 'Полтавська область', 'Рівненська область', 'Сумська область', 'Тернопільська область', 'Харківська область', 'Херсонська область', 'Хмельницька область', 'Черкаська область', 'Чернівецька область', 'Чернігівська область', 'м. Київ'];
  const oblastSel = $('#rlOblast');
  if (oblastSel) {
    oblastSel.innerHTML = '<option value="">Оберіть область…</option>' + OBLASTS.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    oblastSel.onchange = async () => {
      if (!oblastSel.value) return;
      await pickCity(oblastSel.value);
      oblastSel.value = '';
    };
  }
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
      const local = searchLocalPlaces(q, 6);
      let rows = [];
      // Local hits answer instantly; the network only tops up the list.
      if (local.length < 6) {
        try { rows = await searchUkrainianPlaces(q); } catch { rows = []; }
      }
      if (my !== seq) return;
      const seenP = new Set(local.map(x => String(x.settlement || x.oblast || '').toLowerCase()));
      rows = rows.filter(x => !seenP.has(String(x.settlement || x.oblast || '').toLowerCase()));
      rows = [...local, ...rows].slice(0, 8);
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
  // canvas click -> nearest cluster: single opens detail, multi opens list
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
  canvas.setAttribute('tabindex', '0');
  // detail close
  $('#rlDetailClose').onclick = () => {
    $('#detailCard').hidden = true;
    const ph3 = $('#detailPlaceholder');
    if (ph3) ph3.hidden = false;
    setDetailHead({ title: 'Детальна інформація про загрозу' });
    setSheetOpen(false);
    state.selectedId = null; renderFeed();
  };
  // Tapping the backdrop is a dismissal, the way any modal should behave.
  const scrim = $('#rlSheetScrim');
  if (scrim) scrim.onclick = () => $('#rlDetailClose').click();
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
  $$('[data-href]').forEach(b => b.addEventListener('click', () => { location.assign(b.dataset.href); }));
  // settings dialog
  const dlg = $('#rlSettings');
  const openSettings = () => { syncAudioDlg(); if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal(); };
  $('#rlSettingsBtn').onclick = openSettings;
  const sb2 = $('#rlSettingsBtn2');
  if (sb2) sb2.onclick = openSettings;
  $('#rlMobileSettings').onclick = openSettings;
  $('#rlSettingsClose').onclick = () => dlg.close();
  const closeTop = $('#rlSettingsCloseTop');
  if (closeTop) closeTop.onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#rlSoundDlg').onchange = (e) => { state.audio.enabled = e.target.checked; saveAudio(); $('#rlSound').checked = e.target.checked; };
  $('#rlVolumeDlg').oninput = (e) => { state.audio.volume = Number(e.target.value) / 100; saveAudio(); $('#rlVolume').value = e.target.value; };
  $('#rlTestSoundDlg').onclick = () => blip(660);
  $('#rlContoursDlg').onchange = (e) => { state.showContours = e.target.checked; savePrefs(); };
  const sndKinds = [['#rlSndUav', 'uav'], ['#rlSndMissile', 'missile'], ['#rlSndKab', 'kab'], ['#rlSndAviation', 'aviation']];
  for (const [sel, k] of sndKinds) {
    const el = $(sel);
    if (el) { el.checked = state.audio.kinds[k] !== false; el.onchange = (e) => { state.audio.kinds[k] = e.target.checked; saveAudio(); }; }
  }
  const kindDlg = [['#rlUavDlg', 'uav'], ['#rlMissileDlg', 'missile'], ['#rlBallisticDlg', 'ballistic'], ['#rlKabDlg', 'kab'], ['#rlAviationDlg', 'aviation']];
  for (const [sel, k] of kindDlg) {
    $(sel).onchange = (e) => {
      if (e.target.checked) state.kinds.add(k); else state.kinds.delete(k);
      if (!state.kinds.size) state.kinds = new Set(KIND_FILTERS);
      savePrefs(); renderKindFilters(); renderFeed(); renderContacts();
    };
  }
  syncAudioDlg(); syncDialogKinds();
  syncExtraDlg();
  const animDlg2 = $('#rlAnimDlg');
  if (animDlg2) animDlg2.checked = state.animOn;
  $('#rlContoursDlg').checked = state.showContours;
}

function syncAudioDlg() {
  const s = $('#rlSoundDlg'), v = $('#rlVolumeDlg');
  if (s) s.checked = state.audio.enabled;
  if (v) v.value = Math.round((state.audio.volume ?? 0.65) * 100);
  const panelS = $('#rlSound'), panelV = $('#rlVolume');
  if (panelS) panelS.checked = state.audio.enabled;
  if (panelV) panelV.value = Math.round((state.audio.volume ?? 0.65) * 100);
}

function syncAudioUI() {
  syncAudioDlg();
  const map = { uav: '#rlSndUav', missile: '#rlSndMissile', kab: '#rlSndKab', aviation: '#rlSndAviation' };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel);
    if (el) el.checked = state.audio.kinds[k] !== false;
  }
}

function syncExtraDlg() {
  const map = { onlyNew: '#rlOnlyNewDlg', onlyActive: '#rlOnlyActiveDlg', onlyCoords: '#rlOnlyCoordsDlg' };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel);
    if (el) el.checked = !!state[k];
  }
}

// Resolution order: the local verified directory answers first, so the scope
// NEVER waits on (or depends on) an external geocoder. Nominatim is only a
// fallback for a free-text place that is not in the directory — and a failing
// geocoder can no longer leave the radar without a centre.
async function pickCity(name) {
  const local = findLocalPlace(name);
  if (local) { setCenter(local); return; }
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

// Faint city labels: real Nominatim positions cached for 30 days. If the
// geocoder is unreachable, labels are simply skipped (clean radar over
// wrong labels).
const CITY_LABEL_NAMES = ['Львів', 'Вінниця', 'Полтава', 'Кропивницький', 'Запоріжжя', 'Миколаїв', 'Одеса'];

// ── Boot ──────────────────────────────────────────────────────────
loadPrefs();
const bootLabel = $('#rlCenterLabel');
if (bootLabel) bootLabel.textContent = 'Центр: ' + state.centerName + (state.centerName === 'Україна' ? ' (приблизний)' : '');
setupControls();
// Render the filter panel immediately: it must exist even when the data
// backend is unreachable, otherwise the controls vanish during an outage.
renderKindFilters();
renderSources();
renderMapState();
loadContours();
loadCityLabels();
startScope();
load(true);
// Default center: resolve Kyiv honestly via Nominatim (cached). Until then
// the fallback is the approximate centre of Ukraine, labeled as such.
if (state.centerName.startsWith('Україна')) {
  // Київ is a verified local coordinate: the first paint already has a real
  // centre. No geocoder call is needed to boot the radar.
  const kyiv = findLocalPlace('Київ');
  if (kyiv) {
    setCenter(kyiv, false);
    const lbl = $('#rlCenterLabel');
    if (lbl) lbl.textContent = 'Центр: Київ (стартовий — можна змінити)';
  } else {
    pickCity('Київ').catch(() => {});
  }
}
setInterval(load, POLL_MS);
setInterval(tickClock, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { liveMoves.clear(); lastFix.clear(); refreshIfStale(); }
});
window.addEventListener('focus', () => refreshIfStale());
window.addEventListener('online', () => refreshIfStale(0));
window.addEventListener('resize', () => { /* canvas auto-resizes each frame */ });

async function loadCityLabels() {
  try {
    const raw = localStorage.getItem('radar-live-cities-v1');
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached?.ts && Date.now() - cached.ts < 30 * 86400000 && Array.isArray(cached.list) && cached.list.length) {
        state.cityLabels = cached.list;
        staticKey = '';
        return;
      }
    }
  } catch { /* ignore */ }
  const list = [];
  const missing = [];
  for (const name of CITY_LABEL_NAMES) {
    // Verified local coordinates: instant, offline, no rate limit.
    const local = findLocalPlace(name);
    if (local) { list.push({ name, lat: local.lat, lon: local.lon }); continue; }
    missing.push(name);
  }
  // Only names the local directory does not know fall back to the geocoder.
  for (const name of missing) {
    try {
      const rows = await searchUkrainianPlaces(name);
      const r = rows.find(x => (x.settlement || '').toLowerCase() === name.toLowerCase()) || rows[0];
      if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) list.push({ name, lat: r.lat, lon: r.lon });
    } catch { /* skip this city */ }
    await new Promise(res => setTimeout(res, 350)); // be gentle with the free geocoder
  }
  if (list.length) {
    state.cityLabels = list;
    try { localStorage.setItem('radar-live-cities-v1', JSON.stringify({ ts: Date.now(), list })); } catch { /* ignore */ }
    staticKey = '';
  }
}
