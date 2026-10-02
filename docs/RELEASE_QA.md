# Release QA — `nebo-web-rc1`

Дата перевірки: 2026-10-03.

## Автоматичні перевірки

- 21/21 Node tests: PASS.
- Audio transitions: official start/end, UAV, missile/ballistic, outside-region suppression, master off, reload deduplication, coordinate-update deduplication, quiet hours: PASS.
- Critical audio duplication bugs: 0 у тестовому наборі.
- NEPTUN/MAPA normalization, area-only protection, conservative correlation, disagreement semantics, malformed responses: PASS.
- Advertising release flag: `adsEnabled=false`; ad-free override: PASS.
- Manifest, relative GitHub Pages paths and API cache exclusion: PASS.

## Browser / responsive

- Codex in-app Chromium browser: map, live data, Settings, all audio controls, explicit master activation, test sound label, hidden zero-height AdSlot, console: PASS.
- Responsive widths 320, 360, 375, 390, 393, 414, 430, 768, 820, 1024, 1366, 1440, 1920 px: PASS, horizontal overflow not found.
- Android Chrome browser/device emulation: PASS. Physical Android device: NOT TESTED.
- iPhone Safari and installed standalone PWA on physical iPhone: NEEDS REAL DEVICE TEST. Safe-area CSS, viewport-fit and responsive sizes were inspected, but this is not equivalent to a real Safari/iOS audio/background test.
- Edge and Firefox native engines: NOT TESTED in this environment.

## Important limits

Audio was verified after a direct user gesture in the active browser tab. Background execution, a closed browser and iOS audio scheduling are not guaranteed. Web Push needs a future backend and is not enabled in this release.

Live monitoring data is never served from the offline shell cache. Offline mode preserves the application shell only and must not present cached threats as current.
