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

## Liveness-контракт `/v1/state` (STATE TIME ≠ PIPELINE HEALTH)

Поля часу мають різну семантику — не плутати їх:

| Поле | Джерело | Значення |
|---|---|---|
| `dataUpdatedAt` | KV bundle | коли реально змінився видимий вміст (тривоги/треки/здоров'я). Під час штилю стоїть на місці — це нормально. |
| `pipelineCheckedAt` | D1 `checks` (read path, 0 KV writes) | остання **успішна** перевірка upstream (NEPTUN або MAPA). Рухається кожну хвилину, поки пайплайн живий. Оновлюється ТІЛЬКИ після успішного fetch — ніколи на failed fetch. |
| `serverTime` / `receivedAt` | = `pipelineCheckedAt` (fallback: збережений зріз) | legacy-поля для старих consumers (offline threshold 30 хв). Рухаються разом із liveness, тому штиль ≠ OFFLINE. |
| `health.*.updatedAt` | D1 `checks` (останній рядок джерела) | свіжість per-source. |

Freshness для consumers: `LIVE` ≤5 хв від `pipelineCheckedAt`,
`DELAYED` ≤30 хв, інакше `OFFLINE` (або коли всі моніторингові джерела
`offline`). Вік `dataUpdatedAt` сам по собі OFFLINE не викликає.

KV-бюджет при цьому не росте: heartbeat KV-ключа — кожні 20 хв
(~72 writes/day у штиль), снапшот пишеться лише на реальні зміни,
треки — не частіше ніж раз на 3 хв. Штиль ≈73/day, суцільний churn
<500/day (див. `backend/test/liveness.test.js`).

## Admin: POST /v1/refresh

Ручний тригер пайплайна. Без `REFRESH_TOKEN` — відкритий (як раніше).
З секретом — вимагає `Authorization: Bearer <token>`:

```sh
wrangler secret put REFRESH_TOKEN
```

Фронтенд цей маршрут не використовує (лише cron), тож увімкнення
гейта нічого не ламає.

## Атрибуція джерел

Публічний `/v1/state` містить лише нормалізовані статуси тривог з атрибуцією
джерела. Ключів у репозиторії немає, а жодна публічна відповідь не містить
ключового матеріалу — це перевіряє регресійний тест.

Обмежувати публічний доступ без рішення власника не можна: це зламає сайт
і віджет.

Після деплою фронтенд (services/config.js, `DATA_MODE='aggregator'`)
автоматично бере `/v1/state` з `AGGREGATOR_URL`. Старі маршрути
`/alerts`, `/threats`, `/mapa` залишено для сумісності.

## Тести

```sh
node --test backend/test/*.test.js   # або npm test (ганяє все разом)
```

## Web Push (Етап 3)

Фонові сповіщення без акаунтів: ідентифікатор підписки — сам push-endpoint.

### Одноразове налаштування VAPID

```sh
cd backend
npm install
npx web-push generate-vapid-keys
```

Потім:

```sh
wrangler secret put VAPID_PRIVATE_KEY
```

А у `wrangler.toml` впишіть публічну половину і контакт оператора:

```toml
VAPID_PUBLIC_KEY = "<public key>"
VAPID_SUBJECT = "mailto:you@example.com"
```

### Як це працює

- Фронтенд (`services/push.js`): бере публічний ключ з `GET /v1/push/vapid-public-key`,
  підписується через `pushManager` і шле `POST /v1/push/subscribe` з місцями
  (область/район/громада/населений пункт, кілька штук можна), категоріями
  (початок/відбій, БПЛА, ракета, балістика, КАБ, авіація) і тихими годинами.
- Кожен cron-цикл після збереження зрізу викликає розсилку: нові тривоги/цілі
  порівнюються з минулим станом KV, для кожної підписки перевіряються місце,
  категорія, вік події та тихі години.
- Тихі години глушать усе, крім критичного: початок тривоги, ракета, балістика.
- Старі події новим підпискам не шлються: подія мусить вперше з'явитися в
  журналі пізніше, ніж створено підписку; перший запуск після втрати стану
  мовчки праймиться і нічого не розсилає.
- Доставка: до 3 спроб (паузи 1с/4с), `410/404` — підписка мертва і видаляється,
  кожна спроба пишеться в `push_log` (endpoint лише у вигляді хеша).
- `POST /v1/push/test` шле тестове повідомлення на збережену підписку.
- `DELETE /v1/push/unsubscribe` стирає підписку (те саме робить вимкнення
  тумблера в застосунку).

## Діагностика `{"ok":false}` у /v1/push/test

Кожна гілка має свій код (секрети ніколи не повертаються і не логуються —
лише хеш endpoint):

| code | HTTP | Значення | Що робити |
|---|---|---|---|
| `unknown-subscription` | 404 | підписки нема в D1 | увімкніть Push заново (створить запис) |
| `vapid-missing` | 502 | нема `VAPID_*` у Worker | `wrangler secret put VAPID_PRIVATE_KEY` + `VAPID_PUBLIC_KEY`/`VAPID_SUBJECT` у toml, redeploy |
| `gone` | 200 | провайдер відповів 404/410, підписку видалено | увімкніть Push заново |
| `send-failed` + `status` 401/403 | 200 | провайдер відхилив VAPID-авторизацію | перевірте пару ключів і subject |
| `send-failed` без `status` | 200 | помилка до відповіді провайдера — точний етап видно в `stage` (`config-vapid`, `import-web-push`, `set-vapid-details`, `send-notification`) | дивіться `wrangler tail` |
| `internal` | 502 | неочікувана помилка | дивіться `wrangler tail` |

Формат логу в tail (секретів нема — лише хеш endpoint до 12 символів):

```
[push:test] send failed {"endpoint":"06c7c04d9496","code":"send-failed","stage":"send-notification","status":null,"errorName":"...","error":"..."}
```

Поле `stage` і каже, де саме впало: `import-web-push` — не завантажилась
бібліотека; `set-vapid-details` — биті ключі; `send-notification` зі
`status:null` — відповіді від провайдера не було взагалі (мережа/таймаут);
зі `status` — відмова провайдера (401/403 = чужа пара ключів).

Перевірити, чи підписка реально в D1 (без виводу повних endpoint — вони чутливі):

```sh
wrangler d1 execute nebo-journal --command="SELECT substr(endpoint,1,60), created_at FROM push_subscriptions;"
wrangler d1 execute nebo-journal --command="SELECT status, count(*) FROM push_log GROUP BY status;"
```

Перевірити секрети без виводу значень (`GET /v1/push/vapid-public-key`
повертає ключ і прапорець наявності приватного, але ніколи не сам секрет).
