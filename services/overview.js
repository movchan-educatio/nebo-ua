// Pure helpers for the premium dashboard (no DOM). Testable in node.
import { classifyThreat } from './threatClassify.js';

// Honest alert counts: oblasts = distinct regions with any official alert;
// raions = distinct (region,district) with district set; communities =
// distinct community-level names (district slot filled from a Community
// region). One territory counted once even if NEPTUN+UA both report it.
export function computeAlertStats(alerts) {
  const oblasts = new Set();
  const raions = new Set();
  const communities = new Set();
  for (const a of alerts || []) {
    if (!a || !a.region) continue;
    oblasts.add(a.region);
    if (a.district) {
      raions.add(a.region + '||' + a.district);
      if (a.locationPrecision === 'RAION' && a.source === 'OFFICIAL' && /громада/i.test(a.district)) {
        communities.add(a.region + '||' + a.district);
      }
    }
  }
  return { oblasts: oblasts.size, raions: raions.size, communities: communities.size };
}

// Threat feed rows: exact-tier monitoring events only (never area-only
// officials as fake targets). Sorted newest first, capped.
export function groupThreats(events, limit = 30) {
  const rows = (events || [])
    .filter(e => e && e.lat != null && e.lon != null && !e.areaOnly)
    .sort((a, b) => new Date(b.eventTime || b.timestamp || 0) - new Date(a.eventTime || a.timestamp || 0));
  return rows.slice(0, limit).map(e => ({
    id: e.id,
    kind: classifyThreat(e),
    category: e.category,
    region: e.region || e.derivedRegion || null,
    district: e.district || null,
    subtype: e.subtype || null,
    eventTime: e.eventTime || e.timestamp || null,
    stale: !!e.stale,
    source: e.source || null,
    lat: e.lat, lon: e.lon,
  }));
}

// History rows from /v1/official/history items. Duration in minutes from
// start/end when both exist; open alarms (no endDate) show "триває".
// Never invents dates: missing start -> null row time.
export function formatHistory(items, limit = 25) {
  return (items || []).slice(0, limit).map(h => {
    const start = h?.startDate ? new Date(h.startDate) : null;
    const end = h?.endDate ? new Date(h.endDate) : null;
    const okStart = start && Number.isFinite(start.getTime());
    const okEnd = end && Number.isFinite(end.getTime());
    const durMin = okStart && okEnd ? Math.max(0, Math.round((end - start) / 60000)) : null;
    return {
      regionId: h?.regionId || null,
      regionName: h?.regionName || null,
      start: okStart ? start.toISOString() : null,
      end: okEnd ? end.toISOString() : null,
      durMin,
      ongoing: okStart && !okEnd,
      alertType: h?.alertType || 'UNKNOWN',
      isContinue: h?.isContinue === true,
    };
  });
}

// Territory search over oblast names + region directory entries.
// Case-insensitive substring, capped, oblasts first.
export function matchTerritory(query, oblastNames = [], dirRegions = [], limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const name of oblastNames) {
    if (name && name.toLowerCase().includes(q)) {
      out.push({ name, kind: 'oblast', regionId: null });
      if (out.length >= limit) return out;
    }
  }
  for (const r of dirRegions) {
    if (!r?.regionName || !r.regionId) continue;
    if (r.regionName.toLowerCase().includes(q)
      && !out.some(o => o.name === r.regionName)) {
      out.push({ name: r.regionName, kind: (r.regionType || '').toLowerCase() || 'region', regionId: r.regionId });
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Source cards view-model from /v1/state health. ONLINE/DEGRADED/OFFLINE/
// RECOVERING/STALE/IDLE map explicitly: delayed flag => DEGRADED (data old
// but real); missing updatedAt on online => STALE (unconfirmed freshness).
// RECOVERING = this check succeeded right after a recorded failure.
export function sourceCards(health, nowMs = Date.now()) {
  const defs = [
    { key: 'OFFICIAL', name: 'UkraineAlarm API', sub: 'Офіційні дані тривог', ico: 'ua' },
    { key: 'NEPTUN', name: 'NEPTUN', sub: 'Рух цілей (БПЛА, ракети)', ico: 'nep' },
    { key: 'MAPA', name: 'MAPA', sub: 'Додаткові спостереження', ico: 'mapa' },
  ];
  return defs.map(d => {
    const h = health?.[d.key];
    let state = 'IDLE', label = 'Вимкнено';
    if (h) {
      if (h.status === 'disabled') { state = 'IDLE'; label = 'Вимкнено'; }
      else if (h.status === 'offline') { state = 'OFFLINE'; label = 'Офлайн'; }
      else if (h.status === 'recovering') { state = 'RECOVERING'; label = 'Відновлення'; }
      else if (h.delayed) { state = 'DEGRADED'; label = 'Застарілі дані'; }
      else if (!h.updatedAt) { state = 'STALE'; label = 'Не підтверджено'; }
      else if (!Number.isFinite(Date.parse(h.updatedAt)) || nowMs - Date.parse(h.updatedAt) > 3 * 60000) {
        state = 'STALE'; label = 'Перевірка затримується';
      }
      else { state = 'ONLINE'; label = 'Онлайн'; }
    }
    return { ...d, state, label, updatedAt: h?.updatedAt || null, error: h?.error || null };
  });
}

// Overall system badge from per-source states + pipeline age.
// The aggregate reflects the two PRIMARY sources only (NEPTUN, MAPA): an
// auxiliary source (UkraineAlarm) being offline must not drag a healthy
// monitoring pipeline into warning. Cards without a key (legacy callers)
// fall back to the whole set.
export function systemBadge(cards, pipelineAgeMs) {
  if (!cards.length) return { level: 'bad', text: 'Немає даних' };
  const primaries = cards.some(c => c.key)
    ? cards.filter(c => c.key === 'NEPTUN' || c.key === 'MAPA')
    : cards;
  const set = primaries.length ? primaries : cards;
  if (set.every(c => c.state === 'OFFLINE' || c.state === 'IDLE')) return { level: 'bad', text: 'Системи недоступні' };
  if (pipelineAgeMs != null && pipelineAgeMs > 30 * 60000) return { level: 'bad', text: 'Дані застарілі' };
  if (pipelineAgeMs != null && pipelineAgeMs > 3 * 60000 || set.some(c => c.state === 'STALE')) {
    return { level: 'warn', text: 'Перевірка затримується' };
  }
  if (set.some(c => c.state === 'RECOVERING')) {
    return { level: 'warn', text: 'Відновлення джерела' };
  }
  if (set.some(c => c.state === 'OFFLINE') || set.some(c => c.state === 'DEGRADED')) {
    return { level: 'warn', text: 'Часткові дані' };
  }
  return { level: 'ok', text: 'Всі системи працюють' };
}
