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
const officialAlerts = s => s.alerts.filter(a => a.source === 'OFFICIAL');
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
  assert.equal(officialAlerts(data).length, 1);
  assert.equal(data.storage, 'd1');
  for (const key of ['pipelineStartedAt', 'pipelineCheckedAt', 'publishedAt', 'responseAt']) assert.ok(Date.parse(data[key]));
  assert.equal(data.alerts[0].eventTime, '2026-10-09T05:00:00.000Z');
});

for (const status of [401, 500]) test(`UA ${status} for repeated cycles never deletes its alarms; monitoring still publishes`, async () => {
  const env = testEnv(), routes = sourceRoutes();
  globalThis.fetch = mockSources(routes);
  await run(env);
  const lastSuccess = (await read(env)).health.OFFICIAL.updatedAt;
  routes['/api/v3/alerts/status'] = new Response('{}', { status });
  for (let n = 0; n < 5; n++) {
    routes['/mapa'] = { objects: [{ id: n, kind: 'uav', status: 'active', lat: 49, lon: 31, last_seen: Date.now() / 1000 }] };
    await run(env);
    const state = await read(env);
    assert.equal(officialAlerts(state).length, 1);
    assert.equal(officialAlerts(state)[0].stale, true);
    assert.equal(officialAlerts(state)[0].misses, 0);
    assert.equal(state.health.OFFICIAL.status, 'offline');
    assert.equal(state.health.OFFICIAL.updatedAt, lastSuccess);
    assert.ok(state.events.some(e => e.id === `mapa:${n}`), 'new event is immediately visible, no 3-minute throttle');
  }
});

test('UA pending does not block monitoring publication; final failure retains the first publication', async () => {
  const env = testEnv(), routes = sourceRoutes();
  let finish;
  routes['/api/v3/alerts/status'] = () => new Promise(resolve => { finish = resolve; });
  globalThis.fetch = mockSources(routes);
  const pending = run(env);
  let early;
  for (let n = 0; n < 50; n++) {
    await tick(); early = await loadRuntime(env.nebo_journal);
    if (early) break;
  }
  assert.ok(early, 'D1 publication exists before UA resolves');
  assert.equal(early.snapshot.health.MAPA.status, 'online');
  finish(new Response('{}', { status: 401 }));
  await pending;
  assert.equal((await read(env)).health.OFFICIAL.status, 'offline');
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
  routes['/api/v3/alerts/status'] = () => ++calls === 1
    ? new Promise(resolve => { finish = resolve; })
    : new Response('{"lastActionIndex":456}');
  globalThis.fetch = mockSources(routes);
  const older = run(env);
  for (let n = 0; n < 20 && !finish; n++) await tick();
  await run(env);
  const newer = await loadRuntime(env.nebo_journal);
  finish(new Response('{}', { status: 401 }));
  await older;
  const final = await loadRuntime(env.nebo_journal);
  assert.equal(final.startedAt, newer.startedAt);
  assert.equal(final.snapshot.health.OFFICIAL.status, 'online');
});

test('failed publication cannot advance the UA version; next cycle fetches and publishes it', async () => {
  const env = testEnv(), routes = sourceRoutes(), calls = [];
  globalThis.fetch = mockSources(routes, calls);
  await run(env);
  routes['/api/v3/alerts/status'] = { lastActionIndex: 124 };
  routes['/api/v3/alerts'] = [];
  const prepare = env.nebo_journal.prepare;
  env.nebo_journal.prepare = sql => {
    if (sql.includes('INSERT INTO pipeline_state')) throw new Error('D1 unavailable');
    return prepare(sql);
  };
  // A failed commit no longer kills the cycle: lanes still verify, the fresh
  // snapshot reaches the KV checkpoint on content change, and the served D1
  // state keeps the last committed officials (no invented all-clear, no silence).
  await run(env);
  const duringFailure = await read(env);
  assert.equal(officialAlerts(duringFailure).length, 1);
  const kvSnap = JSON.parse(env.NEBO_STATE.data.get('v1:latest'));
  assert.ok(Date.parse(kvSnap.snapshot.pipelineCheckedAt) >= Date.parse(duringFailure.pipelineCheckedAt));
  env.nebo_journal.prepare = prepare;
  const fullBefore = calls.filter(p => p === '/api/v3/alerts').length;
  await run(env);
  assert.equal(calls.filter(p => p === '/api/v3/alerts').length, fullBefore + 1);
  // Grace counts successful absence checks, including version-carried EMPTY
  // data. It must not resurrect the previous alert from its grace state.
  await run(env); await run(env);
  assert.equal(officialAlerts(await read(env)).length, 0);
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
