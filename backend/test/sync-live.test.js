import test from 'node:test';
import assert from 'node:assert/strict';
import { runDurablePipeline } from '../src/pipeline.js';
import { mergeHealth, buildStateResponse } from '../src/index.js';
import { fetchWithRetry } from '../src/sources.js';
import { dispatchPush } from '../src/push.js';
import { loadBundle } from '../src/store.js';
import { testEnv, testKv, sourceRoutes, mockSources } from './helpers/runtime.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const tick = () => new Promise(resolve => setTimeout(resolve, 3));

// D1 total outage: the cycle must still verify lanes and publish the fresh
// snapshot to the KV checkpoint instead of dying silently.
test('D1 outage does not stop verification or KV publication', async () => {
  const deadDb = {
    prepare: () => { throw new Error('D1 down'); },
    batch: async () => { throw new Error('D1 down'); },
  };
  const kv = testKv();
  const env = { ...testEnv(), nebo_journal: deadDb, NEBO_STATE: kv };
  globalThis.fetch = mockSources(sourceRoutes());
  await tick();
  const snap = await runDurablePipeline(env);
  assert.ok(snap && Array.isArray(snap.events), 'fresh snapshot returned, not thrown');
  assert.ok(kv.puts > 0, 'KV checkpoint written despite D1 outage');
  const bundle = await loadBundle(kv);
  assert.ok(bundle?.snapshot?.events, 'read path still has servable content');
  assert.equal(bundle.snapshot.health.MAPA.status, 'online');
});

// D1 read failure falls back to the KV checkpoint, never to an empty state.
test('corrupt D1 row falls back to KV instead of publishing emptiness', async () => {
  const kv = testKv();
  const env = { ...testEnv(), NEBO_STATE: kv };
  globalThis.fetch = mockSources(sourceRoutes());
  await tick();
  await runDurablePipeline(env);
  const good = await loadBundle(kv);
  assert.ok(good?.snapshot?.events !== undefined);
  // Corrupt the D1 row: garbage bundle must not become the baseline.
  env.nebo_journal.sqlite.exec("UPDATE pipeline_state SET bundle='not-json{{{' WHERE id=1");
  await tick();
  const snap = await runDurablePipeline(env);
  assert.ok(snap && Array.isArray(snap.events), 'cycle survives corrupt D1 row via KV');
});

// RECOVERING: first success after a recorded failure, then self-resolves.
test('source shows recovering on first success after failure, then online', async () => {
  const env = testEnv();
  const routes = sourceRoutes();
  routes['/threats'] = new Response(null, { status: 500 });
  globalThis.fetch = mockSources(routes);
  await tick();
  const s1 = await runDurablePipeline(env);
  assert.equal(s1.health.NEPTUN.status, 'offline');
  routes['/threats'] = { threats: [] };
  await tick();
  const s2 = await runDurablePipeline(env);
  assert.equal(s2.health.NEPTUN.status, 'recovering');
  await tick();
  const s3 = await runDurablePipeline(env);
  assert.equal(s3.health.NEPTUN.status, 'online');
});

// mergeHealth derives the same transitions on the read path.
test('mergeHealth derives recovering then resolves it to online', () => {
  const stored = { health: { NEPTUN: { status: 'offline', updatedAt: '2026-10-09T08:00:00.000Z' } } };
  const bySource = { NEPTUN: { ts: '2026-10-09T08:01:00.000Z', ok: true, error: null } };
  assert.equal(mergeHealth(stored.health, bySource).NEPTUN.status, 'recovering');
  const stored2 = { health: { NEPTUN: { status: 'recovering', updatedAt: '2026-10-09T08:01:00.000Z' } } };
  const bySource2 = { NEPTUN: { ts: '2026-10-09T08:02:00.000Z', ok: true, error: null } };
  assert.equal(mergeHealth(stored2.health, bySource2).NEPTUN.status, 'online');
  // A fresh failure always wins over any stored state.
  const bySource3 = { NEPTUN: { ts: '2026-10-09T08:03:00.000Z', ok: false, error: 'x' } };
  assert.equal(mergeHealth(stored2.health, bySource3).NEPTUN.status, 'offline');
});

// buildStateResponse keeps the snapshot's own verification time when the
// D1 journal overlay is unreachable — never reports null liveness for fresh data.
test('read path falls back to embedded verification time when D1 checks are missing', () => {
  const bundle = { snapshot: {
    v: 1, serverTime: '2026-10-09T08:00:00.000Z', receivedAt: '2026-10-09T08:00:00.000Z',
    pipelineCheckedAt: '2026-10-09T08:00:00.000Z', dataUpdatedAt: '2026-10-09T07:00:00.000Z',
    health: { NEPTUN: { status: 'online', updatedAt: '2026-10-09T08:00:00.000Z' }, MAPA: { status: 'online', updatedAt: '2026-10-09T08:00:00.000Z' } },
    alerts: [], events: [],
  }, dataUpdatedAt: '2026-10-09T07:00:00.000Z' };
  const resp = buildStateResponse(bundle, { bySource: {}, checkedAt: null }, Date.now());
  assert.equal(resp.pipelineCheckedAt, '2026-10-09T08:00:00.000Z');
  assert.equal(resp.dataUpdatedAt, '2026-10-09T07:00:00.000Z');
});

// Superseded cycles still record their verified lanes (no liveness gap).
test('a cycle that loses the commit race still records its checks', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  // Freeze the CAS token in the future: every commit loses the race.
  env.nebo_journal.sqlite.exec(`INSERT INTO pipeline_state (id, started_at, bundle)
    VALUES (1, 9999999999999, '{}') ON CONFLICT(id) DO UPDATE SET started_at=9999999999999`);
  await tick();
  await runDurablePipeline(env);
  const rows = env.nebo_journal.sqlite.prepare(
    "SELECT count(1) AS n FROM checks WHERE ts >= datetime('now','-5 minutes')").get();
  assert.ok(rows.n >= 2, `checks recorded despite supersede, got ${rows.n}`);
});

// Retry absorbs one transient blip without hammering the upstream.
test('fetchWithRetry retries once with backoff after a transient failure', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 502 });
    return Response.json({ ok: true });
  };
  const t0 = Date.now();
  const r = await fetchWithRetry('https://sources.invalid/x', { timeoutMs: 5000 }, 2);
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 250, 'a backoff delay happened between attempts');
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 500 }); };
  const r2 = await fetchWithRetry('https://sources.invalid/x', { timeoutMs: 5000 }, 1);
  assert.equal(r2.ok, false);
  assert.equal(calls, 1, 'single attempt means no waiting');
});

// Push CPU cap: 12 new threats + 1 official alert with one open subscriber.
// At most 8 sends are attempted; the official job is never the one capped
// out; overflow is logged as skipped-cap (auditable, no silent loss).
test('dispatchPush caps sends per cycle and prioritizes official alerts', async () => {
  const env = testEnv();
  env.VAPID_PUBLIC_KEY = 'x';
  env.VAPID_PRIVATE_KEY = 'y';
  env.VAPID_SUBJECT = 'mailto:test.invalid';
  const now = new Date();
  await env.nebo_journal.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, places, categories, quiet, oblast_norm, created_at, last_seen, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind('https://push.invalid/sub1', 'k', 'a', '[]', '{}', '{}', '', now.toISOString(), now.toISOString()).run();
  const events = Array.from({ length: 12 }, (_, i) => ({
    id: `t:${i}`, source: 'MAPA', category: 'uav', stale: false,
    eventTime: new Date(now.getTime() - i * 60000).toISOString(),
    region: 'R', district: null, settlement: null, lat: 49, lon: 31,
  }));
  const snapshot = {
    events,
    alerts: [{ id: 'off:1', official: true, region: 'R', district: 'D', stale: false, eventTime: now.toISOString() }],
  };
  const out = await dispatchPush(env, {
    snapshot, prevIds: { threats: [], alerts: [] }, endedAlerts: [], now,
  });
  assert.ok(out.sent + out.failed <= 8, `at most 8 sends attempted, got sent=${out.sent} failed=${out.failed}`);
  const logs = env.nebo_journal.sqlite.prepare('SELECT status, event_id FROM push_log').all();
  const capped = logs.filter(r => r.status === 'skipped-cap');
  assert.ok(capped.length > 0, 'overflow logged as skipped-cap');
  assert.ok(!capped.some(r => r.event_id === 'off:1'), 'the official alert is prioritized, never capped out');
});

// Liveness journal survives a failed commit: checks are recorded before any
// publish attempt, so a dead commit cannot create a liveness gap.
test('checks are recorded even when the D1 commit fails', async () => {
  const env = testEnv();
  const prepare = env.nebo_journal.prepare.bind(env.nebo_journal);
  env.nebo_journal.prepare = (sql) => {
    if (String(sql).includes('INSERT INTO pipeline_state')) throw new Error('commit down');
    return prepare(sql);
  };
  globalThis.fetch = mockSources(sourceRoutes());
  await tick();
  const snap = await runDurablePipeline(env);
  assert.ok(snap && Array.isArray(snap.events), 'cycle still serves fresh content via KV');
  const rows = env.nebo_journal.sqlite.prepare(
    "SELECT count(1) AS n FROM checks WHERE ts >= datetime('now','-5 minutes')").get();
  assert.ok(rows.n >= 2, `checks recorded despite failed commit, got ${rows.n}`);
  env.nebo_journal.prepare = prepare;
});
