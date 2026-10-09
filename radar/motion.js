// РАДАР.LIVE V5 — marker motion rules.
//
// Pure, side-effect free and fully unit-tested. The governing rule:
//
//   A marker may only be ANIMATED between two CONFIRMED fixes of the SAME
//   track. Interpolation is a DISPLAY technique for an update that already
//   happened — it is never a claim that the object passed through the
//   intermediate points, and it never produces a future position.
//
// Everything the renderer needs to decide "may this marker move?" lives here,
// so the rules can be verified without a browser.

import { haversineKm } from './geo.js';

// A transition needs time to have passed. Sub-threshold gaps are refresh
// jitter, not movement, and animating them would only produce flicker.
export const MIN_STEP_MS = 3_000;
// Beyond this the track has simply gone quiet: that is staleness, not travel.
export const MAX_STEP_MS = 20 * 60_000;
// Generous ceiling for implied ground speed (km/h). Faster than this between
// two consecutive fixes is treated as a coordinate discontinuity, not motion.
export const MAX_IMPLIED_KMH = 8_000;
// Presentational duration only — independent of how long the object really took.
export const MIN_TWEEN_MS = 420;
export const MAX_TWEEN_MS = 2_200;

/**
 * Strict numeric read. Rejects null, undefined and empty strings BEFORE the
 * conversion, because Number(null) and Number('') are both 0 — which would
 * turn "no data" into a real heading or a real coordinate.
 */
export function toFinite(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const okLatLon = (lat, lon) => lat !== null && lon !== null
  && Number.isFinite(lat) && Number.isFinite(lon)
  && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/**
 * Extract one confirmed fix from an event.
 * Returns null for anything that must never move: no id, area-only records
 * (no point at all), stale/ended tracks, missing coordinates, missing clock.
 */
export function makeFix(event) {
  if (!event) return null;
  const id = event.trackId ?? event.id ?? null;
  if (id == null) return null;
  if (event.areaOnly === true) return null;
  if (event.stale === true || event.status === 'ended') return null;
  const lat = toFinite(event.lat), lon = toFinite(event.lon);
  if (!okLatLon(lat, lon)) return null;
  const at = Date.parse(event.eventTime || event.timestamp || '');
  if (!Number.isFinite(at)) return null;
  const rawHeading = toFinite(event.heading);
  return {
    id: String(id), lat, lon, atMs: at, source: event.source ?? null,
    // Source-reported heading in degrees, or null when the source has none.
    heading: rawHeading === null ? null : ((rawHeading % 360) + 360) % 360,
  };
}

/**
 * Decide whether from -> to may be animated, and for how long.
 * Returns null when ANY precondition fails; the caller then snaps straight to
 * the confirmed position, which is the honest fallback.
 */
export function planTransition(from, to, { nowMs = Date.now() } = {}) {
  if (!from || !to) return null;
  if (from.id !== to.id) return null;
  if (!okLatLon(from.lat, from.lon) || !okLatLon(to.lat, to.lon)) return null;
  if (!Number.isFinite(from.atMs) || !Number.isFinite(to.atMs)) return null;

  const elapsedMs = to.atMs - from.atMs;
  if (!(elapsedMs >= MIN_STEP_MS)) return null;   // same fix or refresh jitter
  if (elapsedMs > MAX_STEP_MS) return null;       // quiet track, not travel

  const distanceKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
  if (!(distanceKm > 0.5)) return null;           // nothing worth animating

  // Coordinate-jump guard: a pair of consecutive fixes implying impossible
  // travel is a data discontinuity, not a real movement. Snap instead.
  const impliedKmh = distanceKm / (elapsedMs / 3_600_000);
  if (impliedKmh > MAX_IMPLIED_KMH) return null;

  const durationMs = Math.min(MAX_TWEEN_MS, Math.max(MIN_TWEEN_MS, (elapsedMs / 60_000) * 900));
  return { id: to.id, distanceKm, elapsedMs, durationMs, startedAtMs: nowMs };
}

/** Linear interpolation between two confirmed fixes at t in [0,1]. */
export function interpolateFix(from, to, t) {
  const k = Math.min(1, Math.max(0, Number(t) || 0));
  const a = toFinite(from.lat), b = toFinite(to.lat);
  const c = toFinite(from.lon), d = toFinite(to.lon);
  if (a === null || b === null || c === null || d === null) return { lat: a ?? b, lon: c ?? d };
  return { lat: a + (b - a) * k, lon: c + (d - c) * k };
}

/**
 * Shortest signed rotation between two headings in degrees.
 * 0 -> 90 gives +90, 0 -> 270 gives -90 (never a 270-degree spin).
 */
export function shortestTurnDeg(fromDeg, toDeg) {
  const a = toFinite(fromDeg), b = toFinite(toDeg);
  if (a === null || b === null) return 0;
  return ((((b - a) % 360) + 540) % 360) - 180;
}

/** Eased progress in [0,1]. Clamped at 1 so motion always comes to rest. */
export function tweenProgress(plan, nowMs) {
  if (!plan) return 1;
  const k = (nowMs - plan.startedAtMs) / plan.durationMs;
  if (k >= 1) return 1;
  if (k <= 0) return 0;
  const c = 1 - k;
  return 1 - c * c * c; // easeOutCubic
}

/**
 * The rotation a marker should use RIGHT NOW, given the source heading of the
 * previous fix and of the current one. `null` means "the source does not tell
 * us" and the renderer must keep a neutral, north-up orientation rather than
 * inventing one.
 */
export function headingFor(previousHeading, currentHeading, t) {
  // Strict: a missing heading must stay missing. Number(null) === 0 would
  // otherwise point every unsourced marker north.
  const cur = toFinite(currentHeading);
  if (cur === null) return null;
  const norm = (d) => ((d % 360) + 360) % 360;
  const prev = toFinite(previousHeading);
  if (prev === null || t >= 1) return norm(cur);
  const k = Math.min(1, Math.max(0, Number(t) || 0));
  return norm(prev) + shortestTurnDeg(prev, cur) * k;
}