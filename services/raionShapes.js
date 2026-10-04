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
export function assembleRings(members) {
  const ways = (members || [])
    .filter(m => m && m.role !== 'inner' && Array.isArray(m.geometry))
    .map(m => m.geometry.map(p => [p.lat, p.lon]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    .filter(w => w.length > 1);
  const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
  const rings = [];
  const used = new Array(ways.length).fill(false);
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let ring = [...ways[i]];
    let extended = true;
    while (extended) {
      extended = false;
      const sKey = key(ring[0]), eKey = key(ring[ring.length - 1]);
      if (sKey === eKey) break;
      for (let j = 0; j < ways.length; j++) {
        if (used[j]) continue;
        const w = ways[j];
        if (key(w[0]) === eKey) { ring = ring.concat(w.slice(1)); used[j] = true; extended = true; break; }
        if (key(w[w.length - 1]) === eKey) { ring = ring.concat(w.slice(0, -1).reverse()); used[j] = true; extended = true; break; }
        if (key(w[w.length - 1]) === sKey) { ring = w.slice(0, -1).concat(ring); used[j] = true; extended = true; break; }
        if (key(w[0]) === sKey) { ring = w.slice(1).reverse().concat(ring); used[j] = true; extended = true; break; }
      }
    }
    if (ring.length > 3 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}
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
    if (name && rings.length) out.push({ name, rings, polys: assembleRings(el.members) });
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
