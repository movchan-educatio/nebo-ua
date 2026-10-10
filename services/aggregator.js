// Client for the backend aggregator (/v1/state).
// Adapts the server snapshot to the exact shape fetchAll() returns,
// so the rest of the app keeps working unchanged.
import { fetchJson } from './http.js';
import { aggregatorUrl } from './config.js';

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

function adaptHealth(serverHealth = {}) {
  const out = {};
  for (const [k, v] of Object.entries(serverHealth)) {
    out[k] = {
      status: v?.status || 'offline',
      updatedAt: toDate(v?.updatedAt),
      checkedAt: toDate(v?.checkedAt),
      lastSuccessAt: toDate(v?.lastSuccessAt || v?.updatedAt),
      error: v?.error || null,
      // Preserve the backend stale/delayed flag: without it the frontend
      // cannot tell DELAYED (old data) from DOWN (no data).
      ...(v?.delayed ? { delayed: true } : {}),
      ...(v?.latencyMs != null ? { latencyMs: v.latencyMs } : {}),
    };
  }
  return out;
}

function adaptAlert(a) {
  return {
    ...a,
    timestamp: toDate(a.eventTime || a.timestamp),
    receivedAt: toDate(a.receivedAt),
  };
}

function adaptEvent(e) {
  return {
    ...e,
    timestamp: toDate(e.eventTime || e.timestamp),
    receivedAt: toDate(e.receivedAt),
    trail: Array.isArray(e.trail)
      ? e.trail.map(p => ({ ...p, timestamp: toDate(p.timestamp) })).filter(p => p.timestamp)
      : [],
  };
}

export async function fetchAggregated(signal) {
  const data = await fetchJson(aggregatorUrl(), { signal, timeout: 12000 });
  return adaptAggregatorSnapshot(data);
}

// Exposed separately so the radar can fetch the payload itself — with its own
// cache and timeout handling — and still get exactly the same shape. Adapting
// in two places would let the two paths drift.
export function adaptAggregatorSnapshot(data) {
  if (!data || data.v !== 1 || !Array.isArray(data.alerts) || !Array.isArray(data.events)) {
    throw new Error('Некоректний зріз агрегатора');
  }
  // Freshness = pipeline liveness, not content churn. pipelineCheckedAt moves
  // every successful upstream verification (D1 read path, 0 KV writes), while
  // dataUpdatedAt stays put when nothing really changed — calm data + live
  // pipeline must read as LIVE, never OFFLINE. Legacy snapshots without the
  // new fields fall back to receivedAt/serverTime exactly as before.
  const receivedAt = toDate(data.pipelineCheckedAt || data.receivedAt || data.serverTime);
  return {
    alerts: data.alerts.map(adaptAlert).filter(a => a.timestamp || a.official),
    events: data.events.map(adaptEvent),
    rawEvents: data.events.map(adaptEvent),
    health: adaptHealth(data.health),
    disagreement: data.disagreement || { active: false, reason: '' },
    receivedAt,
    serverTime: toDate(data.serverTime),
    dataUpdatedAt: toDate(data.dataUpdatedAt),
    pipelineCheckedAt: toDate(data.pipelineCheckedAt),
    publishedAt: toDate(data.publishedAt),
    responseAt: toDate(data.responseAt),
    pipelineStartedAt: toDate(data.pipelineStartedAt),
    degraded: data.degraded === true,
  };
}
