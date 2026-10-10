// Keep the persisted cycle state small enough to write every minute.
//
// Measured on the live aggregator while it was dying:
//   decoded bundle              759.1 KB
//   snapshot.events             63 items, 312.2 KB
//     -> `correlated`           227.1 KB (72.7%) — read by NOTHING downstream
//   prev.threats               121 items, 176.3 KB
//     -> `trail`                129.4 KB (73.4%)
//
// Past 500 KB the runtime started gzipping the whole bundle on every commit
// and every load, which on the 10 ms free-plan CPU budget is fatal on its own:
// the cron was killed every minute with "Exceeded CPU Limit" while the data
// looked fine. These helpers remove the two dominant costs so compression
// stays the emergency valve it was meant to be.
//
// Trails are the one cost that scales without bound with the number of live
// objects, so they also carry a byte budget: past it they are dropped whole
// rather than allowed to push the commit into compression. Dropping a trail
// costs a drawn track line for that target and nothing else — no event is
// removed, no id changes, so miss counting and the all-clear guarantee are
// untouched.
//
// Pure functions, no I/O, so the budget is directly testable.

export const TRAIL_MAX = 8;            // services/tracks.js renders at most 8
export const TRAIL_BUDGET_BYTES = 120_000;
export const SAFE_BUNDLE_BYTES = 500_000;
// Single source of truth for when compression becomes unavoidable. runtime-state
// imports this so the threshold cannot drift away from what the tests pin.
export const GZIP_TRIGGER_BYTES = 1_800_000;

const enc = new TextEncoder();
// fused() carries `correlated` because fuse() needs the member records while
// merging. After that it is dead weight: the UI reads the summary flags
// (crossSource / confirmed / similarSourceCount / fused), never the members.
const OMIT = new Set(['correlated']);

function slimRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const longTrail = Array.isArray(r.trail) && r.trail.length > TRAIL_MAX;
  const hasCorrelated = 'correlated' in r;
  // Fast path: most records change neither, and this runs over every event on
  // every commit, so an unconditional copy is real CPU for nothing.
  if (!longTrail && !hasCorrelated) return r;
  const out = {};
  for (const k of Object.keys(r)) if (!OMIT.has(k)) out[k] = r[k];
  if (longTrail) out.trail = r.trail.slice(-TRAIL_MAX);
  return out;
}
export { slimRecord };

/** Published event list: drop the dead `correlated` member records. */
export const slimEvents = (events) => (Array.isArray(events) ? events.map(slimRecord) : events);

function trailBytes(...lists) {
  let n = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const r of list) if (Array.isArray(r?.trail)) n += enc.encode(JSON.stringify(r.trail)).length;
  }
  return n;
}

/**
 * Applied to a completed cycle before it is committed or published.
 * `correlated` and long trails are merge/display-only; miss counting,
 * protection and correlation all still see the same ids, timestamps, sources
 * and positions.
 */
export function slimBundle(bundle, { trailBudget = TRAIL_BUDGET_BYTES } = {}) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const snap = bundle.snapshot;
  const slim = (list) => (Array.isArray(list) ? list.map(slimRecord) : list);
  const drop = (list) => (Array.isArray(list)
    ? list.map((r) => (r && typeof r === 'object' && Array.isArray(r.trail) ? { ...r, trail: [] } : r))
    : list);

  const events = slim(snap?.events);
  const alerts = slim(snap?.alerts);
  const prevAlerts = slim(bundle.prev?.alerts);
  const prevThreats = slim(bundle.prev?.threats);

  // Trails are measured directly rather than by serialising the whole bundle:
  // this runs on every commit, so it must not add a second full stringify.
  if (trailBytes(events, alerts, prevAlerts, prevThreats) > trailBudget) {
    const out = { ...bundle };
    if (snap) out.snapshot = { ...snap, events: drop(events), ...(snap.alerts ? { alerts: drop(alerts) } : {}) };
    if (bundle.prev) out.prev = { alerts: drop(prevAlerts), threats: drop(prevThreats) };
    return out;
  }
  const out = { ...bundle };
  if (snap) out.snapshot = { ...snap, events, ...(snap.alerts ? { alerts } : {}) };
  if (bundle.prev) out.prev = { alerts: prevAlerts, threats: prevThreats };
  return out;
}

/** Byte length of the JSON, matching what commitRuntime actually writes. */
export function bundleBytes(bundle) {
  return enc.encode(JSON.stringify(bundle)).length;
}
