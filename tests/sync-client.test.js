import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSnapshot } from '../services/snapshot.js';
import { fetchAggregated } from '../services/aggregator.js';
import { fetchAll } from '../services/data.js';

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('an older fallback snapshot cannot rewind a newer publication', () => {
  const previous = { publishedAt: new Date('2026-10-09T08:00Z'), events: [{ id: 'new' }] };
  const incoming = { publishedAt: new Date('2026-10-09T07:55Z'), events: [] };
  const result = mergeSnapshot(previous, incoming);
  assert.equal(result.events[0].id, 'new'); assert.equal(result.degraded, true);
});

test('direct fallback cannot clear offline official alerts or pretend NEPTUN is UkraineAlarm', async () => {
  globalThis.fetch = async url => {
    if (String(url).endsWith('/v1/state')) return new Response('{}', { status: 503 });
    return Response.json({ oblasts: [], raions: [], threats: [], objects: [] });
  };
  const incoming = await fetchAll();
  assert.equal(incoming.health.OFFICIAL.status, 'offline');
  const lastSuccess = new Date('2026-10-09T06:00:00Z');
  const merged = mergeSnapshot({ alerts: [{ id: 'ua:1', source: 'OFFICIAL' }],
    health: { OFFICIAL: { updatedAt: lastSuccess } } }, incoming);
  assert.equal(merged.alerts[0].id, 'ua:1'); assert.equal(merged.alerts[0].stale, true);
  assert.equal(merged.health.OFFICIAL.lastSuccessAt, lastSuccess);
});

test('successful alerts alone cannot advance monitoring freshness during direct fallback', async () => {
  globalThis.fetch = async url => String(url).endsWith('/alerts')
    ? Response.json({ oblasts: [], raions: [] }) : new Response('{}', { status: 503 });
  const incoming = await fetchAll();
  assert.equal(incoming.receivedAt, null);
  const previousTime = new Date('2026-10-09T06:00:00Z');
  const merged = mergeSnapshot({ receivedAt: previousTime }, incoming);
  assert.equal(merged.receivedAt, previousTime);
  assert.equal(merged.degraded, true);
});

test('all unavailable sources reject, leaving the UI its previous snapshot', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  await assert.rejects(fetchAll(), /Усі джерела/);
});

test('missing source times stay unknown; HTTP receipt is not a freshness timestamp', async () => {
  globalThis.fetch = async () => Response.json({ v: 1, alerts: [], events: [{ id: 'x' }], health: {} });
  const snapshot = await fetchAggregated();
  assert.equal(snapshot.receivedAt, null); assert.equal(snapshot.events[0].receivedAt, null);
});
