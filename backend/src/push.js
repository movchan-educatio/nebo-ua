// Web Push delivery via Workers-native implementation (Web Crypto + fetch).
// No Node APIs, no npm dependencies in the production path.
import { categoryOf, buildPayload, shouldDeliver, diffStarted } from './notify.js';
import { sendNativeOnce, sanitizeErrorText } from './webpush-native.js';
export { sanitizeErrorText };
export function configureVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    throw new Error('VAPID is not configured (VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT)');
  }
}

export async function endpointHash(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(endpoint || '')));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sends one push with retries. 410/404 -> subscription is dead (delete it).
// Returns { ok, deleted, attempts, statusCode, stage, errorName, error, stack, latencyMs }.
// `error`/`stack` are sanitized: never keys, endpoints, or headers.
export async function sendToSubscription(env, subscription, payload, { attempts = 3 } = {}) {
  const started = Date.now();
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    return { ok: false, deleted: false, attempts: 0, statusCode: null, stage: 'config-vapid', errorName: 'Error', error: 'VAPID is not configured', stack: [], latencyMs: Date.now() - started, retryable: false };
  }
  const delays = [0, 1000, 4000];
  let last = null;
  for (let i = 0; i < attempts; i++) {
    if (delays[i]) await sleep(delays[i]);
    const r = await sendNativeOnce(vapid, subscription, payload);
    r.attempts = i + 1;
    r.latencyMs = Date.now() - started;
    if (r.ok || r.deleted || !r.retryable) return r;
    last = r;
  }
  return last;
}

// Maps a send result to an HTTP-safe test response.
// Never includes secrets: only code/message/status, no keys or endpoints.
export function toTestResult(res) {
  if (!res) return { http: 502, body: { ok: false, code: 'send-failed', message: 'Немає результату відправки.' } };
  if (res.ok) return { http: 200, body: { ok: true } };
  if (res.deleted) return { http: 200, body: { ok: false, code: 'gone', message: 'Підписка застаріла і видалена. Увімкніть Push заново.' } };
  const st = res.statusCode ?? null;
  if (st === 401 || st === 403) {
    return { http: 200, body: { ok: false, code: 'send-failed', message: 'Push-провайдер відхилив авторизацію (VAPID).', status: st } };
  }
  if (st === 429) {
    return { http: 200, body: { ok: false, code: 'send-failed', message: 'Push-провайдер обмежив частоту. Спробуйте пізніше.', status: st } };
  }
  return { http: 200, body: { ok: false, code: 'send-failed', message: 'Не вдалося доставити. Спробуйте пізніше.', ...(st == null ? {} : { status: st }) } };
}

export async function loadSubscriptions(db) {
  // Full scan is deliberate: one subscription may follow several oblasts,
  // and correctness beats index tricks at this scale. Revisit past ~10k rows.
  const rows = await db.prepare(
    `SELECT endpoint, p256dh, auth, places, categories, quiet, created_at FROM push_subscriptions`
  ).all();
  return (rows?.results || []).map(r => ({
    ...r,
    places: safeJson(r.places, []),
    categories: safeJson(r.categories, {}),
    quiet: safeJson(r.quiet, {}),
  }));
}

function safeJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export async function deleteSubscription(db, endpoint) {
  await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).bind(endpoint).run();
}

export async function logDeliveries(db, rows) {
  if (!rows.length) return;
  const stmt = db.prepare(
    `INSERT INTO push_log (ts, endpoint_hash, event_id, category, status, attempts, error, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  await db.batch(rows.map(r => stmt.bind(r.ts, r.endpoint_hash, r.event_id || null, r.category || null, r.status, r.attempts || 1, r.error || null, r.latency_ms ?? null)));
}

// Main dispatch: called once per pipeline with protected lists.
// Returns {sent, failed, skipped} counts. Never throws.
//
// CPU SAFETY (Workers free plan = 10 ms/invocation): every actual send costs
// elliptic-curve crypto (ECDH + ECDSA). During mass attacks dozens of new
// tracks per cycle multiplied by subscribers killed cycles with exceededCpu,
// which also prevented liveness checks from being recorded. Sends per cycle
// are therefore hard-capped; overflow is logged as skipped-cap, never sent.
// Priority: official start/end first, then newest threats.
const MAX_PUSH_SENDS_PER_CYCLE = 8;
// Hard ceiling on jobs considered per cycle. Official signals are pushed to
// the front before the cap is applied, so an air-raid start/end is never the
// thing that gets dropped. Overflow is counted, never silently discarded.
const MAX_PUSH_JOBS_PER_CYCLE = 24;
export async function dispatchPush(env, { snapshot, prevIds, endedAlerts, now = new Date() }) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  try {
    configureVapid(env);
  } catch (e) {
    console.error('push disabled:', e.message);
    return { ...out, disabled: true };
  }
  try {
    const startedThreats = diffStarted(prevIds?.threats, snapshot.events.filter(e => !e.stale));
    const startedAlerts = diffStarted(prevIds?.alerts, snapshot.alerts);
    const jobs = [];
    // Cross-source dedup: the same territory alarming via NEPTUN and
    // One officialStart job per (region, district), however many records the
    // source reports for it.
    // Displayed snapshot keeps both attributed records; only push is united.
    const seenOfficial = new Set();
    for (const e of startedAlerts) {
      const k = `${e.region || ''}||${e.district || ''}`;
      if (seenOfficial.has(k)) continue;
      seenOfficial.add(k);
      jobs.push({ event: e, kind: 'officialStart', category: 'officialStart' });
    }
    for (const a of endedAlerts) jobs.push({ event: a, kind: 'officialEnd', category: 'officialEnd' });
    for (const e of startedThreats) {
      const category = categoryOf(e);
      if (category) jobs.push({ event: e, kind: 'threat', category });
    }
    if (!jobs.length) return out;
    const firstSeen = await firstSeenMap(env.nebo_journal, jobs.map(j => j.event.id));
    const subs = await loadSubscriptions(env.nebo_journal);
    const logs = [];
    const skippedByReason = {};
    const ts = now.toISOString();
    // Official signals first, then newest threats — so the cap below drops
    // the least critical overflow, never an official alert.
    const prio = (j) => j.category === 'officialStart' ? 0 : j.category === 'officialEnd' ? 1 : 2;
    const tOf = (j) => new Date(j.event.eventTime || j.event.timestamp || 0).getTime() || 0;
    jobs.sort((a, b) => prio(a) - prio(b) || tOf(b) - tOf(a));
    const droppedJobs = Math.max(0, jobs.length - MAX_PUSH_JOBS_PER_CYCLE);
    if (droppedJobs) {
      out.jobsDropped = (out.jobsDropped || 0) + droppedJobs;
      jobs.length = MAX_PUSH_JOBS_PER_CYCLE;
      console.warn(JSON.stringify({ push: 'jobs-cap', dropped: droppedJobs, kept: jobs.length }));
    }
    let sendsUsed = 0;
    const concurrency = 20;
    for (let i = 0; i < subs.length; i += concurrency) {
      const batch = subs.slice(i, i + concurrency);
      await Promise.all(batch.map(async (sub) => {
        // One hash per subscriber per cycle (not per job): correlation only.
        const hash = await endpointHash(sub.endpoint);
        for (const job of jobs) {
          const reason = shouldDeliver(sub, job.event, job.category, { now, firstSeen: firstSeen.get(job.event.id) || null });
          if (reason) {
            // Counted, but NOT written per pair: a subscriber that follows ten
            // oblasts used to produce one row for every non-matching event.
            out.skipped++;
            skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
            continue;
          }
          if (sendsUsed >= MAX_PUSH_SENDS_PER_CYCLE) {
            out.skipped++;
            logs.push({ ts, endpoint_hash: hash, event_id: job.event.id, category: job.category, status: 'skipped-cap', attempts: 0, error: null, latency_ms: null });
            continue;
          }
          sendsUsed++;
          const payload = buildPayload(job.kind, job.event);
          const res = await sendToSubscription(env, { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          if (res.ok) out.sent++;
          else out.failed++;
          logs.push({ ts, endpoint_hash: hash, event_id: job.event.id, category: job.category, status: res.ok ? 'sent' : res.deleted ? 'gone' : 'failed', attempts: res.attempts, error: res.error, latency_ms: res.latencyMs });
          if (res.deleted) await deleteSubscription(env.nebo_journal, sub.endpoint).catch(() => {});
        }
      }));
    }
    // Relevance misses are summarised in ONE row per reason per cycle instead
    // of one row per (subscriber x unrelated event). Deliberate sends, failures
    // and skipped-cap decisions keep their individual rows above.
    for (const [status, n] of Object.entries(skippedByReason)) {
      logs.push({ ts, endpoint_hash: 'aggregate', event_id: null, category: null, status: `${status}x${n}`, attempts: 0, error: null, latency_ms: null });
    }
    await logDeliveries(env.nebo_journal, logs).catch(e => console.error('push log failed', e));
  } catch (e) {
    console.error('dispatchPush failed', e);
  }
  return out;
}

async function firstSeenMap(db, ids) {
  const map = new Map();
  // One IN(...) with hundreds of placeholders is itself expensive; the jobs we
  // actually consider are already capped, so match that bound.
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 32);
  if (!list.length) return map;
  const placeholders = list.map(() => '?').join(',');
  try {
    const rows = await db.prepare(`SELECT id, first_seen FROM journal WHERE id IN (${placeholders})`).bind(...list).all();
    for (const r of rows?.results || []) map.set(r.id, r.first_seen);
  } catch { /* journal hiccup must not block push */ }
  return map;
}
