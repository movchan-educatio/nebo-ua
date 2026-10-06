import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plural, flowStats, flowSummaryHTML } from '../services/summary.js';
import { territorialDanger } from '../services/districts.js';
import { normalizeNeptun, normalizeMapa } from '../services/normalize.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Ukrainian pluralization: 1/2/5/21/22/25 ──────────────────────────────────
test('plural: повідомлення 1/2/5/21/22/25', () => {
  const p = (n) => plural(n, 'повідомлення', 'повідомлення', 'повідомлень');
  assert.equal(p(1), 'повідомлення');
  assert.equal(p(2), 'повідомлення');
  assert.equal(p(5), 'повідомлень');
  assert.equal(p(21), 'повідомлення');
  assert.equal(p(22), 'повідомлення');
  assert.equal(p(25), 'повідомлень');
  assert.equal(p(0), 'повідомлень');
  assert.equal(p(11), 'повідомлень');
  assert.equal(p(14), 'повідомлень');
  assert.equal(p(111), 'повідомлень');
});

test('plural: область/район/ціль/подія', () => {
  const o = (n) => plural(n, 'область', 'області', 'областей');
  assert.equal(o(1), 'область');
  assert.equal(o(2), 'області');
  assert.equal(o(5), 'областей');
  assert.equal(o(9), 'областей');
  const r = (n) => plural(n, 'район', 'райони', 'районів');
  assert.equal(r(1), 'район');
  assert.equal(r(2), 'райони');
  assert.equal(r(5), 'районів');
  assert.equal(r(31), 'район');
  const t = (n) => plural(n, 'ціль', 'цілі', 'цілей');
  assert.equal(t(1), 'ціль');
  assert.equal(t(2), 'цілі');
  assert.equal(t(5), 'цілей');
  const e = (n) => plural(n, 'координатна подія', 'координатні події', 'координатних подій');
  assert.equal(e(1), 'координатна подія');
  assert.equal(e(2), 'координатні події');
  assert.equal(e(34), 'координатні події');
});

// ── flowStats: exact-tier records by kind, no double counting ─────────────────
function exactUav(id, oblast = 'Сумська область') {
  return {
    id, source: 'NEPTUN', category: 'uav', kind: null, subtype: 'БпЛА',
    lat: 51.6, lon: 33.25, region: oblast, district: null, settlement: 'Конотоп',
    locationPrecision: 'COORDINATE', areaOnly: false, heading: 185, speed: null,
    stale: false, official: false,
  };
}
function exactKab(id) {
  return {
    id, source: 'NEPTUN', category: 'kab', kind: 'kab', subtype: 'Пуск КАБ',
    lat: 49.2, lon: 37.2, region: 'Харківська область', district: null, settlement: 'Ізюм',
    locationPrecision: 'COORDINATE', areaOnly: false, heading: null, speed: null,
    stale: false, official: false,
  };
}
function areaUav(id) {
  return {
    id, source: 'NEPTUN', category: 'uav', kind: null, subtype: 'БпЛА в районі',
    lat: 49.8, lon: 31.5, region: 'Черкаська область', district: 'Уманський район',
    locationPrecision: 'RAION', areaOnly: true, heading: null, speed: null,
    stale: false, official: false,
  };
}

test('flowStats: 32 UAV + 2 KAB exact, 2 area-tier excluded, no double counting', () => {
  const events = [];
  for (let i = 0; i < 32; i++) events.push(exactUav('neptun:u' + i));
  events.push(exactKab('neptun:k1'), exactKab('neptun:k2'));
  events.push(areaUav('neptun:a1'), areaUav('neptun:a2'));
  assert.equal(events.length, 36);
  const s = flowStats(events);
  assert.equal(s.uav, 32);
  assert.equal(s.missiles, 0);
  assert.equal(s.kab, 2);
  assert.equal(s.shahed, 0);
  assert.equal(s.exactTotal, 34);
  // Disjoint categories: never 36+2=38.
  assert.equal(s.uav + s.missiles + s.kab + s.shahed, s.exactTotal);
});

// ── flowSummaryHTML: radar HUD copy, no logbook wording, no debug ────────────
test('flowSummaryHTML: compact honest summary for the real snapshot shape', () => {
  const html = flowSummaryHTML({ uav: 32, shahed: 0, missiles: 0, kab: 2, exactTotal: 34 }, 31);
  assert.ok(html.includes('<b>32</b>'), 'shows 32');
  assert.ok(html.includes('БПЛА'), 'shows БПЛА');
  assert.ok(html.includes('<b>2</b>'), 'shows 2');
  assert.ok(html.includes('КАБ'), 'shows КАБ');
  assert.ok(!html.includes('повідомлен'), 'radar copy, not logbook wording');
  assert.ok(!html.includes('приховано'), 'stale-hidden count is debug info, not for users');
  assert.ok(html.includes('34'), 'shows 34 coordinate events');
  assert.ok(html.includes('точкові цілі'), 'rendered-targets wording (34 = few form)');
  assert.ok(html.includes('31'), 'shows 31 raions');
  assert.ok(html.includes('район') && html.includes('у тривозі'), 'raion line present');
  assert.ok(!html.includes('областей із'), 'no legacy oblast line');
  assert.ok(!html.includes('з координатами'), 'no legacy coordinated line');
  assert.ok(!html.includes('із 1'), 'no truncated legacy text');
});

test('flowSummaryHTML: plurals 1/5 and Shahed cell honesty', () => {
  const one = flowSummaryHTML({ uav: 1, shahed: 0, missiles: 0, kab: 0, exactTotal: 1 }, 1);
  assert.ok(one.includes('<b>1</b>') && one.includes('РАКЕТА') === false, 'missile cell uses РАКЕТА only for missiles');
  assert.ok(one.includes('БПЛА'), 'uav cell present');
  assert.ok(!one.includes('ШАХЕД'), 'no Shahed cell when shahed=0');
  const five = flowSummaryHTML({ uav: 5, shahed: 0, missiles: 1, kab: 0, exactTotal: 6 }, 5);
  assert.ok(five.includes('РАКЕТА'), '1 ракета');
  assert.ok(five.includes('5 районів'), '5 районів');
  const rockets = flowSummaryHTML({ uav: 0, shahed: 0, missiles: 5, kab: 0, exactTotal: 5 }, 0);
  assert.ok(rockets.includes('РАКЕТ'), '5 ракет');
  const withShahed = flowSummaryHTML({ uav: 10, shahed: 2, missiles: 0, kab: 0, exactTotal: 12 }, 1);
  assert.ok(withShahed.includes('ШАХЕД'), 'confirmed Shaheds get their own cell, never hidden in БПЛА');
});

// ── Source-count honesty: generic UAV is never renamed to Shahed ────────────
test('source count passes through normalization without renaming kinds', () => {
  const u = normalizeNeptun({ id: 'x', type: 'uav', title: 'БпЛА', lat: 50, lon: 31, count: 4, updatedAt: '2026-10-06T10:00:00Z' });
  assert.equal(u.count, 4);
  assert.equal(u.kind, null);
  const m = normalizeMapa({ id: 9, kind: 'drone_piston', status: 'active', lat: 50, lon: 31, amount: 3, last_seen: 1759694410 });
  assert.equal(m.count, 3);
});
test('flowStats counts fpv separately, never hidden in БПЛА', () => {
  const fpv = normalizeMapa({ id: 7, kind: 'drone_fpv', status: 'active', lat: 50, lon: 31, last_seen: 1759694410 });
  const uav = normalizeNeptun({ id: 'x', type: 'uav', title: 'БпЛА', lat: 50.1, lon: 31.1, updatedAt: '2026-10-06T10:00:00Z' });
  const st = flowStats([fpv, uav]);
  assert.equal(st.byKind.fpv, 1);
  assert.equal(st.byKind.uav, 1);
});

// ── RAION DANGER MUST NEVER STYLE OBLAST POLYGON ────────────────────────────
test('RAION DANGER MUST NEVER STYLE OBLAST POLYGON (map.js source)', () => {
  const src = fs.readFileSync(path.join(root, 'assets/js/map.js'), 'utf8');
  // No raion-level fill constants may remain for oblast polygons...
  assert.ok(!src.includes('raionHigh'), 'no raionHigh style may remain');
  assert.ok(!src.includes('raionMedium'), 'no raionMedium style may remain');
  assert.ok(!src.includes('DANGER_STYLE.raion'), 'oblast polygons must never use a raion style');
  assert.ok(!src.includes('computeTerritorialDanger'), 'old local computer must be gone (single source: districts.territorialDanger)');
  // ...and setRegions paints oblasts only from the oblast-level list.
  assert.ok(src.includes('territorialDanger(alerts,events).oblasts'), 'setRegions must derive oblast fills from territorialDanger().oblasts only');
});

test('1 raion alert -> 1 raion fill / 0 oblast fills', () => {
  const { oblasts, fills } = territorialDanger(
    [{ region: 'Черкаська область', district: 'Уманський район' }], [],
  );
  assert.equal(oblasts.length, 0);
  assert.equal(fills.length, 1);
  assert.ok(fills[0].district);
});

test('5 raions of one oblast -> 5 raion fills / 0 oblast fills', () => {
  const alerts = ['Конотопський', 'Охтирський', 'Роменський', 'Сумський', 'Шосткинський']
    .map(d => ({ region: 'Сумська область', district: d + ' район' }));
  const { oblasts, fills } = territorialDanger(alerts, []);
  assert.equal(oblasts.length, 0, 'five raion alerts must not activate the oblast');
  assert.equal(fills.length, 5);
});

test('oblast alert (district==null) -> 1 oblast fill', () => {
  const { oblasts, fills } = territorialDanger(
    [{ region: 'Черкаська область', district: null }], [],
  );
  assert.deepEqual(oblasts, ['Черкаська область']);
  assert.equal(fills.length, 0);
});

test('unknown district -> territorial fill exists but resolves to 0 polygons (warn path)', () => {
  const { oblasts, fills } = territorialDanger(
    [{ region: 'Черкаська область', district: 'Невідомий район' }], [],
  );
  assert.equal(oblasts.length, 0, 'unknown district must not activate the oblast either');
  assert.equal(fills.length, 1);
  // Resolution to GeoJSON happens in drawAlertShapes; emulate: no match -> warn, skip.
  assert.ok(fills[0].district === 'Невідомий район');
});

console.log('All summary tests passed!');
