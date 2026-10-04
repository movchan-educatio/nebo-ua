// Server-side dedupe + cross-source correlate + radius fuse.
// Mirrors services/correlation.js. Works on ISO-string records.
function t(e) {
  const d = new Date(e.eventTime);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}
function distanceKm(aLat, aLon, bLat, bLon) {
  const r = 6371, p = Math.PI / 180;
  const dLat = (bLat - aLat) * p, dLon = (bLon - aLon) * p;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}
function similar(a, b) {
  const ta = t(a), tb = t(b);
  if (!ta || !tb || Math.abs(ta - tb) > 15 * 60000) return false;
  if (a.region && b.region && a.region === b.region) return true;
  if (a.lat != null && b.lat != null) return distanceKm(a.lat, a.lon, b.lat, b.lon) <= 50;
  return false;
}

export function correlate(events) {
  const groups = [], used = new Set();
  for (const a of events) {
    if (used.has(a.id)) continue;
    const group = [a];
    used.add(a.id);
    for (const b of events) {
      if (used.has(b.id) || a.source === b.source || a.category !== b.category) continue;
      if (similar(a, b)) { group.push(b); used.add(b.id); }
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
export function fuse(events, radiusKm = 18) {
  const out = [], used = new Set();
  const sorted = [...events].sort((a, b) => t(b) - t(a));
  for (const a of sorted) {
    if (used.has(a.id)) continue;
    used.add(a.id);
    const members = [a];
    if (a.lat != null && a.lon != null) {
      for (const b of sorted) {
        if (used.has(b.id) || b.category !== a.category || b.lat == null || b.lon == null) continue;
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
