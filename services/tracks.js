// TargetStore: persistent live target tracks for Небо.UA.
//
// One trackId (source + ':' + source id, e.g. 'neptun:123') = one live object.
// Map, Radar and the threat list all read the SAME track objects — there are
// no independent copies. Positions only ever move FORWARD in source time:
// an older event can never overwrite a newer confirmed position.
//
// What is real source data here: track identity (source-stable ids),
// coordinates, timestamps, heading/speed (only when the source sent them),
// MAPA trail points. What is UI-only: the short CSS transition between two
// confirmed positions. No extrapolation, no invented points, ever.
const MAX_HISTORY = 8;

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function eventTimeMs(e) {
  if (!e) return null;
  const t = e.timestamp ?? e.eventTime ?? null;
  if (t == null) return null;
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function confirmedPos(e) {
  if (!e || e.areaOnly === true) return null;
  const lat = finiteNum(e.lat), lon = finiteNum(e.lon);
  if (lat == null || lon == null) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

function samePos(a, b) {
  return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p, dLon = (lon2 - lon1) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function createStore() {
  const tracks = new Map();
  const listeners = new Set();
  function notify(change) {
    for (const fn of listeners) {
      try { fn(change); } catch (e) {}
    }
  }
  return {
    upsert(e) {
      const id = e?.trackId ?? e?.id ?? null;
      if (id == null) return { type: 'ignored' };
      const now = eventTimeMs(e);
      const prev = tracks.get(id);
      if (!prev) {
        const pos = confirmedPos(e);
        const track = { id, current: e, pos, history: [], updated: Date.now() };
        tracks.set(id, track);
        notify({ type: 'added', id, track });
        return { type: 'added', track };
      }
      const was = eventTimeMs(prev.current);
      // Out-of-order protection: an older confirmed event must never move
      // the marker back. Same-timestamp duplicates are also ignored.
      if (Number.isFinite(now) && Number.isFinite(was) && now <= was) {
        return { type: 'ignored-order', track: prev };
      }
      const nextPos = confirmedPos(e);
      let moved = false;
      if (nextPos && !samePos(prev.pos, nextPos)) {
        if (!Number.isFinite(now) && Number.isFinite(was)) {
          // A timestamp-less update cannot be ordered against a timestamped
          // confirmed position: refresh metadata, never move the marker.
          prev.current = e;
          prev.updated = Date.now();
          notify({ type: 'updated', id, track: prev });
          return { type: 'updated', track: prev, moved: false };
        }
        // Only real received positions enter history — never interpolated.
        if (prev.pos) {
          prev.history = [...prev.history, { ...prev.pos, t: was }].slice(-MAX_HISTORY);
        }
        prev.pos = nextPos;
        moved = true;
      }
      prev.current = e;
      prev.updated = Date.now();
      notify({ type: moved ? 'updated-moved' : 'updated', id, track: prev });
      return { type: moved ? 'updated-moved' : 'updated', track: prev, moved };
    },
    remove(id) {
      const had = tracks.delete(id);
      if (had) notify({ type: 'removed', id });
      return had;
    },
    get(id) {
      return tracks.get(id) || null;
    },
    getAll() {
      return [...tracks.values()];
    },
    getWithinRadius(lat, lon, radiusKm) {
      const out = [];
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusKm > 0)) return out;
      for (const track of tracks.values()) {
        if (!track.pos) continue;
        const d = haversineKm(lat, lon, track.pos.lat, track.pos.lon);
        if (d <= radiusKm) out.push({ track, distKm: d });
      }
      out.sort((a, b) => a.distKm - b.distKm);
      return out;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    clear() {
      tracks.clear();
    },
    get size() {
      return tracks.size;
    },
  };
}

// Reconcile the store with a fresh fused snapshot. null/undefined input
// (failed poll, e.g. HTTP 503) keeps the previous state untouched.
export function syncStore(store, events) {
  const res = { added: 0, updated: 0, moved: 0, removed: 0, kept: false };
  if (!events) {
    res.kept = true;
    return res;
  }
  const seen = new Set();
  for (const e of events) {
    const id = e?.trackId ?? e?.id ?? null;
    if (id == null) continue;
    seen.add(id);
    const r = store.upsert(e);
    if (r.type === 'added') res.added++;
    else if (r.type === 'updated-moved') { res.updated++; res.moved++; }
    else if (r.type === 'updated') res.updated++;
  }
  for (const t of store.getAll()) {
    if (!seen.has(t.id)) {
      store.remove(t.id);
      res.removed++;
    }
  }
  return res;
}

// Validate + normalize a MAPA-style source trail for display (selected target
// only). Accepts {lat,lon,timestamp?} objects or [lon,lat,ts?] arrays.
// Sorts old→new by timestamp WITHOUT assuming input order, drops invalid
// points ([0,0], out-of-bounds, NaN), dedupes repeats, keeps the last `max`.
export function cleanTrail(points, { max = 8 } = {}) {
  const norm = [];
  for (const p of points || []) {
    let lat = null, lon = null, t = null;
    if (Array.isArray(p)) {
      lon = finiteNum(p[0]); lat = finiteNum(p[1]);
      const ts = p[2];
      t = ts == null ? null : (ts instanceof Date ? ts.getTime() : new Date(Number(ts) * (String(ts).length <= 10 ? 1000 : 1)).getTime());
      if (!Number.isFinite(t)) t = null;
    } else if (p && typeof p === 'object') {
      lat = finiteNum(p.lat); lon = finiteNum(p.lon ?? p.lng);
      const ts = p.timestamp ?? p.time ?? p.ts ?? null;
      t = ts == null ? null : (ts instanceof Date ? ts.getTime() : new Date(ts).getTime());
      if (!Number.isFinite(t)) t = null;
    }
    if (lat == null || lon == null) continue;
    if (lat === 0 && lon === 0) continue;
    if (lat < 43 || lat > 53 || lon < 20 || lon > 42) continue;
    norm.push({ lat, lon, t });
  }
  const withT = norm.filter(p => p.t != null).sort((a, b) => a.t - b.t);
  const noT = norm.filter(p => p.t == null);
  const ordered = [...withT, ...noT];
  const deduped = [];
  for (const p of ordered) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-5 && Math.abs(last.lon - p.lon) < 1e-5) continue;
    deduped.push(p);
  }
  return deduped.slice(-Math.max(1, max));
}

// Selection helper: returns the CURRENT event object for a selected track,
// so Map/Radar/popup all render the same live data after refresh.
export function resolveSelection(store, trackId) {
  if (!store || trackId == null) return null;
  return store.get(trackId)?.current || null;
}
