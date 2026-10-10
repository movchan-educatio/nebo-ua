import { normalizeAlert, normalizeNeptunThreat, normalizeMapa, isFreshEvent } from './normalize.js';
import { correlate, fuse, detectDisagreement } from './fuse.js';
import { protectAlerts, protectThreats } from './protect.js';
import { fetchNeptunAlerts, fetchNeptunThreats, fetchMapa } from './sources.js';
import { loadBundle, saveBundle, meaningfulFp, shouldWrite, recordChecksBatch, journalUpsert, journalEnd } from './store.js';
import { slimBundle } from './slim.js';
import { loadRuntime, commitRuntime } from './runtime-state.js';
import { dispatchPush } from './push.js';

// One deadline for the WHOLE source operation, including UA's chained
// status/alerts/regions calls. A rejected adapter cannot reject other lanes.
export async function sourceTask(task, timeoutMs = 9000) {
  const started = Date.now();
  const ctrl = new AbortController();
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      ctrl.abort(new DOMException('Source timeout', 'AbortError'));
      resolve({ ok: false, items: [], error: 'Перевищено час очікування джерела' });
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => task(ctrl.signal)).catch(() => ({ ok: false, items: [], error: 'Помилка отримання джерела' })),
      timeout,
    ]);
    const completedAt = new Date().toISOString();
    return { ...result, latencyMs: Date.now() - started, checkedAt: completedAt };
  } finally { clearTimeout(timer); }
}

function healthOf(result, previous = {}) {
  if (!result) return previous; // pending UA: preserve its actual prior check
  if (result.disabled) return { status: 'disabled', checkedAt: result.checkedAt, updatedAt: null, lastSuccessAt: null, error: null };
  const successAt = result.ok && !result.stale && !result.partial
    ? result.checkedAt : previous.lastSuccessAt || (previous.status === 'online' ? previous.updatedAt : null) || null;
  // RECOVERING: this check succeeded but the previous recorded state was a
  // failure — the source just came back. One more clean cycle resolves it to
  // online (see mergeHealth + the next healthOf call).
  const status = result.ok
    ? (previous?.status === 'offline' ? 'recovering' : 'online')
    : 'offline';
  return {
    status,
    checkedAt: result.checkedAt,
    lastSuccessAt: successAt,
    updatedAt: successAt,
    error: result.error || (result.partial ? 'Неповний довідник регіонів' : null),
    ...((result.stale || result.delayed) ? { delayed: true } : {}),
  };
}

function newest(...dates) { return dates.filter(Boolean).sort().at(-1) || null; }

// A cycle publishes exactly once, from a single previous state, so monitoring
// grace counters can only ever be incremented once per run.
export function reduceCycle(previous, results, startedMs) {
  const { alerts, threats, mapa } = results;
  const now = new Date(startedMs);
  const prev = previous?.prev || { alerts: [], threats: [] };
  const freshAlerts = alerts.ok
    ? alerts.items.map(x => normalizeAlert(x, new Date(alerts.checkedAt))).filter(Boolean)
    : [];
  const freshThreats = [
    ...(threats.ok && !threats.stale ? threats.items.map(x => normalizeNeptunThreat(x, new Date(threats.checkedAt))).filter(Boolean) : []),
    ...(mapa.ok ? mapa.items.map(x => normalizeMapa(x, new Date(mapa.checkedAt))).filter(Boolean) : []),
  ];
  const alertSources = new Set(alerts.ok ? ['NEPTUN'] : []);
  const threatSources = new Set([
    ...(threats.ok && !threats.stale ? ['NEPTUN'] : []), ...(mapa.ok ? ['MAPA'] : []),
  ]);
  // Pending is different from failed: a source that has not answered yet keeps
  // its records unchanged; on a failure they are retained as stale without
  // counting a miss.
  //
  // The retired source is neither. Its records must LEAVE the active set rather
  // than be held stale forever by outage protection, which exists for transient
  // failures. They stay in D1 as audit history and are journalled as ended —
  // never served as a current confirmation.
  const retiredSources = new Set(['OFFICIAL']);
  const protAlerts = protectAlerts(prev.alerts, freshAlerts,
    results.alertLimit, alertSources, retiredSources);
  const protThreats = protectThreats(prev.threats, freshThreats,
    results.threatLimit, threatSources, retiredSources);
  const events = fuse(correlate(protThreats.active)).map(e => ({
    ...e, stale: e.stale || !isFreshEvent(e.category, e.eventTime, startedMs),
  }));
  const oldHealth = previous?.snapshot?.health || {};
  const neptun = {
    // Monitoring liveness comes from the threats endpoint. Its independent
    // alerts endpoint cannot make successfully fetched tracks look offline.
    ok: threats.ok, stale: threats.stale,
    checkedAt: threats.checkedAt,
    error: [alerts.error, threats.error].filter(Boolean).join('; ') || null,
  };
  const health = {
    NEPTUN: { ...healthOf(neptun, oldHealth.NEPTUN), alertsStatus: alerts.ok ? 'online' : 'offline' },
    MAPA: healthOf(mapa, oldHealth.MAPA),
  };
  const fp = meaningfulFp(protAlerts.active, protThreats.active, health);
  const changed = !previous || Object.keys(fp).some(k => fp[k] !== previous[k]);
  const dataUpdatedAt = changed ? new Date().toISOString() : previous.snapshot.dataUpdatedAt;
  const pipelineCheckedAt = newest(health.NEPTUN.lastSuccessAt, health.MAPA.lastSuccessAt);
  // Slim BEFORE anything is committed or published: the fused `correlated`
  // member records and long trails are merge/display-only, and carrying them
  // through pushed the bundle past the compression threshold, where the
  // per-cycle gzip cost alone exceeded the CPU budget and killed the cron.
  return slimBundle({
    ...fp,
    prev: { alerts: protAlerts.active, threats: protThreats.active },
    ended: { alerts: protAlerts.ended, threats: protThreats.ended },
    dataUpdatedAt,
    snapshot: {
      v: 1, serverTime: pipelineCheckedAt, receivedAt: pipelineCheckedAt,
      pipelineStartedAt: now.toISOString(), pipelineCheckedAt, dataUpdatedAt,
      health, alerts: protAlerts.active, events,
      disagreement: detectDisagreement(events, health),
    },
  });
}

export async function runDurablePipeline(env) {
  const started = Date.now();
  const telemetry = { pipeline: 'cycle', startedAt: new Date(started).toISOString(), stagesMs: {} };
  try {
    // A database READ failure must not kill the cycle: fall back to the KV
    // checkpoint (which loadBundle reads safely) instead of publishing
    // nothing. Writes stay honest — a failed commit publishes to KV only.
    let previous = null, d1LoadError = false, kvLoadError = false;
    try {
      previous = await loadRuntime(env.nebo_journal);
    } catch { d1LoadError = true; telemetry.d1LoadError = true; }
    let checkpoint = null;
    try {
      checkpoint = await loadBundle(env.NEBO_STATE);
    } catch { kvLoadError = true; telemetry.kvLoadError = true; }
    previous ||= checkpoint;
    telemetry.stagesMs.load = Date.now() - started;
    console.log(JSON.stringify({ pipeline: 'stage', stage: 'loaded' }));
    const [alerts, threats, mapa] = await Promise.all([
      sourceTask(() => fetchNeptunAlerts(env), 19000),
      sourceTask(() => fetchNeptunThreats(env), 19000),
      sourceTask(() => fetchMapa(env), 25000),
    ]);
    telemetry.stagesMs.monitoringFetch = Date.now() - started - telemetry.stagesMs.load;
    console.log(JSON.stringify({ pipeline: 'stage', stage: 'fetched', alerts: alerts.items.length, threats: threats.items.length, mapa: mapa.items.length }));
    const common = { alerts, threats, mapa,
      alertLimit: Number(env.ALERT_MISS_LIMIT) || 3,
      threatLimit: Number(env.THREAT_MISS_LIMIT) || 3 };
    let published = previous;
    let superseded = false, d1CommitFailed = false;
    const publish = async () => {
      const reduceStart = Date.now();
      const next = reduceCycle(previous, common, started);
      console.log(JSON.stringify({ pipeline: 'stage', stage: 'reduced' }));
      telemetry.stagesMs.normalizeCorrelateFuse = (telemetry.stagesMs.normalizeCorrelateFuse || 0) + Date.now() - reduceStart;
      const publishedAt = new Date().toISOString();
      // *2 keeps the marker unique per run so a slower earlier run cannot be
      // mistaken for a newer one when deciding whether it was superseded.
      next.startedAt = started * 2;
      next.writtenAt = Date.now();
      next.snapshot.publishedAt = publishedAt;
      // The single publication IS the completed cycle: there is no second phase
      // waiting on a source that no longer exists.
      next.snapshot.pipelineCompletedAt = publishedAt;
      let committed = false;
      const commitStart = Date.now();
      try {
        committed = await commitRuntime(env.nebo_journal, next);
      } catch {
        // D1 write failed: keep serving the freshly verified snapshot from
        // the KV checkpoint instead of dropping the whole cycle. Journal,
        // checks and push below fail best-effort and are flagged.
        d1CommitFailed = true;
        telemetry.d1CommitError = true;
      }
      telemetry.stagesMs.publish = (telemetry.stagesMs.publish || 0) + Date.now() - commitStart;
      if (!committed && !d1CommitFailed) { superseded = true; return; }
      const before = published;
      published = next;
      // Best-effort recovery checkpoint. Critical publication is already in
      // D1 and does not wait for a KV quota, throttle, or cache propagation.
      const decision = shouldWrite({ stored: checkpoint, ...next, nowMs: Date.now() });
      // Only the final publication — the single one this cycle has — is worth a
      // KV checkpoint; earlier phases existed to pre-warm before the official
      // result landed.
      if (decision.write && (!checkpoint?.writtenAt || Date.now() - checkpoint.writtenAt >= 1000)) {
        try { await saveBundle(env.NEBO_STATE, next); checkpoint = next; }
        catch { telemetry.kvError = true; }
      }
      // Optional consumers must not prevent publishing a later UA result.
      const auditStart = Date.now();
      try {
        const items = [...next.prev.alerts, ...next.prev.threats];
        await journalUpsert(env.nebo_journal, items.filter(x => !x.stale), publishedAt, 'active');
        await journalUpsert(env.nebo_journal, items.filter(x => x.stale), publishedAt, 'stale');
        await journalEnd(env.nebo_journal, [...next.ended.alerts, ...next.ended.threats], publishedAt);
      } catch { telemetry.journalError = true; }
      try {
        await dispatchPush(env, { snapshot: next.snapshot,
          prevIds: before?.prev ? { alerts: before.prev.alerts.map(a => a.id), threats: before.prev.threats.map(t => t.id) } : null,
          endedAlerts: next.ended.alerts });
      } catch { telemetry.pushError = true; }
      telemetry.stagesMs.journalAndPush = (telemetry.stagesMs.journalAndPush || 0) + Date.now() - auditStart;
    };
    // Coalesce responses finishing in the same burst; avoid running the CPU
    // work twice for a fast UA response. A slow lane costs at most 50 ms
    // before the monitoring publication, never its network timeout.
    // LIVENESS FIRST. NEPTUN/MAPA are already verified at this point, so their
    // check rows are written BEFORE any publish or push crypto happens. This
    // is the whole point: an isolate that dies later (e.g. exceededCpu inside
    // Web Push ECDSA) must still leave a liveness trace, otherwise the site
    // silently rots into ДАНІ ЗАСТАРІЛІ with no evidence of why.
    try {
      await recordChecksBatch(env.nebo_journal, [
        { source: 'NEPTUN', ok: threats.ok && !threats.stale, latencyMs: threats.latencyMs, error: threats.error },
        { source: 'MAPA', ok: mapa.ok, latencyMs: mapa.latencyMs, error: mapa.error },
      ]);
      telemetry.stagesMs.checks = Date.now() - started - (telemetry.stagesMs.monitoringFetch || 0);
    } catch { telemetry.checksError = true; }

    // One publication, no row for the retired source: nothing about it should
    // cost CPU, a D1 write, or a fake "checked and failed" signal.
    if (!superseded) await publish();
    if (superseded) {
      telemetry.outcome = 'superseded';
      try {
        return (await loadRuntime(env.nebo_journal))?.snapshot || previous?.snapshot;
      } catch {
        return previous?.snapshot;
      }
    }
    telemetry.outcome = d1CommitFailed ? 'published-kv' : 'published';
    return published.snapshot;
  } catch (error) {
    telemetry.outcome = 'failed';
    throw error;
  } finally {
    telemetry.durationMs = Date.now() - started;
    console.log(JSON.stringify(telemetry));
  }
}
