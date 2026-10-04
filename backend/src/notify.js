// Pure push-targeting logic: categories, place matching, quiet hours,
// payloads, transition diff. No I/O, no web-push import — unit-testable.
export const PUSH_CATEGORIES = ['officialStart', 'officialEnd', 'uav', 'missile', 'ballistic', 'kab', 'aviation'];
// Bypass quiet hours no matter what: life-safety signals only.
export const CRITICAL = new Set(['officialStart', 'missile', 'ballistic']);

const CATEGORY_LABEL = {
  uav: 'БПЛА', missile: 'Ракета', ballistic: 'Балістика',
  kab: 'КАБ', aviation: 'Авіація',
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}
function stripOblast(s) {
  return norm(s).replace(/область|обл\.?|м\.|місто/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripRaion(s) {
  return norm(s).replace(/район|р-н|рн\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function stem(s) {
  return s.replace(/(ський|цький|зький|чий|ший|ій|ий|й)$/, '');
}

// Relevance of an event to one subscribed place.
// Mirrors frontend eventRelevance: finer data degrades gracefully.
export function relevanceForPush(event, place) {
  if (!place || !place.oblast) return 'UNKNOWN';
  const region = stripOblast(event.region || event.derivedRegion);
  if (!region || region !== stripOblast(place.oblast)) return 'OUTSIDE';
  if (place.settlement && event.settlement && norm(event.settlement) === norm(place.settlement)) {
    return 'DIRECT';
  }
  if (place.raion && event.district) {
    const a = stripRaion(event.district), b = stripRaion(place.raion);
    if (a === b || (stem(a) && stem(a) === stem(b))) return 'RAION';
    return 'OBLAST';
  }
  if (place.hromada && event.community) {
    return norm(event.community) === norm(place.hromada) ? 'DIRECT' : 'OBLAST';
  }
  return 'OBLAST';
}

export function placeMatches(event, place) {
  return relevanceForPush(event, place) !== 'OUTSIDE'
    && relevanceForPush(event, place) !== 'UNKNOWN';
}

// officialEnd is derived from ended alerts; everything else from active items.
export function categoryOf(event, isEnd = false) {
  if (event.official) return isEnd ? 'officialEnd' : 'officialStart';
  if (event.category === 'ballistic') return 'ballistic';
  if (['uav', 'missile', 'kab', 'aviation'].includes(event.category)) return event.category;
  return null;
}

export function quietActive(quiet, now = new Date()) {
  if (!quiet || quiet.enabled !== true) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const parse = (v) => {
    const [h, m] = String(v || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  };
  const start = parse(quiet.start), end = parse(quiet.end);
  if (start == null || end == null) return false;
  if (start === end) return true;
  return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

// Full gate for one (subscription, event) pair. Returns a reason string or null.
export function shouldDeliver(sub, event, category, opts = {}) {
  const cats = sub.categories || {};
  if (cats[category] === false) return 'skipped-category';
  const places = Array.isArray(sub.places) ? sub.places : [];
  const okPlace = places.length === 0 || places.some(p => placeMatches(event, p));
  if (!okPlace) return 'skipped-place';
  const firstSeen = opts.firstSeen || null;
  if (firstSeen && sub.created_at && new Date(firstSeen).getTime() < new Date(sub.created_at).getTime()) {
    return 'skipped-old';
  }
  if (quietActive(sub.quiet, opts.now) && !CRITICAL.has(category)) return 'skipped-quiet';
  return null;
}

export function buildPayload(kind, event) {
  const loc = event.district || event.settlement || event.region || 'ваш регіон';
  const url = './#skyView';
  if (kind === 'officialStart') {
    return { title: 'Повітряна тривога', body: loc, tag: `alert-start:${event.region || ''}:${event.district || ''}`, level: 'red', category: 'officialStart', url };
  }
  if (kind === 'officialEnd') {
    return { title: 'Відбій повітряної тривоги', body: loc, tag: `alert-end:${event.region || ''}:${event.district || ''}`, level: 'green', category: 'officialEnd', url };
  }
  const label = CATEGORY_LABEL[event.category] || 'Загроза';
  return { title: `${label} · ${loc}`, body: `Моніторингове повідомлення · ${event.source}`, tag: `threat:${event.id}`, level: 'yellow', category: event.category, url };
}

// New items since previous cycle (by id). A null/undefined previous set means
// first run after a wipe: prime silently, notify nothing.
export function diffStarted(prevIds, activeItems) {
  if (prevIds == null) return [];
  const prev = new Set(prevIds);
  return (activeItems || []).filter(e => !prev.has(e.id));
}

const MAX_PLACES = 10;
export function validateSubscribe(body) {
  const errors = [];
  const sub = body?.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) errors.push('bad endpoint');
  if (!sub?.keys?.p256dh || !sub?.keys?.auth) errors.push('bad keys');
  const places = Array.isArray(body?.places) ? body.places.slice(0, MAX_PLACES) : [];
  for (const p of places) {
    if (!p || typeof p.oblast !== 'string' || !p.oblast.trim()) { errors.push('bad place'); break; }
  }
  const categories = {};
  for (const c of PUSH_CATEGORIES) categories[c] = body?.categories?.[c] !== false;
  const quiet = body?.quiet && typeof body.quiet === 'object' ? {
    enabled: body.quiet.enabled === true,
    start: String(body.quiet.start || '23:00'),
    end: String(body.quiet.end || '07:00'),
  } : { enabled: false, start: '23:00', end: '07:00' };
  return {
    ok: errors.length === 0,
    errors,
    subscription: sub,
    places,
    categories,
    quiet,
    oblastNorm: places.length ? stripOblast(places[0].oblast) : '',
  };
}
