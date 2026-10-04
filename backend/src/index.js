// nebo-ua aggregator: cron pipeline + HTTP API + legacy passthrough.
import { normalizeNeptunThreat, normalizeMapa, normalizeAlert, isFreshEvent } from './normalize.js';
import { correlate, fuse, detectDisagreement } from './fuse.js';
import { protectAlerts, protectThreats } from './protect.js';
import { fetchNeptunAlerts, fetchNeptunThreats, fetchMapa, fetchOfficial } from './sources.js';
import { loadPrev, saveState, loadLatest, journalUpsert, journalEnd, recordCheck, sourceMetrics } from './store.js';
import { dispatchPush, sendToSubscription, deleteSubscription, configureVapid } from './push.js';
import { validateSubscribe } from './notify.js';

const SOURCES = ['OFFICIAL', 'NEPTUN', 'MAPA'];

// Explicit binding check: a missing binding must fail loudly with its name,
// never as a cryptic `undefined.prepare` deep in the pipeline.
export function checkBindings(env) {
  const missing = [];
  if (!env.NEBO_STATE || typeof env.NEBO_STATE.get !== 'function') missing.push('NEBO_STATE (KV)');
  if (!env.nebo_journal || typeof env.nebo_journal.prepare !== 'function') missing.push('nebo_journal (D1)');
  return missing;
}

function healthItem(result, extra = {}) {
  if (result.disabled) return { status: 'disabled', updatedAt: null, error: null, ...extra };
  if (!result.ok) return { status: 'offline', updatedAt: null, error: result.error, ...extra };
  return { status: result.delayed ? 'delayed' : 'online', updatedAt: new Date().toISOString(), error: result.delayed ? 'Джерело позначило потік як застарілий' : null, ...extra };
}

function withFreshness(events, nowMs) {
  return events.map(e => ({ ...e, stale: e.stale || !isFreshEvent(e.category, e.eventTime, nowMs) }));
}

async function runPipeline(env) {
  const missing = checkBindings(env);
  if (missing.length) throw new Error('Missing bindings: ' + missing.join(', '));
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const [official, alertsRes, threatsRes, mapaRes] = await Promise.all([
    fetchOfficial(env),
    fetchNeptunAlerts(env),
    fetchNeptunThreats(env),
    fetchMapa(env),
  ]);

  // Record checks (best effort; journal failures must not break the pipeline).
  try {
    await Promise.all([
      recordCheck(env.nebo_journal, 'OFFICIAL', official.ok && !official.disabled, official.latencyMs, official.error),
      recordCheck(env.nebo_journal, 'NEPTUN', alertsRes.ok && threatsRes.ok, Math.max(alertsRes.latencyMs, threatsRes.latencyMs), [alertsRes.error, threatsRes.error].filter(Boolean).join('; ') || null),
      recordCheck(env.nebo_journal, 'MAPA', mapaRes.ok, mapaRes.latencyMs, mapaRes.error),
    ]);
  } catch (e) { console.error('checks failed', e); }

  const prev = await loadPrev(env.NEBO_STATE);
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
    for (const x of official.items) {
      const a = normalizeAlert(x, now, 'OFFICIAL');
      if (a) freshAlerts.push(a);
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
    await saveState(env.NEBO_STATE, snapshot, { alerts: protAlerts.active, threats: protThreats.active });
  } catch (e) { console.error('persist failed', e); }
  try {
    const prevIds = prev
      ? { alerts: prev.alerts.map(a => a.id), threats: prev.threats.map(e => e.id) }
      : null;
    await dispatchPush(env, { snapshot, prevIds, endedAlerts: protAlerts.ended });
  } catch (e) { console.error('push dispatch failed', e); }
  return snapshot;
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
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
    }
    if (url.pathname === '/v1/state') {
      if (!env.NEBO_STATE) return json({ error: 'Storage binding NEBO_STATE is not configured' }, 503, 5);
      const snap = await loadLatest(env.NEBO_STATE);
      if (!snap) return json({ error: 'Snapshot not ready yet, cron warming up' }, 503, 5);
      return json(snap);
    }
    if (url.pathname === '/v1/metrics') {
      const metrics = await sourceMetrics(env.nebo_journal, SOURCES).catch(() => ({}));
      return json({ serverTime: new Date().toISOString(), sources: metrics });
    }
    if (url.pathname === '/v1/refresh' && request.method === 'POST') {
      const snap = await runPipeline(env);
      return json({ ok: true, serverTime: snap.serverTime, alerts: snap.alerts.length, events: snap.events.length });
    }
    if (url.pathname === '/v1/push/vapid-public-key') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY || null });
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
        const row = await env.nebo_journal.prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint=?`).bind(body.endpoint).all();
        const found = row?.results?.[0];
        if (!found) return json({ error: 'Unknown subscription' }, 404, 5);
        configureVapid(env);
        const res = await sendToSubscription(
          env,
          { endpoint: found.endpoint, keys: { p256dh: found.p256dh, auth: found.auth } },
          { title: 'Небо.UA', body: 'Тестове push-сповіщення. Все працює.', tag: 'nebo-test', url: './#skyView' },
          { attempts: 1 },
        );
        if (res.deleted) await deleteSubscription(env.nebo_journal, found.endpoint).catch(() => {});
        return json({ ok: res.ok, status: res.statusCode ?? undefined });
      } catch (e) { return json({ error: String(e?.message || e) }, 502, 5); }
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
