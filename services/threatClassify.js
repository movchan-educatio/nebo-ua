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
 * Text-based threat kind detector from title, subtype, or sourceType.
 */
export function detectKind(parts) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  const s = list.join(' ');
  if (!s) return null;
  // Explicit FPV indication only — generic "дрон"/"БПЛА" is NEVER fpv.
  if (/fpv|фпв/i.test(s)) return 'fpv';
  // Explicit media explosion report only — never a generic "вибух" mention.
  if (list.some(p => /^(explosion|media_explosion_report)$/i.test(String(p).trim()))) return 'explosion';
  if (/повідомля(ють|є)\s+про\s+вибух|media[\s_-]*explosion/i.test(s)) return 'explosion';
  // Shahed/Geran - MUST be checked before generic uav
  if (/shahed|шахед|герань|geran|камикадзе/i.test(s)) return 'shahed';
  // Ballistic missiles
  if (/баліст|баллист|ballistic|кинжал|кинджал|іскандер-м|искандер-м|kn-23|кн-23|s-300|с-300|s-400|с-400/i.test(s)) return 'ballistic';
  // Cruise missiles
  if (/крилат|крылат|cruise|х-101|х-59|х-69|калібр|калибр|іскандер-к|искандер-к/i.test(s)) return 'missile';
  // Guided bombs (KAB)
  if (/каб|фаб|авіабомб|авиабомб|bomb|умпк/i.test(s)) return 'kab';
  // Reconnaissance UAVs
  if (/розвід|развед|recon|орлан|supercam|zala|зала|форпост/i.test(s)) return 'recon';
  // Manned aviation
  if (/авіаці|авиаци|міг|миг|mig|су-34|су-35|су-57|ту-22|ту-95|ту-160/i.test(s)) return 'aviation';
  return null;
}

/**
 * Accuracy tier of a threat event.
 * 'exact'  → source has real GPS coordinates (COORDINATE precision, !areaOnly, high position quality).
 * 'area'   → source reports a settlement / raion / oblast area or low position quality.
 * 'report' → unknown location or direction-only report.
 */
export function accuracyTier(event) {
  if (!event) return 'report';
  const { locationPrecision, areaOnly, lat, lon, positionQuality, uncertaintyKm } = event;
  
  if (areaOnly) return 'area';
  
  const lowQuality = positionQuality === 'area' || positionQuality === 'raion' ||
    positionQuality === 'district' || positionQuality === 'region';
  if (lowQuality) return 'area';

  if (uncertaintyKm != null && Number(uncertaintyKm) >= 20) return 'area';

  const hasCoord = lat != null && lon != null &&
    Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  
  if (locationPrecision === 'COORDINATE' && hasCoord) return 'exact';
  if (locationPrecision === 'SETTLEMENT' ||
      locationPrecision === 'RAION' ||
      locationPrecision === 'OBLAST') return 'area';
  return 'report';
}

/**
 * Detailed threat kind for icon selection.
 * Returns: 'shahed' | 'uav' | 'fpv' | 'missile' | 'ballistic' | 'kab' | 'recon' | 'aviation' | 'explosion' | 'other'
 */
export function classifyThreat(event) {
  if (!event) return 'other';
  if (event.kind === 'shahed') return 'shahed';
  if (event.kind && event.kind !== 'other' && event.kind !== 'unknown') {
    const MAP_KIND = {
      shahed: 'shahed', uav: 'uav', fpv: 'fpv', recon: 'recon',
      missile: 'missile', ballistic: 'ballistic', kab: 'kab',
      aviation: 'aviation', explosion: 'explosion', other: 'other',
    };
    if (MAP_KIND[event.kind]) return MAP_KIND[event.kind];
  }

  // Parse text fields (subtype, title, sourceType, rawExplanation, category)
  const detected = detectKind([
    event.kind, event.subtype, event.sourceType, event.title, event.rawExplanation,
  ]);
  if (detected) return detected;

  const cat = event.category || 'other';
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
 * Should the glyph be rotated to a real heading?
 * Heading is a CONFIRMED direction reported by the source; speed is NOT
 * required for orientation (many sources give course without speed — the
 * old speed>0 gate left every icon pointing north). Requirements:
 *  - real coordinate (not area-only)
 *  - !stale
 *  - finite heading from the source
 */
export function shouldShowHeading(event) {
  if (!event) return false;
  if (event.areaOnly) return false;
  if (event.stale) return false;
  if (event.locationPrecision !== 'COORDINATE' && event.lat == null) return false;
  if (event.heading == null) return false;
  const heading = Number(event.heading);
  return Number.isFinite(heading);
}
