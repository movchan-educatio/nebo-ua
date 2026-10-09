// РАДАР.LIVE — pure feed/radar filtering (no DOM). Tested in node.
import { classifyThreat } from '../services/threatClassify.js';
import { accuracyLevel } from './geo.js';

// Filter kinds shown on the mockup. 'other' covers recon/fpv/explosion/other.
export const KIND_FILTERS = ['uav', 'missile', 'ballistic', 'kab', 'aviation', 'other'];

export function normalizeKind(event) {
  const kind = classifyThreat(event);
  if (kind === 'shahed') return 'uav'; // shaheds live under БпЛА per mockup
  if (KIND_FILTERS.includes(kind)) return kind;
  return 'other';
}

export function ageMinutes(event, nowMs = Date.now()) {
  const t = event?.eventTime ?? event?.timestamp ?? null;
  if (t == null) return null;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (nowMs - ms) / 60000);
}

// "New" = observed within the last 10 minutes (honest recency, not a status).
export function isNew(event, nowMs = Date.now()) {
  const age = ageMinutes(event, nowMs);
  return age != null && age <= 10;
}

// Active/completed derive from the data model (stale/ended), never from age
// alone: a fresh-looking record the source already ended is completed.
export function isActive(event) {
  if (!event) return false;
  if (event.status === 'ended') return false;
  return !event.stale;
}

export function isCompleted(event) {
  if (!event) return false;
  return event.status === 'ended' || !!event.stale;
}

export function hasCoords(event) {
  return Number.isFinite(Number(event?.lat)) && Number.isFinite(Number(event?.lon)) && !event?.areaOnly;
}

// Feed filtering (list): kinds + tabs + coords-only toggle.
// The feed may show region-only reports as TEXT rows (level 3-4), but they
// never become radar points (see geo.radarPoint gate).
export function applyFeedFilters(events, { kinds = null, tab = 'all', onlyNew = false, onlyActive = false, onlyWithCoords = false } = {}, nowMs = Date.now()) {
  let list = (events || []).slice();
  if (Array.isArray(kinds) && kinds.length) {
    const set = new Set(kinds);
    list = list.filter(e => set.has(normalizeKind(e)));
  }
  if (tab === 'new') list = list.filter(e => isNew(e, nowMs));
  else if (tab === 'active') list = list.filter(e => isActive(e));
  else if (tab === 'completed') list = list.filter(e => isCompleted(e));
  if (onlyNew) list = list.filter(e => isNew(e, nowMs));
  if (onlyActive) list = list.filter(e => isActive(e));
  if (onlyWithCoords) list = list.filter(e => hasCoords(e));
  return list.sort((a, b) => {
    const ta = new Date(a?.eventTime ?? a?.timestamp ?? 0).getTime() || 0;
    const tb = new Date(b?.eventTime ?? b?.timestamp ?? 0).getTime() || 0;
    return tb - ta;
  });
}

// Radar points: same feed result, additionally gated to accuracy level 1-2
// with real coordinates inside the selected radius. Returns the events that
// may be plotted (geometry is computed by geo.radarPoint at render time).
export function radarEvents(events, { kinds = null, onlyNew = false, onlyActive = false } = {}, nowMs = Date.now()) {
  return applyFeedFilters(events, { kinds, tab: 'all', onlyNew, onlyActive, onlyWithCoords: true }, nowMs)
    .filter(e => accuracyLevel(e) <= 2);
}

export function countByKind(events) {
  const out = { uav: 0, missile: 0, ballistic: 0, kab: 0, aviation: 0, other: 0 };
  for (const e of events || []) {
    const k = normalizeKind(e);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
