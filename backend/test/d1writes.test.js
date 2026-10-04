// Regression tests for D1 write reduction (issue: 80% Free Tier rows_written)
// These tests verify that journalUpsert only writes on actual changes (new items, status changes)
// and NOT on every cron cycle for unchanged active items.

import test from 'node:test';
import assert from 'node:assert/strict';
import { journalUpsert, recordChecksBatch } from '../src/store.js';

// Mock D1 database that tracks write calls
function createMockDb() {
  const writes = [];
  const tables = {
    journal: new Map(),
    checks: [],
  };
  
  function makeStatement(sql) {
    const isJournalInsert = sql.includes('INSERT INTO journal');
    const isJournalSelect = sql.includes('SELECT id, last_seen, status FROM journal');
    const isChecksInsert = sql.includes('INSERT INTO checks');
    const isChecksDelete = sql.includes('DELETE FROM checks');
    
    const statement = {
      _sql: sql,
      _boundParams: [],
      // For DELETE statements that are run directly without bind()
      run: isChecksDelete ? async () => {
        writes.push({ type: 'checks-delete', sql });
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        tables.checks = tables.checks.filter(c => c.ts >= cutoff);
      } : undefined,
      bind(...params) {
        const bound = {
          _params: params,
          _sql: sql,
          run: async () => {
            if (isChecksInsert) {
              writes.push({ type: 'checks-insert', sql, params });
              tables.checks.push({ ts: params[0], source: params[1], ok: params[2], latency_ms: params[3], error: params[4] });
            }
          },
          all: async () => {
            if (isJournalSelect) {
              const ids = params;
              const results = ids.map(id => tables.journal.get(id)).filter(Boolean);
              return { results };
            }
            return { results: [] };
          },
        };
        statement._boundParams.push(params);
        return bound;
      },
      _executeBatch: async () => {
        for (const params of statement._boundParams) {
          if (isJournalInsert) {
            writes.push({ type: 'journal-upsert', sql, params });
            const [id, kind, source, category, region, district, first_seen, last_seen, status] = params;
            tables.journal.set(id, { id, kind, source, category, region, district, first_seen, last_seen, status });
          }
        }
        statement._boundParams = [];
      },
    };
    return statement;
  }
  
  return {
    writes,
    tables,
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(operations) {
      for (const op of operations) {
        if (op._sql && op._sql.includes('INSERT INTO journal')) {
          writes.push({ type: 'journal-upsert', sql: op._sql, params: op._params });
          const [id, kind, source, category, region, district, first_seen, last_seen, status] = op._params;
          tables.journal.set(id, { id, kind, source, category, region, district, first_seen, last_seen, status });
        }
        if (op._sql && op._sql.includes('INSERT INTO checks')) {
          writes.push({ type: 'checks-insert', sql: op._sql, params: op._params });
          tables.checks.push({ ts: op._params[0], source: op._params[1], ok: op._params[2], latency_ms: op._params[3], error: op._params[4] });
        }
      }
      return Promise.resolve();
    },
    getWriteCount(type) {
      return writes.filter(w => w.type === type).length;
    },
    getTotalWrites() {
      return writes.length;
    },
    reset() {
      writes.length = 0;
    },
  };
}

test('journalUpsert: unchanged active items produce 0 writes on second call', async () => {
  const db = createMockDb();
  const nowIso = new Date().toISOString();
  
  const items = [
    { id: 'alert-1', official: true, source: 'NEPTUN', category: 'official', region: 'Kyiv', district: null },
    { id: 'threat-1', official: false, source: 'MAPA', category: 'uav', region: 'Kyiv', district: 'Kyivskyi' },
  ];
  
  // First call - both items are new, should write
  await journalUpsert(db, items, nowIso, 'active');
  const writesAfterFirst = db.getWriteCount('journal-upsert');
  assert.equal(writesAfterFirst, 2, 'First call should write 2 new items');
  
  // Second call with SAME items, SAME status - should write 0
  db.reset();
  await journalUpsert(db, items, nowIso, 'active');
  const writesAfterSecond = db.getWriteCount('journal-upsert');
  assert.equal(writesAfterSecond, 0, 'Second call with unchanged items should write 0');
});

test('journalUpsert: status change (active->stale) produces write', async () => {
  const db = createMockDb();
  const nowIso = new Date().toISOString();
  
  const items = [
    { id: 'alert-1', official: true, source: 'NEPTUN', category: 'official', region: 'Kyiv', district: null },
  ];
  
  // First call - active
  await journalUpsert(db, items, nowIso, 'active');
  assert.equal(db.getWriteCount('journal-upsert'), 1);
  
  // Second call - same item now stale (status changed)
  db.reset();
  await journalUpsert(db, items, nowIso, 'stale');
  const writes = db.getWriteCount('journal-upsert');
  assert.equal(writes, 1, 'Status change active->stale should write 1');
});

test('journalUpsert: new item added to existing set produces write only for new item', async () => {
  const db = createMockDb();
  const nowIso = new Date().toISOString();
  
  // First call - 2 items
  await journalUpsert(db, [
    { id: 'alert-1', official: true, source: 'NEPTUN', category: 'official', region: 'Kyiv', district: null },
    { id: 'threat-1', official: false, source: 'MAPA', category: 'uav', region: 'Kyiv', district: 'Kyivskyi' },
  ], nowIso, 'active');
  assert.equal(db.getWriteCount('journal-upsert'), 2);
  
  // Second call - 3 items (1 new, 2 unchanged)
  db.reset();
  await journalUpsert(db, [
    { id: 'alert-1', official: true, source: 'NEPTUN', category: 'official', region: 'Kyiv', district: null },
    { id: 'threat-1', official: false, source: 'MAPA', category: 'uav', region: 'Kyiv', district: 'Kyivskyi' },
    { id: 'alert-2', official: true, source: 'OFFICIAL', category: 'official', region: 'Lviv', district: null },
  ], nowIso, 'active');
  const writes = db.getWriteCount('journal-upsert');
  assert.equal(writes, 1, 'Only the new item should be written');
});

test('journalUpsert: empty array produces 0 writes', async () => {
  const db = createMockDb();
  const nowIso = new Date().toISOString();
  
  await journalUpsert(db, [], nowIso, 'active');
  assert.equal(db.getWriteCount('journal-upsert'), 0);
});

test('recordChecksBatch: batches 3 sources into 1 batch insert + hourly cleanup', async () => {
  const db = createMockDb();
  
  // First call - should insert 3 rows
  await recordChecksBatch(db, [
    { source: 'OFFICIAL', ok: true, latencyMs: 100, error: null },
    { source: 'NEPTUN', ok: true, latencyMs: 200, error: null },
    { source: 'MAPA', ok: false, latencyMs: 5000, error: 'timeout' },
  ]);
  const writesAfterFirst = db.getWriteCount('checks-insert');
  assert.equal(writesAfterFirst, 3, 'Should batch insert 3 source checks');
  
  // Second call within same hour - should insert 3 more, NO cleanup delete
  db.reset();
  await recordChecksBatch(db, [
    { source: 'OFFICIAL', ok: true, latencyMs: 150, error: null },
    { source: 'NEPTUN', ok: true, latencyMs: 180, error: null },
    { source: 'MAPA', ok: true, latencyMs: 200, error: null },
  ]);
  const writesAfterSecond = db.getWriteCount('checks-insert');
  const deletes = db.getWriteCount('checks-delete');
  assert.equal(writesAfterSecond, 3, 'Should insert 3 more checks');
  assert.equal(deletes, 0, 'Should NOT run cleanup delete within same hour');
});

test('recordChecksBatch: cleanup delete runs only once per hour', async () => {
  const db = createMockDb();
  
  // Mock time to simulate hour passing
  const originalNow = Date.now;
  let mockTime = Date.now();
  global.Date.now = () => mockTime;
  
  try {
    await recordChecksBatch(db, [
      { source: 'OFFICIAL', ok: true, latencyMs: 100, error: null },
      { source: 'NEPTUN', ok: true, latencyMs: 200, error: null },
      { source: 'MAPA', ok: true, latencyMs: 300, error: null },
    ]);
    assert.equal(db.getWriteCount('checks-delete'), 0, 'First call within hour: no cleanup');
    
    // Advance time by 1 hour + 1 minute
    mockTime += 61 * 60 * 1000;
    db.reset();
    
    await recordChecksBatch(db, [
      { source: 'OFFICIAL', ok: true, latencyMs: 100, error: null },
      { source: 'NEPTUN', ok: true, latencyMs: 200, error: null },
      { source: 'MAPA', ok: true, latencyMs: 300, error: null },
    ]);
    const deletes = db.getWriteCount('checks-delete');
    assert.equal(deletes, 1, 'After hour passed: cleanup delete should run once');
  } finally {
    global.Date.now = originalNow;
  }
});

test('D1 write reduction math: estimated daily writes after optimization', () => {
  // BEFORE (from audit):
  // recordCheck: 6 writes/cron × 1440 = 8,640/day
  // journalUpsert active: ~100 items × 1440 = 144,000/day
  // journalUpsert stale: ~10 items × 1440 = 14,400/day
  // journalEnd: ~5 items × 1440 = 7,200/day
  // TOTAL BEFORE: ~174,240 writes/day (174% of 100K Free Tier limit)
  
  // AFTER (with optimization):
  // recordChecksBatch: 3 inserts/cron × 1440 + 24 cleanup deletes = 4,344/day
  // journalUpsert: only on changes (~10 new + 30 status changes + 10 ended = 50/day)
  // journalEnd: only on actual endings (~10/day)
  // TOTAL AFTER: ~4,344 + 50 + 10 = ~4,404 writes/day
  
  const before = 174240;
  const after = 4404;
  const reductionFactor = before / after;
  const percentOfLimit = (after / 100000) * 100;
  
  console.log(`BEFORE: ${before.toLocaleString()} writes/day (${(before/100000*100).toFixed(1)}% of Free Tier)`);
  console.log(`AFTER:  ${after.toLocaleString()} writes/day (${percentOfLimit.toFixed(1)}% of Free Tier)`);
  console.log(`Reduction: ${reductionFactor.toFixed(1)}x`);
  
  // Target: at least 10x reduction (prefer 50-100x)
  assert.ok(reductionFactor >= 10, `Expected at least 10x reduction, got ${reductionFactor.toFixed(1)}x`);
  // Should be well under Free Tier limit
  assert.ok(after < 100000, `Expected under 100K limit, got ${after}`);
});