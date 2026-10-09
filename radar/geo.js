// РАДАР.LIVE — pure radar geometry (no DOM). Tested in node.
// Center is [lat, lon] (degrees). Range in km. Size in px (square canvas).
const R_EARTH_KM = 6371.0088;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const dLon = (lon2 - lon1) * p;
  const y = Math.sin(dLon) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p)
    - Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Equirectangular projection around the center, scaled so that `rangeKm`
// maps to the canvas radius (minus padding). Returns px coords + geodesic
// distance/bearing + inside flag. Never invents: no coords in -> null.
export function projectRadar(lat, lon, center, rangeKm, size, padPx = 10) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!Array.isArray(center) || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) return null;
  if (!Number.isFinite(rangeKm) || rangeKm <= 0 || !Number.isFinite(size) || size <= 0) return null;
  const kx = KM_PER_DEG_LON_AT_EQUATOR * Math.cos(center[0] * Math.PI / 180);
  const dx = (lon - center[1]) * kx;
  const dy = (lat - center[0]) * KM_PER_DEG_LAT;
  const distKm = haversineKm(center[0], center[1], lat, lon);
  const bearing = bearingDeg(center[0], center[1], lat, lon);
  const k = (size / 2 - padPx) / rangeKm;
  return {
    x: size / 2 + dx * k,
    y: size / 2 - dy * k,
    distKm,
    bearing,
    inside: distKm <= rangeKm,
  };
}

export function insideRadius(lat, lon, center, rangeKm) {
  const p = projectRadar(lat, lon, center, rangeKm, 100);
  return p ? p.inside : false;
}

export function formatDistanceKm(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  return km < 10
    ? km.toFixed(1).replace('.', ',') + ' км'
    : Math.round(km) + ' км';
}

export function formatBearing(bearing) {
  if (!Number.isFinite(bearing)) return '—';
  return 'А' + String(Math.round(bearing)).padStart(3, '0') + '°';
}

export function compassUk(bearing) {
  if (!Number.isFinite(bearing)) return '—';
  const names = ['північ', 'північний схід', 'схід', 'південний схід', 'південь', 'південний захід', 'захід', 'північний захід'];
  return names[Math.round(bearing / 45) % 8];
}

// Honesty levels (§4): 1 = coordinates, 2 = approximate zone (coords +
// declared uncertainty), 3 = region-only (no coords), 4 = unknown position.
// Only level 1-2 may become radar points; 3-4 stay text-only in the feed.
export function accuracyLevel(event) {
  if (!event) return 4;
  const hasCoord = Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lon));
  if (!hasCoord) {
    return (event.region || event.district || event.settlement) ? 3 : 4;
  }
  if (event.areaOnly === true) return 3;
  const pq = String(event.positionQuality || '');
  if (['area', 'raion', 'district', 'region'].includes(pq)) return 3;
  const unc = Number(event.uncertaintyKm);
  if (Number.isFinite(unc) && unc > 0) return 2;
  return 1;
}

export function radarPoint(event, center, rangeKm, size) {
  // Feed honesty gate: no coords -> no point, ever. No centroid invention.
  if (accuracyLevel(event) > 2) return null;
  const lat = Number(event.lat), lon = Number(event.lon);
  const p = projectRadar(lat, lon, center, rangeKm, size);
  if (!p || !p.inside) return null;
  return { ...p, id: event.trackId ?? event.id ?? null };
}

// Ring layout for a selected max range: 4 rings at 25/50/75/100%.
export function rangeRings(rangeKm) {
  if (!Number.isFinite(rangeKm) || rangeKm <= 0) return [];
  return [0.25, 0.5, 0.75, 1].map(f => Math.round(rangeKm * f * 10) / 10);
}
