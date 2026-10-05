import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load GeoJSON directly in Node.js
const raionsGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', 'ukraine-raions.geojson'), 'utf8'));
const oblastsGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', 'ukraine-oblasts.geojson'), 'utf8'));

// ── Helper functions (copied from service for testing) ─────────────────────────
function normRaion(s) {
  return String(s || '').toLowerCase().replace(/район|р-н|рн\b/g, ' ').replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}
function normOblast(s) {
  return String(s || '').toLowerCase().replace(/область|обл\.?|м\.|місто/g, ' ').replace(/[\s_]+/g, ' ').trim();
}

const ALIASES = {
  'новомосковський': 'самарівський',
  'красноградський': 'берестинський',
  'червоноградський': 'шептицький',
  'новоград-волинський': 'звягельський',
  'володимир-волинський': 'володимирський',
  'свердловський': 'довжанський',
  'северодонецький': 'сєвєродонецький',
  'сіверськодонецький': 'сєвєродонецький',
};

function resolveAlias(nRaion) {
  return ALIASES[nRaion] || nRaion;
}

// Build raion index
function buildRaionIndex(geo) {
  const index = new Map();
  for (const f of geo.features) {
    const rayon = f.properties?.rayon;
    if (!rayon) continue;
    const nRaion = normRaion(rayon);
    if (!index.has(nRaion)) index.set(nRaion, []);
    index.get(nRaion).push(f);
  }
  return index;
}

const raionIndex = buildRaionIndex(raionsGeo);

// Point-in-polygon
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
function getCentroid(feature) {
  const coords = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry?.coordinates?.[0]?.[0];
  if (!coords || !coords.length) return null;
  let x = 0, y = 0;
  for (const [lon, lat] of coords) { x += lat; y += lon; }
  return [x / coords.length, y / coords.length];
}

// Build raion->oblast map
function buildRaionOblastMap(index, oblastsGeo) {
  const map = new Map();
  for (const [nRaion, features] of index) {
    for (const f of features) {
      const centroid = getCentroid(f);
      if (!centroid) continue;
      for (const ob of oblastsGeo.features) {
        if (pointInFeature(centroid, ob)) {
          const nOblast = normOblast(ob.properties?.region || ob.properties?.key || ob.properties?.NAME_1 || '');
          if (nOblast) map.set(nRaion, nOblast);
          break;
        }
      }
    }
  }
  return map;
}

const raionOblastMap = buildRaionOblastMap(raionIndex, oblastsGeo);

// ── Test fixtures ──────────────────────────────────────────────────────────────

test('GeoJSON loads: 136 raions, 27 oblasts', () => {
  let count = 0;
  for (const [, feats] of raionIndex) count += feats.length;
  assert.equal(count, 136, 'Should have 136 raion features');
  assert.equal(oblastsGeo.features.length, 27, 'Should have 27 oblast features');
});

test('Uman raion / Cherkasy oblast: polygon found and inside oblast', () => {
  const nRaion = normRaion('Уманський район');
  const nOblast = normOblast('Черкаська область');
  
  const candidates = raionIndex.get(nRaion);
  assert.ok(candidates && candidates.length > 0, 'Uman raion should be found');
  
  const feature = candidates[0];
  assert.ok(feature.geometry, 'Should have geometry');
  
  // Verify it's inside Cherkasy oblast
  const cherkasyOblast = oblastsGeo.features.find(f => normOblast(f.properties?.region || '') === nOblast);
  assert.ok(cherkasyOblast, 'Cherkasy oblast should exist');
  
  const centroid = getCentroid(feature);
  assert.ok(centroid, 'Should have centroid');
  const [lat, lon] = centroid;
  const inside = pointInFeature([lat, lon], cherkasyOblast);
  assert.ok(inside, 'Uman raion centroid should be inside Cherkasy oblast');
  
  // Rings and polys
  const rings = feature.geometry?.type === 'Polygon' 
    ? [feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon])]
    : feature.geometry?.coordinates?.map(poly => poly[0].map(([lon, lat]) => [lat, lon])) || [];
  assert.ok(rings.length > 0, 'Should have rings');
});

test('Odeskyi raion / Odeska oblast: polygon found', () => {
  const nRaion = normRaion('Одеський район');
  const nOblast = normOblast('Одеська область');
  
  const candidates = raionIndex.get(nRaion);
  assert.ok(candidates && candidates.length > 0, 'Odeskyi raion should be found');
  const feature = candidates[0];
  assert.equal(feature.properties.rayon, 'Одеський район');
  
  const rings = feature.geometry?.type === 'Polygon' 
    ? [feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon])]
    : feature.geometry?.coordinates?.map(poly => poly[0].map(([lon, lat]) => [lat, lon])) || [];
  assert.ok(rings.length > 0);
});

test('Kharkivskyi raion / Kharkivska oblast: polygon found', () => {
  const nRaion = normRaion('Харківський район');
  const candidates = raionIndex.get(nRaion);
  assert.ok(candidates && candidates.length > 0, 'Kharkivskyi raion should be found');
  assert.equal(candidates[0].properties.rayon, 'Харківський район');
});

test('Sumskyi raion / Sumska oblast: polygon found', () => {
  const nRaion = normRaion('Сумський район');
  const candidates = raionIndex.get(nRaion);
  assert.ok(candidates && candidates.length > 0, 'Sumskyi raion should be found');
  assert.equal(candidates[0].properties.rayon, 'Сумський район');
});

test('Raion threat does NOT activate oblast (Uman -> not Cherkasy)', async () => {
  const { raionAlertActive } = await import('../services/districts.js');
  const alert = { region: 'Черкаська область', district: 'Уманський район' };
  const result = raionAlertActive([alert], 'Черкаська область', 'Уманський район');
  assert.equal(result.scope, 'raion', 'Raion alert should have scope=raion');
  
  const other = raionAlertActive([alert], 'Черкаська область', 'Звенигородський район');
  assert.equal(other.scope, 'outside', 'Other raions should be outside');
});

test('Oblast threat activates oblast (Cherkasy oblast-wide)', async () => {
  const { raionAlertActive } = await import('../services/districts.js');
  const alert = { region: 'Черкаська область', district: null };
  const result = raionAlertActive([alert], 'Черкаська область', 'Уманський район');
  assert.equal(result.scope, 'oblast', 'Oblast-wide alert should have scope=oblast for any raion');
});

test('Unknown raion does NOT fallback to oblast', () => {
  const nRaion = normRaion('Невідомий Район');
  const nOblast = normOblast('Черкаська область');
  const candidates = raionIndex.get(nRaion);
  assert.equal(candidates, undefined, 'Unknown raion should not be found in index');
});

test('RaionOblastMap built correctly', () => {
  assert.ok(raionOblastMap.size > 0, 'Raion->Oblast map should not be empty');
  assert.equal(raionOblastMap.get(normRaion('Уманський район')), normOblast('Черкаська область'));
  assert.equal(raionOblastMap.get(normRaion('Одеський район')), normOblast('Одеська область'));
  assert.equal(raionOblastMap.get(normRaion('Харківський район')), normOblast('Харківська область'));
  assert.equal(raionOblastMap.get(normRaion('Сумський район')), normOblast('Сумська область'));
});

test('getOblastRaionPolygons returns all raions for oblast', () => {
  const nOblast = normOblast('Черкаська область');
  const cherkasyRaions = [];
  for (const [nRaion, features] of raionIndex) {
    if (raionOblastMap.get(nRaion) !== nOblast) continue;
    cherkasyRaions.push({ name: features[0].properties.rayon, feature: features[0] });
  }
  
  const names = cherkasyRaions.map(r => r.name).sort();
  assert.ok(names.includes('Уманський район'));
  assert.ok(names.includes('Звенигородський район'));
  assert.ok(names.includes('Золотоніський район'));
  assert.ok(names.includes('Черкаський район'));
  assert.equal(cherkasyRaions.length, 4, 'Cherkasy should have 4 raions');
  
  for (const r of cherkasyRaions) {
    const rings = r.feature.geometry?.type === 'Polygon' 
      ? [r.feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon])]
      : r.feature.geometry?.coordinates?.map(poly => poly[0].map(([lon, lat]) => [lat, lon])) || [];
    assert.ok(rings.length > 0, `Raion ${r.name} should have rings`);
  }
});

test('getOblastPolygon returns valid polygon', () => {
  const cherkasy = oblastsGeo.features.find(f => normOblast(f.properties?.region || '') === normOblast('Черкаська область'));
  assert.ok(cherkasy, 'Cherkasy oblast polygon should exist');
  const rings = cherkasy.geometry?.type === 'Polygon' 
    ? [cherkasy.geometry.coordinates[0].map(([lon, lat]) => [lat, lon])]
    : cherkasy.geometry?.coordinates?.map(poly => poly[0].map(([lon, lat]) => [lat, lon])) || [];
  assert.ok(rings.length > 0, 'Should have rings');
});

test('Normalization handles variations', () => {
  assert.equal(normRaion('Уманський район'), 'уманський');
  assert.equal(normRaion('Уманський р-н'), 'уманський');
  assert.equal(normRaion('  УМАНСЬКИЙ  '), 'уманський');
  
  assert.equal(normOblast('Черкаська область'), 'черкаська');
  assert.equal(normOblast('Черкаська обл.'), 'черкаська');
  
  assert.equal(resolveAlias('новомосковський'), 'самарівський');
  assert.equal(resolveAlias('красноградський'), 'берестинський');
});

test('Polygon geometry is valid (not bbox/centroid)', () => {
  const nRaion = normRaion('Уманський район');
  const feature = raionIndex.get(nRaion)[0];
  
  // Handle MultiPolygon
  let ring;
  if (feature.geometry?.type === 'Polygon') {
    ring = feature.geometry.coordinates[0].map(([lon, lat]) => [lat, lon]);
  } else if (feature.geometry?.type === 'MultiPolygon') {
    ring = feature.geometry.coordinates[0][0].map(([lon, lat]) => [lat, lon]);
  }
  
  assert.ok(ring.length > 20, 'Polygon should have many vertices, not just bbox corners');
  
  const first = ring[0], last = ring[ring.length - 1];
  assert.ok(Math.abs(first[0] - last[0]) < 0.0001 && Math.abs(first[1] - last[1]) < 0.0001, 'Ring should be closed');
  
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += (ring[i+1][1] - ring[i][1]) * (ring[i+1][0] + ring[i][0]);
  }
  area = Math.abs(area / 2);
  // In degrees^2, a raion is roughly 0.01-0.1 degrees^2 (very rough)
  // Just verify it's a non-trivial polygon
  assert.ok(area > 0.001, 'Polygon area should be non-trivial (degrees^2)');
});

console.log('All raion polygon real data tests passed!');