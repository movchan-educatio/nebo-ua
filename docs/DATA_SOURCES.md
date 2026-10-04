# Джерела даних

Останній live-аудит: 2–3 жовтня 2026 року. Перевірено документацію, JSON-відповіді, CORS і HTTP cache headers.

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

Leaflet + стандартні raster tiles OpenStreetMap. Dark appearance створюється локальним CSS filter. Attribution постійно видима. CARTO Dark Matter відхилено: актуальні умови не гарантують безкоштовне комерційне використання без enterprise license/grant.

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
