// Guard (geofence watch): pure selection over already-annotated events.
// Events carry _distKm / _closing / _etaMin from annotateDistances().
export function selectGuardTargets(events, radiusKm) {
  if (!(radiusKm > 0)) return [];
  return (events || [])
    .filter(e => e && e._distKm != null && e._distKm <= radiusKm)
    .map(e => ({ e, distKm: e._distKm, closing: e._closing === true, etaMin: e._etaMin }))
    .sort((a, b) => (a.etaMin ?? 1e12) - (b.etaMin ?? 1e12) || a.distKm - b.distKm);
}
