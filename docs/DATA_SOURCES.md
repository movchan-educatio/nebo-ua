# Джерела даних

Останній live-аудит: 2–3 жовтня 2026 року. Перевірено документацію, JSON-відповіді, CORS і HTTP cache headers.

## Агрегатор (Етап 2, рекомендований шлях)

- `backend/` — Cloudflare Worker + KV + D1. Раз на хвилину сам опитує NEPTUN і MAPA (з повторами), веде журнал, міряє доступність і віддає фронтенду один зріз `GET /v1/state`.
- Кожен статус містить: джерело, час події (`eventTime`), час отримання (`receivedAt`), фактичну затримку (`latencyMs`) і рівень довіри (`confidence`).
- Захист від помилкового відбою: падіння джерела ніколи не виглядає як відбій; тривога закривається лише після 3 поспіль успішних циклів без неї.
- Фронтенд бере зріз через `services/aggregator.js` (`services/config.js`: `DATA_MODE`, `AGGREGATOR_URL`). Якщо агрегатор недоступний — автоматичний відкат на прямі запити.
- Фонові push-сповіщення: підписки (`/v1/push/subscribe`) з місцями, категоріями і тихими годинами; розсилка в cron, журнал доставки, критичні винятки з тихих годин.

## NEPTUN — використовується

- Інформаційний агрегатор, не державна система оповіщення.
- `GET https://neptun.in.ua/api/v1/alerts`: агреговані активні сигнали по районах/областях, `key`, `since`, `level`, `reasons`.
- `GET https://neptun.in.ua/api/v1/threats`: active `uav`, `recon`, `missile`, `ballistic`, `kab`, `mig31k`, `unknown`.
- Можливі поля: id, lat/lon або areaOnly, region/district/locality, heading, timestamp, status, advisory, confidenceLevel, positionQuality, uncertaintyKm, sourceCount.
- REST і WebSocket; MVP polling 60 с. CORS `*`, ключ не потрібен, CDN max-age 5 с.
- Обов’язкове видиме посилання. Комерційне й некомерційне використання дозволене умовами API.
- Failure ізольований; API responses не кешуються service worker-ом.

## MAPA.UA — використовується

- Monitoring, не офіційна система оповіщення.
- `GET https://mapa.ua/api/v1/current`.
- Object id, kind/subkind, status, lat/lon, heading, speed_kmh, source-provided `to_city`, first_seen/last_seen, `trail`.
- У live UI залишаються лише `status=active`; завершені записи не показуються active.
- `predicted_lat`/`predicted_lon` не використовуються. Trail називається історією позицій джерела, не прогнозованою траєкторією.
- REST polling 60 с; CORS `*`; cache max-age 5 с; ключ не потрібен.

## alerts.in.ua — не використовується

Потребує секретний token, має soft limit 8–10 і hard limit 12 запитів/хв/IP та вимагає proxy для публічного frontend. GitHub Pages не має backend; вбудовування ключа заборонене.

## Ukraine Alarm API — офіційне, не використовується

Потребує Token, який видається за заявкою. Безпечне використання зі статичного GitHub Pages неможливе без proxy.

## Карта

Leaflet + векторні тайли **OpenFreeMap** (OpenMapTiles-схема, геодані OpenStreetMap), рендер — MapLibre GL усередині Leaflet-шару.

Використовується **світлий** стиль: локальний форк офіційного `positron` — `assets/data/nebo-light.json`. Форк перегенеровується командою `node tools/nebo-light-style.mjs`, тому його можна оновити разом з upstream, а всі зміни лишаються видимими правилами, а не ручною правкою JSON. Що саме прибрано і чому: шари, що починаються вище `maxZoom` самої карти (12) — вони не можуть намалюватись; щити доріг лише для США; льодовики. Мітки приглушено до ~0.31–0.63 luminance, щоб червоний шар загроз був єдиним насиченим кольором на екрані. Мітки аеродромів **лишено**: на повітряному радарі аеродроми — це контекст, а не шум.

Якщо WebGL, CDN або тайли недоступні — відкат на стандартні raster tiles OpenStreetMap, операційний інтерфейс лишається живим.

Attribution постійно видима. **CARTO Dark Matter і далі відхилено**: актуальні умови не гарантують безкоштовне комерційне використання без enterprise license/grant. Цей висновок стосується CARTO, а не OpenFreeMap — і він не змінювався.

Детальна матриця: [SOURCE_COVERAGE.md](SOURCE_COVERAGE.md).

## Вітер — Open-Meteo (опційний шар)

- Безкоштовно, без ключа, CORS відкритий.
- `GET https://api.open-meteo.com/v1/forecast?...&hourly=wind_speed_10m,wind_direction_10m` для 8 точок України.
- Стрілки показують, куди дме вітер (метеорологічний напрямок + 180°), підпис — швидкість км/год.
- Кеш 30 хв у localStorage. Контекст для БПЛА, не дані загроз.

## Локальні мітки користувача

- Зберігаються лише в localStorage цього пристрою, нікуди не надсилаються.
- Не змішуються з monitoring-подіями, не впливають на статистику і звуки.
- Позначені як неперевірені, живуть 24 год, максимум 50.
