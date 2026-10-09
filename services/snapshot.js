// Preserve a newer committed view when a recovery checkpoint is older.
export function mergeSnapshot(previous, incoming) {
  const oldTime = Date.parse(previous?.publishedAt);
  const newTime = Date.parse(incoming?.publishedAt);
  if (Number.isFinite(oldTime) && Number.isFinite(newTime) && newTime < oldTime) {
    return { ...previous, degraded: true };
  }
  if (!incoming?.directFallback || !previous) return incoming;
  const offline = (source, alerts) => {
    const key = String(source || '').startsWith('NEPTUN') ? 'NEPTUN' : source;
    if (alerts && key === 'NEPTUN') return incoming.health?.NEPTUN?.alertsStatus === 'offline';
    return incoming.health?.[key]?.status === 'offline';
  };
  const keep = (old = [], fresh = [], alerts = false) => {
    const ids = new Set(fresh.map(x => x.id));
    return [...fresh, ...old.filter(x => offline(x.source, alerts) && !ids.has(x.id)).map(x => ({ ...x, stale: true }))];
  };
  const health = Object.fromEntries(Object.entries(incoming.health || {}).map(([key, current]) => {
    const lastSuccessAt = current.lastSuccessAt || current.updatedAt
      || previous.health?.[key]?.lastSuccessAt || previous.health?.[key]?.updatedAt || null;
    return [key, { ...current, lastSuccessAt, updatedAt: lastSuccessAt }];
  }));
  return { ...incoming, health, receivedAt: incoming.receivedAt || previous.receivedAt || null,
    alerts: keep(previous.alerts, incoming.alerts, true), events: keep(previous.events, incoming.events) };
}

