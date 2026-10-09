import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PLACES, findLocalPlace, searchLocalPlaces, isLocallyResolvable } from '../services/ukraine-places.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const geo = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/ukraine-oblasts.geojson'), 'utf8'));

// Ray-casting point-in-polygon over every ring of a MultiPolygon.
function pointInFeature(feat, lat, lon) {
  const g = feat.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    for (const ring of poly) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}
// The directory names its features in `region`, but the two standalone
// regions (м. Київ, Севастополь) only carry `name`/`key`.
const featureFor = (region) => geo.features.find((f) => {
  const p = f.properties || {};
  return p.region === region || p.name === region || p.key === region;
});
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+область$/i, '').trim();

test('every local place has finite, in-range coordinates', () => {
  for (const p of LOCAL_PLACES) {
    assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `${p.settlement}: numeric coords`);
    assert.ok(p.lat > 44 && p.lat < 53, `${p.settlement}: lat in Ukraine (${p.lat})`);
    assert.ok(p.lon > 21 && p.lon < 41, `${p.settlement}: lon in Ukraine (${p.lon})`);
  }
});

test('settlement names are unique (no ambiguous offline match)', () => {
  const seen = new Map();
  for (const p of LOCAL_PLACES) {
    const key = p.settlement.replace(/[’'`ʼ]/g, "'").toLowerCase();
    assert.ok(!seen.has(key), `duplicate settlement "${p.settlement}"`);
    seen.set(key, p);
  }
});

test('EVERY local coordinate falls inside its own oblast polygon (offline verification)', () => {
  const bad = [];
  for (const p of LOCAL_PLACES) {
    const feat = featureFor(p.oblast);
    if (!feat) { bad.push(`${p.settlement}: oblast "${p.oblast}" not in oblasts.geojson`); continue; }
    if (!pointInFeature(feat, p.lat, p.lon)) bad.push(`${p.settlement} (${p.lat},${p.lon}) is NOT inside ${p.oblast}`);
  }
  assert.deepEqual(bad, [], 'coordinates must match their oblast: ' + bad.join('; '));
});

test('every referenced oblast exists in the shipped oblast directory', () => {
  for (const p of LOCAL_PLACES) {
    assert.ok(featureFor(p.oblast), `${p.settlement}: unknown oblast "${p.oblast}"`);
  }
});

test('all 24 oblasts + Crimea + Sevastopol + Kyiv resolve to a capital offline', () => {
  const capitals = LOCAL_PLACES.filter((p) => p.kind === 'capital');
  const names = capitals.map((p) => p.settlement.toLowerCase().replace(/[’'`ʼ]/g, "'"));
  assert.equal(new Set(names).size, names.length, 'no oblast has two capitals');
  // Every region in the shipped directory must be resolvable by name to a
  // capital that really lies inside that region. м. Київ and Київська область
  // are separate features but share the same administrative centre, which is
  // why this is a containment check rather than a name set.
  const unresolved = [];
  for (const f of geo.features) {
    const region = f.properties?.region || f.properties?.name || f.properties?.key;
    const hit = findLocalPlace(region);
    if (!hit || !pointInFeature(f, hit.lat, hit.lon)) unresolved.push(region);
  }
  assert.deepEqual(unresolved, [], 'every region resolves to a capital inside it: ' + unresolved.join(', '));
});

test('findLocalPlace resolves settlements, oblasts and prefixes offline', () => {
  assert.equal(findLocalPlace('Київ')?.settlement, 'Київ');
  assert.equal(findLocalPlace('київ')?.settlement, 'Київ');
  assert.equal(findLocalPlace('м. Київ')?.settlement, 'Київ');
  assert.equal(findLocalPlace('Харків')?.lat, 49.9935);
  assert.equal(findLocalPlace('Харківська область')?.settlement, 'Харків');
  assert.equal(findLocalPlace('Львівська')?.settlement, 'Львів');
  assert.ok(findLocalPlace('Дніпро'), 'prefix match works');
  assert.equal(findLocalPlace('Атлантида'), null, 'unknown place is null, never invented');
  assert.equal(findLocalPlace('я'), null, 'too-short query is null');
});

test('searchLocalPlaces ranks exact above prefix and returns a list', () => {
  const r = searchLocalPlaces('Київ');
  assert.ok(r.length >= 1);
  assert.equal(r[0].settlement, 'Київ');
  assert.ok(r.length <= 8, 'capped');
  assert.deepEqual(searchLocalPlaces('я'), [], 'short query -> empty, no network needed');
});

test('isLocallyResolvable gates the network fallback', () => {
  assert.equal(isLocallyResolvable('Одеса'), true);
  assert.equal(isLocallyResolvable('Полтавська область'), true);
  assert.equal(isLocallyResolvable('Десь далеко'), false);
});

test('local places carry the same shape as normalizePlace output', () => {
  const p = findLocalPlace('Львів');
  for (const k of ['id', 'settlement', 'oblast', 'lat', 'lon', 'label', 'source']) {
    assert.ok(k in p, `missing ${k}`);
  }
  assert.equal(p.country, 'Україна');
  assert.equal(typeof p.id, 'string');
});