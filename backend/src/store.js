// KV latest snapshot + previous actives, D1 journal + source checks.
// All functions take explicit bindings so they stay testable.
const LATEST_KEY = 'v1:latest';
const PREV_KEY = 'v1:prev-actives';

// Journal upsert optimization:
// - Only write to D1 when item is NEW or status CHANGED.
// - Active items that stay active don't need last_seen updates every minute.
// - This reduces writes from O(active_items × crons) to O(changes).

export async function loadPrev(kv) {
  try {
    const raw = await kv.get(PREV_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.alerts) || !Array.isArray(p.threats)) return null;
    return p;
  } catch {
    return null;
  }
}

export async function saveState(kv, snapshot, prev) {
  await kv.put(LATEST_KEY, JSON.stringify(snapshot), { expirationTtl: 600 });
  await kv.put(PREV_KEY, JSON.stringify(prev), { expirationTtl: 3600 });
}

export async function loadLatest(kv) {
  try {
    const raw = await kv.get(LATEST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Smart upsert: only write if item is new or status changed.
// Active items that stay active don't need last_seen updates every minute.
export async function journalUpsert(db, items, nowIso, staleMark) {
  if (!items.length) return;

  // Fetch existing journal entries for these IDs in one query
  const ids = items.map(e => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const existingRows = await db.prepare(
    `SELECT id, last_seen, status FROM journal WHERE id IN (${placeholders})`
  ).bind(...ids).all();
  const existing = new Map((existingRows?.results || []).map(r => [r.id, r]));

  const stmt = db.prepare(
    `INSERT INTO journal (id, kind, source, category, region, district, first_seen, last_seen, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, status=excluded.status`
  );

  const batch = [];
  for (const e of items) {
    const ex = existing.get(e.id);
    const desiredStatus = staleMark || 'active';
    const isNew = !ex;
    const statusChanged = ex && ex.status !== desiredStatus;

    if (isNew || statusChanged) {
      batch.push(stmt.bind(
        e.id, e.official ? 'alert' : 'threat', e.source, e.category || null,
        e.region || null, e.district || null,
        ex?.first_seen || nowIso,  // preserve original first_seen
        nowIso,
        desiredStatus
      ));
    }
  }

  if (batch.length) await db.batch(batch);
}

export async function journalEnd(db, items, nowIso) {
  if (!items.length) return;
  const stmt = db.prepare(`UPDATE journal SET ended_at=?, status='ended' WHERE id=? AND status!='ended'`);
  await db.batch(items.map(e => stmt.bind(nowIso, e.id)));
}

// Optimized check recording:
// - Batch all 3 sources into ONE batch INSERT
// - Only run cleanup DELETE once per hour (not every minute)
let _lastChecksCleanup = 0;
const CHECKS_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function recordCheck(db, source, ok, latencyMs, error) {
  const ts = new Date().toISOString();
  // Use a batch-friendly approach: we'll collect and flush in recordChecksBatch
  // For backward compatibility, this single-call version still works but is less efficient.
  // The preferred path is recordChecksBatch (see below).
  await db.prepare(
    `INSERT INTO checks (ts, source, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)`
  ).bind(ts, source, ok ? 1 : 0, latencyMs ?? null, error || null).run();

  const now = Date.now();
  if (now - _lastChecksCleanup > CHECKS_CLEANUP_INTERVAL_MS) {
    _lastChecksCleanup = now;
    await db.prepare(`DELETE FROM checks WHERE ts < datetime('now', '-7 days')`).run();
  }
}

// Batch version: call once per pipeline with all 3 sources
export async function recordChecksBatch(db, checks) {
  if (!checks.length) return;
  const now = Date.now();
  const ts = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO checks (ts, source, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)`
  );
  const batch = checks.map(c => stmt.bind(ts, c.source, c.ok ? 1 : 0, c.latencyMs ?? null, c.error || null));
  await db.batch(batch);

  if (now - _lastChecksCleanup > CHECKS_CLEANUP_INTERVAL_MS) {
    _lastChecksCleanup = now;
    await db.prepare(`DELETE FROM checks WHERE ts < datetime('now', '-7 days')`).run();
  }
}

export async function sourceMetrics(db, sources) {
  const out = {};
  for (const name of sources) {
    const rows = await db.prepare(
      `SELECT ok, latency_ms, error, ts FROM checks WHERE source=? ORDER BY ts DESC LIMIT 2880`
    ).bind(name).all();
    const list = rows?.results || [];
    const oks = list.filter(r => r.ok === 1);
    const lats = oks.map(r => r.latency_ms).filter(Number.isFinite);
    const last = list[0] || null;
    out[name] = {
      checks24h: list.length,
      successRate24h: list.length ? Math.round((oks.length / list.length) * 1000) / 10 : null,
      avgLatencyMs: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      lastOkAt: oks[0]?.ts || null,
      lastError: !last?.ok && last?.error ? last.error : null,
    };
  }
  return out;
}
