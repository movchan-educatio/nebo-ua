# Безпечна публікація змін НЕБО UA

Ця інструкція підготовлена для `fix/sync-integrity-favicon-20261009`.
Production deployment і зміни production secrets **не виконані** та
потребують окремого дозволу власника. Не зливати гілку в `master` до цього
дозволу: злиття може автоматично запустити Vercel production deployment.

## 1. Перевірити код локально

Node ≥22.13, із кореня checkout:

```sh
npm ci
npm test
npm run icons
npx playwright install chromium
node tools/verify-local.mjs
npx wrangler deploy --dry-run --config backend/wrangler.toml --outdir temp/worker-build
```

Остання команда лише складає Worker. `verify-local.mjs` піднімає localhost,
використовує ізольовану SQLite та fixtures і блокує зовнішню мережу браузера.
Не переносити ці fixtures на бойові endpoint або в production D1/KV.

## 2. Окреме staging-середовище

1. Використати окремий тестовий Worker, окремі KV namespace і D1 database.
   Зберегти binding-імена `NEBO_STATE` / `nebo_journal`, але **не копіювати
   production resource IDs** із `backend/wrangler.toml` до staging.
2. Зробити окремий локальний wrangler config із тестовою назвою Worker та
   тестовими IDs. Не запускати `--remote` проти чинного production config
   для тестів. Для нової тестової D1 застосувати `backend/schema.sql`.
3. Почати із тестових endpoint/fixtures. Не підключати production push
   subscriptions/VAPID; тестові повідомлення не повинні надходити користувачам.
4. Для перевірки живих джерел потрібен дозволений staging-доступ провайдерів.
   Не копіювати production secrets і не збільшувати частоту реальних API
   без узгодження лімітів. Залишити cron раз на хвилину; не додавати refresh loop.
5. У staging увімкнути `SYNC_STATE_STORE="d1"` і переглянути `/v1/state`.
   Для preview frontend задати його тестову API URL через наявний
   `localStorage` ключ `nebo-api-url`; не підключати тестовий frontend до
   production refresh. Ця настройка лише для тестового origin/профілю.

## 3. Спостереження 30–60 хвилин

Зібрати Worker logs/analytics, D1 і KV metrics, browser Network/Console.
Не оцінювати CPU за локальним Node wall time.

| Показник | Критерій |
|---|---|
| Cron | Порахувати заплановані та фактичні запуски, published/failed/superseded, останній успіх і збій. Пояснити кожен пропуск. |
| Тривалість | Середня та максимальна durationMs, окремо fetch/publish; CPU із Cloudflare. Немає exceededCpu. |
| UkraineAlarm 401/timeout | Штучні відповіді лише на staging endpoint; нова MAPA/NEPTUN подія публікується без очікування UA, OFFICIAL stale/offline без хибного відбою. |
| Час | checkedAt відображає спробу; lastSuccessAt не рухається при помилці; незмінний контент не змінює dataUpdatedAt. |
| D1/KV | Немає SQL-variable/row-size/quota помилок; виміряти writes/reads та KV write frequency. CAS не дозволяє старішому запуску замінити новий. |
| Frontend | Polling і повернення вкладки отримують нову публікацію; після 3 хв без перевірки є попередження. Старий fallback не показує нову freshness. |
| Сховища | Тестова відмова KV не зупиняє D1; D1 outage дає явний старий fallback/503. Відновлення повертає D1. |
| Іконки | Preview URL повертають image Content-Type, а не HTML; favicon у вкладці та manifest icons правильні. |

Зберегти raw logs без secrets і коротку таблицю результатів. Якщо сценарій
виявить критичний дефект або перевищення ресурсів, виправити його перед
запитом дозволу на production. Локальні 485 тестів цього gate не замінюють.

## 4. Production — лише після дозволу й staging gate

Перевірити Cloudflare account і Worker **`check-ua-proxy`**, database
**`nebo-journal`**, зберегти ID поточної Worker deployment-версії та точку
відновлення D1. Не торкатися WAR LIVE й не змінювати secrets.

Міграція адитивна: створює одну таблицю, не видаляє даних. Спочатку виконати
її, і лише потім публікувати D1 writer. Нижче команди **для схваленого
production етапу**, із кореня repo:

```sh
npx wrangler d1 execute nebo-journal --remote --config backend/wrangler.toml --file backend/migrations/0001_pipeline_state.sql
npx wrangler deploy --config backend/wrangler.toml
```

Перевірити наступний cron: `storage="d1"`, свіжий `publishedAt`, коректні
джерела. Не форсувати багато `POST /v1/refresh`. Якщо міграції немає,
writer зупиниться й читач зможе показувати лише degraded KV fallback/503.

Після успішної backend-перевірки дозволити звичайний Vercel deployment
feature-змін через прийнятий у проєкті workflow. Перевірити публічні URL:

```text
https://nebo-ua.vercel.app/favicon.ico
https://nebo-ua.vercel.app/favicon-32x32.png
https://nebo-ua.vercel.app/favicon-48x48.png
https://nebo-ua.vercel.app/favicon-192x192.png
https://nebo-ua.vercel.app/favicon-512x512.png
https://nebo-ua.vercel.app/apple-touch-icon.png
https://nebo-ua.vercel.app/favicon.svg
https://nebo-ua.vercel.app/manifest.webmanifest
https://nebo-ua.vercel.app/robots.txt
```

Звірити HTTP 200, правильний MIME, сигнатуру/декодування зображень, head і
відсутність redirect на login/HTML. Перевірити звичайний профіль із
попереднім SW cache та чистий профіль. Robots має дозволяти головну й іконки;
додаткові edge-правила не повинні блокувати Googlebot/Googlebot-Image.

У Search Console виконати URL Inspection головної та Request indexing.
Не змінювати favicon URL щодня; повторний обхід може тривати дні/тижні.
Зміну іконки в Google вважати підтвердженою лише після фактичної перевірки.

## 5. Аварійне повернення

Якщо після публікації є критичні помилки, повернути **зафіксовану попередню
версію Worker** через Cloudflare deployment rollback. Додану D1 таблицю
залишити: видалення не потрібне для відкату. За потреби повернути попередній
Vercel deployment окремо.

У коді також залишений legacy writer при `SYNC_STATE_STORE` не `d1`, але він
зберігає описані у звіті обмеження KV та старого version gate. Це аварійний
режим, не рівноцінне довгострокове вирішення. Після відкату потрібні повторні
перевірки свіжості; жодний відкат сам по собі не усуває provider 401.
