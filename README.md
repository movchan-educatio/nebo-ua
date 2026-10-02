# НЕБО UA

Україномовний mobile-first PWA для відображення актуальних сигналів повітряної тривоги та окремо позначеної моніторингової інформації про повітряні загрози.

## Функції

- Leaflet + OpenStreetMap, локальні межі областей;
- активні тривоги й моніторингові об’єкти з NEPTUN без fake data;
- шари, фільтри, стрічка, «Мій регіон», необов’язкова геолокація;
- незалежна обробка помилок, offline shell, контроль свіжості;
- installable PWA, адаптація для iPhone, Android і desktop.
- multi-source normalization: NEPTUN + MAPA без змішування з official status;
- conservative correlation, disagreement/coverage awareness і source health;
- fullscreen dark map, marker clustering, area-only/uncertainty protection;
- Radar-візуалізація, «Моє небо», live timeline, session history і OLED Quiet Mode;
- premium bottom sheet «Чому це показано?» з freshness та source fields.

## Джерела

Детально: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) і [docs/SOURCE_COVERAGE.md](docs/SOURCE_COVERAGE.md). NEPTUN і MAPA є monitoring/aggregation sources; офіційний статус у UI завжди відокремлений. OpenStreetMap використовується з attribution.

## Локальний запуск

Потрібен Node.js 20+:

```bash
npm install
npm run serve
```

Відкрити `http://localhost:4173`. Не відкривайте `index.html` напряму через `file://`, оскільки PWA та ES modules потребують HTTP.

## Тести

```bash
npm test
```

Ручний checklist: [docs/TESTING.md](docs/TESTING.md).

## GitHub Pages

Завантажте вміст цієї папки в окремий репозиторій. У Settings → Pages виберіть Deploy from a branch, гілку `main`, папку `/ (root)`. Усі внутрішні URL відносні, тому `/repo-name/` підтримується. Публікація в цьому проєкті не виконувалася.

## Встановлення PWA

- Android/Chrome: меню → «Встановити застосунок».
- iPhone/Safari: Share → «На початковий екран».

Service worker працює лише на HTTPS або localhost.

## Обмеження

Дані можуть бути неповними, неточними або затриманими. Відсутність об’єкта у потоці не означає відсутність небезпеки. Застосунок не замінює офіційні системи оповіщення. Публічні OSM tiles мають usage policy й не призначені для необмеженого великого трафіку.

## Privacy

Див. [PRIVACY.md](PRIVACY.md). Акаунтів і аналітики немає.

## Майбутній Telegram bot

Модулі `services/` відокремлені від UI та експортують `getOfficialAlert`, `getRegionStatus`, `getActiveThreats`, `getRecentChanges`, `getSourceHealth`. Для бота слід винести їх у спільний package або backend. `services/notifications.js` містить push-ready категорії без платного backend. Базові попередження завжди мають залишатися безкоштовними.

## Безпека даних

Застосунок не використовує MAPA `predicted_lat/predicted_lon`, не виконує dead reckoning, не прогнозує ціль, ETA чи маршрут. Area-only events не стають точковими marker-ами. Відсутність monitoring event не означає безпеку.

## Screenshots

Контрольні знімки зберігаються в `docs/screenshots/final/`: mobile map, Radar, threat detail, My Sky, Quiet Mode, desktop map/Radar і tablet.
