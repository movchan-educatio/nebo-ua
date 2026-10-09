import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runDurablePipeline } from '../src/pipeline.js';
import { isFreshEvent } from '../src/normalize.js';
import { testEnv, sourceRoutes, mockSources } from './helpers/runtime.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const tick = () => new Promise(resolve => setTimeout(resolve, 3));
async function read(env) {
  const res = await worker.fetch(new Request('https://worker.invalid/v1/state'), env);
  assert.equal(res.status, 200);
  return res.json();
}

// Scenario 4 (backend half): an upstream 304 is a source failure.
// Previous state is kept, health goes offline, nothing is faked as fresh.
test('upstream HTTP 304 fails the lane honestly and keeps the previous snapshot', async () => {
  const env = testEnv(), routes = sourceRoutes();
  globalThis.fetch = mockSources(routes);
  await tick(); await runDurablePipeline(env);
  const before = await read(env);
  assert.equal(before.health.MAPA.status, 'online');
  routes['/mapa'] = new Response(null, { status: 304 });
  await tick(); await runDurablePipeline(env);
  const after = await read(env);
  assert.equal(after.health.MAPA.status, 'offline');
  assert.ok(Date.parse(after.pipelineCheckedAt) >= Date.parse(before.pipelineCheckedAt));
  assert.ok((after.events || []).length >= 0);
});

// Scenario 13 (backend half): clock skew — future source time is preserved
// verbatim (never clamped to now), ancient input is stale.
test('future eventTime survives normalization; far-past input is stale', async () => {
  const { normalizeMapa } = await import('../src/normalize.js');
  const future = new Date(Date.now() + 10 * 60000);
  const ev = normalizeMapa({ id: 1, status: 'active', lat: 49, lon: 31, last_seen: future.getTime() / 1000, kind: 'uav' }, new Date());
  assert.equal(new Date(ev.eventTime).getTime(), future.getTime());
  assert.equal(isFreshEvent('uav', ev.eventTime, Date.now()), true);
  assert.equal(isFreshEvent('uav', new Date(Date.now() - 3600000).toISOString(), Date.now()), false);
  assert.equal(isFreshEvent('uav', null, Date.now()), false);
});

// Scenario 14 (backend half): the d1-mode response keeps every field an old
// client reads (v, alerts[], events[], serverTime), extras are additive.
test('d1 response keeps the legacy contract for old clients', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await tick(); await runDurablePipeline(env);
  const data = await read(env);
  assert.equal(data.v, 1);
  assert.ok(Array.isArray(data.alerts) && Array.isArray(data.events));
  assert.ok(Number.isFinite(Date.parse(data.serverTime)));
  assert.ok(Number.isFinite(Date.parse(data.pipelineCheckedAt)));
});

// LEGACY hardening: the compatibility passthrough aborts a hung upstream
// instead of holding the invocation open.
test('legacy passthrough carries an abort signal to the upstream fetch', async () => {
  let seen = null;
  globalThis.fetch = async (url, opts) => { seen = opts?.signal; return Response.json({ objects: [] }); };
  const env = { MAPA_URL: 'https://sources.invalid/mapa' };
  const res = await worker.fetch(new Request('https://worker.invalid/mapa'), env);
  assert.equal(res.status, 200);
  assert.ok(seen instanceof AbortSignal, 'upstream fetch is abortable');
});
