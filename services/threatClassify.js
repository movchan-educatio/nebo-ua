// Threat classification helpers for map rendering.
// No Node-only APIs – runs in browser and node:test.

/** TTL (minutes) per category after which the event is considered expired. */
export const TTL_MINUTES = {
  missile:   2,
  ballistic: 2,
  uav:       5,
  recon:     5,
  kab:       5,
  aviation:  5,
  other:    10,
};

/**
 * Accuracy tier of a threat event.
 * 'exact'  → source has real GPS coordinates (COORDINATE precision, !areaOnly, lat/lon valid).
 * 'area'   → source reports a settlement / raion / oblast area.
 * 'report' → unknown location or direction-only report.
 */
export function accuracyTier(event) {
  if (!event) return 'report';
  const { locationPrecision, areaOnly, lat, lon } = event;
  const hasCoord = lat != null && lon != null &&
    Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  if (locationPrecision === 'COORDINATE' && !areaOnly && hasCoord) return 'exact';
  if (locationPrecision === 'SETTLEMENT' ||
      locationPrecision === 'RAION' ||
      locationPrecision === 'OBLAST') return 'area';
  // areaOnly with any precision → area
  if (areaOnly) return 'area';
  return 'report';
}

/**
 * Detailed threat kind for icon selection.
 * Returns: 'shahed' | 'uav' | 'missile' | 'ballistic' | 'kab' | 'recon' | 'aviation' | 'other'
 */
export function classifyThreat(event) {
  if (!event) return 'other';
  if (event.kind === 'shahed') return 'shahed';
  const cat = event.category || 'other';
  // Map category values to display kinds (missile stays 'missile', not 'missile_cruise')
  const MAP = {
    uav:       'uav',
    recon:     'recon',
    missile:   'missile',
    ballistic: 'ballistic',
    kab:       'kab',
    aviation:  'aviation',
    other:     'other',
  };
  return MAP[cat] || 'other';
}

/** Age of event in minutes (null if no timestamp). */
export function ageMinutes(event, nowMs = Date.now()) {
  if (!event) return null;
  const ts = event.timestamp instanceof Date
    ? event.timestamp.getTime()
    : new Date(event.timestamp || 0).getTime();
  if (!Number.isFinite(ts) || ts === 0) return null;
  return (nowMs - ts) / 60000;
}

/** True if event is within its category TTL. */
export function isWithinTTL(event, nowMs = Date.now()) {
  const age = ageMinutes(event, nowMs);
  if (age == null) return false;
  const ttl = TTL_MINUTES[event?.category] ?? TTL_MINUTES.other;
  return age <= ttl;
}

/**
 * Freshness score 0.0–1.0.
 * 1.0 = just received; 0.0 = at TTL boundary or older.
 * Events with no timestamp return 0.
 */
export function freshnessScore(event, nowMs = Date.now()) {
  const age = ageMinutes(event, nowMs);
  if (age == null || age < 0) return 0;
  const ttl = TTL_MINUTES[event?.category] ?? TTL_MINUTES.other;
  if (ttl <= 0) return 0;
  return Math.max(0, 1 - age / ttl);
}

/**
 * Age class string for CSS: 'fresh' | 'recent' | 'aging' | 'old'
 * fresh  < 2 min
 * recent 2–5 min
 * aging  5–10 min
 * old    > 10 min or no timestamp
 */
export function ageClass(event, nowMs = Date.now()) {
  const age = ageMinutes(event, nowMs);
  if (age == null) return 'old';
  if (age < 2)  return 'fresh';
  if (age < 5)  return 'recent';
  if (age < 10) return 'aging';
  return 'old';
}

/**
 * Should a heading arrow be shown?
 * Only when ALL of:
 *  - locationPrecision === 'COORDINATE' (real position, not area)
 *  - !areaOnly
 *  - heading is a finite number
 *  - speed > 0
 *  - !stale
 */
export function shouldShowHeading(event) {
  if (!event) return false;
  if (event.areaOnly) return false;
  if (event.stale) return false;
  if (event.locationPrecision !== 'COORDINATE') return false;
  if (event.heading == null || event.speed == null) return false;
  const heading = Number(event.heading);
  const speed   = Number(event.speed);
  return Number.isFinite(heading) && Number.isFinite(speed) && speed > 0;
}
