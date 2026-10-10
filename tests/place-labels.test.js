// A place label must never be invented.
//
// Most monitoring records arrive with exact coordinates and no place name at
// all, and the feed used to say "місце невідоме" for every one of them — while
// the same record was plotted on the map at that coordinate. The UI was
// contradicting itself inside one row.
//
// The fallback resolves the point against oblast boundaries. It stops at the
// oblast on purpose: the local gazetteer holds 33 places, all oblast capitals, so
// naming the nearest would put a drone over Ольховка, ten kilometres outside
// Kharkiv, under the label "Харків". A confident wrong answer is worse than a
// coarse right one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const radar = read('radar/radar.js');
const geo = JSON.parse(read('assets/data/ukraine-oblasts.geojson'));

// Written here rather than imported from the app: a test that reuses the code
// it is testing can be wrong in the same way twice.
function oblastAt(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const f of geo.features) {
    const list = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates || [];
    for (const poly of list) {
      const ring = poly[0] || [];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return f.properties.region || f.properties.key;
    }
  }
  return null;
}

test('the oblast polygons cover Ukraine and are named', () => {
  assert.ok(geo.features.length >= 24, `expected the full oblast set, got ${geo.features.length}`);
  for (const f of geo.features) {
    assert.ok(f.properties?.region || f.properties?.key, 'every oblast carries a display name');
  }
});

test('known coordinates resolve to the oblast they fall in', () => {
  const cases = [
    [50.45, 30.52, 'Київська область'],   // Kyiv
    [49.99, 36.23, 'Харківська область'], // Kharkiv
    [46.48, 30.72, 'Одеська область'],    // Odesa
    [49.84, 24.03, 'Львівська область'],  // Lviv
  ];
  for (const [lat, lon, expected] of cases) {
    assert.equal(oblastAt(lat, lon), expected, `${lat},${lon} should be ${expected}`);
  }
});

test('a point outside every polygon resolves to nothing', () => {
  // The rule that matters: no fallback means no label. Moscow, the Black Sea
  // and the Atlantic all sit outside every Ukrainian oblast.
  for (const [lat, lon] of [[55.75, 37.62], [43.4, 34.3], [50.0, 10.0]]) {
    assert.equal(oblastAt(lat, lon), null, `${lat},${lon} is not in any oblast`);
  }
});

test('garbage coordinates never resolve', () => {
  for (const bad of [null, undefined, NaN, 'abc', '', Infinity]) {
    assert.equal(oblastAt(Number(bad), 30), null, `${String(bad)} is not a coordinate`);
  }
});

test('the fallback only applies to exact coordinates', () => {
  const fn = radar.slice(radar.indexOf('function geoDesc'), radar.indexOf('function kindIcon'));
  assert.match(fn, /locationPrecision === 'COORDINATE'/, 'guarded on precision');
  assert.match(fn, /place\)/, 'an existing place always wins');
  // The gazetteer is 33 capitals; the fallback must not use it to name a point.
  assert.doesNotMatch(fn, /findLocalPlace|LOCAL_PLACES|searchLocalPlaces/, 'no nearest-capital guessing');
});

test('the feed re-renders when contours arrive', () => {
  // loadContours is async and the first paint happens before it resolves, so
  // without this every label was drawn against an empty region list and stayed
  // "місце невідоме" until the next poll. That alone accounted for 14 of the 15
  // unknowns on a live check.
  const fn = radar.slice(radar.indexOf('async function loadContours'), radar.indexOf('function renderMapState'));
  // Slice to the end of the ready branch rather than a fixed character count: a
  // comment sits between the assignment and the call, and a magic window is how
  // this assertion passed against a version that had no re-render in it.
  const readyAt = fn.indexOf("contourStatus = 'ready'");
  assert.ok(readyAt > 0, 'the ready branch exists');
  const afterReady = fn.slice(readyAt, fn.indexOf('} catch', readyAt));
  assert.match(afterReady, /renderAll\(\)/, 'and it re-renders the feed');
});

test('contour regions are stored alongside the rings, not replacing them', () => {
  // The scope draws from state.contours. Replacing that shape would break the
  // radar disc, which is the one thing on the page that must not regress.
  const fn = radar.slice(radar.indexOf('async function loadContours'), radar.indexOf('function renderMapState'));
  assert.match(fn, /state\.contours = polys;/, 'rings still go to state.contours');
  assert.match(fn, /state\.contourRegions = regions;/, 'names go to their own field');
  assert.match(radar, /contourRegions: \[\]/, 'the field is initialised');
});
