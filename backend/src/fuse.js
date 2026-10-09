// Server-side dedupe + cross-source correlate + radius fuse.
// Mirrors services/correlation.js. Works on ISO-string records.
//
// CPU budget note (Workers free plan = 10 ms/invocation): the naive
// O(n²) scans (plus per-comparison `new Date(...)` parsing inside the sort
// and similarity checks) exceeded the limit during mass attacks (500+
// active objects) and killed the cron. The current implementation keeps the
// EXACT same output while:
//   • parsing each eventTime once per run via Date.parse (cached ms),
//   • scanning only same-category items (correlate) via per-source buckets,
//   • scanning only same-category neighbours in a 0.5° spatial grid (fuse),
//   • sorting once with cached timestamps (no Date parsing in comparators).
function msOf(e) {
  const t = Date.parse(e.eventTime);
  return Number.isFinite(t) ? t : 0;
}
function distanceKm(aLat, aLon, bLat, bLon) {
  const r = 6371, p = Math.PI / 180;
  const dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}
function similar(a, ta, b, tb) {
  if (!ta || !tb || Math.abs(ta - tb) > 15 * 60000) return false;
  if (a.region && b.region && a.region === b.region) return true;
  if (a.lat != null && b.lat != null) return distanceKm(a.lat, a.lon, b.lat, b.lon) <= 50;
  return false;
}

export function correlate(events) {
  const n = events.length;
  const tms = new Array(n);
  // category → source → ascending indices (different sources only can pair)
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const e = events[i];
    tms[i] = msOf(e);
    const k = e.category + '\u0000' + e.source;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }
  const used = new Set();
  const groups = [];
  for (let i = 0; i < n; i++) {
    const a = events[i];
    if (used.has(a.id)) continue;
    used.add(a.id);
    const group = [a];
    // Collect cross-source, same-category candidates and process them in the
    // original array order so member order stays byte-identical.
    const cand = [];
    for (const [k, arr] of buckets) {
      const sep = k.indexOf('\u0000');
      if (k.slice(0, sep) !== a.category || k.slice(sep + 1) === a.source) continue;
      for (const j of arr) if (j !== i && !used.has(events[j].id)) cand.push(j);
    }
    cand.sort((x, y) => x - y);
    for (const j of cand) {
      const b = events[j];
      if (used.has(b.id)) continue;
      if (similar(a, tms[i], b, tms[j])) { group.push(b); used.add(b.id); }
    }
    groups.push({
      ...a,
      correlated: group,
      crossSource: group.length >= 2,
      confirmed: group.length >= 2,
      similarSourceCount: new Set(group.map(x => x.source)).size,
    });
  }
  return groups;
}

// Merge same-category contacts within radiusKm (any source).
// Anchor = freshest record, so position/heading stay current.
const FUSE_CELL = 0.5; // degrees ≈ 55 km (lat) × 35 km (lon at 50°N) > radius
export function fuse(events, radiusKm = 18) {
  // Decorate-sort: parse each timestamp once, never inside the comparator.
  const sorted = events.map(e => ({ e, t: msOf(e) })).sort((a, b) => b.t - a.t).map(d => d.e);
  const used = new Set();
  const grid = new Map();
  const key = (lat, lon) => Math.floor(lat / FUSE_CELL) + ':' + Math.floor(lon / FUSE_CELL);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.lat == null || e.lon == null) continue;
    const k = key(e.lat, e.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (used.has(a.id)) continue;
    used.add(a.id);
    const members = [a];
    if (a.lat != null && a.lon != null) {
      const gy = Math.floor(a.lat / FUSE_CELL), gx = Math.floor(a.lon / FUSE_CELL);
      const cand = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const arr = grid.get((gy + dy) + ':' + (gx + dx));
          if (!arr) continue;
          // Entries before i are always already used (anchors or merged), so
          // only later indices can still join — same membership as the old scan.
          for (const j of arr) if (j > i) cand.push(j);
        }
      }
      cand.sort((x, y) => x - y);
      for (const j of cand) {
        const b = sorted[j];
        if (used.has(b.id) || b.category !== a.category) continue;
        if (distanceKm(a.lat, a.lon, b.lat, b.lon) <= radiusKm) {
          used.add(b.id);
          members.push(b);
        }
      }
    }
    const corr = [...new Map(members.flatMap(m => m.correlated || [m]).map(x => [x.id, x])).values()];
    out.push({
      ...a,
      correlated: corr,
      fused: members.map(m => m.id),
      fusedCount: members.length,
      crossSource: corr.length >= 2 || new Set(members.map(x => x.source)).size > 1,
      confirmed: corr.length >= 2,
      similarSourceCount: new Set(corr.map(x => x.source)).size,
    });
  }
  return out;
}

export function detectDisagreement(events, health) {
  const n = events.filter(e => e.source === 'NEPTUN');
  const m = events.filter(e => e.source === 'MAPA');
  if (health?.NEPTUN?.status !== 'online' || health?.MAPA?.status !== 'online') {
    return { active: false, reason: 'Порівняння неповне: одне з джерел недоступне.' };
  }
  const cats = new Set([...n, ...m].map(e => e.category));
  const differing = [...cats].filter(c => n.some(e => e.category === c) !== m.some(e => e.category === c));
  return {
    active: differing.length > 0,
    categories: differing,
    reason: differing.length
      ? 'Джерела мають різне покриття або різні активні повідомлення. Відсутність у одному джерелі не спростовує інше.'
      : 'Підключені моніторингові джерела мають узгоджені категорії у поточному зрізі.',
  };
}
