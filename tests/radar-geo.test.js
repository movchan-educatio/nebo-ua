import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineKm, bearingDeg, projectRadar, insideRadius,
  formatDistanceKm, formatBearing, compassUk,
  accuracyLevel, radarPoint, rangeRings,
} from '../radar/geo.js';

test('haversine: Kyiv–Lviv ~465 km', () => {
  const d = haversineKm(50.45, 30.52, 49.84, 24.02);
  assert.ok(d > 440 && d < 490, `got ${d}`);
});

test('haversine: same point is 0', () => {
  assert.equal(haversineKm(49, 31, 49, 31), 0);
});

test('bearing: due north is 0, due east is 90', () => {
  assert.ok(Math.abs(bearingDeg(49, 31, 50, 31) - 0) < 0.5);
  assert.ok(Math.abs(bearingDeg(49, 31, 49, 32) - 90) < 1.5);
});

test('project: center maps to canvas center, 100 km north at range 200 is halfway up', () => {
  const size = 400;
  const c = projectRadar(49, 31, [49, 31], 200, size);
  assert.equal(Math.round(c.x), size / 2);
  assert.equal(Math.round(c.y), size / 2);
  assert.equal(c.inside, true);
  // ~100 km north of (49,31): lat + ~0.9deg
  const p = projectRadar(49.9, 31, [49, 31], 200, size);
  assert.ok(p.inside);
  const expected = size / 2 - (size / 2 - 10) * (p.distKm / 200);
  assert.ok(Math.abs(p.y - expected) < 3, `y=${p.y} expected~${expected} dist=${p.distKm}`);
  assert.ok(p.bearing < 2 || p.bearing > 358);
});

test('project: outside range is flagged, invalid input is null', () => {
  assert.equal(projectRadar(55, 31, [49, 31], 200, 400).inside, false);
  assert.equal(projectRadar(null, 31, [49, 31], 200, 400), null);
  assert.equal(projectRadar(49, 31, null, 200, 400), null);
  assert.equal(projectRadar(49, 31, [49, 31], 0, 400), null);
});

test('insideRadius matches project inside flag', () => {
  assert.equal(insideRadius(49.5, 31, [49, 31], 100), true);
  assert.equal(insideRadius(52, 31, [49, 31], 100), false);
});

test('formatting: distance comma decimals, bearing padding', () => {
  assert.equal(formatDistanceKm(4.25), '4,3 км');
  assert.equal(formatDistanceKm(120.6), '121 км');
  assert.equal(formatDistanceKm(NaN), '—');
  assert.equal(formatBearing(5), 'А005°');
  assert.equal(formatBearing(225), 'А225°');
  assert.equal(compassUk(0), 'північ');
  assert.equal(compassUk(225), 'південний захід');
});

test('accuracy levels: coords=1, declared uncertainty=2, region-only=3, unknown=4', () => {
  assert.equal(accuracyLevel({ lat: 49, lon: 31, locationPrecision: 'COORDINATE' }), 1);
  assert.equal(accuracyLevel({ lat: 49, lon: 31, uncertaintyKm: 25 }), 2);
  assert.equal(accuracyLevel({ lat: 49, lon: 31, areaOnly: true }), 3);
  assert.equal(accuracyLevel({ lat: 49, lon: 31, positionQuality: 'raion' }), 3);
  assert.equal(accuracyLevel({ region: 'Київська область' }), 3);
  assert.equal(accuracyLevel({}), 4);
  assert.equal(accuracyLevel(null), 4);
});

test('radarPoint: only level 1-2 inside radius; never invents centroids', () => {
  const center = [49, 31];
  assert.ok(radarPoint({ id: 'a', lat: 49.5, lon: 31 }, center, 100, 400));
  assert.ok(radarPoint({ id: 'b', lat: 49.5, lon: 31, uncertaintyKm: 10 }, center, 100, 400));
  assert.equal(radarPoint({ id: 'c', region: 'Київська область' }, center, 100, 400), null);
  assert.equal(radarPoint({ id: 'd' }, center, 100, 400), null);
  assert.equal(radarPoint({ id: 'e', lat: 55, lon: 31 }, center, 100, 400), null);
  assert.equal(radarPoint({ id: 'f', lat: 49.5, lon: 31, areaOnly: true }, center, 100, 400), null);
});

test('rangeRings: quarters of the selected range', () => {
  assert.deepEqual(rangeRings(200), [50, 100, 150, 200]);
  assert.deepEqual(rangeRings(25), [6.3, 12.5, 18.8, 25]);
  assert.deepEqual(rangeRings(0), []);
});
