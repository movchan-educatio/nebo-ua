// nebo-ua aggregator: cron pipeline + HTTP API + legacy passthrough.
import { normalizeNeptunThreat, normalizeMapa, normalizeAlert, isFreshEvent } from './normalize.js';
import { correlate, fuse, detectDisagreement } from './fuse.js';
import { protectAlerts, protectThreats } from './protect.js';
import { fetchNeptunAlerts, fetchNeptunThreats, fetchMapa, fetchOfficial } from './sources.js';
import { fetchOfficialUkraineAlarm, fetchRegionHistory, getRegionsTree } from './ukrainealarm.js';
import { loadPrev, saveState, loadLatest, loadBundle, saveBundle, meaningfulFp, shouldWrite, isAlreadyPersisted, journalUpsert, journalEnd, recordChecksBatch, sourceMetrics } from './store.js';
import { dispatchPush, sendToSubscription, deleteSubscription, configureVapid, toTestResult, endpointHash } from './push.js';
import { validateSubscribe } from './notify.js';
import { runDurablePipeline } from './pipeline.js';
import { loadRuntime, runtimeResponse } from './runtime-state.js';

const SOURCES = ['OFFICIAL', 'NEPTUN', 'MAPA'];

// Explicit binding check: a missing binding must fail loudly with its name,
// never as a cryptic `undefined.prepare` deep in the pipeline.
export function checkBindings(env) {
  const missing = [];
  if (!env.NEBO_STATE || typeof env.NEBO_STATE.get !== 'function') missing.push('NEBO_STATE (KV)');
  if (!env.nebo_journal || typeof env.nebo_journal.prepare !== 'function') missing.push('nebo_journal (D1)');
  return missing;
}

// Constant-time string compare for shared-secret gates (no timing oracle).
export function timingSafeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function healthItem(result, extra = {}) {
  if (result.disabled) return { status: 'disabled', updatedAt: null, error: null, ...extra };
  if (!result.ok) return { status: 'offline', updatedAt: null, error: result.error, ...extra };
  // Single contract: online + delayed flag (never a separate 'delayed'
  // status value). mergeHealth and the frontend preserve the flag.
  return { status: 'online', updatedAt: new Date().toISOString(), error: result.delayed ? 'Джерело позначило потік як застарілий' : null, ...(result.delayed ? { delayed: true } : {}), ...extra };
}

function withFreshness(events, nowMs) {
  return events.map(e => ({ ...e, stale: e.stale || !isFreshEvent(e.category, e.eventTime, nowMs) }));
}

// Lightweight KV write telemetry (in-memory only: zero KV writes).
// Counters may split across isolates; ratios (skipped vs wrote) are what matter.
// Post-deploy measurement: filter worker logs for {"kv":"put"} / {"kv":"summary"}.
const kvStats = { cycles: 0, wrote: 0, skippedUnchanged: 0, skippedThrottled: 0, skippedRace: 0 };
function kvSummaryTick() {
  if (kvStats.cycles % 60 !== 0) return;
  try {
    console.log(JSON.stringify({
      kv: 'summary', cycles: kvStats.cycles, wrote: kvStats.wrote,
      skippedUnchanged: kvStats.skippedUnchanged, skippedThrottled: kvStats.skippedThrottled,
      skippedRace: kvStats.skippedRace,
    }));
  } catch { /* logging must never break the pipeline */ }
}

async function runPipeline(env) {
  const missing = checkBindings(env);
  if (missing.length) throw new Error('Missing bindings: ' + missing.join(', '));
  if (env.SYNC_STATE_STORE === 'd1') return runDurablePipeline(env);
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const [official, alertsRes, threatsRes, mapaRes] = await Promise.all([
    // UkraineAlarm v3 (official) when its secret is configured; otherwise the
    // legacy generic endpoint. Absent key => disabled source (never an error).
    env.UKRAINEALARM_API_KEY ? fetchOfficialUkraineAlarm(env) : fetchOfficial(env),
    fetchNeptunAlerts(env),
    fetchNeptunThreats(env),
    fetchMapa(env),
  ]);

  // Record checks (best effort; journal failures must not break the pipeline).
  // Batched: single INSERT batch + hourly cleanup instead of 3×(INSERT+DELETE) per cron.
  try {
    await recordChecksBatch(env.nebo_journal, [
      { source: 'OFFICIAL', ok: official.ok && !official.disabled, latencyMs: official.latencyMs, error: official.error },
      { source: 'NEPTUN', ok: alertsRes.ok && threatsRes.ok, latencyMs: Math.max(alertsRes.latencyMs, threatsRes.latencyMs), error: [alertsRes.error, threatsRes.error].filter(Boolean).join('; ') || null },
      { source: 'MAPA', ok: mapaRes.ok, latencyMs: mapaRes.latencyMs, error: mapaRes.error },
    ]);
  } catch (e) { console.error('checks failed', e); }

  // Coalesced state: ONE bundle key holds snapshot + prev actives + fingerprints.
  // Legacy v1:prev-actives is read once as migration fallback, then left to expire.
  let bundle = await loadBundle(env.NEBO_STATE);
  let prev = bundle?.prev || null;
  if (!bundle) {
    try { prev = await loadPrev(env.NEBO_STATE); } catch { prev = null; }
  }
  const alertsOk = alertsRes.ok;
  const threatsOk = threatsRes.ok && !threatsRes.stale;
  const mapaOk = mapaRes.ok;
  const officialOk = official.ok && !official.disabled;

  // Normalize only successful sources. Failed sources keep previous state untouched.
  let freshAlerts = [];
  if (alertsOk) {
    freshAlerts = alertsRes.items.map(x => normalizeAlert(x, now, 'NEPTUN')).filter(Boolean);
  }
  if (officialOk) {
    if (official.carried) {
      // Version gate proved the upstream set is byte-identical to the last
      // full fetch: re-affirm previous OFFICIAL records as-is. stale:false is
      // honest here (confirmed present); event timestamps are preserved, and
      // misses reset via protectAlerts like any re-seen record.
      for (const a of prev?.alerts || []) {
        if (a?.source === 'OFFICIAL') freshAlerts.push({ ...a, stale: false });
      }
    } else {
      for (const x of official.items) {
        const a = normalizeAlert(x, now, 'OFFICIAL');
        if (a) freshAlerts.push(a);
      }
    }
  }
  let freshThreats = [];
  if (threatsOk) {
    freshThreats.push(...threatsRes.items.map(x => normalizeNeptunThreat(x, now)).filter(Boolean));
  }
  if (mapaOk) {
    freshThreats.push(...mapaRes.items.map(x => normalizeMapa(x, now)).filter(Boolean));
  }

  const alertLimit = Number(env.ALERT_MISS_LIMIT) || 3;
  const threatLimit = Number(env.THREAT_MISS_LIMIT) || 3;
  const alertSourcesOk = alertsOk || officialOk;
  const protAlerts = alertSourcesOk
    ? protectAlerts(prev?.alerts || [], freshAlerts, alertLimit)
    : { active: prev?.alerts || [], ended: [] };
  const threatSourcesOk = threatsOk || mapaOk;
  const protThreats = threatSourcesOk
    ? protectThreats(prev?.threats || [], freshThreats, threatLimit)
    : { active: prev?.threats || [], ended: [] };

  const events = withFreshness(fuse(correlate(protThreats.active)), nowMs);
  const health = {
    OFFICIAL: healthItem(official),
    NEPTUN: healthItem({ ok: alertsOk && threatsOk, error: [alertsRes.error, threatsRes.error].filter(Boolean).join('; ') || null, latencyMs: 0 }, { delayed: threatsRes.stale }),
    MAPA: healthItem(mapaRes),
  };
  const snapshot = {
    v: 1,
    serverTime: nowIso,
    receivedAt: nowIso,
    health,
    alerts: protAlerts.active,
    events,
    disagreement: detectDisagreement(events, health),
  };

  try {
    await journalUpsert(env.nebo_journal, [...protAlerts.active, ...protThreats.active].filter(e => !e.stale), nowIso, 'active');
    await journalUpsert(env.nebo_journal, [...protAlerts.active, ...protThreats.active].filter(e => e.stale), nowIso, 'stale');
    await journalEnd(env.nebo_journal, [...protAlerts.ended, ...protThreats.ended], nowIso);
  } catch (e) { console.error('journal failed', e); }
  const newPrev = { alerts: protAlerts.active, threats: protThreats.active };
  const { fpAlerts, fpThreats, fpHealth } = meaningfulFp(newPrev.alerts, newPrev.threats, health);
  const decision = shouldWrite({ stored: bundle, fpAlerts, fpThreats, fpHealth, nowMs });
  // dataUpdatedAt = when the VISIBLE content last changed. Heartbeat-only
  // writes must NOT move it: calm data + a live pipeline is LIVE, not stale.
  // Consumers tell the two apart via pipelineCheckedAt (served from D1).
  const prevDataUpdatedAt = bundle?.dataUpdatedAt || bundle?.snapshot?.dataUpdatedAt || bundle?.snapshot?.serverTime || null;
  const dataUpdatedAt = (decision.write && decision.reason !== 'heartbeat')
    ? nowIso
    : (prevDataUpdatedAt || nowIso);
  snapshot.dataUpdatedAt = dataUpdatedAt;
  kvStats.cycles++;
  if (!decision.write) {
    if (decision.reason === 'threats-throttled') kvStats.skippedThrottled++;
    else kvStats.skippedUnchanged++;
  } else {
    // Race protection: a concurrent cycle may have persisted this exact state
    // after our read — re-check before spending a PUT.
    let raced = false;
    try {
      raced = isAlreadyPersisted(await loadBundle(env.NEBO_STATE), bundle?.writtenAt, { fpAlerts, fpThreats, fpHealth });
    } catch { /* re-read failure must not block the write */ }
    if (raced) {
      kvStats.skippedRace++;
    } else {
      try {
        await saveBundle(env.NEBO_STATE, { snapshot, prev: newPrev, fpAlerts, fpThreats, fpHealth, writtenAt: nowMs, dataUpdatedAt });
        kvStats.wrote++;
        bundle = { snapshot, prev: newPrev, fpAlerts, fpThreats, fpHealth, writtenAt: nowMs, dataUpdatedAt };
        try {
          console.log(JSON.stringify({
            kv: 'put', reason: decision.reason,
            alerts: newPrev.alerts.length, threats: newPrev.threats.length,
          }));
        } catch { /* logging must never break the pipeline */ }
      } catch (e) { console.error('persist failed', e); }
    }
  }
  kvSummaryTick();
  try {
    const prevIds = prev
      ? { alerts: prev.alerts.map(a => a.id), threats: prev.threats.map(e => e.id) }
      : null;
    await dispatchPush(env, { snapshot, prevIds, endedAlerts: protAlerts.ended });
  } catch (e) { console.error('push dispatch failed', e); }
  return snapshot;
}

// ── Pipeline liveness (STATE TIME ≠ PIPELINE HEALTH) ─────────────────────
// KV holds the snapshot CONTENT (write-gated: unchanged data => 0 PUT).
// D1 `checks` already records every cron cycle (3 rows/min, well within the
// D1 free tier). GET /v1/state derives pipelineCheckedAt from those rows on
// the READ path: zero extra KV writes, per-minute liveness precision.
//   dataUpdatedAt     = when visible content last changed (KV bundle).
//   pipelineCheckedAt = last SUCCESSFUL upstream verification (D1 checks).
//   serverTime/receivedAt mirror pipelineCheckedAt when known, so legacy
//     consumers (30-min offline threshold) stay LIVE during calm stretches.
// Heartbeat timestamps advance ONLY from real successful check rows —
// never hardcoded, never on failed fetches.
export const LIVE_MS = 5 * 60_000;
export const OFFLINE_MS = 30 * 60_000;

// Newest check row per source + newest SUCCESSFUL monitoring verification.
// Monitoring = NEPTUN or MAPA. OFFICIAL is token-gated (often disabled) and
// never counts as pipeline liveness.
// checkedAt scans back through recent rows for the newest SUCCESS: a single
// failed cycle must NOT zero the heartbeat (it just stops advancing it —
// the age then grows honestly until DELAYED/OFFLINE thresholds hit).
// Health display (bySource) always reflects the NEWEST row per source.
export async function latestPipelineCheck(db) {
  const empty = { bySource: {}, checkedAt: null };
  try {
    if (!db || typeof db.prepare !== 'function') return empty;
    const res = await db.prepare(
      `SELECT source, ts, ok, error FROM checks ORDER BY rowid DESC LIMIT 60`
    ).all();
    const rows = res?.results || [];
    const bySource = {};
    let checkedAt = null;
    for (const r of rows) {
      if (!r || typeof r.source !== 'string') continue;
      if (!bySource[r.source] && typeof r.ts === 'string') {
        bySource[r.source] = {
          ts: r.ts,
          ok: r.ok === 1 || r.ok === true,
          error: r.error || null,
        };
      }
      if ((r.source === 'NEPTUN' || r.source === 'MAPA') && (r.ok === 1 || r.ok === true)
        && typeof r.ts === 'string' && Number.isFinite(new Date(r.ts).getTime())) {
        if (!checkedAt || r.ts > checkedAt) checkedAt = r.ts;
      }
    }
    return { bySource, checkedAt };
  } catch {
    return empty;
  }
}

// Refresh per-source health from D1 without touching KV. OFFICIAL keeps its
// stored `disabled` state (D1 rows for a disabled source are ok=0 by design
// and must not flip it to `offline`). The backend `delayed` (stale-stream)
// flag is preserved while the source reports ok.
export function mergeHealth(storedHealth = {}, bySource = {}) {
  const out = { ...(storedHealth || {}) };
  for (const key of ['NEPTUN', 'MAPA']) {
    const row = bySource[key];
    if (!row || !row.ts) continue;
    const prev = storedHealth?.[key] || {};
    out[key] = {
      status: row.ok ? 'online' : 'offline',
      updatedAt: row.ts,
      error: row.ok ? null : (row.error || prev.error || 'Джерело недоступне'),
      ...(row.ok && (prev.delayed || prev.status === 'delayed') ? { delayed: true } : {}),
    };
  }
  const offStored = storedHealth?.OFFICIAL;
  if (offStored?.status === 'disabled') {
    out.OFFICIAL = offStored;
  } else if (bySource.OFFICIAL?.ts) {
    const row = bySource.OFFICIAL;
    out.OFFICIAL = {
      status: row.ok ? 'online' : 'offline',
      updatedAt: row.ts,
      error: row.ok ? null : (row.error || 'Джерело недоступне'),
    };
  }
  return out;
}

// Build the public /v1/state body: stored content + live health overlay.
// Pure (no I/O): fully unit-testable. Reads never PUT.
export function buildStateResponse(bundle, d1, nowMs) {
  const stored = bundle?.snapshot || null;
  if (!stored) return null;
  const storedTime = stored.serverTime || stored.receivedAt || null;
  const dataUpdatedAt = bundle?.dataUpdatedAt || stored.dataUpdatedAt || storedTime;
  const checkedAt = d1?.checkedAt || null;
  return {
    ...stored,
    serverTime: checkedAt || storedTime,
    receivedAt: checkedAt || stored.receivedAt || storedTime,
    dataUpdatedAt,
    pipelineCheckedAt: checkedAt,
    health: mergeHealth(stored.health, d1?.bySource),
  };
}

// Consumer-side freshness over the merged response. Mirrors the frontend /
// WAR LIVE contract: LIVE ≤5 min, DELAYED ≤30 min, OFFLINE beyond that or
// when every monitoring source is down. dataUpdatedAt age NEVER forces
// OFFLINE on its own — calm data + live pipeline is LIVE.
export function livenessLevel(resp, nowMs) {
  const mon = ['NEPTUN', 'MAPA']
    .map(k => resp?.health?.[k])
    .filter(h => h && h.status !== 'disabled');
  if (mon.length && mon.every(h => h.status === 'offline')) return 'OFFLINE';
  const t = resp?.pipelineCheckedAt ? Date.parse(resp.pipelineCheckedAt) : NaN;
  if (!Number.isFinite(t)) return 'OFFLINE';
  const age = Math.max(0, nowMs - t);
  if (age > OFFLINE_MS) return 'OFFLINE';
  if (age > LIVE_MS) return 'DELAYED';
  return 'LIVE';
}

function json(data, status = 200, cacheSeconds = 10) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${cacheSeconds}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Legacy passthrough (kept for backward compatibility).
const LEGACY = {
  '/alerts': (env) => fetch(env.NEPTUN_ALERTS_URL, { headers: { Accept: 'application/json' } }),
  '/threats': (env) => fetch(env.NEPTUN_THREATS_URL, { headers: { Accept: 'application/json' } }),
  '/mapa': (env) => fetch(env.MAPA_URL, { headers: { Accept: 'application/json' } }),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (url.pathname === '/v1/state' && request.method === 'GET') {
      if (env.SYNC_STATE_STORE === 'd1') {
        try {
          const current = await loadRuntime(env.nebo_journal);
          if (current) return json(runtimeResponse(current, Date.now()), 200, 5);
        } catch { /* serve the last committed checkpoint, with its own times */ }
        const fallback = await loadBundle(env.NEBO_STATE);
        if (fallback?.snapshot) return json(runtimeResponse(fallback, Date.now(), 'kv-fallback'), 200, 5);
        return json({ error: 'Актуальний стан тимчасово недоступний' }, 503, 0);
      }
      if (!env.NEBO_STATE) return json({ error: 'Storage binding NEBO_STATE is not configured' }, 503, 5);
      const bundle = await loadBundle(env.NEBO_STATE);
      if (!bundle?.snapshot) return json({ error: 'Snapshot not ready yet, cron warming up' }, 503, 5);
      // Liveness overlay from D1 (best effort, 0 KV writes). On D1 failure
      // the stored snapshot is served as-is: honestly stale, never faked.
      const d1 = await latestPipelineCheck(env.nebo_journal);
      return json(buildStateResponse(bundle, d1, Date.now()));
    }
    if (url.pathname === '/v1/official/regions' && request.method === 'GET') {
      // Public region directory (id/name/type/parent) for the history picker
      // and search. Served from the KV tree cache; contains no key material
      // and no alert content. 404 when the tree was never fetched (key
      // missing or upstream unreachable) — never an empty list passed off
      // as authoritative.
      const tree = await getRegionsTree(env);
      if (!tree.states?.length) return json({ error: 'Region directory not available yet' }, 404, 30);
      const flat = [];
      const walk = (nodes, parentId) => {
        for (const n of nodes || []) {
          if (n && typeof n.regionId === 'string') {
            flat.push({ regionId: n.regionId, regionName: n.regionName || null, regionType: n.regionType || null, parentId: parentId || null });
            walk(n.regionChildIds, n.regionId);
          }
        }
      };
      walk(tree.states, null);
      return json({ v: 1, serverTime: new Date().toISOString(), regions: flat }, 200, 300);
    }
    if (url.pathname === '/v1/official/history' && request.method === 'GET') {
      // Validated read-through to UkraineAlarm regionHistory (last 25).
      // No KV writes, no persistence. Requires the server secret.
      if (!env.UKRAINEALARM_API_KEY) return json({ error: 'Official source not configured' }, 503, 5);
      const regionId = url.searchParams.get('regionId');
      let items = null;
      try {
        items = await fetchRegionHistory(env, regionId);
      } catch (e) {
        // fetchRegionHistory throws 'Некоректний regionId' BEFORE any
        // network call: that is a client error, not an upstream outage.
        if (e instanceof Error && /regionId/.test(e.message)) {
          return json({ error: 'Некоректний regionId' }, 400, 5);
        }
        return json({ error: 'Official source unavailable' }, 502, 5);
      }
      return json({ v: 1, serverTime: new Date().toISOString(), regionId, history: items }, 200, 60);
    }
    if (url.pathname === '/v1/metrics' && request.method === 'GET') {
      const metrics = await sourceMetrics(env.nebo_journal, SOURCES).catch(() => ({}));
      return json({ serverTime: new Date().toISOString(), sources: metrics });
    }
    if (url.pathname === '/v1/refresh' && request.method === 'POST') {
      // Admin pipeline trigger — FAIL-CLOSED. An open trigger lets anyone
      // force upstream fetches, D1/KV writes and push dispatch at will.
      // The frontend never calls this route (cron only), so closing it
      // changes nothing for the site. Requires REFRESH_TOKEN:
      //   wrangler secret put REFRESH_TOKEN
      // then call with `Authorization: Bearer <token>`.
      if (!env.REFRESH_TOKEN) {
        return json({ error: 'Refresh endpoint is disabled (REFRESH_TOKEN not configured)' }, 503, 5);
      }
      const got = request.headers.get('Authorization') || '';
      if (!timingSafeEqual(got, `Bearer ${env.REFRESH_TOKEN}`)) {
        return json({ error: 'Forbidden' }, 403, 5);
      }
      let snap;
      try { snap = await runPipeline(env); }
      catch { return json({ ok: false, error: 'Не вдалося опублікувати оновлення' }, 503, 0); }
      if (env.SYNC_STATE_STORE === 'd1') {
        return json({ ok: true, serverTime: snap.serverTime, alerts: snap.alerts.length,
          events: snap.events.length, pipelineCheckedAt: snap.pipelineCheckedAt,
          dataUpdatedAt: snap.dataUpdatedAt, publishedAt: snap.publishedAt }, 200, 0);
      }
      let extra = {};
      try {
        const b = await loadBundle(env.NEBO_STATE);
        const d1 = await latestPipelineCheck(env.nebo_journal);
        const merged = b ? buildStateResponse(b, d1, Date.now()) : null;
        if (merged) extra = { pipelineCheckedAt: merged.pipelineCheckedAt, dataUpdatedAt: merged.dataUpdatedAt };
      } catch { /* diagnostic fields are best effort */ }
      return json({ ok: true, serverTime: snap.serverTime, alerts: snap.alerts.length, events: snap.events.length, ...extra });
    }
    if (url.pathname === '/v1/push/vapid-public-key') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY || null, hasPrivateKey: !!env.VAPID_PRIVATE_KEY });
    }
    if (url.pathname === '/v1/push/subscribe' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400, 5); }
      const v = validateSubscribe(body);
      if (!v.ok) return json({ error: 'Invalid subscription', details: v.errors }, 400, 5);
      const now = new Date().toISOString();
      try {
        await env.nebo_journal.prepare(
          `INSERT INTO push_subscriptions (endpoint, p256dh, auth, places, categories, quiet, oblast_norm, created_at, last_seen, failures)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, places=excluded.places, categories=excluded.categories, quiet=excluded.quiet, oblast_norm=excluded.oblast_norm, last_seen=excluded.last_seen`
        ).bind(body.subscription.endpoint, body.subscription.keys.p256dh, body.subscription.keys.auth, JSON.stringify(v.places), JSON.stringify(v.categories), JSON.stringify(v.quiet), v.oblastNorm, now, now).run();
      } catch (e) { return json({ error: 'Storage unavailable' }, 503, 5); }
      return json({ ok: true });
    }
    if (url.pathname === '/v1/push/unsubscribe' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400, 5); }
      if (typeof body?.endpoint !== 'string') return json({ error: 'Bad endpoint' }, 400, 5);
      try { await deleteSubscription(env.nebo_journal, body.endpoint); }
      catch (e) { return json({ error: 'Storage unavailable' }, 503, 5); }
      return json({ ok: true });
    }
    if (url.pathname === '/v1/push/test' && request.method === 'POST') {
      let body = null;
      try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400, 5); }
      if (typeof body?.endpoint !== 'string') return json({ error: 'Bad endpoint' }, 400, 5);
      try {
        configureVapid(env);
      } catch (e) {
        console.error('[push:test] vapid-missing');
        return json({ ok: false, code: 'vapid-missing', message: 'VAPID-ключ не налаштовано на сервері.' }, 502, 5);
      }
      try {
        const row = await env.nebo_journal.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint=?`).bind(body.endpoint).all();
        const found = row?.results?.[0];
        if (!found) return json({ ok: false, code: 'unknown-subscription', message: 'Підписку не знайдено. Увімкніть Push заново.' }, 404, 5);
        const res = await sendToSubscription(
          env,
          { endpoint: found.endpoint, keys: { p256dh: found.p256dh, auth: found.auth } },
          { title: 'Небо.UA', body: 'Тестове push-сповіщення. Все працює.', tag: 'nebo-test', url: './#skyView' },
          { attempts: 1 },
        );
        const out = toTestResult(res);
        if (!res.ok) {
          let hash = '?';
          try { hash = await endpointHash(found.endpoint); } catch { /* ignore */ }
          console.error('[push:test] send failed', JSON.stringify({ endpoint: hash, code: out.body.code, stage: res.stage || null, status: res.statusCode ?? null, errorName: res.errorName || null, error: res.error ?? null, stack: res.stack || [] }));
        if (res.deleted) await deleteSubscription(env.nebo_journal, found.endpoint).catch(() => {});
        }
        return json(out.body, out.http, 5);
      } catch (e) {
        console.error('[push:test] internal error');
        return json({ ok: false, code: 'internal', message: 'Внутрішня помилка сервера.' }, 502, 5);
      }
    }
    const legacy = LEGACY[url.pathname];
    if (legacy) {
      try {
        const res = await legacy(env);
        const data = await res.json();
        return json(data);
      } catch (e) {
        return json({ error: 'Source unavailable' }, 502, 5);
      }
    }
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runPipeline(env));
  },
};
