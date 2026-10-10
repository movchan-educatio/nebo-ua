import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchPush } from '../src/push.js';
import { testEnv, mockSources } from './helpers/runtime.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Why this file exists ────────────────────────────────────────
// On 2026-10-09 the cron pipeline degraded from 60 cycles/hour to zero and the
// site sat on "ДАНІ ЗАСТАРІЛІ". Root cause: dispatchPush CPU work ran BEFORE
// recordChecksBatch, so an isolate killed mid-push left no liveness trace at
// all. These tests pin the two guarantees that were missing.

test('regression: liveness checks are written before any push crypto runs', () => {
  const src = fs.readFileSync(path.join(root, 'backend/src/pipeline.js'), 'utf8');
  const checksIdx = src.indexOf('recordChecksBatch(env.nebo_journal, [');
  const firstPublishIdx = src.indexOf('await publish()');
  assert.ok(checksIdx > -1, 'pipeline records checks');
  assert.ok(firstPublishIdx > -1, 'pipeline has the early publish');
  assert.ok(checksIdx < firstPublishIdx,
    'monitoring liveness must be recorded BEFORE the first publish (and thus before push dispatch)');
});

test('regression: push fan-out per cycle is hard-bounded', async () => {
  const env = testEnv();
  env.VAPID_PUBLIC_KEY = 'x';
  env.VAPID_PRIVATE_KEY = 'y';
  env.VAPID_SUBJECT = 'mailto:test.invalid';
  const now = new Date();
  // Three subscribers that follow nothing -> maximum relevance misses.
  for (let i = 0; i < 3; i++) {
    await env.nebo_journal.prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, places, categories, quiet, oblast_norm, created_at, last_seen, failures)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(`https://push.invalid/s${i}`, 'k', 'a', '[]', '{}', '{}', '', now.toISOString(), now.toISOString()).run();
  }
  // 400 fresh events: far beyond one cycle's worth.
  const events = Array.from({ length: 400 }, (_, i) => ({
    id: `t:${i}`, source: 'MAPA', category: 'uav', stale: false,
    eventTime: new Date(now.getTime() - i * 1000).toISOString(),
    region: `R${i}`, district: null, settlement: null, lat: 49, lon: 31,
  }));
  const out = await dispatchPush(env, { snapshot: { events, alerts: [] }, prevIds: { threats: [], alerts: [] }, endedAlerts: [], now });
  assert.ok(out.jobsDropped > 0, `overflow counted, not silent (dropped=${out.jobsDropped})`);
  const rows = env.nebo_journal.sqlite.prepare('SELECT status FROM push_log').all();
  // Relevance misses are aggregated: bounded rows, not subscribers x events.
  const aggregate = rows.filter(r => String(r.status).startsWith('skipped-place'));
  assert.ok(aggregate.length <= 2, `relevance misses are aggregated (rows=${aggregate.length})`);
});

test('regression: push can never break the publishing cycle', async () => {
  const env = testEnv();
  env.VAPID_PUBLIC_KEY = 'x';
  env.VAPID_PRIVATE_KEY = 'y';
  env.VAPID_SUBJECT = 'mailto:test.invalid';
  const now = new Date();
  await env.nebo_journal.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, places, categories, quiet, oblast_norm, created_at, last_seen, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind('https://push.invalid/x', 'k', 'a', '[]', '{}', '{}', '', now.toISOString(), now.toISOString()).run();
  // A journal that explodes on every push_log write.
  env.nebo_journal.prepare = () => ({ bind: () => ({ run: async () => { throw new Error('D1 down'); } }) });
  const out = await dispatchPush(env, {
    snapshot: { events: [{ id: 'e1', source: 'MAPA', category: 'uav', stale: false, eventTime: now.toISOString(), region: 'R', district: null, lat: 49, lon: 31 }], alerts: [] },
    prevIds: { threats: [], alerts: [] }, endedAlerts: [], now,
  });
  assert.ok(out && typeof out.sent === 'number', 'dispatchPush returns counters instead of throwing');
});
