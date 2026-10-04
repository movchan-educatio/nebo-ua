import test from'node:test';import assert from'node:assert/strict';import{overpassToRings}from'../services/raionShapes.js';
const SAMPLE = { elements: [
  { type: 'relation', id: 1, tags: { 'name:uk': 'Уманський район' }, members: [
    { type: 'way', role: 'outer', geometry: [{ lat: 48.7, lon: 30.2 }, { lat: 48.8, lon: 30.3 }] },
    { type: 'way', role: 'inner', geometry: [{ lat: 48.75, lon: 30.25 }, { lat: 48.76, lon: 30.26 }] },
    { type: 'node', role: 'admin_centre' },
  ] },
  { type: 'relation', id: 2, tags: { name: 'Nameless' }, members: [] },
  { type: 'way', id: 3 },
] };
test('overpass relations become outer-only rings',()=>{
  const r = overpassToRings(SAMPLE);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'Уманський район');
  assert.equal(r[0].rings.length, 1);
  assert.deepEqual(r[0].rings[0], [[48.7, 30.2], [48.8, 30.3]]);
});
test('bad input yields empty list',()=>{
  assert.deepEqual(overpassToRings(null), []);
  assert.deepEqual(overpassToRings({ elements: [{ type: 'relation', members: [] }] }), []);
});
