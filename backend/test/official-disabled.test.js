// UkraineAlarm is retired in production. These tests pin what "off" must mean:
// zero upstream traffic, no cost to the pipeline, no false all-clear, and
// nothing that would stop the source coming back with one config line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDurablePipeline } from '../src/pipeline.js';
import { officialSourceEnabled, fetchOfficialUkraineAlarm } from '../src/ukrainealarm.js';
import { loadRuntime } from '../src/runtime-state.js';
import { testEnv, mockSources, sourceRoutes } from './helpers/runtime.js';

const OFF = { OFFICIAL_SOURCE_ENABLED: 'false' };
const disabledEnv = (over = {}) => ({ ...testEnv(), ...OFF, ...over });

// The default fixture is empty; these routes carry real monitoring data so the
// tests can prove the primaries still publish while the source is off.
const liveRoutes = () => ({
  ...sourceRoutes(),
  '/threats': { threats: [{ id: 't1', lat: 50.4, lon: 30.5, type: 'uav', last_seen: Date.now() / 1000, status: 'active' }] },
  '/mapa': { objects: [{ id: 'm1', lat: 49.8, lon: 30.6, kind: 'uav', status: 'active', last_seen: Date.now() / 1000 }] },
  '/alerts': { oblasts: [{ name: 'Одеська область', key: 'od', since: new Date().toISOString(), level: 'red', reasons: ['бойові дії'] }], raions: [] },
});

// Fails on any attempt to reach the provider: a retired source must not even
// build a request.
const noNetwork = () => { throw new Error('the retired source must not make requests'); };

// ── 1. The switch ──────────────────────────────────────────────────────────
test('the switch fails closed: absent means disabled', () => {
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: 'false' }), false);
  assert.equal(officialSourceEnabled({}), false, 'no var must not enable the source');
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: '' }), false);
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: 'off' }), false);
  assert.equal(officialSourceEnabled(null), false);
});

test('the switch is explicit and re-enableable', () => {
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: 'true' }), true);
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: '1' }), true);
  assert.equal(officialSourceEnabled({ OFFICIAL_SOURCE_ENABLED: 'ON' }), true);
});

test('the adapter short-circuits before any network call', async () => {
  const env = disabledEnv({ UKRAINEALARM_API_KEY: 'a-real-looking-key' });
  globalThis.fetch = noNetwork;
  const out = await fetchOfficialUkraineAlarm(env);
  assert.equal(out.ok, true, 'not a failure');
  assert.equal(out.disabled, true);
  assert.equal(out.error, null, 'no error: it is switched off, not failing');
  assert.deepEqual(out.items, []);
});

// ── 2. The pipeline ────────────────────────────────────────────────────────
test('a full cycle makes ZERO requests to api.ukrainealarm.com', async () => {
  const env = disabledEnv();
  const calls = [];
  globalThis.fetch = mockSources(sourceRoutes(), calls);
  await runDurablePipeline(env);
  const ua = calls.filter((p) => p.startsWith('/api/v3/'));
  assert.deepEqual(ua, [], 'no /alerts, no /alerts/status, no /regions, no history');
  assert.ok(calls.length > 0, 'the real sources were still fetched');
});

test('the retired source reports disabled with no error', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  const snap = await runDurablePipeline(env);
  assert.equal(snap.health.OFFICIAL.status, 'disabled');
  assert.equal(snap.health.OFFICIAL.error, null, 'never rendered as a failure');
  assert.equal(snap.health.OFFICIAL.updatedAt, null);
});

test('NEPTUN and MAPA are unaffected and liveness still advances', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(liveRoutes());
  const snap = await runDurablePipeline(env);
  assert.equal(snap.health.NEPTUN.status, 'online');
  assert.equal(snap.health.MAPA.status, 'online');
  assert.ok(Number.isFinite(Date.parse(snap.pipelineCheckedAt)), 'pipelineCheckedAt is a real time');
  assert.ok(snap.events.length > 0, 'monitoring events are published');
});

test('liveness keeps advancing across cycles with the source off', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  const seen = new Set();
  for (let i = 0; i < 3; i++) seen.add((await runDurablePipeline(env)).pipelineCheckedAt);
  assert.equal(seen.size, 3, 'pipelineCheckedAt must not be pinned');
});

test('no OFFICIAL row is written to the checks table', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  const n = env.nebo_journal.sqlite
    .prepare("SELECT COUNT(*) AS n FROM checks WHERE source='OFFICIAL'").get().n;
  assert.equal(n, 0, 'a switched-off source must not cost a D1 write per cycle');
  const primaries = env.nebo_journal.sqlite
    .prepare("SELECT COUNT(DISTINCT source) AS n FROM checks").get().n;
  assert.equal(primaries, 2, 'NEPTUN and MAPA are still checked');
});

test('the version-gate table is never touched', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  const rows = env.nebo_journal.sqlite.prepare('SELECT COUNT(*) AS n FROM ua_sync').get().n;
  assert.equal(rows, 0, 'no lastActionIndex, no 429 backoff');
});

test('the regions cache is not written', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  assert.equal(env.NEBO_STATE.puts, 0, 'no KV write for a retired source');
});

// ── 3. Historical OFFICIAL records: retired, never deleted ─────────────────
test('records of a retired source leave the active set and are journalled as ended', async () => {
  const env = testEnv();                       // enabled for one cycle
  globalThis.fetch = mockSources(sourceRoutes());
  const first = await runDurablePipeline(env);
  assert.ok(first.alerts.some((a) => a.source === 'OFFICIAL'), 'OFFICIAL alerts exist first');
  const journalBefore = env.nebo_journal.sqlite
    .prepare("SELECT COUNT(*) AS n FROM journal WHERE source='OFFICIAL'").get().n;
  assert.ok(journalBefore > 0, 'they were journalled while active');

  // Now retire the source and run another cycle.
  env.OFFICIAL_SOURCE_ENABLED = 'false';
  globalThis.fetch = mockSources(sourceRoutes(), []);
  const second = await runDurablePipeline(env);

  assert.equal(second.alerts.filter((a) => a.source === 'OFFICIAL').length, 0,
    'a retired source must not be republished as a current confirmation');
  const journalAfter = env.nebo_journal.sqlite
    .prepare("SELECT COUNT(*) AS n FROM journal WHERE source='OFFICIAL'").get().n;
  assert.ok(journalAfter >= journalBefore, 'audit history is kept, never deleted');
});

test('retiring the source does not pin its records stale forever', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  env.OFFICIAL_SOURCE_ENABLED = 'false';
  globalThis.fetch = mockSources(sourceRoutes());
  await runDurablePipeline(env);
  const stored = await loadRuntime(env.nebo_journal);
  const leftover = stored.prev.alerts.filter((a) => a.source === 'OFFICIAL');
  assert.equal(leftover.length, 0,
    'outage protection exists for transient failures and must not pin a retired source');
});

test('NEPTUN alerts are untouched by the retirement', async () => {
  const env = testEnv();
  const routes = liveRoutes();
  globalThis.fetch = mockSources(routes);
  await runDurablePipeline(env);
  env.OFFICIAL_SOURCE_ENABLED = 'false';
  globalThis.fetch = mockSources(routes);
  const snap = await runDurablePipeline(env);
  assert.ok(snap.alerts.some((a) => String(a.source).startsWith('NEPTUN')), 'NEPTUN alerts survive');
  assert.equal(snap.alerts.filter((a) => a.source === 'OFFICIAL').length, 0);
});

// ── 4. No false all-clear ──────────────────────────────────────────────────
test('the site never shows an all-clear while NEPTUN and MAPA are down', async () => {
  const env = disabledEnv();
  globalThis.fetch = mockSources({
    '/alerts': new Error('down'),
    '/threats': new Error('down'),
    '/mapa': new Error('down'),
  });
  const snap = await runDurablePipeline(env);
  assert.notEqual(snap.health.NEPTUN.status, 'online');
  assert.notEqual(snap.health.MAPA.status, 'online');
  // Switching the official source off must not mask a monitoring outage.
  assert.ok(!String(snap.pipelineCheckedAt || '').includes('undefined'));
});

// ── 5. The integration is still there and still works ──────────────────────
test('setting the switch back to true restores the integration', async () => {
  const env = testEnv();
  globalThis.fetch = mockSources(sourceRoutes());
  const snap = await runDurablePipeline(env);
  assert.equal(snap.health.OFFICIAL.status, 'online', 're-enabling needs no code change');
  assert.ok(snap.alerts.some((a) => a.source === 'OFFICIAL'));
});

test('production configuration ships the source switched off', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const line = toml.split(/\r?\n/).find((l) => /^\s*OFFICIAL_SOURCE_ENABLED\s*=/.test(l));
  assert.ok(line, 'the switch is declared in wrangler.toml');
  assert.match(line, /=\s*"false"\s*$/, 'production has the source switched off');
});
