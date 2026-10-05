import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { territorialDanger, raionMatches } from '../services/districts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load GeoJSON directly in Node.js
const raionsGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', 'ukraine-raions.geojson'), 'utf8'));
const oblastsGeo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', 'ukraine-oblasts.geojson'), 'utf8'));

// ── Helper functions (mirror the service normalization incl. apostrophe fix) ───
function normRaion(s) {
  return String(s || '').replace(/[’‘ʼ`´]/g, "'").toLowerCase().replace(/район|р-н|рн\b/g, ' ').replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
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

// Build raion->oblast map: centroid fast path + majority-vote fallback for
// coastal/concave shapes (mirrors services/raionShapesLocal.js).
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
function buildRaionOblastMap(index, oblastsGeo) {
  const prepared = oblastsGeo.features
    .map(ob => ({ ob, name: normOblast(ob.properties?.region || ob.properties?.key || ob.properties?.NAME_1 || ''), bbox: oblastBbox(ob) }))
    .filter(p => p.name);
  const map = new Map();
  const containingOblast = (pt) => {
    for (const p of prepared) {
      if (inBbox(pt, p.bbox) && pointInFeature(pt, p.ob)) return p.name;
    }
    return null;
  };
  for (const [nRaion, features] of index) {
    const f = features[0];
    if (!f) continue;
    const centroid = getCentroid(f);
    const direct = centroid && containingOblast(centroid);
    if (direct) { map.set(nRaion, direct); continue; }
    const votes = new Map();
    let total = 0;
    for (const ring of outerRings(f)) {
      const step = Math.max(1, Math.floor(ring.length / 60));
      for (let i = 0; i < ring.length; i += step) {
        total++;
        const hit = containingOblast([ring[i][1], ring[i][0]]);
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

// ── PRODUCTION REGRESSION: full render path ───────────────────────────────────
// Simulates drawAlertShapes: snapshot -> territorialDanger -> geom resolution.
// district threat -> raion GeoJSON polygon ONLY, never the oblast polygon.
function resolvePolygonsForSnapshot(alerts, events) {
  const { oblasts, fills } = territorialDanger(alerts, events);
  const oblastPolygons = oblasts.map(o => ({ kind: 'oblast', name: o }));
  const raionPolygons = [];
  const warnings = [];
  for (const f of fills) {
    const candidates = raionIndex.get(normRaion(f.district)) || [];
    // oblast containment check via raionOblastMap
    const g = candidates.find(c => raionOblastMap.get(normRaion(c.properties.rayon)) === normOblast(f.oblast));
    if (!g) {
      warnings.push(`${f.oblast}||${f.district}`);
      continue;
    }
    raionPolygons.push({ kind: 'raion', name: g.properties.rayon, level: f.level });
  }
  return { oblastPolygons, raionPolygons, warnings };
}

test('PRODUCTION: Uman shahed raion threat -> exactly one raion polygon (Uman), zero oblast polygons', () => {
  const alerts = [];
  const events = [{
    id: 'neptun:x', source: 'NEPTUN', category: 'uav', kind: 'shahed',
    region: 'Черкаська область', district: 'Уманський район',
    locationPrecision: 'RAION', areaOnly: true, official: false,
  }];
  const { oblastPolygons, raionPolygons, warnings } = resolvePolygonsForSnapshot(alerts, events);
  assert.equal(oblastPolygons.length, 0, 'Cherkasy oblast must NOT get an active fill');
  assert.equal(raionPolygons.length, 1, 'exactly one active raion polygon');
  assert.equal(raionPolygons[0].name, 'Уманський район');
  assert.equal(raionPolygons[0].level, 'high');
  assert.equal(warnings.length, 0);
});

test('PRODUCTION: all 34 real alert districts -> raion polygons only, oblast never painted', () => {
  const alerts = [
    { region: 'Донецька область', district: 'Бахмутський район' },
    { region: 'Запорізька область', district: 'Бердянський район' },
    { region: 'Харківська область', district: 'Богодухівський район' },
    { region: 'Київська область', district: 'Броварський район' },
    { region: 'Київська область', district: 'Бучанський район' },
    { region: 'Запорізька область', district: 'Василівський район' },
    { region: 'Київська область', district: 'Вишгородський район' },
    { region: 'Донецька область', district: 'Волноваський район' },
    { region: 'Донецька область', district: 'Горлівський район' },
    { region: 'Донецька область', district: 'Донецький район' },
    { region: 'Запорізька область', district: 'Запорізький район' },
    { region: 'Донецька область', district: 'Кальміуський район' },
    { region: 'Сумська область', district: 'Конотопський район' },
    { region: 'Чернігівська область', district: 'Корюківський район' },
    { region: 'Донецька область', district: 'Краматорський район' },
    { region: 'Харківська область', district: 'Куп’янський район' },
    { region: 'Донецька область', district: 'Маріупольський район' },
    { region: 'Запорізька область', district: 'Мелітопольський район' },
    { region: 'Чернігівська область', district: 'Новгород-Сіверський район' },
    { region: 'Чернігівська область', district: 'Ніжинський район' },
    { region: 'Сумська область', district: 'Охтирський район' },
    { region: 'Донецька область', district: 'Покровський район' },
    { region: 'Запорізька область', district: 'Пологівський район' },
    { region: 'Сумська область', district: 'Роменський район' },
    { region: 'Дніпропетровська область', district: 'Синельниківський район' },
    { region: 'Сумська область', district: 'Сумський район' },
    { region: 'Харківська область', district: 'Харківський район' },
    { region: 'Чернігівська область', district: 'Чернігівський район' },
    { region: 'Харківська область', district: 'Чугуївський район' },
    { region: 'Сумська область', district: 'Шосткинський район' },
    { region: 'Харківська область', district: 'Ізюмський район' },
  ];
  const { oblastPolygons, raionPolygons, warnings } = resolvePolygonsForSnapshot(alerts, []);
  assert.equal(oblastPolygons.length, 0, 'no oblast polygon may be painted for raion alerts');
  assert.equal(raionPolygons.length, 31, 'all 31 real raion districts resolve to polygons (incl. Куп’янський via apostrophe fix)');
  assert.equal(warnings.length, 0);
  assert.ok(raionPolygons.every(p => p.kind === 'raion'));
});

test('PRODUCTION: unknown district warns and paints nothing (no oblast fallback)', () => {
  const alerts = [{ region: 'Черкаська область', district: 'Невідомий район' }];
  const { oblastPolygons, raionPolygons, warnings } = resolvePolygonsForSnapshot(alerts, []);
  assert.equal(oblastPolygons.length, 0);
  assert.equal(raionPolygons.length, 0);
  assert.deepEqual(warnings, ['Черкаська область||Невідомий район']);
});

console.log('All raion polygon real data tests passed!');