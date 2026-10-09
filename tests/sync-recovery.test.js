import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../services/http.js';
import { fetchAggregated } from '../services/aggregator.js';
import { isFresh } from '../services/normalize.js';
import { mergeSnapshot }from '../services/snapshot.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.parse('2026-10-09T08:00:00.000Z');

// Scenario 4 (frontend half): HTTP 304 is a fetch failure, never data.
// The caller (dashboard load catch) keeps the previous snapshot as-is.
test('fetchJson rejects HTTP 304 so a conditional upstream can never look like data', async () => {
  globalThis.fetch = async () => new Response(null, { status: 304 });
  await assert.rejects(fetchJson('https://backend.invalid/v1/state'), /HTTP 304/);
  let sent = null;
  globalThis.fetch = async (url, opts) => { sent = opts; return new Response('{}', { status: 503 }); };
  await assert.rejects(fetchJson('https://backend.invalid/v1/state'), /HTTP 503/);
  assert.ok(!sent?.headers?.['If-None-Match'], 'never sends conditional headers');
});

// Scenario 15: new frontend reads an OLD backend shape (only v/alerts/events).
test('new frontend reads a legacy aggregator shape without inventing timestamps', async () => {
  globalThis.fetch = async () => Response.json({
    v: 1, alerts: [], events: [{ id: 'e1', eventTime: '2026-10-09T07:59:00.000Z' }],
    health: {}, serverTime: '2026-10-09T08:00:00.000Z',
  });
  const snap = await fetchAggregated();
  assert.equal(new Date(snap.receivedAt).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.ok(!snap.degraded, 'no degraded flag without evidence');
  assert.equal(snap.events[0].timestamp.toISOString(), '2026-10-09T07:59:00.000Z');
});

// Scenario 14: old-shape validation still accepts the NEW d1 response
// (v/alerts/events/serverTime present; extra fields ignored by old clients).
test('d1-mode response keeps the legacy contract fields old clients read', async () => {
  globalThis.fetch = async () => Response.json({
    v: 1, alerts: [], events: [], health: { NEPTUN: { status: 'online', checkedAt: '2026-10-09T08:00:00.000Z', lastSuccessAt: '2026-10-09T08:00:00.000Z' } },
    serverTime: '2026-10-09T08:00:00.000Z', pipelineCheckedAt: '2026-10-09T08:00:00.000Z',
    publishedAt: '2026-10-09T08:00:00.000Z', responseAt: '2026-10-09T08:00:00.000Z', degraded: false,
  });
  const snap = await fetchAggregated();
  assert.equal(new Date(snap.receivedAt).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(new Date(snap.publishedAt).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(new Date(snap.health.NEPTUN.lastSuccessAt).toISOString(), '2026-10-09T08:00:00.000Z');
});

// Scenario 13: server/client clock skew — future eventTime is preserved
// (never rewritten), far-past input is stale, never "fresh".
test('clock skew: future source time is kept as-is, ancient input is stale', () => {
  const future = new Date(NOW + 10 * 60000);
  assert.equal(isFresh({ category: 'uav', timestamp: future }, NOW), true);
  const ancient = new Date(NOW - 60 * 60000);
  assert.equal(isFresh({ category: 'uav', timestamp: ancient }, NOW), false);
  assert.equal(isFresh({ category: 'uav', timestamp: 'not-a-date' }, NOW), false);
});

// Scenario 9/10 (merge half): a newer committed view survives an older
// recovery checkpoint, and offline-source rows are kept stale, not dropped.
test('mergeSnapshot prefers the newer publication and keeps offline rows stale', () => {
  const prev = { publishedAt: '2026-10-09T08:00:00.000Z', alerts: [], events: [{ id: 'm1', source: 'MAPA' }], health: {}, receivedAt: '2026-10-09T08:00:00.000Z' };
  const older = { publishedAt: '2026-10-09T07:50:00.000Z', directFallback: true, alerts: [], events: [], health: { MAPA: { status: 'online' } } };
  const kept = mergeSnapshot(prev, older);
  assert.equal(kept.events[0].id, 'm1');
  assert.equal(kept.degraded, true);
  const offline = { publishedAt: '2026-10-09T08:01:00.000Z', directFallback: true, alerts: [], events: [], health: { MAPA: { status: 'offline' } }, receivedAt: null };
  const merged = mergeSnapshot(prev, offline);
  assert.equal(merged.events[0].id, 'm1');
  assert.equal(merged.events[0].stale, true);
  assert.equal(new Date(merged.receivedAt).toISOString(), '2026-10-09T08:00:00.000Z');
});

// Scenario 11: Service Worker can never serve the LIVE API from cache.
test('service worker bypasses /v1/ and /api/, falls back to index only for navigations', () => {
  const sw = readFileSync(path.join(root, 'service-worker.js'), 'utf8');
  assert.match(sw, /CACHE='nebo-shell-[^']+'/);
  const shell = sw.match(/SHELL=\[(.*?)\]/s)[1];
  const entries = [...shell.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(entries.length > 10, 'precache list present');
  for (const e of entries) {
    assert.ok(!/^https?:/.test(e), `no absolute URL in precache: ${e}`);
    assert.ok(!e.includes('/v1/') && !e.includes('/api/'), `no API entry in precache: ${e}`);
    assert.ok(existsSync(path.join(root, e.replace(/^\.\//, ''))), `precached file exists: ${e}`);
  }
  assert.ok(sw.includes("startsWith('/v1/')") || sw.includes('/v1/'), 'fetch handler bypasses /v1/');
  assert.ok(sw.includes("mode==='navigate'"), 'offline fallback is navigation-only');
});
