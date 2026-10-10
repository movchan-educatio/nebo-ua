import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAlertStats, groupThreats, formatHistory,
  matchTerritory, sourceCards, systemBadge,
} from '../services/overview.js';

test('computeAlertStats dedups cross-source territories', () => {
  const alerts = [
    { region: 'Київ', district: null, source: 'OFFICIAL' },
    { region: 'Київ', district: null, source: 'NEPTUN / офіційні канали' },
    { region: 'Київська область', district: 'Бучанський район', source: 'OFFICIAL', locationPrecision: 'RAION' },
    { region: 'Київська область', district: 'Бучанський район', source: 'NEPTUN / офіційні канали', locationPrecision: 'RAION' },
    { region: 'Львівська область', district: 'Сокальська громада', source: 'OFFICIAL', locationPrecision: 'RAION' },
  ];
  const s = computeAlertStats(alerts);
  assert.equal(s.oblasts, 3);
  assert.equal(s.raions, 2, 'same raion via two sources counted once');
  assert.equal(s.communities, 1);
  assert.deepEqual(computeAlertStats([]), { oblasts: 0, raions: 0, communities: 0 });
});

test('groupThreats excludes area-only officials, sorts newest first, caps', () => {
  const events = [
    { id: 'a', lat: 50, lon: 30, areaOnly: true, official: true, eventTime: '2026-10-08T12:00:00Z' },
    { id: 'b', lat: 49, lon: 31, category: 'uav', eventTime: '2026-10-08T11:00:00Z' },
    { id: 'c', lat: null, lon: null, category: 'uav' },
    { id: 'd', lat: 48, lon: 32, category: 'missile', eventTime: '2026-10-08T13:00:00Z' },
  ];
  const rows = groupThreats(events, 10);
  assert.equal(rows.length, 2, 'only coordinate-backed targets');
  assert.equal(rows[0].id, 'd', 'newest first');
  assert.equal(rows[1].id, 'b');
});

test('formatHistory: duration, ongoing, no invented dates', () => {
  const rows = formatHistory([
    { regionId: '1', startDate: '2026-10-08T10:00:00Z', endDate: '2026-10-08T10:30:00Z', alertType: 'AIR' },
    { regionId: '1', startDate: '2026-10-08T11:00:00Z', endDate: null, alertType: 'AIR' },
    { regionId: '1', startDate: null, endDate: null, alertType: 'UNKNOWN' },
  ]);
  assert.equal(rows[0].durMin, 30);
  assert.equal(rows[1].ongoing, true);
  assert.equal(rows[1].durMin, null);
  assert.equal(rows[2].start, null, 'missing start never defaulted');
});

test('matchTerritory: oblasts first, min length, capped', () => {
  const oblasts = ['Київська область', 'Львівська область'];
  const dir = [{ regionId: 'd1', regionName: 'Бучанський район', regionType: 'District' }];
  assert.deepEqual(matchTerritory('к', oblasts, dir), []);
  const r = matchTerritory('київ', oblasts, dir);
  assert.equal(r[0].kind, 'oblast');
  assert.equal(matchTerritory('бучан', oblasts, dir)[0].regionId, 'd1');
});

// Complete health: the card list is data-driven, so a test that asserts on a
// position must supply every source it expects to see.
const ALL = (o) => ({ OFFICIAL: o.o, NEPTUN: o.n, MAPA: o.m });
const AT = Date.parse('2026-10-08T12:01:00Z');

test('sourceCards maps ONLINE/DEGRADED/OFFLINE/RECOVERING/STALE explicitly', () => {
  const cards = sourceCards(ALL({
    o: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    n: { status: 'online', updatedAt: '2026-10-08T12:00:00Z', delayed: true },
    m: { status: 'offline', updatedAt: null, error: 'x' },
  }), AT);
  assert.equal(cards[0].state, 'ONLINE');
  assert.equal(cards[1].state, 'DEGRADED');
  assert.equal(cards[2].state, 'OFFLINE');
  const stale = sourceCards(ALL({
    o: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    n: { status: 'online', updatedAt: null },
    m: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
  }), AT);
  assert.equal(stale[1].state, 'STALE');
  const rec = sourceCards(ALL({
    o: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    n: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    m: { status: 'recovering', updatedAt: '2026-10-08T12:00:00Z' },
  }), AT);
  assert.equal(rec[2].state, 'RECOVERING');
  assert.equal(rec[2].label, 'Відновлення');
});

test('a source switched off in configuration has no card at all', () => {
  const off = sourceCards(ALL({
    o: { status: 'disabled', updatedAt: null, error: null },
    n: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    m: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
  }), AT);
  assert.deepEqual(off.map((c) => c.key), ['NEPTUN', 'MAPA'],
    'no UkraineAlarm card, and nothing labelled "Вимкнено"');
  assert.equal(off.some((c) => /UkraineAlarm/.test(c.name)), false);
});

test('a source missing from the payload entirely gets no card', () => {
  const cards = sourceCards({
    NEPTUN: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    MAPA: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
  }, AT);
  assert.deepEqual(cards.map((c) => c.key), ['NEPTUN', 'MAPA']);
  assert.equal(cards.length, 2, 'the retired source is absent from the public UI');
});

test('re-enabling the source brings its card back with no code change', () => {
  const cards = sourceCards(ALL({
    o: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    n: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
    m: { status: 'online', updatedAt: '2026-10-08T12:00:00Z' },
  }), AT);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].key, 'OFFICIAL');
});

test('systemBadge: ok/warn/bad from cards + pipeline age', () => {
  const ok = [{ state: 'ONLINE' }, { state: 'ONLINE' }];
  assert.equal(systemBadge(ok, 60000).level, 'ok');
  assert.equal(systemBadge([{ state: 'ONLINE' }, { state: 'OFFLINE' }], 60000).level, 'warn');
  assert.equal(systemBadge(ok, 31 * 60000).level, 'bad', 'stale pipeline overrides');
  assert.equal(systemBadge(ok, 9 * 60000).level, 'warn', 'a nine-minute delay is never healthy');
  assert.equal(systemBadge([{ state: 'STALE' }], 0).level, 'warn');
  assert.equal(systemBadge([{ state: 'IDLE' }], 0).level, 'bad');
});

test('systemBadge: aggregate follows the two primaries, not the auxiliary source', () => {
  const keyed = (n, m, o) => ([
    { key: 'NEPTUN', state: n }, { key: 'MAPA', state: m }, { key: 'OFFICIAL', state: o },
  ]);
  // Both primaries healthy + a non-primary source offline => still ok.
  assert.equal(systemBadge(keyed('ONLINE', 'ONLINE', 'OFFLINE'), 60000).level, 'ok');
  // One primary down => warn; both down => bad.
  assert.equal(systemBadge(keyed('ONLINE', 'OFFLINE', 'ONLINE'), 60000).level, 'warn');
  assert.equal(systemBadge(keyed('OFFLINE', 'OFFLINE', 'ONLINE'), 60000).level, 'bad');
  // A recovering primary is honest warn, never fake-ok.
  const rec = systemBadge(keyed('RECOVERING', 'ONLINE', 'OFFLINE'), 60000);
  assert.equal(rec.level, 'warn');
  assert.equal(rec.text, 'Відновлення джерела');
});

test('a stopped cron cannot keep source cards online with a cached successful response', () => {
  const cards = sourceCards({
    OFFICIAL: { status: 'online', updatedAt: '2026-10-09T07:45:00Z' },
    NEPTUN: { status: 'online', updatedAt: '2026-10-09T07:45:00Z' },
    MAPA: { status: 'online', updatedAt: '2026-10-09T07:45:00Z' },
  }, Date.parse('2026-10-09T07:54:00Z'));
  assert.equal(cards[2].state, 'STALE');
});

console.log('All overview tests passed!');
