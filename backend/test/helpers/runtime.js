import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Real SQLite, matching D1's binding interface and atomic batch semantics.
export function testDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));
  const make = (sql, params = []) => ({
    bind: (...values) => {
      if (values.length > 100) throw new Error('D1: too many SQL variables');
      if (values.some(v => typeof v === 'string' && Buffer.byteLength(v) > 2_000_000)) {
        throw new Error('D1: value exceeds row limit');
      }
      return make(sql, values);
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }),
  });
  return {
    sqlite, prepare: sql => make(sql),
    batch: async stmts => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const stmt of stmts) results.push(await stmt.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

export function testKv() {
  const data = new Map();
  return { data, puts: 0,
    get: async key => data.get(key) || null,
    async put(key, value) { this.puts++; data.set(key, value); },
  };
}

export function testEnv() {
  return {
    SYNC_STATE_STORE: 'd1', NEBO_STATE: testKv(), nebo_journal: testDb(),
    UKRAINEALARM_API_KEY: 'fixture-key',
    NEPTUN_ALERTS_URL: 'https://sources.invalid/alerts',
    NEPTUN_THREATS_URL: 'https://sources.invalid/threats',
    MAPA_URL: 'https://sources.invalid/mapa',
  };
}

export function sourceRoutes() {
  return {
    '/alerts': { oblasts: [], raions: [] },
    '/threats': { threats: [] }, '/mapa': { objects: [] },
    '/api/v3/alerts/status': { lastActionIndex: 123 },
    '/api/v3/alerts': [{ regionId: 's1', regionType: 'State', regionName: 'Черкаська область',
      activeAlerts: [{ type: 'AIR', lastUpdate: '2026-10-09T05:00:00Z' }] }],
    '/api/v3/regions': { states: [{ regionId: 's1', regionType: 'State', regionName: 'Черкаська область', regionChildIds: [] }] },
  };
}

export function mockSources(routes, calls = []) {
  return async (url, opts) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const value = routes[path];
    if (typeof value === 'function') return value(url, opts);
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value.clone();
    if (value === undefined) throw new Error('Unexpected network request: ' + path);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
}
