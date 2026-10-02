# Архітектура

Статичний mobile-first PWA без backend, акаунтів, секретів і аналітики.

## Data flow

1. `alerts.js`, `threats.js`, `mapa.js` отримують незалежні потоки.
2. `normalize.js` створює спільну nullable-модель; відсутні значення не генеруються.
3. `correlation.js` обережно групує схожі за category, часом і location повідомлення. Формулювання — «схожі повідомлення», не «підтверджено радарами».
4. Disagreement detector порівнює online streams із урахуванням coverage: no data ≠ negative confirmation.
5. `data.js` надає `getOfficialAlert`, `getRegionStatus`, `getActiveThreats`, `getRecentChanges`, `getSourceHealth` для майбутнього Telegram-бота.
6. `notifications.js` містить push-ready business categories, але push backend не ввімкнений.

## Reliability

Кожен source має окремий health. Official outage ніколи не перетворюється на «тривоги немає». Root `stale` NEPTUN переводить global status у DELAYED. Freshness рахується від source timestamp. Service worker кешує лише оболонку, не API.

## Memory and performance

Leaflet.markercluster обробляє велику кількість marker-ів. MAPA trail обмежений 20 останніми source points; session history — 30 хв/30 snapshots; timeline — 80 подій. Predictive fields і dead reckoning вимкнені.

Відносні шляхи підтримують GitHub Pages `/repo-name/`. Safety information ніколи не має бути за paywall.
