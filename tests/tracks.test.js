import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, syncStore, cleanTrail, resolveSelection, eventTimeMs, planMove, moveDurationKm, inspectTrack } from '../services/tracks.js';

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
  for (let i = 3; i < 30; i++) {
    s.upsert(ev('neptun:1', 50 + i * 0.1, 31 + i * 0.1, `2026-10-05T22:${String(12 + i).padStart(2, '0')}:00Z`));
  }
  assert.equal(s.get('neptun:1').history.length, 20);
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

// ── planMove: visual glide only between two confirmed positions ────────────
test('planMove animates same-track confirmed A→B with bounded duration', () => {
  const r = planMove(
    { id: 'a', trackId: 'a', lat: 50, lon: 31, timestamp: new Date('2026-10-06T10:00:00Z') },
    { id: 'a', trackId: 'a', lat: 50.05, lon: 31.05, timestamp: new Date('2026-10-06T10:01:00Z') },
  );
  assert.equal(r.animate, true);
  assert.deepEqual([r.from.lat, r.to.lon], [50, 31.05]);
  assert.ok(r.durationMs >= 600 && r.durationMs <= 1800);
});

test('planMove refuses everything else', () => {
  const A = { id: 'a', trackId: 'a', lat: 50, lon: 31, timestamp: new Date('2026-10-06T10:00:00Z') };
  const B = (over) => ({ id: 'a', trackId: 'a', lat: 50.05, lon: 31.05, timestamp: new Date('2026-10-06T10:01:00Z'), ...over });
  assert.equal(planMove(A, { ...B(), trackId: 'b' }).animate, false); // different track
  assert.equal(planMove(A, B({ areaOnly: true })).animate, false); // area-only
  assert.equal(planMove(A, B({ lat: null })).animate, false); // missing coord
  assert.equal(planMove(A, B({ stale: true })).animate, false); // stale
  assert.equal(planMove(A, B({ timestamp: new Date('2026-10-06T09:59:00Z') })).animate, false); // older
  assert.equal(planMove(A, B({ lat: 50, lon: 31 })).animate, false); // same point
  assert.equal(planMove(null, B()).animate, false); // no previous
});

test('moveDurationKm scales 600–1800ms with distance', () => {
  assert.ok(moveDurationKm(0.2) >= 600 && moveDurationKm(0.2) <= 900);
  assert.ok(moveDurationKm(5) >= 1000 && moveDurationKm(5) <= 1300);
  assert.equal(moveDurationKm(500), 1800);
  assert.equal(moveDurationKm(0), 0);
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

// ── A→B→C: stop at each confirmed position, never glide past ────────────────
test('A→B→C stops at B then moves to C', () => {
  const s = createStore();
  const A = ev('t', 50, 31, '2026-10-06T10:00:00Z');
  const B = ev('t', 50.1, 31.1, '2026-10-06T10:01:00Z');
  const C = ev('t', 50.2, 31.2, '2026-10-06T10:02:00Z');
  assert.equal(s.upsert(A).type, 'added');
  assert.deepEqual([s.get('t').pos.lat, s.get('t').pos.lon], [50, 31]);
  assert.equal(s.upsert(B).type, 'updated-moved');
  assert.deepEqual([s.get('t').pos.lat, s.get('t').pos.lon], [50.1, 31.1]); // STOP B
  assert.equal(s.upsert(C).type, 'updated-moved');
  assert.deepEqual([s.get('t').pos.lat, s.get('t').pos.lon], [50.2, 31.2]); // STOP C
  assert.deepEqual(s.get('t').history.map(p => [p.lat, p.lon]), [[50, 31], [50.1, 31.1]]);
});

test('different trackId never continues another trail', () => {
  const s = createStore();
  s.upsert(ev('a', 50, 31, '2026-10-06T10:00:00Z'));
  s.upsert(ev('a', 50.1, 31.1, '2026-10-06T10:01:00Z'));
  s.upsert(ev('b', 49, 32, '2026-10-06T10:01:00Z'));
  assert.deepEqual(s.get('b').history, []);
  assert.equal(s.get('b').pos.lat, 49);
  assert.equal(s.get('a').history.length, 1);
});

test('reconnect snapshot does not duplicate target or trail', () => {
  const s = createStore();
  const mk = (iso) => ev('t', 50, 31, iso);
  s.upsert(mk('2026-10-06T10:00:00Z'));
  syncStore(s, [mk('2026-10-06T10:00:00Z')]); // same snapshot again
  assert.equal(s.size, 1);
  assert.deepEqual(s.get('t').history, []);
});

test('inspectTrack reports live state for the inspector', () => {
  const s = createStore();
  s.upsert({ id: 't', trackId: 't', lat: 50, lon: 31, heading: 90, speed: 150, source: 'MAPA', timestamp: new Date('2026-10-06T10:00:00Z'), category: 'uav' });
  const now = Date.parse('2026-10-06T10:00:30Z');
  const r = inspectTrack(s, 't', now);
  assert.equal(r.trackId, 't');
  assert.equal(r.source, 'MAPA');
  assert.equal(r.ageS, 30);
  assert.equal(r.lat, 50);
  assert.equal(r.heading, 90);
  assert.equal(r.speed, 150);
  assert.equal(r.points, 1);
  assert.equal(r.lastChangeS, 30);
  assert.equal(inspectTrack(s, 'missing', now), null);
});
