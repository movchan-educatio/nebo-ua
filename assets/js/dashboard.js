// НЕБО UA — premium dashboard bootstrap.
// Data layer: services/data.js (aggregator + direct fallback), services/
// overview.js (pure view-models), assets/js/map.js (GIS, untouched),
// assets/js/scope.js (radar, untouched). No invented data anywhere.
import { fetchAll, shouldPoll, POLL_MS } from '../../services/data.js';
import { createStore, syncStore, selectTrails } from '../../services/tracks.js';
import { createSituationMap, getThreatVisual } from './map.js';
import { createScope, haversineKm } from './scope.js';
import { fetchRegions } from '../../services/regions.js';
import { oblastRaions, raionAlertActive, territorialDanger, normOblast, raionMatches } from '../../services/districts.js';
import { getOblastRaionPolygons } from '../../services/raionShapesLocal.js';
import { loadSelectedPlace } from '../../services/locations.js';
import {
  computeAlertStats, groupThreats, formatHistory,
  matchTerritory, sourceCards, systemBadge,
} from '../../services/overview.js';
import { fetchJson } from '../../services/http.js';
import { aggregatorUrl } from '../../services/config.js';
import { AudioAlerts } from '../../services/audio.js';
import { NotificationAlerts } from '../../services/notifications.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (d) => {
  try {
    return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  } catch { return '—'; }
};
const ago = (d) => {
  const ms = Date.now() - new Date(d).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  return `${Math.floor(m / 60)} год тому`;
};

const state = {
  snapshot: null, geo: null, regionsDir: [], lastSuccess: null,
  detail: 'country', base: 'dark', layers: { satellite: false },
  tracks: createStore(), audio: new AudioAlerts(), notifier: new NotificationAlerts(),
  timeline: [], timelinePrimed: false,
};

// ── Kyiv clock ────────────────────────────────────────────────────────────
function tickClock() {
  try {
    const now = new Date();
    $('#kyivClock').textContent = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(now);
    $('#kyivDate').textContent = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', weekday: 'short', timeZone: 'Europe/Kyiv' }).format(now);
  } catch { /* clock is decorative */ }
}

// ── Theme ─────────────────────────────────────────────────────────────────
// Theme toggle removed: the app ships one consistent dark theme (the approved
// reference). Any previously stored 'light' preference is cleared so nobody is
// stuck on the old, inconsistent light skin.
function setupTheme() {
  try { localStorage.removeItem('nebo-theme'); } catch { /* ignore */ }
  try { delete document.documentElement.dataset.theme; } catch { /* ignore */ }
  const btn = document.getElementById('themeButton');
  if (btn) btn.remove();
}

// ── Views (dialog panels) ─────────────────────────────────────────────────
function openSheet(html) {
  const d = $('#detailSheet');
  $('#detailContent').innerHTML = html;
  if (typeof d.showModal === 'function' && !d.open) d.showModal();
}
// Red dot on Сповіщення only for RECENT unseen events (≤10 min old) — an old
// record must never keep the indicator glowing forever.
function updateNavDot(snap) {
  try {
    const RECENT_MS = 10 * 60_000;
    let max = 0;
    for (const e of snap.events || []) {
      const t = new Date(e.eventTime || e.timestamp || 0).getTime();
      if (Number.isFinite(t) && t > max) max = t;
    }
    const seen = Number(localStorage.getItem('nebo-seen-max') || 0);
    const dot = $('#navDot');
    if (dot) dot.hidden = !(max > seen && max > Date.now() - RECENT_MS);
  } catch { /* badge best effort */ }
}
function setupViews() {
  const handlers = { map: scrollMap, radar: scrollRadar, stats: showStats, history: showHistory, alerts: showAlerts, sources: showSources, about: () => location.assign('./about/') };  const onNav = (v) => {
    $$('.mainnav button, .bottom-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    (handlers[v] || scrollMap)();
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) {
      if (b.dataset.view === 'alerts') {
        try {
          let max = 0;
          for (const ev of state.snapshot?.events || []) {
            const t = new Date(ev.eventTime || ev.timestamp || 0).getTime();
            if (Number.isFinite(t) && t > max) max = t;
          }
          if (max) localStorage.setItem('nebo-seen-max', String(max));
          const dot = $('#navDot');
          if (dot) dot.hidden = true;
        } catch { /* ignore */ }
      }
      onNav(b.dataset.view);
    }
  });
  $$('[data-view]').forEach(b => b.addEventListener('click', () => onNav(b.dataset.view)));
}
function scrollMap() { $('#mapPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function scrollRadar() {
  // Radar lives in the right column panel — just bring it into view.
  const el = document.querySelector('.radar-mini');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Sources panel ─────────────────────────────────────────────────────────
const SRC_ICON = {
  ua: '<svg><use href="./assets/brand/icons.svg#i-region"/></svg>',
  nep: '<svg><use href="./assets/brand/threat-icons.svg#recon"/></svg>',
  mapa: '<svg><use href="./assets/brand/icons.svg#i-map"/></svg>',
};
function renderSources(health) {
  const cards = sourceCards(health);
  $('#srcList').innerHTML = cards.map(c => `
    <div class="src-card"><span class="src-ico ${c.ico}">${SRC_ICON[c.ico]}</span>
    <span><b>${esc(c.name)}</b><small>${esc(c.sub)}</small>
    <time>${c.updatedAt ? 'Оновлено ' + esc(clock(c.updatedAt)) : (c.error ? esc(c.error) : 'Очікування')}</time></span>
    <span class="pill ${c.state === 'ONLINE' ? 'on' : c.state === 'DEGRADED' || c.state === 'STALE' ? 'warn' : c.state === 'OFFLINE' ? 'off' : 'idle'}">${esc(c.label)}</span></div>`).join('');
  const age = state.lastSuccess ? Date.now() - state.lastSuccess.getTime() : null;
  const badge = systemBadge(cards, age);
  const el = $('#sysStatus');
  el.className = 'sysok' + (badge.level === 'ok' ? '' : badge.level === 'warn' ? ' warn' : ' bad');
  el.querySelector('.txt').textContent = badge.text;
  return cards;
}

// ── Threats feed ──────────────────────────────────────────────────────────
function threatIcon(kind) {
  const v = getThreatVisual({ kind });
  return `<svg style="color:${v.color || '#8ca4b3'}"><use href="./assets/brand/threat-icons.svg#${v.icon || 'other'}"/></svg>`;
}
function durStr(t) {
  const ms = Date.now() - new Date(t).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  const h = Math.floor(m / 60);
  return `${h} год ${m % 60} хв тому`;
}
function renderThreats(events) {
  const rows = groupThreats(events, 30);
  $('#threatCount').textContent = rows.filter(r => !r.stale).length;
  $('#threatList').innerHTML = rows.length ? rows.map(r => {
    const isAir = /тривога|AIR/i.test(r.subtype || '') || r.kind === 'missile' || r.kind === 'ballistic';
    return `
    <button class="threat-row" data-lat="${r.lat}" data-lon="${r.lon}" data-id="${esc(r.id)}">
      <span class="threat-ico" style="background:#ffffff0d">${threatIcon(r.kind)}</span>
      <span><b>${esc(r.region || r.district || 'Невідома територія')}</b>
      <small class="${isAir ? 'threat-type-air' : 'threat-type-other'}">${esc(r.subtype || r.kind)} · ${esc(r.source || '')}</small>
      <time>${r.eventTime ? esc(clock(r.eventTime)) + ' · ' + esc(durStr(r.eventTime)) : '—'}</time></span>
      <span class="live-tag${r.stale ? ' stale' : ''}">${r.stale ? 'STALE' : 'LIVE'}</span>
    </button>`; }).join('') : '<p class="micro">Активних точкових цілей немає.</p>';
}

// ── Stats + events ────────────────────────────────────────────────────────
function renderStats(alerts, events) {
  const s = computeAlertStats(alerts);
  $('#stOblasts').textContent = s.oblasts;
  $('#stRaions').textContent = s.raions;
  $('#stComm').textContent = s.communities;
  const feed = groupThreats(events, 12);
  const officials = (alerts || []).filter(a => a.official).slice(0, 12);
  const items = [
    ...officials.map(a => ({ t: a.eventTime, icon: 'alert', text: `${a.region}${a.district ? ' — ' + a.district : ''} — ${a.subtype || 'тривога'}` })),
    ...feed.map(r => ({ t: r.eventTime, icon: r.kind, text: `${r.region || r.district || 'Територія'} — ${r.subtype || r.kind}` })),
  ].sort((a, b) => new Date(b.t || 0) - new Date(a.t || 0)).slice(0, 10);
  $('#eventList').innerHTML = items.length ? items.map(i => `
    <div class="event-row"><time>${i.t ? esc(clock(i.t)) : '—'}</time>${threatIcon(i.icon)}<span>${esc(i.text)}</span></div>`).join('')
    : '<p class="micro">Подій поки немає.</p>';
  $('#mapUpdated').textContent = 'Оновлено ' + (state.lastSuccess ? new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(state.lastSuccess) : '—');
}

// ── Map ───────────────────────────────────────────────────────────────────
let mapUI = null, scopeMini = null, scopeMiniRange = 100, raionFills = [];
function initMap() {
  mapUI = createSituationMap($('#map'), onTerritory);
  mapUI.map.setView([48.6, 31.2], 6);
  scopeMini = createScope($('#scopeMini'));
  scopeMini.setActive(true);
  const rr = $('#radarRange');
  if (rr) rr.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    scopeMiniRange = Number(b.dataset.range) || 100;
    [...rr.querySelectorAll('button')].forEach(x => x.classList.toggle('active', x === b));
    updateMiniRadar();
  });
  // Container settles after first layout: re-fit so Ukraine is fully visible.
  requestAnimationFrame(() => { try { mapUI.map.invalidateSize(false); mapUI.fitUkraine(); } catch { /* ignore */ } });
  setTimeout(() => { try { mapUI.map.invalidateSize(false); mapUI.fitUkraine(); } catch { /* ignore */ } }, 400);
  $('#zoomIn').onclick = () => mapUI.map.zoomIn();
  $('#zoomOut').onclick = () => mapUI.map.zoomOut();
  $('#gpsButton').onclick = () => locateMe(false);
  const legendBtn = $('#legendBtn');
  const legendBox = $('#mapLegend');
  if (legendBtn && legendBox) {
    legendBtn.onclick = () => {
      const open = legendBox.classList.toggle('sheet-open');
      legendBtn.setAttribute('aria-expanded', String(open));
    };
  }
  $('#layerButton').onclick = () => { const p = $('#layerPanel'); p.hidden = !p.hidden; };
  renderLayerPanel();
}
function renderLayerPanel() {
  const p = $('#layerPanel');
  const rows = [
    ['satellite', 'Супутник'], ['relief', 'Рельєф'], ['monitoring', 'Моніторинг'], ['alerts', 'Тривоги'],
    ['shapes', 'Межі'], ['wind', 'Вітер'],
  ];
  p.innerHTML = rows.map(([k, n]) => {
    const on = k === 'satellite' ? state.base === 'sat' : k === 'relief' ? state.base === 'relief' : true;
    return `<label style="display:flex;gap:8px;align-items:center;min-height:40px;font-size:13px"><input type="checkbox" data-layer="${k}"${on ? ' checked' : ''}>${n}</label>`;
  }).join('');
  p.querySelectorAll('input').forEach(i => i.onchange = () => {
    const k = i.dataset.layer;
    if (k === 'satellite') { applyBasemap(i.checked ? 'sat' : 'dark'); if (i.checked) p.querySelector('[data-layer="relief"]').checked = false; return; }
    if (k === 'relief') { applyBasemap(i.checked ? 'relief' : 'dark'); if (i.checked) p.querySelector('[data-layer="satellite"]').checked = false; return; }
    mapUI.toggle(k, i.checked);
  });
}
function locateMe(silent) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    mapUI.setUserPos({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy });
    if (!silent) mapUI.centerOnUser();
    // Radar centre = the operator's own position (that is what a scope means).
    try { scopeMini.update([], state.userPos, { range: scopeMiniRange }); } catch { /* ignore */ }
    updateMiniRadar();
  }, () => { /* denied/unavailable: keep place or Ukraine fallback */ },
  { timeout: 8000, maximumAge: 600000 });
}
function onTerritory(item) {
  // item: raion fill {oblast, district, level} or oblast feature.
  const card = $('#terrCard');
  const oblast = item?.oblast || item?.region || item?.name || '';
  const districtRaw = item?.district || null;
  // Never double the word "район" ("Кропивницький район район").
  const district = districtRaw && /район|громада/i.test(districtRaw)
    ? districtRaw.replace(/\s*район$/i, '')
    : districtRaw;
  const st = state.snapshot;
  const scope = oblast ? raionAlertActive(st?.alerts || [], oblast, districtRaw) : null;
  const official = (st?.alerts || []).filter(a => a.official
    && (!oblast || a.region === oblast)
    && (!districtRaw || a.district === districtRaw));
  const threats = (st?.events || []).filter(e => !oblast || e.region === oblast || e.derivedRegion === oblast).slice(0, 6);
  const levels = [...new Set(official.map(a => a.level).filter(Boolean))];
  const scopeText = official.length
    ? (districtRaw ? 'Район у тривозі' : 'Уся область у тривозі')
    : (scope && scope.scope === 'outside' ? 'Поза зоною тривоги' : 'Тривоги немає');
  const rows = [
    ...official.slice(0, 3).map(a => ({ t: a.eventTime, s: a.subtype || 'Повітряна тривога' })),
    ...threats.slice(0, 4).map(e => ({ t: e.eventTime, s: e.subtype || e.kind || 'Ціль' })),
  ];
  const listHtml = rows.length
    ? rows.map(r => `<p class="micro">• ${esc(r.s)}${r.t ? ' · ' + esc(clock(r.t)) + ' · ' + esc(durStr(r.t)) : ''}</p>`).join('')
    : '<p class="micro">Немає активних загроз для цієї території.</p>';
  card.innerHTML = `
    <h3>${esc(district ? district + ' район' : oblast || 'Територія')}</h3>
    <div class="sub">${esc(district ? (oblast || 'Територія') : 'Область')} · ${esc(scopeText)}</div>
    <div class="terr-grid">
      <div class="terr-field"><span>Статус</span><b>${official.length ? 'Тривога' : 'Спокійно'}</b></div>
      <div class="terr-field"><span>Рівень</span><b>${levels.includes('red') ? 'Високий' : levels.includes('yellow') ? 'Підвищений' : '—'}</b></div>
      <div class="terr-field"><span>Тривог</span><b>${official.length}</b></div>
      <div class="terr-field"><span>Цілей поруч</span><b>${threats.length}</b></div>
      <div class="terr-field"><span>Джерело</span><b>${esc(official[0]?.source || threats[0]?.source || '—')}</b></div>
      <div class="terr-field"><span>Оновлено</span><b>${state.lastSuccess ? esc(clock(state.lastSuccess)) : '—'}</b></div>
    </div>
    ${listHtml}
    <div class="terr-actions">
      <button class="btn-primary" id="terrHistory">Історія тривог ›</button>
      <button class="btn-ghost" id="terrClose">Закрити</button>
    </div>`;
  card.classList.add('open');
  $('#terrClose').onclick = () => card.classList.remove('open');
  $('#terrHistory').onclick = () => showHistory(oblast, districtRaw);
}
async function loadRegionsGeo() {
  if (state.geo) return state.geo;
  try {
    const g = await fetchRegions();
    if (g?.features?.length) state.geo = g;
  } catch { /* offline: skip outlines */ }
  return state.geo;
}
// Legend is generated from the SAME registry the map uses (META via
// getThreatVisual) — it can never drift from what is drawn on the map.
function renderLegend() {
  const el = $('#legendStrip');
  if (!el) return;
  // Title stays OUTSIDE the body so a collapsed strip is never an empty pill.
  let title = el.querySelector('.legend-title');
  if (!title) {
    title = document.createElement('b');
    title.className = 'legend-title';
    title.textContent = 'Умовні позначення:';
    el.insertBefore(title, el.firstChild);
  }
  let body = el.querySelector('.legend-body');
  if (!body) {
    body = document.createElement('div');
    body.className = 'legend-body';
    el.appendChild(body);
  }
  const territory = [
    ['#F04444', 'Повітряна тривога'],
    ['#F59E0B', 'Підвищена небезпека'],
    ['#3E5468', 'Немає тривоги'],
  ];
  const kinds = ['shahed', 'uav', 'missile', 'ballistic', 'kab', 'aviation', 'recon'];
  const KIND_LABEL = {
    shahed: 'Шахед', uav: 'БПЛА', missile: 'Ракета', ballistic: 'Балістика',
    kab: 'КАБ', aviation: 'Авіація', recon: 'Розвідка',
  };
  body.innerHTML = ''
    + territory.map(([c, t]) => `<span class="row"><i style="background:${c}"></i>${t}</span>`).join('')
    + kinds.map(k => {
      const v = getThreatVisual(k);
      return `<span class="row lg"><svg style="color:${v.color};fill:${v.color};stroke:${v.color}"><use href="./assets/brand/threat-icons.svg#${v.icon}"/></svg>${KIND_LABEL[k]}</span>`;
    }).join('');
}
function updateMiniRadar() {
  const st = state.snapshot;
  if (!scopeMini || !st) return;
  // Radar shows only CURRENT (non-stale) confirmed coordinates, same set as
  // the map markers. Stale records stay in the lists but are never plotted
  // as live radar contacts.
  const center = state.userPos
    || (() => { try { const p = loadSelectedPlace(); return (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) ? { lat: p.lat, lon: p.lon } : null; } catch { return null; } })()
    || { lat: 49, lon: 31 };
  const fresh = (st.events || []).filter(e => e.lat != null && !e.areaOnly && !e.stale);
  try {
    scopeMini.update(fresh, center, { range: scopeMiniRange });
  } catch { /* radar best effort */ }
  // Count ONLY what is inside the selected radius (matches the screen).
  const inside = fresh.filter(e => {
    try { return haversineKm(center.lat, center.lon, e.lat, e.lon) <= scopeMiniRange; } catch { return false; }
  });
  const cnt = $('#radarCount');
  if (cnt) {
    const c = state.userPos ? 'від вас' : 'від центру України';
    cnt.textContent = `${inside.length} ${inside.length === 1 ? 'ціль' : inside.length < 5 ? 'цілі' : 'цілей'} у радіусі ${scopeMiniRange} км ${c}`;
  }
}
async function refreshMap() {
  const st = state.snapshot;
  if (!st || !mapUI) return;
  await loadRegionsGeo();
  if (state.geo) {
    try { mapUI.setRegions(state.geo, st.alerts, st.events); } catch { /* keep old frame */ }
  }
  // Raion fills for the selected detail level + centroids for labelled dots.
  try {
    const { fills } = territorialDanger(st.alerts, st.events);
    raionFills = fills || [];
    const withPolys = [];
    for (const f of raionFills.slice(0, 60)) {
      // Skip "fills" whose district slot is the oblast name itself (not a raion).
      if (!f.district || f.district === f.oblast) continue;
      try {
        const polys = await getOblastRaionPolygons(f.oblast);
        // Alias/suffix-aware match ("Уманський" ↔ "Уманський район").
        const g = (polys || []).find(g => { try { return raionMatches(g.name, f.district); } catch { return g.name === f.district; } });
        if (g?.polys) withPolys.push({ ...f, district: g.name, polys: g.polys });
      } catch { /* skip missing geometry: no phantom polygons */ }
    }
    // Every raion of an affected oblast becomes clickable: already drawn ones
    // keep their status colour, the rest get an invisible 'calm' polygon.
    try {
      const drawn = new Set(withPolys.map(f => f.oblast + '||' + f.district));
      const oblastsToComplete = [...new Set(withPolys.map(f => f.oblast))].slice(0, 8);
      for (const ob of oblastsToComplete) {
        const polys = await getOblastRaionPolygons(ob);
        for (const g of polys || []) {
          if (!g?.polys || drawn.has(ob + '||' + g.name)) continue;
          withPolys.push({ oblast: ob, district: g.name, level: 'calm', polys: g.polys });
          drawn.add(ob + '||' + g.name);
          if (withPolys.length > 140) break;
        }
        if (withPolys.length > 140) break;
      }
    } catch { /* completion is best effort */ }
    // No level selector now: fills are always shown, raion dots always help
    // identify territories at a glance.
    mapUI.setAlertShapes(withPolys, onTerritory);
    try { mapUI.map.getContainer().classList.remove('detail-raion', 'detail-community'); } catch { /* ignore */ }
    {
      const dots = [];
      const firstRing = (polys) => {
        const p0 = polys && polys[0];
        if (!Array.isArray(p0) || !p0.length) return null;
        // p0 is either an array of rings or a single ring of [lat,lon] pairs.
        if (Array.isArray(p0[0]) && Array.isArray(p0[0][0])) return p0[0];
        if (Array.isArray(p0[0]) && Number.isFinite(p0[0][0])) return p0;
        return null;
      };
      for (const f of withPolys.slice(0, 40)) {
        const ring = firstRing(f.polys);
        if (!ring || !ring.length) continue;
        let lat = 0, lon = 0, n = 0;
        for (const p of ring) {
          if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
          lat += p[0]; lon += p[1]; n++;
        }
        if (!n) continue;
        if (!Number.isFinite(lat / n) || !Number.isFinite(lon / n)) continue;
        dots.push({ name: f.district, region: f.oblast, status: f.level === 'critical' || f.level === 'alert' ? 'alert' : 'mon', lat: lat / n, lon: lon / n });
      }
      mapUI.setRaionDots(dots, onTerritory);
    }
  } catch { /* shapes best effort */ }
  try {
    // NOTE: sync ONLY current (fresh) targets — a destroyed/removed threat
    // leaves the store immediately, so its dashed trail disappears at once
    // instead of lingering as a stale direction line.
    const freshEvents = (st.events || []).filter(e => !e.stale);
    syncStore(state.tracks, freshEvents);
    let trails = [];
    try {
      const visibleSet = new Set(['uav', 'missile', 'ballistic', 'kab', 'aviation', 'shahed', 'recon', 'other']);
      trails = selectTrails(state.tracks.getAll(), visibleSet) || [];
      // Sanitize: never let one dashed line stitch an old position to a new
      // one. Drop points older than 15 min (when timed) and any segment longer
      // than a plausible single step (~80 km). Keeps every trail a real,
      // continuous observed path — no stale leftovers.
      const MAX_JUMP_KM = 80, MAX_AGE_MIN = 15;
      const kmBetween = (a, b) => {
        const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
      };
      const now = Date.now();
      trails = trails.map(t => {
        const pts = [];
        for (const p of t.points || []) {
          if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
          if (p.t) {
            const ts = p.t instanceof Date ? p.t.getTime() : new Date(p.t).getTime();
            if (Number.isFinite(ts) && now - ts > MAX_AGE_MIN * 60000) continue;
          }
          if (pts.length && kmBetween(pts[pts.length - 1], p) > MAX_JUMP_KM) pts.length = 0; // break: start a new, real segment
          pts.push(p);
        }
        return { ...t, points: pts };
      }).filter(t => t.points.length >= 2);
    } catch { trails = []; }
    // Fallback: source-provided trail arrays (MAPA) when the store has none.
    if (!trails.length) {
      trails = (st.events || [])
        .filter(e => Array.isArray(e.trail) && e.trail.length >= 2)
        .map(e => ({ trackId: e.trackId || e.id, category: e.category, points: e.trail.slice(-8) }));
    }
    const sel = null;
    // Markers: only current (non-stale) confirmed targets — stale records
    // stay in the panels but are not drawn as live positions.
    mapUI.setEvents(freshEvents, new Set(['uav', 'missile', 'ballistic', 'kab', 'aviation', 'shahed', 'recon', 'other']), sel, trails);
  } catch { /* markers best effort */ }
  // Mini radar: confirmed coordinates only (animated sweep).
  updateMiniRadar();
}

// ── Search ────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = $('#mapSearch'), box = $('#searchResults');
  let oblasts = [];
  input.addEventListener('input', () => {
    const q = input.value;
    const hits = matchTerritory(q, oblasts, state.regionsDir, 8);
    if (!hits.length) { box.hidden = true; return; }
    box.innerHTML = hits.map((h, i) => `<button data-i="${i}"><b>${esc(h.name)}</b><small>${esc(h.kind)}${h.regionId ? ' · ' + esc(h.regionId) : ''}</small></button>`).join('');
    box.hidden = false;
    box.querySelectorAll('button').forEach(b => b.onclick = () => {
      const h = hits[+b.dataset.i];
      box.hidden = true;
      input.value = h.name;
      focusTerritory(h);
    });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.map-search') && !e.target.closest('#searchResults')) box.hidden = true; });
  fetchRegions().then(g => {
    const feats = g?.features || [];
    oblasts = feats.map(f => f?.properties?.name).filter(Boolean);
  }).catch(() => {});
}
function focusTerritory(h) {
  if (!mapUI) return;
  if (h.kind === 'oblast' || !h.regionId) {
    try { mapUI.showHome(h.name); } catch { /* ignore */ }
  }
  onTerritory({ oblast: h.name, district: h.kind === 'District' ? h.name : null });
}

// ── Basemap + relief toggles now live in the Шари panel ──────────────────
let reliefLayer = null;
function applyBasemap(kind) {
  if (!mapUI) return;
  state.base = kind;
  mapUI.toggle('satellite', kind === 'sat');
  try {
    if (kind === 'relief') {
      if (!reliefLayer) reliefLayer = window.L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | style: © OpenTopoMap (CC-BY-SA)' });
      if (reliefLayer) reliefLayer.addTo(mapUI.map);
    } else if (reliefLayer && mapUI.map.hasLayer(reliefLayer)) {
      mapUI.map.removeLayer(reliefLayer);
    }
  } catch { /* basemap best effort */ }
}
function setupSegs() {
  const detailSeg = $('#detailSeg');
  if (detailSeg) detailSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.detail = b.dataset.detail;
    $$('#detailSeg button').forEach(x => x.classList.toggle('active', x === b));
    refreshMap();
  });
}

// ── Stats / history / alerts / sources panels ─────────────────────────────
function showStats() {
  const st = state.snapshot;
  const s = computeAlertStats(st?.alerts || []);
  // Split point targets the SAME way the map does: current vs stale.
  const withCoords = (st?.events || []).filter(e => e.lat != null && !e.areaOnly);
  const fresh = withCoords.filter(e => !e.stale);
  const stale = withCoords.filter(e => e.stale);
  const byKind = {};
  for (const e of fresh) {
    const v = (() => { try { return getThreatVisual(e); } catch { return { label: e.category || 'інше' }; } })();
    byKind[v.label] = (byKind[v.label] || 0) + 1;
  }
  const kindRows = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<p class="micro">• ${esc(k)}: <b>${v}</b></p>`).join('');
  openSheet(`<span class="kicker">СТАТИСТИКА</span><h2>Підтверджені дані</h2>
    <div class="terr-grid">
      <div class="terr-field"><span>Областей у тривозі</span><b>${s.oblasts}</b></div>
      <div class="terr-field"><span>Районів у тривозі</span><b>${s.raions}</b></div>
      <div class="terr-field"><span>Громад у тривозі</span><b>${s.communities}</b></div>
      <div class="terr-field"><span>Активних точкових цілей</span><b>${fresh.length}</b></div>
      <div class="terr-field"><span>Застарілих (не на карті)</span><b>${stale.length}</b></div>
    </div>
    <p class="micro">Офіційні тривоги й моніторингові цілі рахуються окремо; одна територія з двох джерел — один запис. Активні цілі — ті, що зараз показані на карті; застарілі записи лишаються в списках, але не малюються як поточні позиції. Зріз: ${state.lastSuccess ? esc(clock(state.lastSuccess)) : '—'}.</p>
    <h3 class="subheading">Активні цілі за типами</h3>
    ${kindRows || '<p class="micro">Активних точкових цілей немає.</p>'}`);
}
async function loadRegionsDir() {
  if (state.regionsDir.length) return state.regionsDir;
  try {
    const base = aggregatorUrl().replace(/\/v1\/state.*$/, '');
    const r = await fetchJson(base + '/v1/official/regions', { timeout: 10000 });
    state.regionsDir = Array.isArray(r?.regions) ? r.regions : [];
  } catch { state.regionsDir = []; }
  return state.regionsDir;
}
async function showHistory(oblast = null, district = null) {
  openSheet(`<span class="kicker">ІСТОРІЯ ТРИВОГ</span><h2>${esc(district || oblast || 'Останні тривоги')}</h2><div id="histBody"><p class="micro">Завантаження довідника регіонів…</p></div>`);
  const dir = await loadRegionsDir();
  const body = $('#histBody');
  if (!dir.length) {
    body.innerHTML = '<p class="micro">Довідник регіонів недоступний (джерело офлайн). Історія без зіставлення території недостовірна, тому її приховано.</p>';
    return;
  }
  const cands = dir.filter(r => !oblast || (r.regionName || '').includes(oblast.replace(' область', ''))).slice(0, 12);
  body.innerHTML = `<label class="micro" for="histRegion">Територія</label>
    <select id="histRegion" style="width:100%;min-height:44px;background:#08121a;color:var(--text);border:1px solid var(--line);border-radius:11px;margin:6px 0 10px">${cands.map(r => `<option value="${esc(r.regionId)}">${esc(r.regionName)} (${esc(r.regionType || '')})</option>`).join('')}</select>
    <div id="histList"><p class="micro">Оберіть територію.</p></div>`;
  $('#histRegion').onchange = async (e) => {
    const list = $('#histList');
    list.innerHTML = '<p class="micro">Завантаження…</p>';
    try {
      const base = aggregatorUrl().replace(/\/v1\/state.*$/, '');
      const r = await fetchJson(base + '/v1/official/history?regionId=' + encodeURIComponent(e.target.value), { timeout: 12000 });
      const rows = formatHistory(r?.history || []);
      list.innerHTML = rows.length ? rows.map(h => `
        <div class="event-row"><time>${h.start ? esc(clock(h.start)) : '—'}</time>
        <span>${esc(h.regionName || '')} · ${esc(h.alertType)} · ${h.ongoing ? 'триває' : h.durMin != null ? h.durMin + ' хв' : '—'}</span></div>`).join('')
        : '<p class="micro">Записів немає.</p>';
    } catch {
      list.innerHTML = '<p class="micro">Історія недоступна (помилка джерела). Порожній список як достовірний не показуємо.</p>';
    }
  };
}
function showAlerts() {
  const p = state.notifier.prefs || {};
  openSheet(`<span class="kicker">СПОВІЩЕННЯ</span><h2>Керування</h2>
    <label style="display:flex;justify-content:space-between;gap:10px;padding:10px 0">Сповіщення на пристрої<input id="ntfOn" type="checkbox" ${p.enabled ? 'checked' : ''}></label>
    <label style="display:flex;justify-content:space-between;gap:10px;padding:10px 0">Офіційна тривога<input data-ntf="officialStart" type="checkbox" ${p.officialStart !== false ? 'checked' : ''}></label>
    <label style="display:flex;justify-content:space-between;gap:10px;padding:10px 0">Відбій<input data-ntf="officialEnd" type="checkbox" ${p.officialEnd !== false ? 'checked' : ''}></label>
    <label style="display:flex;justify-content:space-between;gap:10px;padding:10px 0">БПЛА<input data-ntf="uav" type="checkbox" ${p.uav !== false ? 'checked' : ''}></label>
    <label style="display:flex;justify-content:space-between;gap:10px;padding:10px 0">Ракети<input data-ntf="missile" type="checkbox" ${p.missile !== false ? 'checked' : ''}></label>
    <p class="micro">Фонові push — у налаштуваннях пристрою після підписки. Відбій через помилку мережі не надсилається; дублікати з двох джерел об'єднуються.</p>
    <div class="terr-actions"><button class="btn-ghost" id="audioBtn">Звукові сповіщення</button></div>`);
  $('#ntfOn').onchange = async (e) => {
    if (e.target.checked) { try { await state.notifier.enable(); } catch { /* denied */ } }
    else state.notifier.save({ enabled: false });
  };
  document.querySelectorAll('[data-ntf]').forEach(i => i.onchange = () => state.notifier.save({ [i.dataset.ntf]: i.checked }));
  $('#audioBtn').onclick = () => { const d = $('#audioPrompt'); if (typeof d.showModal === 'function' && !d.open) d.showModal(); };
}
function showSources() {
  const cards = sourceCards(state.snapshot?.health);
  openSheet(`<span class="kicker">ДЖЕРЕЛА ДАНИХ</span><h2>Статуси</h2>
    ${cards.map(c => `<div class="event-row"><span><b>${esc(c.name)}</b><br><small class="micro">${esc(c.sub)} · ${c.updatedAt ? 'оновлено ' + esc(clock(c.updatedAt)) : esc(c.error || 'очікування')}</small></span><span class="pill ${c.state === 'ONLINE' ? 'on' : c.state === 'OFFLINE' ? 'off' : c.state === 'IDLE' ? 'idle' : 'warn'}" style="margin-left:auto">${esc(c.label)}</span></div>`).join('')}
    <p class="micro">Офіційні тривоги — <a href="https://www.ukrainealarm.com/" target="_blank" rel="noopener" class="top-links-link">UkraineAlarm</a> (ключ лише на сервері). НЕБО.UA не є його партнером. Моніторинг цілей — NEPTUN і MAPA. <a href="./sources/" class="top-links-link">Розгорнута сторінка&nbsp;джерел&nbsp;›</a></p>`);
}

// ── Data loop ─────────────────────────────────────────────────────────────
async function load() {
  if (!shouldPoll()) return;
  try {
    const snap = await fetchAll(new AbortController().signal);
    state.snapshot = snap;
    state.lastSuccess = snap.receivedAt instanceof Date ? snap.receivedAt : new Date(snap.receivedAt);
    try { syncStore(state.tracks, snap.events); } catch { /* ignore */ }
    try { state.audio.process(snap, ''); } catch { /* ignore */ }
    try { state.notifier.process(snap, null); } catch { /* ignore */ }
    renderSources(snap.health);
    renderThreats(snap.events);
    renderStats(snap.alerts, snap.events);
    renderLegend();
    refreshMap();
    try { mapUI.map.invalidateSize(false); mapUI.fitUkraine(); } catch { /* ignore */ }
    updateNavDot(snap);
    const notice = $('#networkNotice');
    if (snap.health?.OFFICIAL?.status === 'offline') {
      notice.hidden = false;
      notice.innerHTML = '';
      const t = document.createElement('span');
      t.textContent = 'Офіційне джерело тимчасово недоступне. Показуємо NEPTUN/MAPA.';
      const x = document.createElement('button');
      x.className = 'notice-x';
      x.setAttribute('aria-label', 'Приховати попередження');
      x.textContent = '×';
      x.onclick = () => { notice.hidden = true; };
      notice.append(t, x);
    } else notice.hidden = true;
  } catch {
    const el = $('#sysStatus');
    el.className = 'sysok bad';
    el.querySelector('.txt').textContent = 'Немає з’єднання';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
// Bottom nav: auto-hide while scrolling down, reappear on scroll up or at
// the top — never permanently covering the last cards.
function setupNavAutoHide() {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;
  const collapse = document.getElementById('navCollapse');
  const reveal = document.getElementById('navReveal');
  let userCollapsed = false;
  try { userCollapsed = localStorage.getItem('nebo-nav-collapsed') === '1'; } catch { /* ignore */ }
  const applyCollapsed = () => {
    nav.classList.toggle('nav-collapsed', userCollapsed);
    if (reveal) reveal.hidden = !userCollapsed;
  };
  applyCollapsed();
  if (collapse) collapse.onclick = () => {
    userCollapsed = true;
    try { localStorage.setItem('nebo-nav-collapsed', '1'); } catch { /* ignore */ }
    applyCollapsed();
  };
  if (reveal) reveal.onclick = () => {
    userCollapsed = false;
    try { localStorage.setItem('nebo-nav-collapsed', '0'); } catch { /* ignore */ }
    applyCollapsed();
  };
  let lastY = window.scrollY, ticking = false;
  const apply = () => {
    ticking = false;
    if (userCollapsed) { lastY = window.scrollY; return; }
    const y = window.scrollY;
    const down = y > lastY + 6;
    const nearBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 40;
    if ((down && y > 80) && !nearBottom) nav.classList.add('nav-hidden');
    else nav.classList.remove('nav-hidden');
    lastY = y;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(apply); }
  }, { passive: true });
}
// Every panel gets a collapse toggle (desktop + mobile), persisted per id.
// Headers stay visible; bodies hide. Also: hide whole side columns and the
// map legend on request.
function setupCollapsibles() {
  const KEY = 'nebo-collapsed-v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ } };

  const targets = [
    ...$$('.sources-col .panel'), ...$$('.right-col .panel'),
    $$('.legend-strip')[0], $$('#mapLegend')[0],
  ].filter(Boolean);

  targets.forEach((el, i) => {
    const head = el.querySelector('.panel-head') || el;
    const id = el.id || ('panel-' + i);
    el.dataset.collapseId = id;
    const btn = document.createElement('button');
    btn.className = 'collapse-btn';
    btn.type = 'button';
    btn.title = 'Згорнути / розгорнути';
    btn.setAttribute('aria-label', 'Згорнути панель');
    btn.textContent = '▾';
    btn.onclick = (e) => {
      e.stopPropagation();
      const off = el.classList.toggle('collapsed');
      btn.textContent = off ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!off));
      saved[id] = off ? 1 : 0;
      persist();
      try { mapUI.map.invalidateSize(false); } catch { /* ignore */ }
    };
    if (head.classList.contains('panel-head')) head.appendChild(btn);
    else { btn.classList.add('float'); el.appendChild(btn); }
    if (saved[id]) { el.classList.add('collapsed'); btn.textContent = '▸'; }
  });

  // ONE toggle for the whole bottom row (Активні тривоги + Останні події).
  const statsRow = document.querySelector('.stats-row');
  if (statsRow) {
    const head = statsRow.querySelector('.panel .panel-head');
    if (head) {
      const btn = document.createElement('button');
      btn.className = 'collapse-btn';
      btn.type = 'button';
      btn.title = 'Згорнути / розгорнути блок';
      btn.setAttribute('aria-label', 'Згорнути блок статистики та подій');
      btn.textContent = '▾';
      if (saved['stats-row']) { statsRow.classList.add('collapsed'); btn.textContent = '▸'; }
      btn.onclick = (e) => {
        e.stopPropagation();
        const off = statsRow.classList.toggle('collapsed');
        btn.textContent = off ? '▸' : '▾';
        btn.setAttribute('aria-expanded', String(!off));
        saved['stats-row'] = off ? 1 : 0;
        persist();
      };
      head.appendChild(btn);
    }
  }
}
// Mobile: the radar lives in the bottom stats row (compact); desktop: back to
// the right column. Pure DOM move — the scope keeps running in both places.
function layoutRadar() {
  const radar = document.querySelector('.radar-mini');
  const centerCol = document.querySelector('.center-col');
  const statsRow = document.querySelector('.stats-row');
  const rightCol = document.querySelector('.right-col');
  if (!radar || !statsRow || !rightCol || !centerCol) return;
  const mobile = window.matchMedia('(max-width:760px)').matches;
  if (mobile) {
    // Directly under the map — the radar is visible without hunting for it.
    if (radar.nextElementSibling !== statsRow || radar.parentElement !== centerCol) {
      centerCol.insertBefore(radar, statsRow);
    }
    radar.classList.add('radar-own-panel');
  } else {
    // Top of the right column, above «Поточні загрози»: visible on first paint.
    if (rightCol.firstElementChild !== radar) rightCol.insertBefore(radar, rightCol.firstElementChild);
    radar.classList.remove('radar-own-panel');
  }
  try { scopeMini.setActive(true); } catch { /* ignore */ }
  try { mapUI.map.invalidateSize(false); } catch { /* ignore */ }
}
function setupRadarLayout() {
  layoutRadar();
  window.addEventListener('resize', () => { layoutRadar(); });
}
function setupMenu() {
  const b = $('#menuButton'), m = $('#topMenu');
  if (!b || !m) return;
  b.onclick = () => { const open = m.hidden; m.hidden = !open; b.setAttribute('aria-expanded', String(open)); };
  m.addEventListener('click', () => { m.hidden = true; });
}
function setupDialogs() {
  $$('dialog .sheet-close').forEach(b => b.onclick = () => b.closest('dialog').close());
  $$('[data-report-close]').forEach(b => b.onclick = () => $('#reportDialog').close());
  const en = $('#enableAudio'), la = $('#laterAudio');
  if (en) en.onclick = async () => { try { await state.audio.enable(); } catch { /* denied */ } $('#audioPrompt').close(); };
  if (la) la.onclick = () => $('#audioPrompt').close();
  const ex = $('#exitQuiet');
  if (ex) ex.onclick = () => { $('#quietScreen').hidden = true; };
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.threat-row');
    if (row && row.dataset.lat && mapUI) {
      mapUI.map.setView([+row.dataset.lat, +row.dataset.lon], 8);
      scrollMap();
    }
  });
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}
tickClock();
setInterval(tickClock, 20000);
setupTheme();
setupViews();
setupNavAutoHide();
setupCollapsibles();
setupRadarLayout();
setupMenu();setupDialogs();
initMap();
setupSearch();
setupSegs();
load();
setInterval(load, POLL_MS);
loadRegionsDir();
// Radar/map centre: ask for the operator's position on boot (silently — no
// map jump). Falls back to the selected place, then to Ukraine's centre.
locateMe(true);
