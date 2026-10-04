// KV latest snapshot + previous actives, D1 journal + source checks.
// All functions take explicit bindings so they stay testable.
const LATEST_KEY = 'v1:latest';
const PREV_KEY = 'v1:prev-actives';

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

export async function journalUpsert(db, items, nowIso, staleMark) {
  if (!items.length) return;
  const stmt = db.prepare(
    `INSERT INTO journal (id, kind, source, category, region, district, first_seen, last_seen, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, status=excluded.status`
  );
  const batch = items.map(e => stmt.bind(
    e.id, e.official ? 'alert' : 'threat', e.source, e.category || null,
    e.region || null, e.district || null, nowIso, nowIso, staleMark || 'active',
  ));
  await db.batch(batch);
}

export async function journalEnd(db, items, nowIso) {
  if (!items.length) return;
  const stmt = db.prepare(`UPDATE journal SET ended_at=?, status='ended' WHERE id=? AND status!='ended'`);
  await db.batch(items.map(e => stmt.bind(nowIso, e.id)));
}

export async function recordCheck(db, source, ok, latencyMs, error) {
  const ts = new Date().toISOString();
  await db.prepare(
    `INSERT INTO checks (ts, source, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)`
  ).bind(ts, source, ok ? 1 : 0, latencyMs ?? null, error || null).run();
  await db.prepare(`DELETE FROM checks WHERE ts < datetime('now', '-7 days')`).run();
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
