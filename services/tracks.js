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
const MAX_HISTORY = 20;

function finiteNum(v) {
  if (v === null || v === undefined || v === '') return null;
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
        const track = { id, current: e, pos, posT: pos ? eventTimeMs(e) : null, history: [], updated: Date.now() };
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
        prev.posT = Number.isFinite(now) ? now : prev.posT;
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

// Trail selection for map rendering (pure): returns [{trackId,category,points}]
// for tracks that genuinely have ≥2 confirmed positions — MAPA source trail
// or accumulated session history. Fresh, visible tracks only; capped.
export function selectTrails(trackList, visible, { maxTracks = 40, maxPoints = 8 } = {}) {
  const out = [];
  for (const t of trackList || []) {
    if (out.length >= maxTracks) break;
    const cur = t?.current;
    if (!cur || cur.stale) continue;
    if (visible && cur.category && !visible.has(cur.category)) continue;
    let pts = null;
    if (Array.isArray(cur.trail) && cur.trail.length > 1) {
      pts = cleanTrail(cur.trail, { max: maxPoints });
    } else if (t.history?.length && t.pos) {
      pts = [...t.history.map(p => ({ lat: p.lat, lon: p.lon, t: p.t })), { lat: t.pos.lat, lon: t.pos.lon, t: t.posT }].slice(-maxPoints);
    }
    if (pts && pts.length > 1) out.push({ trackId: t.id, category: cur.category, points: pts });
  }
  return out;
}

// Debug Target Inspector payload (pure): everything a QA engineer needs for
// one track, computed only from confirmed source data. Shown in ?debug only.
export function inspectTrack(store, trackId, nowMs = Date.now()) {
  const t = store?.get(trackId);
  if (!t) return null;
  const e = t.current || {};
  const ageMs = (() => {
    const m = eventTimeMs(e);
    return m != null ? Math.max(0, nowMs - m) : null;
  })();
  const changeMs = t.posT != null ? Math.max(0, nowMs - t.posT) : null;
  return {
    trackId: t.id,
    source: e.source || null,
    ageS: ageMs != null ? Math.round(ageMs / 1000) : null,
    lat: t.pos?.lat ?? null,
    lon: t.pos?.lon ?? null,
    heading: Number.isFinite(Number(e.heading)) ? Number(e.heading) : null,
    speed: e.speed != null && Number.isFinite(Number(e.speed)) ? Number(e.speed) : null,
    points: (t.history?.length || 0) + (t.pos ? 1 : 0),
    lastChangeS: changeMs != null ? Math.round(changeMs / 1000) : null,
  };
}

// Movement-transition planner (pure, unit-tested): decides whether a visual
// glide between two CONFIRMED positions is allowed and how long it lasts.
// Returns { animate, from, to, durationMs }. This is UI ONLY — never a
// prediction: both endpoints are really received coordinates of the SAME
// stable trackId, and the marker stops at `to`.
export function moveDurationKm(distKm) {
  if (!Number.isFinite(distKm) || distKm <= 0) return 0;
  if (distKm < 2) return 800;
  if (distKm < 10) return 1200;
  return 1800;
}

export function planMove(prev, next) {
  const nope = { animate: false, from: null, to: null, durationMs: 0 };
  const pid = prev?.trackId ?? prev?.id ?? null;
  const nid = next?.trackId ?? next?.id ?? null;
  if (pid == null || nid == null || pid !== nid) return nope;
  if (!prev || !next || prev.stale || next.stale) return nope;
  if (next.areaOnly === true) return nope;
  const a = confirmedPos(prev);
  const b = confirmedPos(next);
  if (!a || !b) return nope;
  if (samePos(a, b)) return nope;
  const pt = eventTimeMs(prev);
  const nt = eventTimeMs(next);
  if (Number.isFinite(pt) && Number.isFinite(nt) && nt <= pt) return nope;
  return { animate: true, from: a, to: b, durationMs: moveDurationKm(haversineKm(a.lat, a.lon, b.lat, b.lon)) };
}
