import { fetchJson } from './http.js';

const CACHE_KEY = 'nebo-wind-cache-v1';
const CACHE_MS = 30 * 60000;
// Open-Meteo: free, no key, CORS open. Paired lat[i]/lon[i] points across Ukraine.
const POINTS = [
  [50.45, 30.52], // Kyiv
  [49.84, 24.03], // Lviv
  [46.48, 30.72], // Odesa
  [49.99, 36.23], // Kharkiv
  [48.46, 35.04], // Dnipro
  [47.83, 35.18], // Zaporizhzhia
  [49.23, 28.46], // Vinnytsia
  [50.75, 25.33], // Lutsk
];

export async function fetchWind(signal) {
  const cached = readCache();
  if (cached) return cached;
  const lat = POINTS.map(p => p[0]).join(',');
  const lon = POINTS.map(p => p[1]).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m&forecast_days=1&wind_speed_unit=kmh&timezone=auto`;
  const data = await fetchJson(url, { signal, timeout: 10000 });
  const list = Array.isArray(data) ? data : [data];
  const now = Date.now();
  const items = list.map((d, i) => pickClosest(d, POINTS[i], now)).filter(Boolean);
  const result = { at: new Date().toISOString(), items };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)); } catch (e) {}
  return result;
}

function pickClosest(d, point, now) {
  const times = d?.hourly?.time;
  const speeds = d?.hourly?.wind_speed_10m;
  const dirs = d?.hourly?.wind_direction_10m;
  if (!Array.isArray(times) || !Array.isArray(speeds) || !Array.isArray(dirs)) return null;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - now);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  const speedKmh = Number(speeds[best]);
  const fromDeg = Number(dirs[best]);
  if (!Number.isFinite(speedKmh) || !Number.isFinite(fromDeg)) return null;
  return { lat: point[0], lon: point[1], speedKmh: Math.round(speedKmh), fromDeg: Math.round(fromDeg) };
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.at || !Array.isArray(parsed.items)) return null;
    if (Date.now() - new Date(parsed.at).getTime() > CACHE_MS) return null;
    return parsed;
  } catch (e) { return null; }
}
