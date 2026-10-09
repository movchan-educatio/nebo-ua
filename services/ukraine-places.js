// Verified local place directory for the radar centre.
//
// Why this exists: the radar must never depend on an external geocoder.
// Nominatim (OpenStreetMap) rate-limits, is blocked by some networks and can
// simply be unreachable — which used to leave the scope with no centre at all.
// Every coordinate below is a published reference coordinate, and every entry
// is verified offline against the oblast polygons shipped in this repo
// (assets/data/ukraine-oblasts.geojson) by tests/locations.test.js, so a wrong
// oblast pairing cannot ship unnoticed.
//
// Nominatim is still used, but only as an OPTIONAL enrichment for free-text
// search of places that are not in this table. It is never required for the
// default centre, for popular cities or for oblast centres.

/** @type {{settlement:string,lat:number,lon:number,oblast:string,kind:'capital'|'city'}[]} */
export const LOCAL_PLACES = [
  // ── Обласні центри ──
  { settlement: 'Київ',           lat: 50.4501, lon: 30.5234, oblast: 'м. Київ', kind: 'capital' },
  { settlement: 'Вінниця',        lat: 49.2331, lon: 28.4682, oblast: 'Вінницька область', kind: 'capital' },
  { settlement: 'Луцьк',          lat: 50.9077, lon: 25.3350, oblast: 'Волинська область', kind: 'capital' },
  { settlement: 'Дніпро',         lat: 48.4647, lon: 35.0462, oblast: 'Дніпропетровська область', kind: 'capital' },
  { settlement: 'Донецьк',        lat: 48.0159, lon: 37.8028, oblast: 'Донецька область', kind: 'capital' },
  { settlement: 'Житомир',        lat: 50.2547, lon: 28.6586, oblast: 'Житомирська область', kind: 'capital' },
  { settlement: 'Ужгород',        lat: 48.6208, lon: 22.2880, oblast: 'Закарпатська область', kind: 'capital' },
  { settlement: 'Запоріжжя',      lat: 47.8388, lon: 35.1396, oblast: 'Запорізька область', kind: 'capital' },
  { settlement: 'Івано-Франківськ', lat: 48.9226, lon: 24.7111, oblast: 'Івано-Франківська область', kind: 'capital' },
  { settlement: 'Кропивницький',  lat: 48.5080, lon: 32.0753, oblast: 'Кіровоградська область', kind: 'capital' },
  { settlement: 'Луганськ',       lat: 48.9228, lon: 39.2671, oblast: 'Луганська область', kind: 'capital' },
  { settlement: 'Львів',          lat: 49.8397, lon: 24.0297, oblast: 'Львівська область', kind: 'capital' },
  { settlement: 'Миколаїв',       lat: 46.9750, lon: 31.9946, oblast: 'Миколаївська область', kind: 'capital' },
  { settlement: 'Одеса',          lat: 46.4825, lon: 30.7233, oblast: 'Одеська область', kind: 'capital' },
  { settlement: 'Полтава',        lat: 49.5967, lon: 34.5714, oblast: 'Полтавська область', kind: 'capital' },
  { settlement: 'Рівне',          lat: 50.6199, lon: 26.2527, oblast: 'Рівненська область', kind: 'capital' },
  { settlement: 'Суми',           lat: 50.9077, lon: 34.7981, oblast: 'Сумська область', kind: 'capital' },
  { settlement: 'Тернопіль',      lat: 49.5535, lon: 25.5948, oblast: 'Тернопільська область', kind: 'capital' },
  { settlement: 'Харків',         lat: 49.9935, lon: 36.2304, oblast: 'Харківська область', kind: 'capital' },
  { settlement: 'Херсон',         lat: 46.6354, lon: 32.6163, oblast: 'Херсонська область', kind: 'capital' },
  { settlement: 'Хмельницький',   lat: 49.2832, lon: 27.0382, oblast: 'Хмельницька область', kind: 'capital' },
  { settlement: 'Черкаси',        lat: 49.3807, lon: 32.0409, oblast: 'Черкаська область', kind: 'capital' },
  { settlement: 'Чернівці',       lat: 48.2921, lon: 25.9615, oblast: 'Чернівецька область', kind: 'capital' },
  { settlement: 'Чернігів',       lat: 51.4982, lon: 31.2893, oblast: 'Чернігівська область', kind: 'capital' },
  { settlement: 'Сімферополь',    lat: 44.9521, lon: 34.1000, oblast: 'Автономна Республіка Крим', kind: 'capital' },
  { settlement: 'Севастополь',    lat: 44.6166, lon: 33.5254, oblast: 'Севастополь', kind: 'capital' },

  // ── Міста-мільйонники та великі центри ──
  { settlement: 'Кривий Ріг',    lat: 47.9077, lon: 33.3600, oblast: 'Дніпропетровська область', kind: 'city' },
  { settlement: 'Маріуполь',      lat: 47.1167, lon: 37.8667, oblast: 'Донецька область', kind: 'city' },
  { settlement: 'Біла Церква',    lat: 49.8034, lon: 30.1120, oblast: 'Київська область', kind: 'city' },
  { settlement: 'Бровари',        lat: 50.0878, lon: 30.7097, oblast: 'Київська область', kind: 'city' },
  { settlement: 'Кам’янець-Подільський', lat: 48.9530, lon: 26.4560, oblast: 'Хмельницька область', kind: 'city' },
  { settlement: 'Мелітополь',     lat: 47.0664, lon: 35.4333, oblast: 'Запорізька область', kind: 'city' },
  { settlement: 'Кременчук',      lat: 49.0637, lon: 33.4238, oblast: 'Полтавська область', kind: 'city' },
];

const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[’'`ʼ]/g, "'")
  .replace(/^(м\.|мi\.|мi|м\.)\s*/i, '')
  .trim();

/** Shape-compatible with services/locations.js normalizePlace() output. */
function toPlace(p) {
  return {
    id: `local:${p.settlement}`,
    settlement: p.settlement,
    community: null,
    raion: null,
    oblast: p.oblast,
    country: 'Україна',
    lat: p.lat,
    lon: p.lon,
    label: `${p.settlement} · ${p.oblast}`,
    bbox: null,
    source: 'Локальний довідник',
  };
}

/**
 * Offline lookup. Matches a settlement name, or an oblast name
 * ("Вінницька", "Вінницька область") returning its administrative centre.
 * Returns null when nothing matches — callers may then fall back to the
 * network geocoder, but nothing here ever requires it.
 */
export function findLocalPlace(query) {
  const q = norm(query);
  if (q.length < 2) return null;
  // 1) exact settlement (also accepts the Latin apostrophe variant)
  const byName = LOCAL_PLACES.find((p) => norm(p.settlement) === q);
  if (byName) return toPlace(byName);
  // 2) oblast -> its centre ("Харківська область" -> Харків)
  const byOblast = LOCAL_PLACES.find((p) => {
    const o = norm(p.oblast).replace(/\s+(область|обл\.?)$/i, '');
    return o && (o === q || o === q.replace(/\s+(область|обл\.?)$/i, ''));
  });
  if (byOblast) return toPlace(byOblast);
  // 3) unambiguous prefix on the settlement name
  const pref = LOCAL_PLACES.filter((p) => norm(p.settlement).startsWith(q));
  return pref.length ? toPlace(pref[0]) : null;
}

/** Offline prefix search returning a ranked list (caps first). */
export function searchLocalPlaces(query, limit = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  const scored = [];
  for (const p of LOCAL_PLACES) {
    const s = norm(p.settlement);
    let score = -1;
    if (s === q) score = 0;
    else if (s.startsWith(q)) score = 1;
    else if (s.includes(q)) score = 2;
    else if (norm(p.oblast).replace(/\s+область$/i, '').startsWith(q)) score = 3;
    if (score >= 0) scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.p.kind === 'capital' ? -1 : 1));
  return scored.slice(0, limit).map((x) => toPlace(x.p));
}

/** True when the query can be answered without any network call. */
export function isLocallyResolvable(query) {
  return findLocalPlace(query) !== null;
}