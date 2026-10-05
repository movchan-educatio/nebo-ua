// Local static GeoJSON raion shapes (post-2020 reform, 136 raions).
// Replaces runtime Overpass queries with pre-bundled, verified geometry.
// Source: slawomirmatuszak/ukrainian_geodata → rayony.geojson
import { fetchJson } from './http.js';

// Use import.meta.url so the path works regardless of the GitHub Pages
// repository subpath (e.g. /nebo-ua/) or any other base.
const RAIONS_GEOJSON_URL = new URL('../assets/data/ukraine-raions.geojson', import.meta.url).href;
const OBLASTS_GEOJSON_URL = new URL('../assets/data/ukraine-oblasts.geojson', import.meta.url).href;

let _raionsCache = null;
let _oblastsCache = null;
let _raionIndex = null; // Map<normalizedOblast, Map<normalizedRaion, feature>>

// Normalize raion name: remove "район", "р-н", case-insensitive, trim.
// Unify apostrophes: API uses ’ (U+2019), GeoJSON uses ' (U+0027).
export function normRaion(s) {
  return String(s || '').replace(/[’‘ʼ`´]/g, "'").toLowerCase().replace(/район|р-н|рн\b/g, ' ').replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}

// Normalize oblast name
export function normOblast(s) {
  return String(s || '').toLowerCase().replace(/область|обл\.?|м\.|місто/g, ' ').replace(/[\s_]+/g, ' ').trim();
}

// Load and index raions GeoJSON
async function loadRaionsIndex() {
  if (_raionIndex) return _raionIndex;
  const geo = await fetchJson(RAIONS_GEOJSON_URL, { timeout: 5000 });
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('Invalid raions GeoJSON');
  }
  const index = new Map();
  for (const f of geo.features) {
    const rayon = f.properties?.rayon;
    if (!rayon) continue;
    // Expect rayon like "Уманський район" - extract oblast from geometry containment or separate mapping
    // For now, we'll need a mapping from raion to oblast. We'll build it by point-in-polygon against oblasts.
    // But for fast lookup, let's just index by raion name and also store the feature.
    const nRaion = normRaion(rayon);
    if (!index.has(nRaion)) index.set(nRaion, []);
    index.get(nRaion).push(f);
  }
  _raionIndex = index;
  return index;
}

// Load oblasts for point-in-polygon containment
async function loadOblasts() {
  if (_oblastsCache) return _oblastsCache;
  const geo = await fetchJson(OBLASTS_GEOJSON_URL, { timeout: 5000 });
  if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
    throw new Error('Invalid oblasts GeoJSON');
  }
  _oblastsCache = geo;
  return geo;
}

// Point-in-polygon test
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInFeature([lat, lon], feature) {
  const polys = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry?.coordinates || [];
  return polys.some(poly => pointInRing([lon, lat], poly[0] || []));
}

// Get centroid of first ring for point-in-polygon testing
function getCentroid(feature) {
  const coords = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry?.coordinates?.[0]?.[0];
  if (!coords || !coords.length) return null;
  let x = 0, y = 0;
  for (const [lon, lat] of coords) { x += lat; y += lon; }
  return [x / coords.length, y / coords.length];
}

// Build raion->oblast mapping by containment.
// Fast path: vertex-average centroid inside an oblast polygon.
// Fallback (coastal/concave shapes whose centroid falls in the sea):
// majority vote over sampled outer-ring vertices with bbox prefilter,
// winner-takes-all above 0.5.
function oblastBbox(feature) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  const walk = (coords) => {
    for (const p of coords) {
      if (typeof p?.[0] === 'number') {
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
      } else if (Array.isArray(p)) walk(p);
    }
  };
  walk(feature.geometry?.coordinates || []);
  return { minLat, maxLat, minLon, maxLon };
}
function inBbox([lat, lon], b) {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}
function outerRings(feature) {
  if (feature.geometry?.type === 'Polygon') return [feature.geometry.coordinates[0]];
  if (feature.geometry?.type === 'MultiPolygon') return feature.geometry.coordinates.map(p => p[0]);
  return [];
}
function oblastNameOf(ob) {
  return normOblast(ob.properties?.region || ob.properties?.key || ob.properties?.NAME_1 || '');
}
async function buildRaionOblastMap() {
  const [raionsGeo, oblastsGeo] = await Promise.all([loadRaionsIndex(), loadOblasts()]);
  const prepared = oblastsGeo.features.map(ob => ({ ob, name: oblastNameOf(ob), bbox: oblastBbox(ob) })).filter(p => p.name);
  const map = new Map(); // normRaion -> normOblast
  const containingOblast = (pt) => {
    for (const p of prepared) {
      if (inBbox(pt, p.bbox) && pointInFeature(pt, p.ob)) return p.name;
    }
    return null;
  };
  for (const [nRaion, features] of raionsGeo) {
    const f = features[0];
    if (!f) continue;
    const centroid = getCentroid(f);
    const direct = centroid && containingOblast(centroid);
    if (direct) { map.set(nRaion, direct); continue; }
    // Majority vote fallback.
    const votes = new Map();
    let total = 0;
    for (const ring of outerRings(f)) {
      const step = Math.max(1, Math.floor(ring.length / 60));
      for (let i = 0; i < ring.length; i += step) {
        const pt = [ring[i][1], ring[i][0]];
        total++;
        const hit = containingOblast(pt);
        if (hit) votes.set(hit, (votes.get(hit) || 0) + 1);
      }
    }
    if (!total) continue;
    let best = null, bestVotes = 0;
    for (const [name, v] of votes) {
      if (v > bestVotes) { bestVotes = v; best = name; }
    }
    if (best && bestVotes / total > 0.5) map.set(nRaion, best);
  }
  return map;
}

let _raionOblastMap = null;
export async function getRaionOblastMap() {
  if (!_raionOblastMap) _raionOblastMap = await buildRaionOblastMap();
  return _raionOblastMap;
}

/**
 * Get raion polygon feature by oblast and raion name (normalized).
 * Returns { feature, rings, polys } or null if not found.
 * rings: array of [lat,lon] arrays (outer rings only)
 * polys: array of polygon coordinates for L.polygon (assembled)
 */
export async function getRaionPolygon(oblast, raion) {
  const nOblast = normOblast(oblast);
  const nRaion = normRaion(raion);
  if (!nOblast || !nRaion) return null;

  const index = await loadRaionsIndex();
  // Direct hit, then reverse-alias (API post-rename -> GeoJSON pre-rename).
  const candidates = index.get(nRaion) || index.get(resolveReverseAlias(nRaion));
  if (!candidates || !candidates.length) return null;

  // If multiple candidates (same raion name in different oblasts), filter by oblast containment
  let feature = candidates[0];
  if (candidates.length > 1) {
    const raionOblastMap = await getRaionOblastMap();
    for (const f of candidates) {
      const centroid = getCentroid(f);
      if (!centroid) continue;
      const mappedOblast = raionOblastMap.get(nRaion);
      if (mappedOblast === nOblast) { feature = f; break; }
    }
  }

  // Assemble rings for Leaflet polygon
  const rings = [];
  const geom = feature.geometry;
  if (geom?.type === 'Polygon') {
    rings.push(geom.coordinates[0].map(([lon, lat]) => [lat, lon]));
  } else if (geom?.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      rings.push(poly[0].map(([lon, lat]) => [lat, lon]));
    }
  }

  // For fill (polys), use the same rings (simplified - no inner rings assembly for now)
  const polys = rings;

  return { feature, rings, polys };
}

/**
 * Get all raion polygons for an oblast (for batch rendering).
 * Returns array of { name, rings, polys, feature }.
 */
export async function getOblastRaionPolygons(oblast) {
  const nOblast = normOblast(oblast);
  if (!nOblast) return [];
  const index = await loadRaionsIndex();
  const raionOblastMap = await getRaionOblastMap();
  const results = [];
  for (const [nRaion, features] of index) {
    if (raionOblastMap.get(nRaion) !== nOblast) continue;
    const f = features[0];
    const rings = [];
    if (f.geometry?.type === 'Polygon') {
      rings.push(f.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]));
    } else if (f.geometry?.type === 'MultiPolygon') {
      for (const poly of f.geometry.coordinates) {
        rings.push(poly[0].map(([lon, lat]) => [lat, lon]));
      }
    }
    if (rings.length) {
      results.push({ name: f.properties.rayon, rings, polys: rings, feature: f });
    }
  }
  return results;
}

/**
 * Get oblast polygon feature by name.
 */
export async function getOblastPolygon(oblast) {
  const nOblast = normOblast(oblast);
  if (!nOblast) return null;
  const geo = await loadOblasts();
  const feature = geo.features.find(f => normOblast(f.properties?.region || f.properties?.key || f.properties?.NAME_1 || '') === nOblast);
  if (!feature) return null;
  const rings = [];
  if (feature.geometry?.type === 'Polygon') {
    rings.push(feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]));
  } else if (feature.geometry?.type === 'MultiPolygon') {
    for (const poly of feature.geometry.coordinates) {
      rings.push(poly[0].map(([lon, lat]) => [lat, lon]));
    }
  }
  return { feature, rings, polys: rings };
}

// Aliases for old names (matching districts.js ALIASES): GeoJSON carries the
// pre-rename names, the API carries post-rename names.
export const ALIASES = {
  'новомосковський': 'самарівський',
  'красноградський': 'берестинський',
  'червоноградський': 'шептицький',
  'новоград-волинський': 'звягельський',
  'володимир-волинський': 'володимирський',
  'свердловський': 'довжанський',
  'северодонецький': 'сєвєродонецький',
  'сіверськодонецький': 'сєвєродонецький',
};
// Reverse map: API (new name) -> GeoJSON (old name).
const REVERSE_ALIASES = Object.fromEntries(Object.entries(ALIASES).map(([o, n]) => [n, o]));

export function resolveAlias(nRaion) {
  return ALIASES[nRaion] || nRaion;
}

export function resolveReverseAlias(nRaion) {
  return REVERSE_ALIASES[nRaion] || nRaion;
}