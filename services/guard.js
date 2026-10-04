export function selectProximityAlerts(events, seen, nowMs, radiusKm = 10, repeatMs = 120000) {
  const hits = (events || []).filter(e => e && !e.stale && e._distKm != null && e._distKm <= radiusKm);
  const fresh = hits.filter(h => {
    const last = seen instanceof Map ? seen.get(h.id) : null;
    return last == null || nowMs - last > repeatMs;
  });
  return { hits, fresh };
}
// Events carry _distKm / _closing / _etaMin from annotateDistances().
export function selectGuardTargets(events, radiusKm) {
  if (!(radiusKm > 0)) return [];
  return (events || [])
    .filter(e => e && e._distKm != null && e._distKm <= radiusKm)
    .map(e => ({ e, distKm: e._distKm, closing: e._closing === true, etaMin: e._etaMin }))
    .sort((a, b) => (a.etaMin ?? 1e12) - (b.etaMin ?? 1e12) || a.distKm - b.distKm);
}
