import test from'node:test';import assert from'node:assert/strict';import{normalizePlace}from'../services/locations.js';
test('normalizePlace keeps coordinates, bbox and raion',()=>{
  const p=normalizePlace({ place_id: 1, lat: '49.44', lon: '32.06', boundingbox: ['48.9', '49.1', '31.5', '32.2'], address: { city: 'Умань', county: 'Уманський район', state: 'Черкаська область', country: 'Україна' } });
  assert.equal(p.lat, 49.44);assert.equal(p.lon, 32.06);
  assert.deepEqual(p.bbox, [48.9, 49.1, 31.5, 32.2]);
  assert.equal(p.settlement, 'Умань');assert.equal(p.raion, 'Уманський район');assert.equal(p.oblast, 'Черкаська область');
});
test('normalizePlace tolerates missing bbox',()=>{
  const p=normalizePlace({ place_id: 2, lat: '50', lon: '30', address: {} });
  assert.equal(p.bbox, null);
});
