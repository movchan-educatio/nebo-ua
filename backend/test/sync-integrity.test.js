import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runDurablePipeline, sourceTask } from '../src/pipeline.js';
import { loadRuntime, commitRuntime } from '../src/runtime-state.js';
import { fetchAggregated } from '../../services/aggregator.js';
import { testEnv, sourceRoutes, mockSources } from './helpers/runtime.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const tick = () => new Promise(resolve => setTimeout(resolve, 3));
async function run(env) { await tick(); return runDurablePipeline(env); }
const airAlerts = s => s.alerts.filter(a => a.official);
async function read(env) {
  const res = await worker.fetch(new Request('https://worker.invalid/v1/state'), env);
  assert.equal(res.status, 200);
  return res.json();
}

test('all sources work; source time, publish time and HTTP response time are distinct', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await run(env);
  const data = await read(env);
  assert.equal(airAlerts(data).length, 1);
  assert.equal(data.storage, 'd1');
  for (const key of ['pipelineStartedAt', 'pipelineCheckedAt', 'publishedAt', 'responseAt']) assert.ok(Date.parse(data[key]));
  assert.equal(data.alerts[0].eventTime, '2026-10-09T05:00:00.000Z');
  // Only the two monitoring sources exist now, and neither is the retired one.
  assert.deepEqual(Object.keys(data.health).sort(), ['MAPA', 'NEPTUN']);
});

// An alert source that keeps failing must never turn its own alarm into an
// all-clear. The record stays, marked stale, without a single miss counted, and
// the rest of the site keeps publishing.
for (const status of [401, 500]) test(`NEPTUN alerts ${status} for repeated cycles never deletes its alarm; monitoring still publishes`, async () => {
  const env = testEnv(), routes = sourceRoutes();
  globalThis.fetch = mockSources(routes);
  await run(env);
  const lastChecked = (await read(env)).pipelineCheckedAt;
  routes['/alerts'] = new Response('{}', { status });
  for (let n = 0; n < 5; n++) {
    routes['/mapa'] = { objects: [{ id: n, kind: 'uav', status: 'active', lat: 49, lon: 31, last_seen: Date.now() / 1000 }] };
    await run(env);
    const state = await read(env);
    assert.equal(airAlerts(state).length, 1);
    assert.equal(airAlerts(state)[0].stale, true);
    assert.equal(airAlerts(state)[0].misses, 0);
    assert.equal(state.health.NEPTUN.alertsStatus, 'offline');
    // NEPTUN's liveness comes from the threats lane, which still answers, so
    // the heartbeat must keep advancing — one failed lane is not an outage.
    assert.ok(state.pipelineCheckedAt > lastChecked);
    assert.equal(state.health.NEPTUN.status, 'online');
    assert.ok(state.events.some(e => e.id === `mapa:${n}`), 'new event is immediately visible, no 3-minute throttle');
  }
});

// A source that never answers must not hang the cron: the per-source deadline
// bounds it and the cycle still publishes.
test('a source that never settles is bounded by its deadline and the cycle still publishes', async () => {
  const env = testEnv(), routes = sourceRoutes();
  routes['/alerts'] = () => new Promise(() => {});
  globalThis.fetch = mockSources(routes);
  await run(env);
  const state = await read(env);
  assert.equal(state.health.NEPTUN.alertsStatus, 'offline');
  assert.equal(state.health.MAPA.status, 'online');
  // The alert could not be verified, so it must not be presented as current.
  assert.ok(airAlerts(state).every(a => a.stale === true));
});

test('whole-source timeout terminates an adapter that never settles', async () => {
  let signal;
  const result = await sourceTask(s => { signal = s; return new Promise(() => {}); }, 15);
  assert.equal(result.ok, false);
  assert.equal(signal.aborted, true);
  assert.match(result.error, /час/);
});

test('NEPTUN alert endpoint failure does not hide successful threat verification', async () => {
  const env = testEnv(), routes = sourceRoutes();
  routes['/alerts'] = new Response('{}', { status: 500 });
  routes['/mapa'] = new Response('{}', { status: 500 });
  globalThis.fetch = mockSources(routes);
  await run(env);
  const state = await read(env);
  assert.equal(state.health.NEPTUN.status, 'online');
  assert.equal(state.health.NEPTUN.alertsStatus, 'offline');
  assert.ok(state.pipelineCheckedAt);
});

for (const failed of [['/threats'], ['/mapa'], ['/threats', '/mapa']]) {
  test(`outages ${failed.join(', ')} retain their last state without invented all-clear`, async () => {
    const env = testEnv(), routes = sourceRoutes();
    routes['/threats'] = { threats: [{ id: 'a', type: 'uav', lat: 49, lon: 31, status: 'active', updatedAt: new Date().toISOString() }] };
    routes['/mapa'] = { objects: [{ id: 1, kind: 'uav', status: 'active', lat: 51, lon: 33, last_seen: Date.now() / 1000 }] };
    globalThis.fetch = mockSources(routes);
    await run(env);
    for (const path of failed) routes[path] = new Response('{}', { status: 500 });
    for (let n = 0; n < 4; n++) await run(env);
    const stored = await loadRuntime(env.nebo_journal);
    for (const path of failed) {
      const source = path === '/mapa' ? 'MAPA' : 'NEPTUN';
      const item = stored.prev.threats.find(e => e.source === source);
      assert.ok(item); assert.equal(item.misses, 0); assert.equal(item.stale, true);
    }
  });
}

test('unchanged content: ten simulated minutes advance checks, preserve content time, and avoid KV writes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T06:00:00Z') });
  const env = testEnv(); globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  const first = await read(env), puts = env.NEBO_STATE.puts;
  for (let n = 1; n <= 10; n++) {
    t.mock.timers.setTime(Date.parse('2026-10-09T06:00:00Z') + n * 60000);
    await runDurablePipeline(env);
  }
  const last = await read(env);
  assert.equal(last.dataUpdatedAt, first.dataUpdatedAt);
  assert.ok(last.pipelineCheckedAt > first.pipelineCheckedAt);
  assert.equal(env.NEBO_STATE.puts, puts);
});

test('overlapping cron: late older publication cannot overwrite the newer completed state', async () => {
  const env = testEnv(), routes = sourceRoutes();
  let finish, calls = 0;
  routes['/alerts'] = () => ++calls === 1
    ? new Promise(resolve => { finish = resolve; })
    : Response.json(sourceRoutes()['/alerts']);
  globalThis.fetch = mockSources(routes);
  const older = run(env);
  for (let n = 0; n < 20 && !finish; n++) await tick();
  await run(env);
  const newer = await loadRuntime(env.nebo_journal);
  finish(new Response('{}', { status: 401 }));
  await older;
  const final = await loadRuntime(env.nebo_journal);
  assert.equal(final.startedAt, newer.startedAt);
  assert.equal(final.snapshot.health.NEPTUN.alertsStatus, 'online');
});

test('a failed D1 commit still verifies and checkpoints, and never invents an all-clear', async () => {
  const env = testEnv(), routes = sourceRoutes(), calls = [];
  globalThis.fetch = mockSources(routes, calls);
  await run(env);
  const prepare = env.nebo_journal.prepare;
  env.nebo_journal.prepare = sql => {
    if (sql.includes('INSERT INTO pipeline_state')) throw new Error('D1 unavailable');
    return prepare(sql);
  };
  // A failed commit no longer kills the cycle: the lane still verifies, the
  // fresh snapshot reaches the KV checkpoint, and the served D1 state keeps the
  // last committed alert rather than dropping it.
  await run(env);
  const duringFailure = await read(env);
  assert.equal(airAlerts(duringFailure).length, 1);
  assert.equal(duringFailure.storage, 'd1', 'the last committed state is still what is served');
  const kvSnap = JSON.parse(env.NEBO_STATE.data.get('v1:latest'));
  assert.ok(Date.parse(kvSnap.snapshot.pipelineCheckedAt) >= Date.parse(duringFailure.pipelineCheckedAt));
  env.nebo_journal.prepare = prepare;
  // Recovery: once the commit works again the lane is fetched again in full.
  const fullBefore = calls.filter(p => p === '/alerts').length;
  await run(env);
  assert.equal(calls.filter(p => p === '/alerts').length, fullBefore + 1);
});

test('records of the retired source leave the active set instead of being pinned stale', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await run(env);
  // Seed history from the era when the source existed: its rows are audit
  // material, not a current confirmation, and outage protection must not keep
  // them alive as if they were.
  const stored = await loadRuntime(env.nebo_journal);
  stored.prev.alerts = [{ id: 'official:legacy', source: 'OFFICIAL', official: true, stale: false, misses: 0, eventTime: '2026-09-01T00:00:00.000Z', timestamp: '2026-09-01T00:00:00.000Z' }];
  await commitRuntime(env.nebo_journal, stored);
  await run(env);
  const state = await read(env);
  assert.equal(state.alerts.filter(a => a.source === 'OFFICIAL').length, 0,
    'a retired source is never served as a current confirmation');
  assert.equal(state.health.OFFICIAL, undefined, 'a retired source reports no health at all');
});

test('D1 outage keeps verifying lanes and serving fresh KV instead of going silent', async () => {
  const env = testEnv(); globalThis.fetch = mockSources(sourceRoutes());
  await run(env);
  const checkpoint = JSON.parse(env.NEBO_STATE.data.get('v1:latest'));
  env.nebo_journal.prepare = () => { throw new Error('D1 unavailable'); };
  const routes = sourceRoutes();
  routes['/mapa'] = { objects: [{ id: 9, kind: 'uav', status: 'active', lat: 49, lon: 31, last_seen: Date.now() / 1000 }] };
  globalThis.fetch = mockSources(routes);
  await run(env); // resolves via KV instead of rejecting
  const fallback = await read(env);
  assert.equal(fallback.storage, 'kv-fallback'); assert.equal(fallback.degraded, true);
  assert.ok(Date.parse(fallback.pipelineCheckedAt) >= Date.parse(checkpoint.snapshot.pipelineCheckedAt),
    'served verification time never moves backwards during the outage');
});

test('KV outage does not prevent D1 publication or serving fresh events', async () => {
  const env = testEnv();
  env.NEBO_STATE.get = async () => { throw new Error('KV down'); };
  env.NEBO_STATE.put = async () => { throw new Error('KV down'); };
  globalThis.fetch = mockSources(sourceRoutes());
  await run(env);
  assert.equal((await read(env)).storage, 'd1');
});

test('large MAPA payload uses the real schema without SQL variable errors', async () => {
  const env = testEnv(), routes = sourceRoutes();
  routes['/mapa'] = { objects: Array.from({ length: 1500 }, (_, id) => ({
    id, kind: 'uav', status: 'active', lat: 47 + id % 50 / 10, lon: 25 + id % 110 / 10, last_seen: Date.now() / 1000,
  })) };
  globalThis.fetch = mockSources(routes);
  await run(env);
  const stored = await loadRuntime(env.nebo_journal);
  assert.equal(stored.prev.threats.length, 1500);
  const row = env.nebo_journal.sqlite.prepare('SELECT bundle FROM pipeline_state').get();
  assert.ok(Buffer.byteLength(row.bundle) < 2_000_000, 'fits the actual D1 row limit');
  // Compression used to kick in here. Gzipping a payload this size on every
  // commit AND every load is what exhausted the 10 ms CPU budget and killed
  // the cron, so a mass attack is now written as-is; only a payload near the
  // D1 row limit is worth compressing at all.
  assert.ok(!row.bundle.startsWith('gzip:'), 'a mass attack is no longer compressed every cycle');
  // 1500 MAPA threats + 1 standing NEPTUN alert. No row is written for the
  // retired source — not a success, not a failure.
  assert.equal(env.nebo_journal.sqlite.prepare('SELECT COUNT(*) AS n FROM journal').get().n, 1501);
});

test('frontend adapts unchanged and changed snapshots without inventing timestamps', async () => {
  const env = testEnv(); globalThis.fetch = mockSources(sourceRoutes());
  await run(env); const first = await read(env);
  globalThis.fetch = async () => Response.json(first);
  const a = await fetchAggregated(), b = await fetchAggregated();
  assert.equal(a.receivedAt.getTime(), b.receivedAt.getTime());
  assert.equal(a.dataUpdatedAt.getTime(), b.dataUpdatedAt.getTime());
  const changed = { ...first, pipelineCheckedAt: '2026-10-09T08:00:00Z' };
  globalThis.fetch = async () => Response.json(changed);
  assert.equal((await fetchAggregated()).pipelineCheckedAt.toISOString(), changed.pipelineCheckedAt.replace('Z', '.000Z'));
});

test('SQL compare-and-swap rejects identical and older cycle versions', async () => {
  const env = testEnv();
  const bundle = { startedAt: 10, snapshot: {}, prev: { alerts: [], threats: [] } };
  assert.equal(await commitRuntime(env.nebo_journal, bundle), true);
  assert.equal(await commitRuntime(env.nebo_journal, bundle), false);
  assert.equal(await commitRuntime(env.nebo_journal, { ...bundle, startedAt: 9 }), false);
});
