// KV latest snapshot + previous actives, D1 journal + source checks.
// All functions take explicit bindings so they stay testable.
const LATEST_KEY = 'v1:latest';
const PREV_KEY = 'v1:prev-actives';

// --- KV write budget (Cloudflare Workers Free: max 1000 writes/day) ---
// BEFORE: saveState() did 2 unconditional PUTs every 1-min cron = 2880/day.
// AFTER: one coalesced bundle key, fingerprint-gated writes, throttled
// threat persistence, immediate alert writes, rare heartbeat.
// Worst case ~= 480/day, calm day ~= 29/day.
export const BUNDLE_KEY = LATEST_KEY;
export const LATEST_TTL_S = 3600; // 1h: bounds dead-worker staleness; clients detect age via serverTime/health
export const WRITE_THROTTLE_MS = 180000; // positional/track churn persists at most every 3 min
export const HEARTBEAT_MS = 50 * 60_000; // keeps the key alive during calm (~29/day); sources stay shielded

// stableStringify: deterministic JSON with recursively sorted object keys.
// Arrays keep their order (callers pre-sort by id where order is unstable).
export function stableStringify(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function isoOrNull(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}
function byId(a, b) {
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

// meaningfulFp: fingerprint of DISPLAYED state only. Volatile telemetry
// (serverTime, receivedAt, health.updatedAt, latencyMs, trails) is excluded,
// so identical situations produce identical fingerprints and SKIP the write.
export function meaningfulFp(alerts, threats, health) {
  const a = [...(alerts || [])].sort(byId).map(x => ({
    id: x.id, official: !!x.official, source: x.source || null,
    category: x.category || null, kind: x.kind || null,
    region: x.region || null, district: x.district || null,
    level: x.level || null, eventTime: isoOrNull(x.eventTime || x.timestamp),
  }));
  const t = [...(threats || [])].sort(byId).map(x => ({
    id: x.id, source: x.source || null, category: x.category || null,
    kind: x.kind || null, region: x.region || null, district: x.district || null,
    lat: round3(x.lat), lon: round3(x.lon),
    heading: Number.isFinite(x.heading) ? Math.round(x.heading) : null,
    speed: Number.isFinite(x.speed) ? Math.round(x.speed) : null,
    stale: !!x.stale, status: x.status || null,
    eventTime: isoOrNull(x.eventTime || x.timestamp),
    subtype: x.subtype ?? null, explanation: x.rawExplanation ?? null,
  }));
  const h = {
    OFFICIAL: health?.OFFICIAL?.status || null,
    NEPTUN: health?.NEPTUN?.status || null,
    NEPTUN_DELAYED: !!health?.NEPTUN?.delayed,
    MAPA: health?.MAPA?.status || null,
  };
  return {
    fpAlerts: stableStringify(a),
    fpThreats: stableStringify(t),
    fpHealth: stableStringify(h),
  };
}

// shouldWrite: the single write gate. Alerts/health bypass the throttle
// (critical signals persist immediately); track churn is throttled;
// heartbeat keeps the TTL key alive during long calm stretches.
export function shouldWrite({ stored, fpAlerts, fpThreats, fpHealth, nowMs }) {
  const oldA = stored?.fpAlerts ?? null;
  const oldT = stored?.fpThreats ?? null;
  const oldH = stored?.fpHealth ?? null;
  const writtenAt = Number(stored?.writtenAt) || 0;
  if (!stored || !writtenAt) return { write: true, reason: 'cold-start' };
  if (fpAlerts !== oldA || fpHealth !== oldH) return { write: true, reason: 'alerts-changed' };
  if (fpThreats !== oldT) {
    if (nowMs - writtenAt >= WRITE_THROTTLE_MS) return { write: true, reason: 'threats-changed' };
    return { write: false, reason: 'threats-throttled' };
  }
  if (nowMs - writtenAt >= HEARTBEAT_MS) return { write: true, reason: 'heartbeat' };
  return { write: false, reason: 'unchanged' };
}

// isAlreadyPersisted: race protection. A concurrent cycle may have persisted
// this exact state after our read — re-check before spending a PUT.
export function isAlreadyPersisted(fresh, prevWrittenAt, { fpAlerts, fpThreats, fpHealth }) {
  return !!fresh && fresh.fpAlerts === fpAlerts && fresh.fpThreats === fpThreats
    && fresh.fpHealth === fpHealth && (fresh.writtenAt || 0) >= (prevWrittenAt || 0);
}
// loadBundle: read the coalesced state (1 GET). Tolerates the legacy bare
// snapshot shape written before this optimization (forces one rewrite).
export async function loadBundle(kv) {
  try {
    const raw = await kv.get(BUNDLE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && p.snapshot && p.prev && typeof p.writtenAt === 'number') return p;
    if (p && Array.isArray(p.alerts) && Array.isArray(p.events)) {
      return { snapshot: p, prev: null, fpAlerts: null, fpThreats: null, fpHealth: null, writtenAt: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

// saveBundle: ONE PUT per logical state change (coalesced snapshot + prev).
export async function saveBundle(kv, { snapshot, prev, fpAlerts, fpThreats, fpHealth, writtenAt }) {
  await kv.put(BUNDLE_KEY, JSON.stringify({ v: 1, snapshot, prev, fpAlerts, fpThreats, fpHealth, writtenAt }), { expirationTtl: LATEST_TTL_S });
}

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
    if (!raw) return null;
    const p = JSON.parse(raw);
    // Coalesced bundle (current writers): unwrap to the bare snapshot shape
    // so GET /v1/state keeps its exact API contract.
    if (p && p.snapshot && p.prev) return p.snapshot;
    return p;
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
