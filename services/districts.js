// Raion (district) breakdown: static directory (2020 reform, 2024 names) +
// fuzzy matching of source names. Pure functions, no network.
import { classifyThreat } from './threatClassify.js';
const RAIONS = {
  'Вінницька область': ['Вінницький', 'Гайсинський', 'Жмеринський', 'Могилів-Подільський', 'Тульчинський', 'Хмільницький'],
  'Волинська область': ['Володимирський', 'Камінь-Каширський', 'Ковельський', 'Луцький'],
  'Дніпропетровська область': ['Дніпровський', "Кам'янський", 'Криворізький', 'Нікопольський', 'Павлоградський', 'Самарівський', 'Синельниківський'],
  'Донецька область': ['Бахмутський', 'Волноваський', 'Горлівський', 'Донецький', 'Кальміуський', 'Краматорський', 'Маріупольський', 'Покровський'],
  'Житомирська область': ['Бердичівський', 'Житомирський', 'Звягельський', 'Коростенський'],
  'Закарпатська область': ['Берегівський', 'Мукачівський', 'Рахівський', 'Тячівський', 'Ужгородський', 'Хустський'],
  'Запорізька область': ['Бердянський', 'Василівський', 'Запорізький', 'Мелітопольський', 'Пологівський'],
  'Івано-Франківська область': ['Верховинський', 'Івано-Франківський', 'Калуський', 'Коломийський', 'Косівський', 'Надвірнянський'],
  'Київська область': ['Білоцерківський', 'Бориспільський', 'Броварський', 'Бучанський', 'Вишгородський', 'Обухівський', 'Фастівський'],
  'Кіровоградська область': ['Голованівський', 'Кропивницький', 'Новоукраїнський', 'Олександрійський'],
  'Луганська область': ['Алчевський', 'Довжанський', 'Луганський', 'Ровеньківський', 'Сватівський', 'Сєвєродонецький', 'Старобільський', 'Щастинський'],
  'Львівська область': ['Дрогобицький', 'Золочівський', 'Львівський', 'Самбірський', 'Стрийський', 'Шептицький', 'Яворівський'],
  'Миколаївська область': ['Баштанський', 'Вознесенський', 'Миколаївський', 'Первомайський'],
  'Одеська область': ['Березівський', 'Білгород-Дністровський', 'Болградський', 'Ізмаїльський', 'Одеський', 'Подільський', 'Роздільнянський'],
  'Полтавська область': ['Кременчуцький', 'Лубенський', 'Миргородський', 'Полтавський'],
  'Рівненська область': ['Вараський', 'Дубенський', 'Рівненський', 'Сарненський'],
  'Сумська область': ['Конотопський', 'Охтирський', 'Роменський', 'Сумський', 'Шосткинський'],
  'Тернопільська область': ['Кременецький', 'Тернопільський', 'Чортківський'],
  'Харківська область': ['Берестинський', 'Богодухівський', 'Ізюмський', "Куп'янський", 'Лозівський', 'Харківський', 'Чугуївський'],
  'Херсонська область': ['Бериславський', 'Генічеський', 'Каховський', 'Скадовський', 'Херсонський'],
  'Хмельницька область': ["Кам'янець-Подільський", 'Хмельницький', 'Шепетівський'],
  'Черкаська область': ['Звенигородський', 'Золотоніський', 'Уманський', 'Черкаський'],
  'Чернівецька область': ['Вижницький', 'Дністровський', 'Чернівецький'],
  'Чернігівська область': ['Корюківський', 'Ніжинський', 'Новгород-Сіверський', 'Прилуцький', 'Чернігівський'],
};
// Old / variant names mapped to directory names (normalized keys).
const ALIASES = {
  'новомосковський': 'самарівський',
  'красноградський': 'берестинський',
  'червоноградський': 'шептицький',
  'новоград-волинський': 'звягельський',
  'володимир-волинський': 'володимирський',
  'свердловський': 'довжанський',
  'северодонецький': 'сєвєродонецький',
  'сіверськодонецький': 'сєвєродонецький',
};
export function normRaion(s) {
  // Unify apostrophes first: API uses ’ (U+2019), GeoJSON uses ' (U+0027).
  return String(s || '').replace(/[’‘ʼ`´]/g, "'").toLowerCase().replace(/район|р-н|рн\b/g, ' ').replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}
export function normOblast(s) {
  return String(s || '').toLowerCase().replace(/область|обл\.?|м\.|місто/g, ' ').replace(/[\s_]+/g, ' ').trim();
}
function stem(s) {
  return normRaion(s).replace(/(ський|цький|зький|чий|ший|ій|ий|й)$/, '');
}
export function raionMatches(a, b) {
  const na = normRaion(a), nb = normRaion(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = ALIASES[na] || na, cb = ALIASES[nb] || nb;
  if (ca === cb) return true;
  const sa = ca.replace(/(ський|цький|зький|чий|ший|ій|ий|й)$/, '');
  const sb = cb.replace(/(ський|цький|зький|чий|ший|ій|ий|й)$/, '');
  return !!sa && sa === sb;
}
// Is there an official alert covering (oblast, raion)?
// Returns null (none), {scope:'oblast'} (oblast-wide alert), {scope:'raion'} (raion-specific),
// {scope:'outside'} (oblast alert, other raions).
export function raionAlertActive(alerts, oblast, raion) {
  const list = (alerts || []).filter(a => normOblast(a.region) === normOblast(oblast));
  if (!list.length) return null;
  if (!raion) return { scope: 'oblast', alerts: list };
  // Oblast-wide alert (no district) -> scope 'oblast' for any raion
  const oblastWide = list.find(a => !a.district);
  if (oblastWide) return { scope: 'oblast', alerts: [oblastWide] };
  // Raion-specific alert matching this raion
  const mine = list.filter(a => raionMatches(a.district, raion));
  return mine.length ? { scope: 'raion', alerts: mine } : { scope: 'outside', alerts: list };
}
export function matchRaion(dirList, incoming) {
  if (!incoming) return null;
  const n = normRaion(incoming);
  if (!n) return null;
  const canon = ALIASES[n] || n;
  const normed = dirList.map(d => normRaion(d));
  const direct = normed.indexOf(canon);
  if (direct >= 0) return dirList[direct];
  const st = stem(canon);
  if (!st) return null;
  const byStem = normed.findIndex(d => stem(d) === st);
  return byStem >= 0 ? dirList[byStem] : null;
}
export function raionDirectory(oblast) {
  const want = normOblast(oblast);
  const key = Object.keys(RAIONS).find(k => normOblast(k) === want);
  return key ? RAIONS[key] : null;
}
// Builds per-raion status rows for one oblast.
// Row: {name, status:'alert'|'mon'|'calm', alert, monCount, monSample, fromStream}
export function oblastRaions(snapshot, oblast) {
  const want = normOblast(oblast);
  const dir = raionDirectory(oblast);
  const alerts = (snapshot?.alerts || []).filter(a => normOblast(a.region) === want);
  const oblastWide = alerts.find(a => !a.district) || null;
  const events = (snapshot?.events || []).filter(e => normOblast(e.region || e.derivedRegion) === want);
  const byRaion = new Map();
  const take = name => {
    if (!byRaion.has(name)) byRaion.set(name, { name, alert: null, monCount: 0, monSample: [], fromStream: false });
    return byRaion.get(name);
  };
  if (dir) for (const name of dir) take(name);
  for (const a of alerts) {
    if (!a.district) continue;
    const hit = dir ? matchRaion(dir, a.district) : null;
    const row = take(hit || a.district);
    if (hit == null) row.fromStream = true;
    if (!row.alert) row.alert = a;
  }
  let unassignedMon = 0;
  for (const e of events) {
    const hit = dir && e.district ? matchRaion(dir, e.district) : null;
    if (hit) {
      const row = take(hit);
      row.monCount += 1;
      if (row.monSample.length < 3) row.monSample.push(e.subtype || e.category);
    } else if (e.district && !dir) {
      const row = take(e.district);
      row.fromStream = true;
      row.monCount += 1;
      if (row.monSample.length < 3) row.monSample.push(e.subtype || e.category);
    } else {
      unassignedMon += 1;
    }
  }
  const rows = [...byRaion.values()].map(r => {
    const alert = r.alert || (oblastWide && !r.fromStream ? { ...oblastWide, oblastWide: true } : r.alert);
    return { ...r, alert, status: alert ? 'alert' : r.monCount > 0 ? 'mon' : 'calm' };
  });
  const rank = { alert: 0, mon: 1, calm: 2 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name, 'uk'));
  return { rows, unassignedMon, hasDirectory: !!dir, oblastWide: !!oblastWide };
}
// ── Territorial danger (pure, testable) ──────────────────────────────────────
// Scope is driven ONLY by district presence, never invented from threat type:
// - official alert with district==null        -> whole oblast
// - official alert with district               -> that raion only (level 'alert')
// - missile/ballistic monitor, district==null  -> whole oblast (level critical)
// - missile/ballistic monitor, district set    -> that raion only (level 'critical')
// - shahed/uav/kab monitor, areaOnly+district  -> that raion only (level 'high')
// - other monitor, areaOnly+district           -> that raion only (level 'medium')
// - exact-coordinate threats (areaOnly=false)  -> NO territorial fill (markers only)
// - areaOnly monitor WITHOUT district         -> NO fill (never invent a raion,
//   never auto-paint the oblast for UAV/KAB)
// Returns { oblasts: [oblastName], fills: [{oblast, district, level}] }.
// A district that has no GeoJSON polygon must warn and be skipped by the
// renderer — it must NEVER fall back to painting the oblast.
export function territorialDanger(alerts, events) {
  const oblasts = [];
  const seenO = new Set();
  const fills = [];
  const seenF = new Set();
  const addOblast = (o) => {
    if (!o) return;
    const k = normOblast(o);
    if (!k || seenO.has(k)) return;
    seenO.add(k);
    oblasts.push(o);
  };
  const addFill = (oblast, district, level) => {
    if (!oblast || !district) return;
    const k = normOblast(oblast) + '||' + normRaion(district) + '||' + level;
    if (seenF.has(k)) return;
    seenF.add(k);
    fills.push({ oblast, district, level });
  };
  for (const a of alerts || []) {
    if (!a || !a.region) continue;
    // Official raion alert: the source's own level decides the color.
    // level red ("Ракетна загроза") -> critical red; anything else -> high orange.
    if (a.district) addFill(a.region, a.district, a.level === 'red' ? 'critical' : 'high');
    else addOblast(a.region);
  }
  for (const e of events || []) {
    if (!e || e.official) continue;
    const oblast = e.region || e.derivedRegion;
    if (!oblast) continue;
    const cat = e.category;
    const isMissile = cat === 'missile' || cat === 'ballistic';
    if (!e.district) {
      if (isMissile) addOblast(oblast);
      continue;
    }
    if (isMissile) { addFill(oblast, e.district, 'critical'); continue; }
    if (e.areaOnly !== true) continue;
    const kind = classifyThreat(e);
    if (kind === 'shahed' || kind === 'uav' || kind === 'kab') addFill(oblast, e.district, 'high');
    else addFill(oblast, e.district, 'medium');
  }
  return { oblasts, fills };
}
const CENTER_KEY = 'nebo-raion-centers-v1', CENTER_TTL = 30 * 24 * 3600000;
export function loadCenterCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CENTER_KEY) || '{}');
    return c && typeof c === 'object' ? c : {};
  } catch (e) { return {}; }
}
export function saveCenterCache(c) {
  try { localStorage.setItem(CENTER_KEY, JSON.stringify(c)); } catch (e) {}
}
export function getCachedCenter(cache, oblast, name) {
  const hit = cache && cache[oblast + '||' + name];
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) return null;
  try {
    if (Date.now() - new Date(hit.at).getTime() > CENTER_TTL) return null;
  } catch (e) { return null; }
  return hit;
}
