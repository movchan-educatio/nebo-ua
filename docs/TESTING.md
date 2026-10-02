# Тестування

## Автоматично

Запустіть `npm test`, потім `npm run serve` і відкрийте `http://localhost:4173`.

## Browser QA

Перевірити карту й тайли, обидва API-потоки, фільтри, вибір регіону та reload, відмову геолокації, offline shell, помилку API, ширини 375/390/430 px і desktop, manifest/service worker/cache, timestamp/stale state, attribution, посилання та console errors. Live API не має кешуватися service worker-ом.

Фінальний цикл 3 жовтня 2026: 320/360/375/390/393/414/430/768/820/1024/1366/1440/1920 px та mobile landscape; horizontal overflow = 0. Проклікано Map, Radar, Threats, My Sky, detail, Why, direction, source destination, Sources, Settings, Quiet Mode. Offline shell перевірено з вимкненим local server. Critical console errors: 0.

Real-data cross-check: 20 official raions + 3 oblast entries, 6 NEPTUN threats, 53 active MAPA objects; усі 53 MAPA active records мали heading, destination і trail у цьому конкретному snapshot. Це не гарантує наявність полів у майбутніх відповідях; UI має null fallback.
# Release candidate

Фактичні результати останньої перевірки: [RELEASE_QA.md](RELEASE_QA.md).
