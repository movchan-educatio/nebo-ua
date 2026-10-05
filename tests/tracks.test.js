import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, syncStore, cleanTrail, resolveSelection, eventTimeMs } from '../services/tracks.js';

const T = (iso) => new Date(iso);
function ev(id, lat, lon, iso, extra = {}) {
  return { id, trackId: id, lat, lon, timestamp: T(iso), category: 'uav', ...extra };
}

// ── same trackId updates the existing target ────────────────────────────────
test('same trackId updates existing target', () => {
  const s = createStore();
  assert.equal(s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z')).type, 'added');
  assert.equal(s.size, 1);
  const r = s.upsert(ev('neptun:1', 50.1, 31.1, '2026-10-05T22:11:00Z'));
  assert.equal(r.type, 'updated-moved');
  assert.equal(s.size, 1);
  assert.equal(s.get('neptun:1').pos.lat, 50.1);
});

// ── new trackId adds a target ───────────────────────────────────────────────
test('new trackId adds target', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  assert.equal(s.upsert(ev('mapa:9', 49, 32, '2026-10-05T22:10:00Z')).type, 'added');
  assert.equal(s.size, 2);
});

// ── old event cannot overwrite new ──────────────────────────────────────────
test('old event cannot overwrite new', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  s.upsert(ev('neptun:1', 50.5, 31.5, '2026-10-05T22:11:00Z'));
  const r = s.upsert(ev('neptun:1', 49.9, 30.9, '2026-10-05T22:10:30Z'));
  assert.equal(r.type, 'ignored-order');
  assert.deepEqual([s.get('neptun:1').pos.lat, s.get('neptun:1').pos.lon], [50.5, 31.5]);
  // Same-timestamp duplicate is also ignored.
  assert.equal(s.upsert(ev('neptun:1', 49.8, 30.8, '2026-10-05T22:11:00Z')).type, 'ignored-order');
});

// ── same coordinates don't create animation/history ─────────────────────────
test("same coordinates don't create animation", () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  const r = s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:11:00Z'));
  assert.equal(r.type, 'updated');
  assert.equal(r.moved, false);
  assert.deepEqual(s.get('neptun:1').history, []);
});

// ── missing coordinates don't move the marker ───────────────────────────────
test("missing coordinates don't move marker", () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  const r = s.upsert({ id: 'neptun:1', trackId: 'neptun:1', lat: null, lon: null, timestamp: T('2026-10-05T22:11:00Z'), category: 'uav' });
  assert.equal(r.type, 'updated');
  assert.deepEqual([s.get('neptun:1').pos.lat, s.get('neptun:1').pos.lon], [50, 31]);
  assert.deepEqual(s.get('neptun:1').history, []);
});

// ── areaOnly doesn't become a point marker ──────────────────────────────────
test("areaOnly doesn't become point marker", () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  const r = s.upsert({ id: 'neptun:1', trackId: 'neptun:1', lat: 50.2, lon: 31.2, areaOnly: true, timestamp: T('2026-10-05T22:11:00Z'), category: 'uav' });
  assert.equal(r.type, 'updated');
  assert.deepEqual([s.get('neptun:1').pos.lat, s.get('neptun:1').pos.lon], [50, 31]);
});

// ── MAPA trail parsed + deduplicated ────────────────────────────────────────
test('MAPA trail parsed correctly', () => {
  const pts = cleanTrail([
    { lon: 31.0, lat: 50.0, timestamp: T('2026-10-05T22:10:00Z') },
    [31.1, 50.1, 1759695000],
    { lat: 50.2, lon: 31.2, timestamp: '2026-10-05T22:12:00Z' },
  ]);
  assert.equal(pts.length, 3);
  assert.ok(pts[0].t <= pts[1].t && pts[1].t <= pts[2].t);
});

test('MAPA trail deduplicated and validated', () => {
  const pts = cleanTrail([
    { lon: 31.0, lat: 50.0, timestamp: T('2026-10-05T22:10:00Z') },
    { lon: 31.0, lat: 50.0, timestamp: T('2026-10-05T22:10:30Z') },
    { lon: 0, lat: 0, timestamp: T('2026-10-05T22:11:00Z') },
    { lon: 99, lat: 99, timestamp: T('2026-10-05T22:11:30Z') },
    { lon: NaN, lat: 50.1, timestamp: T('2026-10-05T22:12:00Z') },
    { lon: 31.2, lat: 50.2, timestamp: T('2026-10-05T22:12:30Z') },
  ]);
  assert.deepEqual(pts.map(p => [p.lat, p.lon]), [[50.0, 31.0], [50.2, 31.2]]);
});

// ── NEPTUN history only contains confirmed received positions ───────────────
test('NEPTUN history only contains confirmed received positions', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  s.upsert(ev('neptun:1', 50.1, 31.1, '2026-10-05T22:11:00Z'));
  s.upsert(ev('neptun:1', 50.2, 31.2, '2026-10-05T22:12:00Z'));
  const h = s.get('neptun:1').history;
  assert.deepEqual(h.map(p => [p.lat, p.lon]), [[50, 31], [50.1, 31.1]]);
  // History is capped.
  for (let i = 3; i < 15; i++) {
    s.upsert(ev('neptun:1', 50 + i * 0.1, 31 + i * 0.1, `2026-10-05T22:${String(12 + i).padStart(2, '0')}:00Z`));
  }
  assert.ok(s.get('neptun:1').history.length <= 8);
});

// ── selection survives refresh ──────────────────────────────────────────────
test('selection survives refresh', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  syncStore(s, [ev('neptun:1', 50.1, 31.1, '2026-10-05T22:11:00Z'), ev('neptun:2', 49, 32, '2026-10-05T22:11:00Z')]);
  const cur = resolveSelection(s, 'neptun:1');
  assert.ok(cur);
  assert.equal(cur.lat, 50.1);
  assert.equal(resolveSelection(s, 'gone'), null);
});

// ── 503 keeps previous state ────────────────────────────────────────────────
test('503 keeps previous state', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  const r = syncStore(s, null);
  assert.equal(r.kept, true);
  assert.equal(s.size, 1);
  assert.equal(s.get('neptun:1').pos.lat, 50);
});

// ── Map and Radar receive the same updated coordinates ──────────────────────
test('Map and Radar receive same updated coordinates', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  syncStore(s, [ev('neptun:1', 50.2, 31.2, '2026-10-05T22:11:00Z')]);
  const forMap = s.getAll().map(t => t.current);
  const forRadar = s.getAll().map(t => t.current);
  assert.equal(forMap[0], forRadar[0]);
  assert.equal(forMap[0].lat, 50.2);
});

// ── helpers ─────────────────────────────────────────────────────────────────
test('timestamp-less update never moves a timestamped position', () => {
  const s = createStore();
  s.upsert(ev('neptun:1', 50, 31, '2026-10-05T22:10:00Z'));
  const r = s.upsert({ id: 'neptun:1', trackId: 'neptun:1', lat: 55, lon: 35, category: 'uav' });
  assert.equal(r.type, 'updated');
  assert.equal(r.moved, false);
  assert.deepEqual([s.get('neptun:1').pos.lat, s.get('neptun:1').pos.lon], [50, 31]);
});
test('eventTimeMs reads Date and ISO strings', () => {
  assert.equal(eventTimeMs({ timestamp: T('2026-10-05T22:10:00Z') }), Date.parse('2026-10-05T22:10:00Z'));
  assert.equal(eventTimeMs({ eventTime: '2026-10-05T22:10:00Z' }), Date.parse('2026-10-05T22:10:00Z'));
  assert.equal(eventTimeMs({}), null);
  assert.equal(eventTimeMs(null), null);
});

test('getWithinRadius returns nearest-first confirmed positions', () => {
  const s = createStore();
  s.upsert(ev('a', 50, 31, '2026-10-05T22:10:00Z'));
  s.upsert(ev('b', 49, 32, '2026-10-05T22:10:00Z'));
  const near = s.getWithinRadius(50, 31, 200);
  assert.deepEqual(near.map(x => x.track.id), ['a', 'b']);
  assert.equal(s.getWithinRadius(50, 31, 0).length, 0);
});

test('subscribe notifies on add/update/remove', () => {
  const s = createStore();
  const seen = [];
  const off = s.subscribe((c) => seen.push(c.type));
  s.upsert(ev('a', 50, 31, '2026-10-05T22:10:00Z'));
  s.upsert(ev('a', 50.1, 31.1, '2026-10-05T22:11:00Z'));
  s.remove('a');
  off();
  s.upsert(ev('b', 49, 32, '2026-10-05T22:10:00Z'));
  assert.deepEqual(seen, ['added', 'updated-moved', 'removed']);
});
