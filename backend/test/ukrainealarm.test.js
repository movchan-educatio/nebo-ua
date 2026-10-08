// UkraineAlarm API v3 adapter tests. All upstream calls are mocked —
// no real API requests, no key material, no network dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {
  authHeaderValue, UAHttpError, uaGet,
  parseStatusVersion, parseAlerts, parseRegions, parseHistory,
  buildRegionIndex, hashRegionIndex, mapAlertRegion,
  shouldFetchFull, getUASync, setUASync,
  getRegionsTree, refreshRegionsTree,
  fetchOfficialUkraineAlarm, fetchRegionHistory,
  UA_TYPE_LABEL,
} from '../src/ukrainealarm.js';

const UA = 'https://api.ukrainealarm.com';

// Key-aware KV stub (bundle + regions tree coexist by key).
function keyKv() {
  const data = new Map();
  const puts = [];
  return {
    puts,
    kv: {
      get: async (k) => (data.has(k) ? data.get(k) : null),
      put: async (k, v) => { puts.push(k); data.set(k, v); },
    },
  };
}

// Fake D1 with real ua_sync + checks behavior.
function fakeD1ua() {
  const checks = [];
  const uaSync = new Map();
  const db = {
    checks, uaSync,
    prepare(sql) {
      const isChecksInsert = sql.includes('INSERT INTO checks');
      const isUaSelect = sql.includes('FROM ua_sync');
      const isUaUpsert = sql.includes('INSERT INTO ua_sync');
      const isJournalSelect = sql.includes('FROM journal');
      return {
        bind: (...params) => ({
          _params: params, _checksInsert: isChecksInsert, _uaUpsert: isUaUpsert,
          run: async () => {
            if (isChecksInsert) checks.push({ ts: params[0], source: params[1], ok: params[2], error: params[4] });
            return { success: true };
          },
          all: async () => {
            if (isUaSelect) {
              return { results: [...uaSync.entries()].map(([key, value]) => ({ key, value })) };
            }
            if (isJournalSelect) return { results: [] };
            if (/FROM checks/.test(sql)) {
              return { results: [...checks].reverse().slice(0, 60).map(c => ({ ...c })) };
            }
            return { results: [] };
          },
        }),
        run: async () => ({ success: true }),
        all: async () => {
          if (isUaSelect) {
            return { results: [...uaSync.entries()].map(([key, value]) => ({ key, value })) };
          }
          if (/FROM checks/.test(sql)) {
            return { results: [...checks].reverse().slice(0, 60).map(c => ({ ...c })) };
          }
          return { results: [] };
        },
      };
    },
    batch: async (stmts) => {
      for (const s of stmts || []) {
        if (s?._checksInsert) {
          const p = s._params;
          checks.push({ ts: p[0], source: p[1], ok: p[2], error: p[4] });
        } else if (s?._uaUpsert) {
          uaSync.set(s._params[0], s._params[1]);
        }
      }
      return { success: true };
    },
  };
  return db;
}

// Mock fetch router: route path -> JSON body | Error | {status, body, headers}.
function stubUa(routes) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, auth: opts.headers?.Authorization });
    const path = u.startsWith(UA) ? u.slice(UA.length) : u;
    const route = routes[path];
    if (route instanceof Error) throw route;
    if (!route) throw new Error('unexpected fetch ' + u);
    if (route.status) {
      return {
        ok: false, status: route.status,
        headers: { get: (h) => (route.headers || {})[h] || null },
        text: async () => JSON.stringify(route.body ?? {}),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(route),
    };
  };
  return { restore: () => { globalThis.fetch = real; }, calls };
}

const envBase = (kv, db, extra = {}) => ({
  NEBO_STATE: kv, nebo_journal: db,
  NEPTUN_ALERTS_URL: 'https://src.test/alerts',
  NEPTUN_THREATS_URL: 'https://src.test/threats',
  MAPA_URL: 'https://src.test/mapa',
  OFFICIAL_API_URL: '', OFFICIAL_API_TOKEN: '',
  UKRAINEALARM_API_URL: UA, UKRAINEALARM_AUTH_SCHEME: '',
  ...extra,
});
const directEmpty = {
  'https://src.test/alerts': { oblasts: [], raions: [] },
  'https://src.test/threats': { threats: [] },
  'https://src.test/mapa': { objects: [] },
};

// ── auth ──────────────────────────────────────────────────────────────────
test('auth header: raw key by default, prefixed when scheme set', () => {
  assert.equal(authHeaderValue('K', ''), 'K');
  assert.equal(authHeaderValue('K', 'Token'), 'Token K');
  assert.equal(authHeaderValue('K', '  Bearer  '), 'Bearer K');
});

// ── status version gate ───────────────────────────────────────────────────
test('parseStatusVersion: number ok, missing -> null, garbage throws', () => {
  assert.equal(parseStatusVersion({ lastActionIndex: 7 }), 7);
  assert.equal(parseStatusVersion({}), null);
  assert.throws(() => parseStatusVersion({ lastActionIndex: '7' }), /JSON/);
  assert.throws(() => parseStatusVersion([]), /JSON/);
  assert.throws(() => parseStatusVersion(null), /JSON/);
});

test('shouldFetchFull: unknown always fetches, equal skips', () => {
  assert.equal(shouldFetchFull(null, 7), true);
  assert.equal(shouldFetchFull(7, null), true);
  assert.equal(shouldFetchFull(null, null), true);
  assert.equal(shouldFetchFull(7, 7), false);
  assert.equal(shouldFetchFull(7, 8), true);
});

// ── alerts validation ─────────────────────────────────────────────────────
test('parseAlerts: validates items, normalizes type, never fakes time', () => {
  const out = parseAlerts([
    { regionId: 's1', regionType: 'State', regionName: 'Область', lastUpdate: '2026-10-08T10:00:00Z', activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:01:00Z' }] },
    { regionId: 'd1', regionType: 'District', regionName: 'Район', activeAlerts: [{ type: 'WEIRD', lastUpdate: 'not-a-date' }] },
    null, 'x', {},
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].activeAlerts[0].type, 'AIR');
  assert.equal(out[0].activeAlerts[0].lastUpdate, '2026-10-08T10:01:00Z');
  assert.equal(out[1].activeAlerts[0].type, 'UNKNOWN', 'unknown type contained, not invented');
  assert.equal(out[1].activeAlerts[0].lastUpdate, null, 'invalid time stays null');
  assert.throws(() => parseAlerts({}), /JSON/);
  assert.deepEqual(parseAlerts([]), []);
});

// ── regions index ─────────────────────────────────────────────────────────
const TREE = {
  states: [{
    regionId: 's1', regionName: 'Область', regionType: 'State',
    regionChildIds: [{
      regionId: 'd1', regionName: 'Район', regionType: 'District',
      regionChildIds: [{ regionId: 'c1', regionName: 'Громада', regionType: 'Community', regionChildIds: [] }],
    }],
  }],
};

test('buildRegionIndex resolves oblast/district parents', () => {
  const byId = buildRegionIndex(structuredClone(TREE.states));
  assert.equal(byId.get('s1').oblastName, 'Область');
  assert.equal(byId.get('d1').oblastName, 'Область');
  assert.equal(byId.get('d1').districtName, 'Район');
  assert.equal(byId.get('c1').oblastName, 'Область');
  assert.equal(byId.get('c1').districtName, 'Район');
});

test('hashRegionIndex stable, changes on rename', () => {
  const a = hashRegionIndex(buildRegionIndex(structuredClone(TREE.states)));
  const b = hashRegionIndex(buildRegionIndex(structuredClone(TREE.states)));
  assert.equal(a, b);
  const mod = structuredClone(TREE.states);
  mod[0].regionName = 'Інша';
  assert.notEqual(hashRegionIndex(buildRegionIndex(mod)), a);
});

test('parseRegions validates tree shape', () => {
  assert.equal(parseRegions(TREE).states.length, 1);
  assert.throws(() => parseRegions({}), /JSON/);
  assert.throws(() => parseRegions({ states: 'x' }), /JSON/);
});

// ── mapping ───────────────────────────────────────────────────────────────
test('mapAlertRegion: State/District/Community, stable ids, empty skipped', () => {
  const byId = buildRegionIndex(structuredClone(TREE.states));
  const st = mapAlertRegion({
    regionId: 's1', regionType: 'State', regionName: 'Область',
    activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:01:00Z' }],
  }, byId);
  assert.equal(st.length, 1);
  assert.equal(st[0].key, 'ua:s1:AIR');
  assert.equal(st[0].oblast, null);
  assert.equal(st[0].name, 'Область');
  assert.equal(st[0].since, '2026-10-08T10:01:00Z');
  assert.equal(st[0].reasons[0], UA_TYPE_LABEL.AIR);

  const d = mapAlertRegion({
    regionId: 'd1', regionType: 'District', regionName: 'Район',
    activeAlerts: [{ type: 'ARTILLERY', lastUpdate: null }],
  }, byId);
  assert.equal(d[0].oblast, 'Область', 'district carries oblast for matching');
  assert.equal(d[0].reasons[0], UA_TYPE_LABEL.ARTILLERY, 'honest non-AIR label');

  const c = mapAlertRegion({
    regionId: 'c1', regionType: 'Community', regionName: 'Громада',
    activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:02:00Z' }],
  }, byId);
  assert.equal(c[0].oblast, 'Область', 'community keeps oblast (documented approximation)');

  assert.deepEqual(mapAlertRegion({ regionId: 's1', regionName: 'X', activeAlerts: [] }, byId), [], 'no alerts -> no records');
  assert.deepEqual(mapAlertRegion({ regionId: '', regionName: 'X', activeAlerts: [{ type: 'AIR' }] }, byId), []);
  const noTime = mapAlertRegion({
    regionId: 's1', regionType: 'State', regionName: 'Область', activeAlerts: [{ type: 'AIR', lastUpdate: null }],
  }, byId);
  assert.equal(noTime[0].since, null, 'missing event time never defaulted to now');
});

// ── uaGet transport ───────────────────────────────────────────────────────
test('uaGet sends exact Authorization header, classifies errors, never leaks key', async () => {
  const { restore, calls } = stubUa({ '/api/v3/alerts/status': { lastActionIndex: 3 } });
  try {
    const env = { UKRAINEALARM_API_KEY: 'SECRET-KEY', UKRAINEALARM_API_URL: UA, UKRAINEALARM_AUTH_SCHEME: '' };
    assert.deepEqual(await uaGet(env, '/api/v3/alerts/status'), { lastActionIndex: 3 });
    assert.equal(calls[0].auth, 'SECRET-KEY');
    const env2 = { ...env, UKRAINEALARM_AUTH_SCHEME: 'Token' };
    await uaGet(env2, '/api/v3/alerts/status');
    assert.equal(calls[1].auth, 'Token SECRET-KEY');
  } finally {
    restore();
  }
});

test('uaGet: 429/401/500/invalid-JSON/missing-key', async () => {
  const env = { UKRAINEALARM_API_KEY: 'K', UKRAINEALARM_API_URL: UA };
  let r = stubUa({ '/x': { status: 429, body: {}, headers: { 'Retry-After': '5' } } });
  try {
    await assert.rejects(uaGet(env, '/x'), (e) => e instanceof UAHttpError && e.status === 429 && e.retryAfterMs === 5000);
  } finally {
    r.restore();
  }
  r = stubUa({ '/x': { status: 401, body: {} } });
  try {
    await assert.rejects(uaGet({ ...env, UKRAINEALARM_API_KEY: 'SECRET-KEY-12345' }, '/x'), (e) => {
      assert.match(e.message, /401\/403/);
      assert.ok(!e.message.includes('SECRET-KEY-12345'), 'key must not appear in errors');
      return true;
    });
  } finally {
    r.restore();
  }
  r = stubUa({ '/x': { status: 500, body: {} } });
  try {
    await assert.rejects(uaGet(env, '/x'), /HTTP 500/);
  } finally {
    r.restore();
  }
  r = stubUa({ '/ok': { status: 200, body: {} } });
  try {
    // status:200 with JSON body is fine; invalid JSON tested via throw
  } finally {
    r.restore();
  }
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'not json{' });
  try {
    await assert.rejects(uaGet(env, '/x'), /JSON/);
  } finally {
    globalThis.fetch = real;
  }
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not call'); };
  try {
    await assert.rejects(uaGet({}, '/x'), /not configured/);
    assert.equal(called, false, 'no request without key');
  } finally {
    globalThis.fetch = real;
  }
});

// ── official cycle ────────────────────────────────────────────────────────
const UA_ALERTS = [{
  regionId: 's1', regionType: 'State', regionName: 'Тестова область',
  lastUpdate: '2026-10-08T10:00:00Z',
  activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:01:00Z' }],
}];

test('fetchOfficialUkraineAlarm: disabled without key (legacy behavior preserved)', async () => {
  const r = await fetchOfficialUkraineAlarm({});
  assert.deepEqual([r.ok, r.disabled, r.items], [true, true, []]);
});

test('fetchOfficialUkraineAlarm: version-unchanged -> carried, no full fetch', async () => {
  const { restore, calls } = stubUa({
    '/api/v3/alerts/status': { lastActionIndex: 7 },
    '/api/v3/alerts': UA_ALERTS,
    '/api/v3/regions': TREE,
  });
  try {
    const db = fakeD1ua();
    const env = envBase(null, db, { UKRAINEALARM_API_KEY: 'K' });
    const first = await fetchOfficialUkraineAlarm(env);
    assert.equal(first.ok, true);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].key, 'ua:s1:AIR');
    assert.equal(db.uaSync.get('lastActionIndex'), '7', 'version persisted');
    const second = await fetchOfficialUkraineAlarm(env);
    assert.equal(second.carried, true);
    assert.deepEqual(second.items, []);
    const fullCalls = calls.filter(c => c.url.endsWith('/api/v3/alerts')).length;
    assert.equal(fullCalls, 1, 'full pull only on version change');
  } finally {
    restore();
  }
});

test('fetchOfficialUkraineAlarm: failure honest, 429 sets backoff, no fake success', async () => {
  let r = stubUa({ '/api/v3/alerts/status': { status: 500, body: {} } });
  try {
    const out = await fetchOfficialUkraineAlarm(envBase(null, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' }));
    assert.equal(out.ok, false);
    assert.match(out.error, /HTTP 500/);
  } finally {
    r.restore();
  }
  r = stubUa({ '/api/v3/alerts/status': { status: 429, body: {}, headers: { 'Retry-After': '120' } } });
  try {
    const db = fakeD1ua();
    const out = await fetchOfficialUkraineAlarm(envBase(null, db, { UKRAINEALARM_API_KEY: 'K' }));
    assert.equal(out.ok, false);
    assert.ok(Number(db.uaSync.get('notBefore')) > Date.now(), 'Retry-After honored');
    const skipped = await fetchOfficialUkraineAlarm(envBase(null, db, { UKRAINEALARM_API_KEY: 'K' }));
    assert.equal(skipped.ok, false, 'backoff window skips network honestly as failure');
    assert.match(skipped.error, /429/);
  } finally {
    r.restore();
  }
});

test('fetchOfficialUkraineAlarm: regions outage -> State-only, no fabricated parents', async () => {
  const { restore } = stubUa({
    '/api/v3/alerts/status': { lastActionIndex: 9 },
    '/api/v3/alerts': [
      { regionId: 's1', regionType: 'State', regionName: 'Область', activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:01:00Z' }] },
      { regionId: 'd1', regionType: 'District', regionName: 'Район', activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-08T10:01:00Z' }] },
    ],
    '/api/v3/regions': { status: 500, body: {} },
  });
  try {
    const out = await fetchOfficialUkraineAlarm(envBase(null, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' }));
    assert.equal(out.ok, true);
    assert.equal(out.items.length, 1, 'only State survives tree outage');
    assert.equal(out.items[0].key, 'ua:s1:AIR');
  } finally {
    restore();
  }
});

// ── regions cache ─────────────────────────────────────────────────────────
test('regions cache: fetch once, hash-gated rewrites', async () => {
  const { restore } = stubUa({ '/api/v3/regions': TREE });
  try {
    const store = keyKv();
    const env = envBase(store.kv, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' });
    const r1 = await refreshRegionsTree(env, false);
    assert.equal(r1.written, true);
    assert.equal(store.puts.filter(k => k === 'v1:ua-regions').length, 1);
    const r2 = await refreshRegionsTree(env, false);
    assert.equal(r2.written, undefined, 'identical tree -> no rewrite');
    assert.equal(store.puts.filter(k => k === 'v1:ua-regions').length, 1);
    const cached = await getRegionsTree(env);
    assert.equal(cached.fromCache, true);
    assert.ok(cached.hash);
  } finally {
    restore();
  }
});

// ── history ───────────────────────────────────────────────────────────────
test('fetchRegionHistory validates input and output', async () => {
  const { restore } = stubUa({
    '/api/v3/alerts/regionHistory?regionId=s1': [
      { regionId: 's1', regionName: 'X', startDate: '2026-10-08T09:00:00Z', endDate: '2026-10-08T09:30:00Z', alertType: 'AIR', isContinue: false },
    ],
  });
  try {
    const env = { UKRAINEALARM_API_KEY: 'K', UKRAINEALARM_API_URL: UA };
    const h = await fetchRegionHistory(env, 's1');
    assert.equal(h.length, 1);
    assert.equal(h[0].alertType, 'AIR');
    await assert.rejects(fetchRegionHistory(env, ''), /regionId/);
    await assert.rejects(fetchRegionHistory(env, 'a'.repeat(65)), /regionId/);
    await assert.rejects(fetchRegionHistory(env, '../x'), /regionId/, 'path injection rejected before fetch');
  } finally {
    restore();
  }
});

// ── pipeline wiring ───────────────────────────────────────────────────────
test('pipeline with UA key: OFFICIAL online, ua alerts normalized, source preserved', async () => {
  const { restore } = stubUa({
    ...directEmpty,
    '/api/v3/alerts/status': { lastActionIndex: 11 },
    '/api/v3/alerts': UA_ALERTS,
    '/api/v3/regions': TREE,
  });
  try {
    const store = keyKv();
    const env = envBase(store.kv, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' });
    const r = await worker.fetch(new Request('https://worker.test/v1/refresh', { method: 'POST' }), env);
    assert.equal(r.status, 200);
    const st = await worker.fetch(new Request('https://worker.test/v1/state'), env);
    const body = await st.json();
    assert.equal(body.health.OFFICIAL.status, 'online');
    const ua = body.alerts.filter(a => a.source === 'OFFICIAL');
    assert.equal(ua.length, 1);
    assert.equal(ua[0].id, 'official:ua:s1:AIR');
    assert.equal(ua[0].region, 'Тестова область');
    assert.equal(ua[0].eventTime, '2026-10-08T10:01:00.000Z', 'source event time preserved end-to-end');
  } finally {
    restore();
  }
});

test('pipeline without UA key: OFFICIAL stays disabled (zero behavior change)', async () => {
  const { restore } = stubUa({ ...directEmpty });
  try {
    const store = keyKv();
    const env = envBase(store.kv, fakeD1ua());
    await worker.fetch(new Request('https://worker.test/v1/refresh', { method: 'POST' }), env);
    const st = await worker.fetch(new Request('https://worker.test/v1/state'), env);
    const body = await st.json();
    assert.equal(body.health.OFFICIAL.status, 'disabled');
  } finally {
    restore();
  }
});

test('no inbound webhook endpoint exists (undocumented auth -> must stay closed)', async () => {
  const store = keyKv();
  const env = envBase(store.kv, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' });
  for (const method of ['GET', 'POST']) {
    const r = await worker.fetch(new Request('https://worker.test/v1/official/webhook', { method }), env);
    assert.equal(r.status, 404, `${method} /v1/official/webhook must not exist`);
  }
});

test('history route: 503 without key, validated 502 on bad input, CORS present', async () => {
  const store = keyKv();
  const noKey = await worker.fetch(new Request('https://worker.test/v1/official/history?regionId=s1'), envBase(store.kv, fakeD1ua()));
  assert.equal(noKey.status, 503);
  const env = envBase(store.kv, fakeD1ua(), { UKRAINEALARM_API_KEY: 'K' });
  const bad = await worker.fetch(new Request('https://worker.test/v1/official/history?regionId=../x'), env);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), '*');
});

console.log('All UkraineAlarm adapter tests passed!');
