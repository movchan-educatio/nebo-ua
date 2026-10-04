// Raion border shapes from OpenStreetMap Overpass (admin levels 6/7).
// Borders-only polylines (no polygon assembly): honest outlines, cached 7 days.
// Any failure returns null and the caller keeps the oblast view.
import { fetchJson } from './http.js';
const CACHE_KEY = 'nebo-raion-shapes-v1';
const CACHE_TTL = 7 * 24 * 3600000;
const MAX_OBLASTS = 2;
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export function overpassToRings(data) {
  const out = [];
  for (const el of data?.elements || []) {
    if (el?.type !== 'relation' || !Array.isArray(el.members)) continue;
    const name = el.tags?.['name:uk'] || el.tags?.name || null;
    const rings = [];
    for (const m of el.members) {
      if (m?.role !== 'outer' && m?.role !== '') continue;
      const pts = (m.geometry || []).map(p => [p.lat, p.lon]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length > 1) rings.push(pts);
    }
    if (name && rings.length) out.push({ name, rings });
  }
  return out;
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return c && typeof c === 'object' ? c : {};
  } catch (e) { return {}; }
}
export async function fetchRaionBorders(oblast, signal) {
  const now = Date.now();
  const cache = loadCache();
  const hit = cache[oblast];
  if (hit && now - new Date(hit.at).getTime() < CACHE_TTL && Array.isArray(hit.rings)) return hit.rings;
  const q = '[out:json][timeout:45];area["name:uk"="' + oblast + '"]->.a;(rel["admin_level"~"^[67]$"](area.a););out geom;';
  let lastErr = null;
  for (const base of ENDPOINTS) {
    try {
      const data = await fetchJson(base + '?data=' + encodeURIComponent(q), { signal, timeout: 60000 });
      const rings = overpassToRings(data);
      if (!rings.length) { lastErr = new Error('empty'); continue; }
      const next = { [oblast]: { at: new Date().toISOString(), rings } };
      for (const k of Object.keys(cache).slice(0, MAX_OBLASTS - 1)) next[k] = cache[k];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch (e) {}
      return rings;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('unavailable');
}
