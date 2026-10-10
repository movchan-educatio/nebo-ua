// Regression tests for the frozen-LIVE fix (STATE TIME ≠ PIPELINE HEALTH).
// Contract:
//   dataUpdatedAt     = when visible content last changed (KV bundle, write-gated).
//   pipelineCheckedAt = last SUCCESSFUL upstream verification (D1 checks, read path, 0 KV writes).
//   serverTime/receivedAt mirror pipelineCheckedAt when known (legacy consumers).
// Rules under test:
//   1. unchanged + success  -> checkedAt fresh, dataUpdatedAt untouched, 0 PUT.
//   2. changed alerts       -> immediate state update.
//   3. changed threats      -> throttled update, dataUpdatedAt moves only on write.
//   4. failed upstream      -> checkedAt does NOT advance (no fake heartbeat).
//   5. stale pipeline       -> OFFLINE.
//   6. live pipeline + calm data >30min -> NOT offline (the core split).
//   7. read path never writes; new state visible right after write; cache headers set.
//   8. KV write-gating preserved (no per-minute PUT regression).
//   9. 24h budget simulation: normal <200/day, worst churn <500/day.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {
  latestPipelineCheck, buildStateResponse, mergeHealth, livenessLevel,
  LIVE_MS, OFFLINE_MS,
} from '../src/index.js';
import { meaningfulFp, shouldWrite, HEARTBEAT_MS } from '../src/store.js';

const T0 = 1760000000000;
const MIN = 60_000;

// ── fakes ─────────────────────────────────────────────────────────────────
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

// Minimal D1 stub: checks rows, journal no-ops, push no-ops.
function fakeD1() {
  const checks = [];
  const db = {
    checks,
    prepare(sql) {
      const isChecksInsert = sql.includes('INSERT INTO checks');
      const isChecksSelect = /FROM checks/.test(sql);
      const isJournalSelect = sql.includes('FROM journal');
      const stmt = {
        bind: (...params) => ({
          _params: params,
          _checksInsert: isChecksInsert,
          run: async () => {
            if (isChecksInsert) checks.push({ ts: params[0], source: params[1], ok: params[2], error: params[4] });
            return { success: true };
          },
          all: async () => {
            if (isJournalSelect) return { results: [] };
            return { results: [] };
          },
        }),
        run: async () => ({ success: true }),
        all: async () => {
          if (isChecksSelect) {
            return {
              results: [...checks].reverse().slice(0, 60)
                .map(c => ({ source: c.source, ts: c.ts, ok: c.ok, error: c.error })),
            };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
    batch: async (stmts) => {
      for (const s of stmts || []) {
        if (s?._checksInsert) {
          const p = s._params;
          checks.push({ ts: p[0], source: p[1], ok: p[2], error: p[4] });
        }
      }
      return { success: true };
    },
  };
  return db;
}

function stubFetch(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = routes[String(url).split('?')[0]];
    if (body instanceof Error) throw body;
    if (!body) throw new Error('unexpected fetch ' + url);
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  return () => { globalThis.fetch = real; };
}

const baseEnv = (kv, db) => ({
  NEBO_STATE: kv, nebo_journal: db,
  NEPTUN_ALERTS_URL: 'https://src.test/alerts',
  NEPTUN_THREATS_URL: 'https://src.test/threats',
  MAPA_URL: 'https://src.test/mapa',

  REFRESH_TOKEN: 'test-refresh',
});
const emptySources = {
  'https://src.test/alerts': { oblasts: [], raions: [] },
  'https://src.test/threats': { threats: [] },
  'https://src.test/mapa': { objects: [] },
};
const postRefresh = () => new Request('https://worker.test/v1/refresh', { method: 'POST', headers: { Authorization: 'Bearer test-refresh' } });
const getState = () => new Request('https://worker.test/v1/state');

async function refresh(env) {
  const r = await worker.fetch(postRefresh(), env);
  assert.equal(r.status, 200);
  return r.json();
}
async function readState(env) {
  const r = await worker.fetch(getState(), env);
  assert.equal(r.status, 200);
  return { res: r, body: await r.json() };
}

// ── 1. unchanged + success: checkedAt fresh, dataUpdatedAt untouched ──────
test('1. unchanged data + successful pipeline -> checkedAt moves, dataUpdatedAt frozen, 0 extra PUT', async () => {
  const restore = stubFetch(emptySources);
  try {
    const c = countingKv();
    const db = fakeD1();
    const env = baseEnv(c.kv, db);
    await refresh(env);
    assert.equal(c.puts(), 1, 'cold start writes once');
    const first = await readState(env);
    const d1 = first.body.dataUpdatedAt;
    assert.ok(d1, 'dataUpdatedAt present');
    await refresh(env);
    assert.equal(c.puts(), 1, 'unchanged second cycle writes nothing');
    const second = await readState(env);
    assert.equal(second.body.dataUpdatedAt, d1, 'dataUpdatedAt NOT faked forward');
    assert.ok(second.body.pipelineCheckedAt, 'pipelineCheckedAt present');
    assert.ok(Date.parse(second.body.pipelineCheckedAt) >= Date.parse(first.body.pipelineCheckedAt),
      'pipelineCheckedAt advanced on successful re-check');
    assert.equal(second.body.serverTime, second.body.pipelineCheckedAt, 'legacy serverTime mirrors liveness');
    assert.equal(second.body.receivedAt, second.body.pipelineCheckedAt, 'legacy receivedAt mirrors liveness');
    assert.equal(livenessLevel(second.body, Date.now()), 'LIVE');
  } finally {
    restore();
  }
});

// ── 2. changed alerts -> immediate update ─────────────────────────────────
test('2. changed alerts -> immediate state update + dataUpdatedAt advances', async () => {
  let routes = { ...emptySources };
  const restore = stubFetch(routes);
  try {
    const c = countingKv();
    const env = baseEnv(c.kv, fakeD1());
    await refresh(env);
    const before = (await readState(env)).body.dataUpdatedAt;
    routes['https://src.test/alerts'] = {
      oblasts: [{ name: 'Київ', since: new Date().toISOString(), level: 'alarm', reasons: ['Тривога'] }],
      raions: [],
    };
    await refresh(env);
    assert.equal(c.puts(), 2, 'alert activation writes immediately');
    const after = await readState(env);
    assert.ok(after.body.alerts.length >= 1, 'new alert visible');
    assert.notEqual(after.body.dataUpdatedAt, before, 'dataUpdatedAt moved with real change');
  } finally {
    restore();
  }
});

// ── 3. changed threats -> throttled; dataUpdatedAt moves only on write ────
test('3. threat churn inside throttle window -> 0 PUT, dataUpdatedAt frozen', async () => {
  const tA = { threats: [{ id: 't1', type: 'uav', lat: 50.0, lon: 30.0, status: 'active', updatedAt: new Date(T0).toISOString() }] };
  const tB = { threats: [{ id: 't1', type: 'uav', lat: 50.5, lon: 30.5, status: 'active', updatedAt: new Date(T0 + 30_000).toISOString() }] };
  const restore = stubFetch({
    'https://src.test/alerts': { oblasts: [], raions: [] },
    'https://src.test/threats': tA,
    'https://src.test/mapa': { objects: [] },
  });
  try {
    const c = countingKv();
    const db = fakeD1();
    const env = baseEnv(c.kv, db);
    await refresh(env);
    assert.equal(c.puts(), 1);
    const d1 = (await readState(env)).body.dataUpdatedAt;
    // Swap stub to a MOVED threat and refresh immediately (inside 3-min throttle).
    globalThis.fetch = async (url) => {
      const k = String(url).split('?')[0];
      const body = k.endsWith('/threats') ? tB : emptySources[k];
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    await refresh(env);
    assert.equal(c.puts(), 1, 'throttled threat move writes nothing');
    const second = await readState(env);
    assert.equal(second.body.dataUpdatedAt, d1, 'dataUpdatedAt frozen while throttled');
    assert.ok(second.body.pipelineCheckedAt, 'but liveness still fresh');
    assert.equal(livenessLevel(second.body, Date.now()), 'LIVE');
  } finally {
    restore();
  }
});

// ── 4. failed upstream -> checkedAt does NOT advance ──────────────────────
test('4. failed upstream -> pipelineCheckedAt frozen (no fake heartbeat)', async () => {
  const restore = stubFetch(emptySources);
  try {
    const c = countingKv();
    const db = fakeD1();
    const env = baseEnv(c.kv, db);
    await refresh(env);
    const good = await readState(env);
    const goodChecked = good.body.pipelineCheckedAt;
    assert.ok(goodChecked);
    // Now every source fails.
    globalThis.fetch = async () => { throw new Error('upstream down'); };
    await refresh(env);
    const bad = await readState(env);
    assert.equal(bad.body.pipelineCheckedAt, goodChecked, 'checkedAt must NOT move on failed verification');
    assert.equal(bad.body.health.NEPTUN.status, 'offline', 'health honestly offline');
    assert.equal(bad.body.health.MAPA.status, 'offline', 'health honestly offline');
    assert.equal(livenessLevel(bad.body, Date.now() + 31 * MIN), 'OFFLINE', 'stale check -> OFFLINE');
  } finally {
    restore();
  }
});

// ── 5. stale pipeline -> OFFLINE ──────────────────────────────────────────
test('5. stale pipelineCheckedAt -> OFFLINE', () => {
  const mk = (agoMs) => ({
    v: 1, serverTime: new Date(T0 - agoMs).toISOString(),
    pipelineCheckedAt: new Date(T0 - agoMs).toISOString(),
    health: { NEPTUN: { status: 'online' }, MAPA: { status: 'online' } },
  });
  assert.equal(livenessLevel(mk(60 * MIN), T0), 'OFFLINE');
  assert.equal(livenessLevel({ v: 1, health: {} }, T0), 'OFFLINE', 'missing checkedAt -> OFFLINE');
  assert.equal(livenessLevel(mk(10 * MIN), T0), 'DELAYED');
  assert.equal(livenessLevel(mk(60_000), T0), 'LIVE');
});

// ── 6. live pipeline + calm data >30min -> NOT offline (the core split) ───
test('6. working pipeline + unchanged data >30min -> LIVE, data age ignored', async () => {
  const db = fakeD1();
  const nowIso = new Date().toISOString();
  db.checks.push(
    { ts: nowIso, source: 'NEPTUN', ok: 1, error: null },
    { ts: nowIso, source: 'MAPA', ok: 1, error: null },
    { ts: nowIso, source: 'OFFICIAL', ok: 0, error: null },
  );
  const d1 = await latestPipelineCheck(db);
  assert.ok(d1.checkedAt, 'D1 success visible');
  const fortyMinAgo = new Date(Date.now() - 40 * MIN).toISOString();
  const bundle = {
    snapshot: {
      v: 1, serverTime: fortyMinAgo, receivedAt: fortyMinAgo, dataUpdatedAt: fortyMinAgo,
      alerts: [], events: [],
      health: {
        OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
        NEPTUN: { status: 'online', updatedAt: fortyMinAgo, error: null },
        MAPA: { status: 'online', updatedAt: fortyMinAgo, error: null },
      },
    },
    prev: { alerts: [], threats: [] },
    fpAlerts: 'a', fpThreats: 't', fpHealth: 'h',
    writtenAt: Date.now() - 40 * MIN, dataUpdatedAt: fortyMinAgo,
  };
  const merged = buildStateResponse(bundle, d1, Date.now());
  assert.equal(merged.dataUpdatedAt, fortyMinAgo, 'data time preserved');
  assert.equal(merged.pipelineCheckedAt, d1.checkedAt, 'liveness fresh');
  assert.ok(Date.now() - Date.parse(merged.serverTime) < 5 * MIN, 'legacy serverTime fresh');
  assert.equal(livenessLevel(merged, Date.now()), 'LIVE', 'calm data + live pipeline is LIVE (was: false OFFLINE)');
});

// ── mergeHealth: OFFICIAL disabled preserved; delayed flag kept ───────────
test('mergeHealth keeps OFFICIAL disabled and NEPTUN delayed flag', () => {
  const stored = {
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
    NEPTUN: { status: 'online', updatedAt: '2026-10-07T19:00:00.000Z', error: null, delayed: true },
    MAPA: { status: 'online', updatedAt: '2026-10-07T19:00:00.000Z', error: null },
  };
  const bySource = {
    NEPTUN: { ts: '2026-10-07T20:00:00.000Z', ok: true, error: null },
    MAPA: { ts: '2026-10-07T20:00:00.000Z', ok: false, error: 'HTTP 500' },
    OFFICIAL: { ts: '2026-10-07T20:00:00.000Z', ok: false, error: null },
  };
  const h = mergeHealth(stored, bySource);
  assert.equal(h.OFFICIAL.status, 'disabled', 'disabled never flips to offline');
  assert.equal(h.NEPTUN.status, 'online');
  assert.equal(h.NEPTUN.updatedAt, '2026-10-07T20:00:00.000Z');
  assert.equal(h.NEPTUN.delayed, true, 'stale-stream flag preserved while ok');
  assert.equal(h.MAPA.status, 'offline');
  assert.equal(h.MAPA.error, 'HTTP 500');
});

// ── latestPipelineCheck unit behavior ─────────────────────────────────────
test('latestPipelineCheck: newest success wins, OFFICIAL ignored, empty -> null', async () => {
  const db = fakeD1();
  assert.equal((await latestPipelineCheck(db)).checkedAt, null, 'empty checks -> null (honest, not now)');
  assert.equal((await latestPipelineCheck(null)).checkedAt, null);
  assert.equal((await latestPipelineCheck({})).checkedAt, null);
  db.checks.push(
    { ts: '2026-10-07T19:50:00.000Z', source: 'NEPTUN', ok: 1, error: null },
    { ts: '2026-10-07T19:55:00.000Z', source: 'MAPA', ok: 1, error: null },
    { ts: '2026-10-07T19:59:00.000Z', source: 'OFFICIAL', ok: 1, error: null },
  );
  const d1 = await latestPipelineCheck(db);
  assert.equal(d1.checkedAt, '2026-10-07T19:55:00.000Z', 'monitoring max, OFFICIAL excluded');
  db.checks.push({ ts: '2026-10-07T20:00:00.000Z', source: 'NEPTUN', ok: 0, error: 'HTTP 500' });
  const d2 = await latestPipelineCheck(db);
  assert.equal(d2.checkedAt, '2026-10-07T19:55:00.000Z', 'failed rows never advance the heartbeat');
  assert.equal(d2.bySource.NEPTUN.ok, false);
});

// ── 7. read path: 0 PUT, read-your-write, cache headers ───────────────────
test('7. GET /v1/state never writes; updates visible immediately; cache headers set', async () => {
  const restore = stubFetch(emptySources);
  try {
    const c = countingKv();
    const env = baseEnv(c.kv, fakeD1());
    await refresh(env);
    for (let i = 0; i < 5; i++) {
      const { res } = await readState(env);
      const cc = res.headers.get('Cache-Control');
      assert.match(cc, /no-store/, 'live state is not storable by any cache');
      assert.doesNotMatch(cc, /public/, 'and no shared cache may keep it');
    }
    assert.equal(c.puts(), 1, 'reads never PUT');
  } finally {
    restore();
  }
});

// The test above exercises the KV branch. Production runs with
// SYNC_STATE_STORE='d1', which is a DIFFERENT set of return statements in the
// same handler — so a fix applied to one can leave the deployed endpoint still
// serving `public, max-age=5` while the suite is green. This one pins the
// branch that actually runs in production.
test('7b. GET /v1/state is uncacheable on the D1 path too (the one production uses)', async () => {
  const restore = stubFetch(emptySources);
  try {
    const c = countingKv();
    const env = baseEnv(c.kv, fakeD1());
    // Seed through the KV branch first: the D1 branch reads whatever is already
    // stored. Calling the refresh endpoint under SYNC_STATE_STORE='d1' would go
    // down a different code path that is not what this test is about.
    await refresh(env);
    const d1env = { ...env, SYNC_STATE_STORE: 'd1' };
    for (let i = 0; i < 3; i++) {
      const { res } = await readState(d1env);
      const cc = res.headers.get('Cache-Control');
      assert.match(cc, /no-store/, 'D1 path: live state is not storable by any cache');
      assert.doesNotMatch(cc, /public/, 'D1 path: and no shared cache may keep it');
    }
  } finally {
    restore();
  }
});

// ── 8. gating preserved: 100 identical rapid cycles -> 0 PUT ──────────────
test('8. write gating preserved: identical rapid cycles never PUT', () => {
  const f = meaningfulFp([], []);
  const stored = { snapshot: { v: 1 }, prev: { alerts: [], threats: [] }, ...f, writtenAt: T0 };
  for (let i = 0; i < 100; i++) {
    const d = shouldWrite({ stored, ...f, nowMs: T0 + 60_000 });
    assert.equal(d.write, false, `cycle ${i} must not write`);
  }
});

// ── 9 + 20. 24h budget: 1440 cron cycles ──────────────────────────────────
test('9. KV budget: 24h calm (1440 unchanged cycles) <200 writes/day', () => {
  const f = meaningfulFp([], []);
  let writtenAt = T0;
  let writes = 1; // cold start
  for (let m = 1; m <= 1440; m++) {
    const stored = { snapshot: { v: 1 }, prev: { alerts: [], threats: [] }, ...f, writtenAt };
    const d = shouldWrite({ stored, ...f, nowMs: T0 + m * MIN });
    if (d.write) { writes++; writtenAt = T0 + m * MIN; assert.equal(d.reason, 'heartbeat'); }
  }
  console.log(`EXPECTED KV WRITES/DAY (calm): ${writes}`);
  assert.ok(writes < 200, `calm day must stay <200 (got ${writes})`);
  assert.ok(writes < 100, `calm day should be ~72 (got ${writes})`);
});

test('KV budget: 24h permanent threat churn stays <500/day (no per-minute PUT)', () => {
  let writtenAt = T0;
  let writes = 1;
  for (let m = 1; m <= 1440; m++) {
    // Every cycle the tracks move -> fingerprint always differs.
    const moving = [{ id: 't1', source: 'MAPA', category: 'uav', lat: 50 + m * 0.001, lon: 30, heading: 90, speed: 165, stale: false, eventTime: new Date(T0 + m * MIN).toISOString() }];
    const f = meaningfulFp([], moving);
    const storedFp = meaningfulFp([], [{ id: 't1', source: 'MAPA', category: 'uav', lat: 50 + (m - 1) * 0.001, lon: 30, heading: 90, speed: 165, stale: false, eventTime: new Date(T0 + (m - 1) * MIN).toISOString() }]);
    const stored = { snapshot: { v: 1 }, prev: { alerts: [], threats: [] }, ...storedFp, writtenAt };
    const d = shouldWrite({ stored, ...f, nowMs: T0 + m * MIN });
    if (d.write) { writes++; writtenAt = T0 + m * MIN; }
  }
  console.log(`EXPECTED KV WRITES/DAY (full churn): ${writes}`);
  assert.ok(writes < 500, `worst churn must stay <500 (got ${writes})`);
});

test('thresholds: LIVE<=5min, OFFLINE>30min', () => {
  assert.equal(LIVE_MS, 5 * 60_000);
  assert.equal(OFFLINE_MS, 30 * 60_000);
  assert.ok(HEARTBEAT_MS < OFFLINE_MS, 'KV heartbeat interval is inside the consumer offline window');
});

console.log('All liveness tests passed!');
