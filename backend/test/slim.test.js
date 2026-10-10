import test from 'node:test';
import assert from 'node:assert/strict';
import { slimBundle, slimEvents, slimRecord, bundleBytes, TRAIL_MAX, SAFE_BUNDLE_BYTES, GZIP_TRIGGER_BYTES } from '../src/slim.js';

// Shaped like the real aggregator at the moment it died, so the budget is
// pinned against production volumes and not against a toy.
const now = Date.parse('2026-10-09T23:40:00Z');
const trail = (n, i) => Array.from({ length: n }, (_, k) => ({
  lon: 30 + i * 0.01 + k * 0.001, lat: 50 + k * 0.001, timestamp: new Date(now - (n - k) * 60_000).toISOString(),
}));
const threat = (i, { trailLen = 20, correlated = 3 } = {}) => ({
  id: `mapa:t${i}`, trackId: `mapa:t${i}`, source: 'MAPA', category: 'uav', kind: 'uav',
  lat: 50 + i * 0.01, lon: 30 + i * 0.01, heading: 311, speed: 450,
  eventTime: new Date(now - i * 60_000).toISOString(), receivedAt: new Date(now).toISOString(),
  locationPrecision: 'COORDINATE', uncertaintyKm: 4, positionQuality: 'source-position',
  areaOnly: false, stale: false, status: 'active', misses: 0,
  subtype: ' Shahed at Odesa', rawExplanation: 'Виявлено повітряну ціль у районі Одеси.',
  sourceUrl: 'https://mapa.ua/', trail: trail(trailLen, i),
  correlated: Array.from({ length: correlated }, (_, k) => threat(i * 100 + k, { trailLen: 20, correlated: 0 })),
  crossSource: true, confirmed: true, fused: [`mapa:t${i}`], fusedCount: correlated,
  similarSourceCount: 2,
});

function liveState({ events = 63, prevThreats = 121, prevAlerts = 63 } = {}) {
  const evs = Array.from({ length: events }, (_, i) => threat(i));
  return {
    startedAt: 1, writtenAt: 1, dataUpdatedAt: new Date(now).toISOString(),
    fpAlerts: 'a', fpThreats: 't', fpHealth: 'h',
    snapshot: {
      v: 1, pipelineCheckedAt: new Date(now).toISOString(), health: { NEPTUN: { status: 'online' } },
      alerts: Array.from({ length: prevAlerts }, (_, i) => ({ id: `n:a${i}`, source: 'NEPTUN', subtype: 'alert', region: 'Одеська область' })),
      events: evs,
    },
    prev: {
      alerts: Array.from({ length: prevAlerts }, (_, i) => ({ id: `n:a${i}`, source: 'NEPTUN', misses: 0 })),
      threats: Array.from({ length: prevThreats }, (_, i) => threat(i)),
    },
    ended: { alerts: [], threats: [] },
  };
}

// ── The two dominant costs are gone ────────────────────────────────────────
test('published events no longer carry the dead correlated member records', () => {
  const out = slimEvents([threat(0)]);
  assert.equal('correlated' in out[0], false, 'correlated is dropped');
  assert.ok(Array.isArray(out[0].fused), 'the fused id list is kept');
  assert.equal(out[0].crossSource, true, 'summary flags survive');
  assert.equal(out[0].confirmed, true);
  assert.equal(out[0].similarSourceCount, 2);
});

test('records that need no change are returned by reference, not copied', () => {
  const e = threat(0, { trailLen: 3, correlated: 0 });
  delete e.correlated;                 // a record that simply never had members
  assert.equal(slimEvents([e])[0], e, 'no needless copy on the common path');
});

test('trails are capped to what the UI actually renders', () => {
  const original = threat(0, { trailLen: 20 });
  const out = slimRecord(original);
  assert.equal(out.trail.length, TRAIL_MAX);
  // The NEWEST points must survive — a trail that drops its recent positions
  // would draw the track backwards in time.
  assert.deepEqual(out.trail, original.trail.slice(-TRAIL_MAX));
  assert.equal('correlated' in out, false, 'bookkeeping records shed it too');
});

test('a short trail is left alone', () => {
  const r = { ...threat(0, { trailLen: 3 }), trail: trail(3, 0) };
  assert.equal(slimRecord(r).trail.length, 3);
});

test('slimBundle is idempotent and null-safe', () => {
  const once = slimBundle(liveState());
  const twice = slimBundle(once);
  assert.equal(bundleBytes(once), bundleBytes(twice), 'slimming twice changes nothing');
  assert.equal(slimBundle(null), null);
});

// ── The budget itself ──────────────────────────────────────────────────────
test('live production volumes stay well under the compression trigger', () => {
  const before = bundleBytes(liveState());
  const after = bundleBytes(slimBundle(liveState()));
  assert.ok(after < SAFE_BUNDLE_BYTES,
    `slimmed bundle ${(after / 1024).toFixed(0)} KB must stay under ${SAFE_BUNDLE_BYTES / 1024} KB`);
  assert.ok(after < before * 0.5,
    `must at least halve the payload: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
});

test('at production volumes the track lines survive', () => {
  // Trails are the first thing to go when the budget is blown. At the volumes
  // the aggregator actually sees they must NOT be dropped — otherwise the map
  // loses every confirmed track line to save bytes nobody needed to save.
  const out = slimBundle(liveState());
  const trails = out.snapshot.events.filter((e) => Array.isArray(e.trail) && e.trail.length > 1);
  assert.equal(trails.length, 63, 'every published event keeps a usable trail');
  assert.ok(out.snapshot.events[0].trail.length === TRAIL_MAX, 'capped but present');
  assert.ok(out.prev.threats[0].trail.length === TRAIL_MAX, 'and so does every previous record');
});

test('a mass attack sheds trails but never events', () => {
  // fuse.js documents 500+ active objects as a real scenario. Past the trail
  // budget the trails go; the event list and every id stay, so miss counting
  // and the all-clear guarantee are unaffected.
  const state = liveState({ events: 500, prevThreats: 900, prevAlerts: 500 });
  const out = slimBundle(state);
  assert.equal(out.snapshot.events.length, 500, 'no event is dropped');
  assert.equal(out.prev.threats.length, 900);
  assert.deepEqual(out.snapshot.events.map((e) => e.id), state.snapshot.events.map((e) => e.id));
  assert.ok(out.snapshot.events.every((e) => !e.trail || e.trail.length === 0), 'trails dropped');
  // The invariant that actually matters: a mass attack must not push the
  // commit into per-cycle compression, which is what killed the cron.
  assert.ok(bundleBytes(out) < GZIP_TRIGGER_BYTES,
    `500 events / 900 previous must stay uncompressed, got ${(bundleBytes(out) / 1024).toFixed(0)} KB`);
});

test('slimming never drops an event or changes an id', () => {
  const before = liveState({ events: 200 });
  const after = slimBundle(before);
  assert.equal(after.snapshot.events.length, before.snapshot.events.length, 'no event is lost');
  assert.deepEqual(after.snapshot.events.map((e) => e.id), before.snapshot.events.map((e) => e.id));
  assert.equal(after.prev.threats.length, before.prev.threats.length, 'miss counting keeps every record');
  assert.deepEqual(after.prev.threats.map((t) => t.id), before.prev.threats.map((t) => t.id));
});
