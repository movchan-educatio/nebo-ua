# Backend-агрегатор Небо.UA (Етап 2)

Cloudflare Worker, який раз на хвилину (cron) сам опитує NEPTUN і MAPA,
веде журнал подій, міряє доступність джерел і віддає фронтенду один
готовий зріз `GET /v1/state`. Браузер більше не ходить по джерелах напряму.

## Що всередині

| Файл | Роль |
|---|---|
| `src/index.js` | cron-пайплайн + HTTP API (`/v1/state`, `/v1/metrics`, `POST /v1/refresh`, legacy `/alerts`, `/threats`, `/mapa`) |
| `src/sources.js` | фетчери NEPTUN / MAPA / офіційного API з таймаутом і повторною спробою |
| `src/normalize.js` | нормалізація в єдиний формат: `eventTime`, `receivedAt`, `latencyMs`, `confidence` |
| `src/fuse.js` | дедуп + кореляція + зведення в радіусі 18 км (порт логіки фронтенда) |
| `src/protect.js` | захист від помилкового відбою: тривоги закриваються лише після N пропусків поспіль; падіння джерела ніколи не виглядає як відбій |
| `src/store.js` | KV (останній зріз + попередній стан) і D1 (журнал подій + перевірки джерел) |
| `schema.sql` | таблиці `journal`, `checks` |

## Правила надійності

- Опитування джерел — лише з успішних циклів. Якщо джерело впало, попередній стан зберігається, у `health` — `offline` з текстом помилки.
- Тривога зникає з активних тільки після `ALERT_MISS_LIMIT` (за замовчуванням 3) поспіль успішних циклів без неї; факт закриття пишеться в журнал (`ended_at`).
- Моніторингова ціль після 1 пропуску позначається `stale`, після `THREAT_MISS_LIMIT` — закривається в журналі.
- Свіжість: ракети/балістика — 2 хв, решта — 5 хв (як у фронтенді).
- Метрики: `/v1/metrics` — за 24 год на джерело: кількість перевірок, % успіху, середня затримка, остання помилка.

## Офіційне API за токеном

Задайте змінні (звичайні vars або secrets):

```toml
OFFICIAL_API_URL = "https://api.example.ua/alerts"
```

```sh
wrangler secret put OFFICIAL_API_TOKEN
```

Очікуваний формат відповіді — масив:

```json
[{ "oblast": "Черкаська область", "district": "Уманський район",
   "since": "2026-10-04T12:00:00Z", "level": "alarm", "reasons": ["Повітряна тривога"] }]
```

Без URL або токена джерело `OFFICIAL` має статус `disabled` — це не помилка,
фронтенд показує «Вимкнено» нейтральним кольором.

## Деплой (5–10 хв)

```sh
npm i -g wrangler
wrangler login
wrangler kv:namespace create NEBO_STATE
wrangler kv:namespace create NEBO_STATE --preview
# вставте id() у wrangler.toml
wrangler d1 create nebo-journal
# вставте database_id у wrangler.toml
wrangler d1 execute nebo-journal --file=./schema.sql
wrangler deploy
```

Перевірка:

```sh
curl https://<your-worker>.workers.dev/v1/state | head -c 500
curl https://<your-worker>.workers.dev/v1/metrics
```

Після деплою фронтенд (services/config.js, `DATA_MODE='aggregator'`)
автоматично бере `/v1/state` з `AGGREGATOR_URL`. Старі маршрути
`/alerts`, `/threats`, `/mapa` залишено для сумісності.

## Тести

```sh
node --test backend/test/*.test.js   # або npm test (ганяє все разом)
```
