import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  meaningfulFp, shouldWrite, isAlreadyPersisted, loadBundle, saveBundle, loadLatest,
  WRITE_THROTTLE_MS, HEARTBEAT_MS, LATEST_TTL_S,
} from '../src/store.js';

// Counting in-memory KV stub: records every PUT (the Cloudflare-limited operation).
function countingKv(initial = null) {
  let data = initial;
  const log = [];
  return {
    log,
    puts: () => log.length,
    kv: {
      get: async () => data,
      put: async (k, v) => { log.push(k); data = v; },
    },
  };
}

const T0 = 1760000000000;
const HEALTH = {
  OFFICIAL: { status: 'online' },
  NEPTUN: { status: 'online' },
  MAPA: { status: 'online' },
};
const alertKyiv = {
  id: 'official:kyiv', official: true, source: 'NEPTUN / офіційні канали',
  category: 'alert', region: 'Київ', district: null, level: 'red',
  eventTime: '2026-10-07T10:00:00.000Z',
};
const shahedUman = {
  id: 'neptun:1', source: 'NEPTUN', category: 'uav', kind: 'shahed',
  region: 'Черкаська область', district: 'Уманський район',
  lat: 48.7514, lon: 30.2216, heading: 90, speed: 180,
  stale: false, status: 'active', eventTime: '2026-10-07T10:00:00.000Z',
  subtype: 'Шахед', rawExplanation: 'моніторинг',
};
const fpsOf = (alerts, threats, health = HEALTH) => meaningfulFp(alerts, threats, health);

function storedBundle(alerts, threats, writtenAt, health = HEALTH) {
  const f = fpsOf(alerts, threats, health);
  return { snapshot: { v: 1 }, prev: { alerts, threats }, ...f, writtenAt };
}

test('same meaningful state => 0 PUT', async () => {
  const c = countingKv();
  const f = fpsOf([alertKyiv], [shahedUman]);
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [alertKyiv], threats: [shahedUman] }, ...f, writtenAt: T0 });
  assert.equal(c.puts(), 1, 'setup writes once');
  const d = shouldWrite({ stored: storedBundle([alertKyiv], [shahedUman], T0), ...fpsOf([alertKyiv], [shahedUman]), nowMs: T0 + 60000 });
  assert.deepEqual(d, { write: false, reason: 'unchanged' });
});

test('timestamp-only change => 0 PUT', () => {
  // Same actives, but every volatile field a cycle would regenerate differs.
  const moved = {
    ...shahedUman,
    receivedAt: '2026-10-07T10:01:00.000Z',
    latencyMs: 45000,
    trail: [{ lat: 48.7, lon: 30.2, timestamp: '2026-10-07T09:59:00.000Z' }],
  };
  const health2 = {
    OFFICIAL: { status: 'online', updatedAt: '2026-10-07T10:01:00.000Z' },
    NEPTUN: { status: 'online', updatedAt: '2026-10-07T10:01:00.000Z' },
    MAPA: { status: 'online', updatedAt: '2026-10-07T10:01:00.000Z' },
  };
  const a = fpsOf([alertKyiv], [shahedUman]);
  const b = fpsOf([alertKyiv], [moved], health2);
  assert.deepEqual(b, a, 'volatile-only differences are invisible to the fingerprint');
  const d = shouldWrite({ stored: storedBundle([alertKyiv], [shahedUman], T0), ...b, nowMs: T0 + 60000 });
  assert.deepEqual(d, { write: false, reason: 'unchanged' });
});

test('same state 100 times => 0 additional PUT', () => {
  const stored = storedBundle([alertKyiv], [shahedUman], T0);
  const f = fpsOf([alertKyiv], [shahedUman]);
  // 100 rapid identical cycles inside one minute: no throttle/heartbeat window passes.
  for (let i = 0; i < 100; i++) {
    const d = shouldWrite({ stored, ...f, nowMs: T0 + 60000 });
    assert.equal(d.write, false, `cycle ${i} must not write`);
  }
  // Heartbeat over a long calm stretch: simulate properly (each heartbeat
  // write refreshes writtenAt, resetting the timer) — expect ~2 in 2 hours.
  let heartbeats = 0;
  let lastWrite = T0;
  for (let m = 1; m <= 120; m++) {
    const d = shouldWrite({ stored: storedBundle([], [], lastWrite), ...fpsOf([], []), nowMs: T0 + m * 60000 });
    if (d.write) { heartbeats++; assert.equal(d.reason, 'heartbeat'); lastWrite = T0 + m * 60000; }
  }
  assert.ok(heartbeats >= 1 && heartbeats <= 3, `rare heartbeat keeps key alive (got ${heartbeats}/2h)`);
});

test('real alert activation => 1 PUT (immediate, bypasses throttle)', async () => {
  const c = countingKv();
  const f = fpsOf([alertKyiv], [shahedUman]);
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [], threats: [shahedUman] }, ...fpsOf([], [shahedUman]), writtenAt: T0 });
  assert.equal(c.puts(), 1);
  const d = shouldWrite({ stored: storedBundle([], [shahedUman], T0), ...f, nowMs: T0 + 30000 });
  assert.deepEqual(d, { write: true, reason: 'alerts-changed' });
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [alertKyiv], threats: [shahedUman] }, ...f, writtenAt: T0 + 30000 });
  assert.equal(c.puts(), 2, 'exactly one additional PUT for the activation');
});

test('real alert deactivation => 1 PUT', async () => {
  const c = countingKv();
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [alertKyiv], threats: [] }, ...fpsOf([alertKyiv], []), writtenAt: T0 });
  const f = fpsOf([], []);
  const d = shouldWrite({ stored: storedBundle([alertKyiv], [], T0), ...f, nowMs: T0 + 10000 });
  assert.deepEqual(d, { write: true, reason: 'alerts-changed' });
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [], threats: [] }, ...f, writtenAt: T0 + 10000 });
  assert.equal(c.puts(), 2);
});

test('real meaningful threat change => max 1 PUT (throttled, then released)', async () => {
  const c = countingKv();
  const f0 = fpsOf([], [shahedUman]);
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [], threats: [shahedUman] }, ...f0, writtenAt: T0 });
  assert.equal(c.puts(), 1);
  const moved = { ...shahedUman, lat: 48.9, lon: 30.4, eventTime: '2026-10-07T10:01:00.000Z' };
  const f1 = fpsOf([], [moved]);
  assert.notDeepEqual(f1, f0, 'position change is a real fingerprint change');
  const early = shouldWrite({ stored: storedBundle([], [shahedUman], T0), ...f1, nowMs: T0 + 60000 });
  assert.deepEqual(early, { write: false, reason: 'threats-throttled' });
  const late = shouldWrite({ stored: storedBundle([], [shahedUman], T0), ...f1, nowMs: T0 + WRITE_THROTTLE_MS + 1000 });
  assert.deepEqual(late, { write: true, reason: 'threats-changed' });
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [], threats: [moved] }, ...f1, writtenAt: T0 + WRITE_THROTTLE_MS + 1000 });
  assert.equal(c.puts(), 2, 'max one PUT per logical change');
});

test('heartbeat keeps the key alive, then stays quiet', () => {
  const f = fpsOf([], []);
  const due = shouldWrite({ stored: storedBundle([], [], T0), ...f, nowMs: T0 + HEARTBEAT_MS + 1000 });
  assert.deepEqual(due, { write: true, reason: 'heartbeat' });
  const fresh = shouldWrite({ stored: storedBundle([], [], T0 + HEARTBEAT_MS + 1000), ...f, nowMs: T0 + HEARTBEAT_MS + 60000 });
  assert.deepEqual(fresh, { write: false, reason: 'unchanged' });
});

test('parallel identical updates => max 1 effective write', async () => {
  const c = countingKv();
  // Two concurrent cycles read the same (empty) state...
  const before = await loadBundle(c.kv);
  assert.equal(before, null);
  const f = fpsOf([alertKyiv], []);
  // ...cycle A decides and writes...
  const dA = shouldWrite({ stored: before, ...f, nowMs: T0 });
  assert.equal(dA.write, true);
  await saveBundle(c.kv, { snapshot: { v: 1 }, prev: { alerts: [alertKyiv], threats: [] }, ...f, writtenAt: T0 });
  // ...cycle B decided on the same stale read, but its race re-check sees A's write.
  const dB = shouldWrite({ stored: before, ...f, nowMs: T0 });
  assert.equal(dB.write, true, 'stale decision still says write');
  const raced = isAlreadyPersisted(await loadBundle(c.kv), before?.writtenAt, f);
  assert.equal(raced, true, 'race check suppresses the duplicate');
  assert.equal(c.puts(), 1, 'only one effective PUT');
});

test('loadLatest unwraps the bundle (API shape unchanged)', async () => {
  const c = countingKv();
  const snap = { v: 1, serverTime: 'x', alerts: [alertKyiv], events: [shahedUman], health: {} };
  await saveBundle(c.kv, { snapshot: snap, prev: { alerts: [], threats: [] }, ...fpsOf([], []), writtenAt: T0 });
  assert.deepEqual(await loadLatest(c.kv), snap, 'bundle unwraps to the bare snapshot');
  const legacy = countingKv(JSON.stringify({ v: 1, alerts: [], events: [] }));
  assert.deepEqual(await loadLatest(legacy.kv), { v: 1, alerts: [], events: [] }, 'legacy bare snapshot still loads');
});

// Full-pipeline tests with stubbed sources (no network).
function stubFetch(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = routes[String(url).split('?')[0]];
    if (!body) throw new Error('unexpected fetch ' + url);
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  return () => { globalThis.fetch = real; };
}
const fakeDb = () => ({
  prepare() {
    const stmt = {
      bind: () => ({ run: async () => ({ success: true }), all: async () => ({ results: [] }) }),
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
    };
    return stmt;
  },
  batch: async () => ({ success: true }),
});
const baseEnv = (kv, db) => ({
  NEBO_STATE: kv, nebo_journal: db,
  NEPTUN_ALERTS_URL: 'https://src.test/alerts',
  NEPTUN_THREATS_URL: 'https://src.test/threats',
  MAPA_URL: 'https://src.test/mapa',
  OFFICIAL_API_URL: '', OFFICIAL_API_TOKEN: '',
});
const emptySources = {
  'https://src.test/alerts': { oblasts: [], raions: [] },
  'https://src.test/threats': { threats: [] },
  'https://src.test/mapa': { objects: [] },
};

test('POST /v1/refresh without changes => 0 PUT', async () => {
  const restore = stubFetch(emptySources);
  try {
    const c = countingKv();
    const env = baseEnv(c.kv, fakeDb());
    const req = () => new Request('https://worker.test/v1/refresh', { method: 'POST' });
    const r1 = await worker.fetch(req(), env);
    assert.equal(r1.status, 200, 'first refresh warms the state');
    assert.equal(c.puts(), 1, 'cold start writes once');
    const r2 = await worker.fetch(req(), env);
    assert.equal(r2.status, 200);
    assert.equal(c.puts(), 1, 'unchanged refresh writes nothing');
    const r3 = await worker.fetch(req(), env);
    assert.equal(r3.status, 200);
    assert.equal(c.puts(), 1, 'still nothing');
  } finally {
    restore();
  }
});

test('GET /v1/state => 0 PUT and intact shape', async () => {
  const snap = { v: 1, serverTime: 'x', receivedAt: 'x', alerts: [], events: [], health: {}, disagreement: {} };
  const c = countingKv(JSON.stringify({ v: 1, snapshot: snap, prev: { alerts: [], threats: [] }, ...fpsOf([], []), writtenAt: T0 }));
  const res = await worker.fetch(new Request('https://worker.test/v1/state'), baseEnv(c.kv, fakeDb()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.alerts) && Array.isArray(body.events), 'API shape intact');
  assert.equal(c.puts(), 0, 'reads never write');
});

console.log('All KV budget tests passed!');
