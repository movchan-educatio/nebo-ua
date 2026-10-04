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
      error: v?.error || null,
      ...(v?.latencyMs != null ? { latencyMs: v.latencyMs } : {}),
    };
  }
  return out;
}

function adaptAlert(a) {
  return {
    ...a,
    timestamp: toDate(a.eventTime || a.timestamp),
    receivedAt: toDate(a.receivedAt) || new Date(),
  };
}

function adaptEvent(e) {
  return {
    ...e,
    timestamp: toDate(e.eventTime || e.timestamp),
    receivedAt: toDate(e.receivedAt) || new Date(),
    trail: Array.isArray(e.trail)
      ? e.trail.map(p => ({ ...p, timestamp: toDate(p.timestamp) })).filter(p => p.timestamp)
      : [],
  };
}

export async function fetchAggregated(signal) {
  const data = await fetchJson(aggregatorUrl(), { signal, timeout: 12000 });
  if (!data || data.v !== 1 || !Array.isArray(data.alerts) || !Array.isArray(data.events)) {
    throw new Error('Некоректний зріз агрегатора');
  }
  const receivedAt = toDate(data.receivedAt || data.serverTime) || new Date();
  return {
    alerts: data.alerts.map(adaptAlert).filter(a => a.timestamp || a.official),
    events: data.events.map(adaptEvent),
    rawEvents: data.events.map(adaptEvent),
    health: adaptHealth(data.health),
    disagreement: data.disagreement || { active: false, reason: '' },
    receivedAt,
    serverTime: toDate(data.serverTime),
  };
}
