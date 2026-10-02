# Покриття джерел

Аудит: 2–3 жовтня 2026 року. Відсутність події в одному джерелі не є спростуванням події з іншого.

| Джерело | Семантика | Географія | Категорії | Позиція | Напрямок | Історія | Destination | Quality/confidence | Оновлення |
|---|---|---|---|---|---|---|---|---|---|
| NEPTUN alerts | агреговані офіційні сигнали | області й райони України | air raid/reasons | area-only | ні | `since` | ні | level/reasons | REST CDN ~5 с; UI 60 с |
| NEPTUN threats | monitoring | Україна | uav, recon, missile, ballistic, kab, mig31k, unknown | точка або area-only | `heading`, іноді velocity | endpoint не гарантує trail | `destination` лише коли передано | confidenceLevel, positionQuality, uncertaintyKm, sourceCount | REST CDN ~5 с; UI 60 с |
| MAPA current | monitoring | Україна та прилеглі маршрути, залежно від потоку | drone_piston/jet/fpv, missile_cruise/ballistic, bomb | координата source | heading, speed | source-provided `trail` | `to_city` | окремого confidence немає | cache 5 с; UI 60 с |

## Важливі обмеження

- NEPTUN і MAPA мають різну семантику, життєвий цикл та покриття; їх кількості не порівнюються як фізичні об’єкти.
- MAPA `/current` повертає також завершені записи; у live UI залишаються лише `status=active`.
- `predicted_lat` та `predicted_lon` MAPA не використовуються.
- Регіон для MAPA, якщо він відсутній у відповіді, може локально визначатися попаданням отриманої координати у відкриту межу області. Це позначається як derived region, не поле джерела.
- Area-only NEPTUN не створює точковий marker, дистанцію, heading чи trail.
- `sourceCount` NEPTUN показується як кількість агрегованих повідомлень, не як кількість радарів або фізичних об’єктів.
