import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterPoints } from '../radar/geo.js';

const pt = (id, x, y) => ({ id, x, y });

test('cluster: distant points stay single', () => {
  const out = clusterPoints([pt('a', 0, 0), pt('b', 200, 200)], 34);
  assert.equal(out.length, 2);
  assert.ok(out.every(c => c.members.length === 1));
});

test('cluster: overlapping points merge with count, members intact', () => {
  const out = clusterPoints([pt('a', 100, 100), pt('b', 110, 105), pt('c', 400, 400)], 34);
  assert.equal(out.length, 2);
  const cluster = out.find(c => c.members.length === 2);
  assert.ok(cluster, 'one cluster of two');
  assert.deepEqual(cluster.members.map(m => m.id).sort(), ['a', 'b']);
  // member coordinates untouched (honest geography)
  assert.deepEqual([cluster.members[0].x, cluster.members[0].y], [100, 100]);
  assert.deepEqual([cluster.members[1].x, cluster.members[1].y], [110, 105]);
});

test('cluster: chain does not drag far points in', () => {
  // a-b close, b-c close, a-c far: b joins a first, c stays single
  const out = clusterPoints([pt('a', 0, 0), pt('b', 20, 0), pt('c', 40, 0)], 25);
  const sizes = out.map(c => c.members.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('cluster: empty and single input', () => {
  assert.deepEqual(clusterPoints([], 34), []);
  const out = clusterPoints([pt('a', 5, 5)], 34);
  assert.equal(out.length, 1);
  assert.equal(out[0].members[0].id, 'a');
});

test('cluster: radius 0 disables clustering', () => {
  const out = clusterPoints([pt('a', 0, 0), pt('b', 1, 1)], 0);
  assert.equal(out.length, 2);
});
