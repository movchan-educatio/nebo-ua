// НЕБО UA — premium dashboard bootstrap.
// Data layer: services/data.js (aggregator + direct fallback), services/
// overview.js (pure view-models), assets/js/map.js (GIS, untouched),
// assets/js/scope.js (radar, untouched). No invented data anywhere.
import { fetchAll, shouldPoll, POLL_MS } from '../../services/data.js';
import { createStore, syncStore } from '../../services/tracks.js';
import { createSituationMap, getThreatVisual } from './map.js';
import { createScope } from './scope.js';
import { fetchRegions } from '../../services/regions.js';
import { oblastRaions, raionAlertActive, territorialDanger, normOblast } from '../../services/districts.js';
import { getOblastRaionPolygons } from '../../services/raionShapesLocal.js';
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
function setupTheme() {
  const root = document.documentElement;
  try {
    if (localStorage.getItem('nebo-theme') === 'light') root.dataset.theme = 'light';
  } catch { /* ignore */ }
  $('#themeButton').onclick = () => {
    const next = root.dataset.theme === 'light' ? '' : 'light';
    if (next) root.dataset.theme = next;
    else delete root.dataset.theme;
    try { localStorage.setItem('nebo-theme', next || 'dark'); } catch { /* ignore */ }
  };
}

// ── Views (dialog panels) ─────────────────────────────────────────────────
function openSheet(html) {
  const d = $('#detailSheet');
  $('#detailContent').innerHTML = html;
  if (typeof d.showModal === 'function' && !d.open) d.showModal();
}
function setupViews() {
  const handlers = { map: scrollMap, radar: scrollRadar, stats: showStats, history: showHistory, alerts: showAlerts, sources: showSources, about: () => location.assign('./about/') };
  const onNav = (v) => {
    $$('.mainnav button, .bottom-nav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    (handlers[v] || scrollMap)();
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) onNav(b.dataset.view);
  });
  $$('[data-view]').forEach(b => b.addEventListener('click', () => onNav(b.dataset.view)));
}
function scrollMap() { $('#mapPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function scrollRadar() {
  openRadarBig();
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
function renderThreats(events) {
  const rows = groupThreats(events, 30);
  $('#threatCount').textContent = rows.filter(r => !r.stale).length;
  $('#threatList').innerHTML = rows.length ? rows.map(r => `
    <button class="threat-row" data-lat="${r.lat}" data-lon="${r.lon}" data-id="${esc(r.id)}">
      <span class="threat-ico" style="background:#ffffff0d">${threatIcon(r.kind)}</span>
      <span><b>${esc(r.region || r.district || 'Невідома територія')}</b>
      <small>${esc(r.subtype || r.kind)} · ${esc(r.source || '')}</small>
      <time>${r.eventTime ? esc(clock(r.eventTime)) + ' · ' + esc(ago(r.eventTime)) : '—'}</time></span>
      <span class="live-tag${r.stale ? ' stale' : ''}">${r.stale ? 'STALE' : 'LIVE'}</span>
    </button>`).join('') : '<p class="micro">Активних точкових цілей немає.</p>';
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
let mapUI = null, scopeMini = null, raionFills = [];
function initMap() {
  mapUI = createSituationMap($('#map'), onTerritory);
  mapUI.map.setView([48.6, 31.2], 6);
  scopeMini = createScope($('#scopeMini'));
  $('#zoomIn').onclick = () => mapUI.map.zoomIn();
  $('#zoomOut').onclick = () => mapUI.map.zoomOut();
  $('#gpsButton').onclick = locateMe;
  $('#layerButton').onclick = () => { const p = $('#layerPanel'); p.hidden = !p.hidden; };
  renderLayerPanel();
}
function renderLayerPanel() {
  const p = $('#layerPanel');
  const rows = [
    ['satellite', 'Супутник'], ['monitoring', 'Моніторинг'], ['alerts', 'Тривоги'],
    ['raions', 'Райони'], ['shapes', 'Межі'], ['wind', 'Вітер'],
  ];
  p.innerHTML = rows.map(([k, n]) => {
    const on = k === 'satellite' ? state.layers.satellite : true;
    return `<label style="display:flex;gap:8px;align-items:center;min-height:40px;font-size:13px"><input type="checkbox" data-layer="${k}"${on ? ' checked' : ''}>${n}</label>`;
  }).join('');
  p.querySelectorAll('input').forEach(i => i.onchange = () => {
    if (i.dataset.layer === 'satellite') state.layers.satellite = i.checked;
    mapUI.toggle(i.dataset.layer, i.checked);
  });
}
function locateMe() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    mapUI.setUserPos({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy });
    mapUI.centerOnUser();
  }, () => { /* denied: stay silent */ }, { timeout: 8000 });
}
function onTerritory(item) {
  // item: raion fill {oblast, district, level} or oblast feature.
  const card = $('#terrCard');
  const oblast = item?.oblast || item?.name || '';
  const district = item?.district || null;
  const st = state.snapshot;
  const scope = oblast ? raionAlertActive(st?.alerts || [], oblast, district) : null;
  const official = (st?.alerts || []).filter(a => a.official && (!oblast || a.region === oblast) && (!district || a.district === district));
  const threats = (st?.events || []).filter(e => !oblast || e.region === oblast || e.derivedRegion === oblast).slice(0, 5);
  const levels = [...new Set(official.map(a => a.level).filter(Boolean))];
  card.innerHTML = `
    <h3>${esc(district ? district + ' район' : oblast || 'Територія')}</h3>
    <div class="sub">${esc(oblast || '')} · ${scope ? ({ oblast: 'вся область', raion: 'район', outside: 'спокійно' }[scope.scope] || scope.scope) : 'немає даних'}</div>
    <div class="terr-grid">
      <div class="terr-field"><span>Статус</span><b>${official.length ? 'Тривога' : 'Спокійно'}</b></div>
      <div class="terr-field"><span>Рівень</span><b>${levels.includes('red') ? 'Високий' : levels.includes('yellow') ? 'Підвищений' : '—'}</b></div>
      <div class="terr-field"><span>Джерело</span><b>${esc(official[0]?.source || threats[0]?.source || '—')}</b></div>
      <div class="terr-field"><span>Оновлено</span><b>${state.lastSuccess ? esc(clock(state.lastSuccess)) : '—'}</b></div>
    </div>
    ${official.slice(0, 3).map(a => `<p class="micro">• ${esc(a.subtype || 'Тривога')} · початок ${a.eventTime ? esc(clock(a.eventTime)) : '—'}</p>`).join('')}
    ${threats.slice(0, 3).map(e => `<p class="micro">• ${esc(e.subtype || e.kind || 'Ціль')} · ${e.eventTime ? esc(clock(e.eventTime)) : '—'}</p>`).join('')}
    <div class="terr-actions">
      <button class="btn-primary" id="terrHistory">Історія тривог ›</button>
      <button class="btn-ghost" id="terrClose">Закрити</button>
    </div>`;
  card.classList.add('open');
  $('#terrClose').onclick = () => card.classList.remove('open');
  $('#terrHistory').onclick = () => showHistory(oblast, district);
}
async function refreshMap() {
  const st = state.snapshot;
  if (!st || !mapUI) return;
  if (state.geo) {
    try { mapUI.setRegions(state.geo, st.alerts, st.events); } catch { /* keep old frame */ }
  }
  // Raion fills for stats + shapes (honest polygons only).
  try {
    const { fills } = territorialDanger(st.alerts, st.events);
    raionFills = fills || [];
    const withPolys = [];
    for (const f of raionFills.slice(0, 60)) {
      try {
        const polys = await getOblastRaionPolygons(f.oblast);
        const g = (polys || []).find(g => g.name === f.district);
        if (g?.polys) withPolys.push({ ...f, polys: g.polys });
      } catch { /* skip missing geometry: no phantom polygons */ }
    }
    const vis = state.detail === 'country' ? withPolys
      : state.detail === 'oblast' ? [] : withPolys;
    mapUI.setAlertShapes(vis, onTerritory);
  } catch { /* shapes best effort */ }
  try {
    const { syncStore: sync } = await import('../../services/tracks.js').catch(() => ({}));
    void sync;
    syncStore(state.tracks, st.events);
    mapUI.setEvents(st.events, new Set(['uav', 'missile', 'ballistic', 'kab', 'aviation', 'shahed', 'recon', 'other']), null, null);
  } catch { /* markers best effort */ }
  // Mini radar: confirmed coordinates only.
  try {
    scopeMini.update((st.events || []).filter(e => e.lat != null && !e.areaOnly), null, { range: 100 });
  } catch { /* radar best effort */ }
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

// ── Detail + basemap segs ─────────────────────────────────────────────────
function setupSegs() {
  $('#detailSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.detail = b.dataset.detail;
    $$('#detailSeg button').forEach(x => x.classList.toggle('active', x === b));
    refreshMap();
  });
  let relief = null;
  $('#baseSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !mapUI) return;
    state.base = b.dataset.base;
    $$('#baseSeg button').forEach(x => x.classList.toggle('active', x === b));
    mapUI.toggle('satellite', state.base === 'sat');
    try {
      if (state.base === 'relief') {
        if (!relief) relief = window.L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenStreetMap, SRTM | style: © OpenTopoMap (CC-BY-SA)' });
        relief.addTo(mapUI.map);
      } else if (relief && mapUI.map.hasLayer(relief)) {
        mapUI.map.removeLayer(relief);
      }
    } catch { /* basemap best effort */ }
  });
}

// ── Stats / history / alerts / sources panels ─────────────────────────────
function showStats() {
  const st = state.snapshot;
  const s = computeAlertStats(st?.alerts || []);
  const byKind = {};
  for (const e of st?.events || []) {
    if (e.lat == null || e.areaOnly) continue;
    byKind[e.category || 'other'] = (byKind[e.category || 'other'] || 0) + 1;
  }
  openSheet(`<span class="kicker">СТАТИСТИКА</span><h2>Підтверджені дані</h2>
    <div class="terr-grid">
      <div class="terr-field"><span>Областей у тривозі</span><b>${s.oblasts}</b></div>
      <div class="terr-field"><span>Районів у тривозі</span><b>${s.raions}</b></div>
      <div class="terr-field"><span>Громад у тривозі</span><b>${s.communities}</b></div>
      <div class="terr-field"><span>Точкових цілей</span><b>${(st?.events || []).filter(e => e.lat != null && !e.areaOnly).length}</b></div>
    </div>
    <p class="micro">Офіційні тривоги й моніторингові цілі рахуються окремо; одна територія з двох джерел — один запис. Період: поточний зріз ${state.lastSuccess ? esc(clock(state.lastSuccess)) : '—'}.</p>
    ${Object.entries(byKind).map(([k, v]) => `<p class="micro">• ${esc(k)}: <b>${v}</b></p>`).join('') || '<p class="micro">Цілей немає.</p>'}`);
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
    <p class="micro">Офіційні тривоги — <a href="https://www.ukrainealarm.com/" target="_blank" rel="noopener" class="top-links-link">UkraineAlarm</a> (ключ лише на сервері). НЕБО.UA не є його партнером. Моніторинг цілей — NEPTUN і MAPA. <a href="./sources/" class="top-links-link">Розгорнута сторінка джерел ›</a></p>`);
}
function openRadarBig() {
  openSheet(`<span class="kicker">РАДАР</span><h2>Розгорнутий огляд</h2>
    <div class="radar-screen" style="max-height:420px"><canvas id="scopeBig" aria-label="Радар-огляд"></canvas></div>
    <p class="radar-note">Лише цілі з підтвердженими координатами (NEPTUN/MAPA). Тривоги областей — не цілі.</p>`);
  try {
    const big = createScope($('#scopeBig'));
    big.update((state.snapshot?.events || []).filter(e => e.lat != null && !e.areaOnly), null, { range: 100 });
  } catch { /* radar best effort */ }
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
    refreshMap();
    const notice = $('#networkNotice');
    if (snap.health?.OFFICIAL?.status === 'offline') {
      notice.hidden = false;
      notice.textContent = 'Офіційний статус тривог тимчасово недоступний. Моніторингові дані не замінюють офіційний статус.';
    } else notice.hidden = true;
  } catch {
    const el = $('#sysStatus');
    el.className = 'sysok bad';
    el.querySelector('.txt').textContent = 'Немає з’єднання';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
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
setupMenu();
setupDialogs();
initMap();
setupSearch();
setupSegs();
load();
setInterval(load, POLL_MS);
loadRegionsDir();
