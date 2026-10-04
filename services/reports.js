// Local user marks: this device only, never uploaded, never mixed with monitoring events.
const KEY = 'nebo-local-reports-v1';
const MAX = 50;
const TTL_MS = 24 * 3600000;
export const REPORT_KINDS = {
  sound: 'Чув звук',
  sighting: 'Бачив проліт',
  other: 'Інше',
};

export function loadReports(now = Date.now()) {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const fresh = list.filter(r => r && Number.isFinite(r.lat) && Number.isFinite(r.lon) && now - new Date(r.at).getTime() < TTL_MS);
    if (fresh.length !== list.length) try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e) {}
    return fresh.slice(0, MAX);
  } catch (e) { return []; }
}

export function saveReport({ lat, lon, kind, note }) {
  const rounded = v => Math.round(Number(v) * 1000) / 1000;
  const item = {
    id: `r-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    lat: rounded(lat),
    lon: rounded(lon),
    kind: REPORT_KINDS[kind] ? kind : 'other',
    note: String(note || '').slice(0, 140),
    at: new Date().toISOString(),
  };
  if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) throw new Error('Немає координат');
  const list = [item, ...loadReports()].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(list));
  return item;
}

export function deleteReport(id) {
  const list = loadReports().filter(r => r.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  return list;
}
