// Raion (district) breakdown: static directory (2020 reform, 2024 names) +
// fuzzy matching of source names. Pure functions, no network.
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
  return String(s || '').toLowerCase().replace(/район|р-н|рн\b/g, ' ').replace(/[\s_]+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}
export function normOblast(s) {
  return String(s || '').toLowerCase().replace(/область|обл\.?|м\.|місто/g, ' ').replace(/[\s_]+/g, ' ').trim();
}
function stem(s) {
  return normRaion(s).replace(/(ський|цький|зький|чий|ший|ій|ий|й)$/, '');
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
