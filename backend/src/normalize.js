// Server-side normalization. Mirrors services/normalize.js semantics,
// but outputs JSON-serializable records with eventTime/receivedAt/latencyMs.
const TYPE_MAP = {
  uav: 'uav', recon: 'recon', missile: 'missile', ballistic: 'ballistic',
  kab: 'kab', mig31k: 'aviation', unknown: 'other',
  drone_piston: 'uav', drone_jet: 'uav', drone_fpv: 'uav',
  missile_cruise: 'missile', missile_ballistic: 'ballistic', bomb: 'kab',
};
const FRESH_MIN = { missile: 2, ballistic: 2, uav: 5, recon: 5, kab: 5, aviation: 5, other: 5 };

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function date(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}
function unix(v) {
  return v == null || v === '' ? null : date(Number(v) * 1000);
}
function validCoord(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= 43 && lat <= 53 && lon >= 20 && lon <= 42;
}
function latencyMs(eventTime, receivedAt) {
  if (!eventTime || !receivedAt) return null;
  const ms = receivedAt.getTime() - eventTime.getTime();
  return ms >= 0 && ms < 24 * 3600000 ? Math.round(ms) : null;
}
function iso(d) {
  return d ? d.toISOString() : null;
}
function base(part, receivedAt) {
  const eventTime = part.timestamp;
  return {
    ...part,
    timestamp: undefined,
    eventTime: iso(eventTime),
    receivedAt: iso(receivedAt),
    latencyMs: latencyMs(eventTime, receivedAt),
  };
}

export function normalizeNeptunThreat(raw, receivedAt = new Date()) {
  if (!raw || raw.id == null) return null;
  const lat = num(raw.lat), lon = num(raw.lon);
  const areaOnly = raw.areaOnly === true;
  const okPoint = validCoord(lat, lon) && !areaOnly;
  const ts = date(raw.updatedAt);
  return base({
    id: `neptun:${raw.id}`,
    source: 'NEPTUN',
    sourceEventId: String(raw.id),
    sourceType: raw.type ?? null,
    official: false,
    category: TYPE_MAP[raw.type] || 'other',
    subtype: raw.title ?? null,
    lat: okPoint ? lat : null,
    lon: okPoint ? lon : null,
    region: raw.region || null,
    district: raw.district || null,
    settlement: raw.locality || null,
    locationPrecision: okPoint ? 'COORDINATE' : raw.locality ? 'SETTLEMENT' : raw.district ? 'RAION' : raw.region ? 'OBLAST' : 'UNKNOWN',
    heading: num(raw.heading),
    direction: null,
    speed: num(raw.velocity?.speedKmh),
    destination: null,
    timestamp: ts,
    confidence: raw.confidenceLevel || raw.displayConfidence || null,
    positionQuality: raw.positionQuality || null,
    uncertaintyKm: num(raw.uncertaintyKm),
    sourceCount: num(raw.sourceCount),
    areaOnly,
    advisory: raw.advisory === true,
    status: raw.status || 'active',
    stale: raw.status === 'stale',
    trail: [],
    sourceUrl: 'https://neptun.in.ua/',
    rawExplanation: raw.explanationShort || null,
  }, receivedAt);
}

const ACTIVE_MAPA = new Set(['active']);
export function normalizeMapa(raw, receivedAt = new Date()) {
  if (raw?.id == null || !ACTIVE_MAPA.has(raw.status)) return null;
  const lat = num(raw.lat), lon = num(raw.lon);
  if (!validCoord(lat, lon)) return null;
  const ts = unix(raw.last_seen || raw.first_seen);
  const trail = Array.isArray(raw.trail)
    ? raw.trail.slice(-20).map(p => ({ lon: num(p[0]), lat: num(p[1]), timestamp: unix(p[2]) && unix(p[2]).toISOString() })).filter(p => validCoord(p.lat, p.lon) && p.timestamp)
    : [];
  return base({
    id: `mapa:${raw.id}`,
    source: 'MAPA',
    sourceEventId: String(raw.id),
    sourceType: raw.kind ?? null,
    official: false,
    category: TYPE_MAP[raw.kind] || 'other',
    subtype: raw.title || raw.subkind || null,
    lat, lon,
    region: null, district: null, settlement: null,
    locationPrecision: 'COORDINATE',
    heading: num(raw.heading),
    direction: null,
    speed: num(raw.speed_kmh),
    destination: raw.to_city || null,
    timestamp: ts,
    confidence: null,
    positionQuality: 'source-position',
    uncertaintyKm: null,
    sourceCount: null,
    areaOnly: false,
    advisory: false,
    status: 'active',
    stale: false,
    trail,
    sourceUrl: 'https://mapa.ua/',
    rawExplanation: raw.title || null,
  }, receivedAt);
}

// Generic official alert shape (works for NEPTUN alerts and a token API
// returning [{oblast|region, district?, since, level?, reasons?[]}]).
export function normalizeAlert(raw, receivedAt = new Date(), source = 'NEPTUN') {
  if (!raw || (!raw.name && !raw.region && !raw.oblast)) return null;
  const name = raw.name || raw.region || raw.oblast;
  const oblast = raw.oblast || null;
  return base({
    id: `official:${raw.key || name}`,
    source: source === 'OFFICIAL' ? 'OFFICIAL' : 'NEPTUN / офіційні канали',
    sourceEventId: String(raw.key || name),
    sourceType: 'air_raid',
    official: true,
    category: 'alert',
    subtype: (Array.isArray(raw.reasons) && raw.reasons[0]) || 'Повітряна тривога',
    lat: null, lon: null,
    region: oblast || name,
    district: oblast ? name : null,
    settlement: null,
    locationPrecision: oblast ? 'RAION' : 'OBLAST',
    heading: null, direction: null, speed: null, destination: null,
    timestamp: date(raw.since),
    confidence: null,
    positionQuality: 'area',
    uncertaintyKm: null,
    sourceCount: null,
    areaOnly: true,
    advisory: false,
    status: 'active',
    stale: false,
    trail: [],
    sourceUrl: source === 'OFFICIAL' ? null : 'https://neptun.in.ua/',
    level: raw.level || null,
    key: raw.key || null,
  }, receivedAt);
}

export function freshnessMinutes(category) {
  return FRESH_MIN[category] ?? 10;
}

export function isFreshEvent(category, eventTime, nowMs = Date.now()) {
  if (!eventTime) return false;
  const t = new Date(eventTime).getTime();
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= freshnessMinutes(category) * 60000;
}
