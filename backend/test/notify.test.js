import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relevanceForPush, categoryOf, quietActive, shouldDeliver,
  buildPayload, diffStarted, validateSubscribe, CRITICAL,
} from '../src/notify.js';

const place = { oblast: 'Черкаська область', raion: 'Уманський район', settlement: 'Дмитрушки' };

test('relevance degrades gracefully without finer data', () => {
  assert.equal(relevanceForPush({ region: 'Черкаська область', district: 'Уманський район', settlement: 'Дмитрушки' }, place), 'DIRECT');
  assert.equal(relevanceForPush({ region: 'Черкаська область', district: 'Уманський район' }, place), 'RAION');
  assert.equal(relevanceForPush({ region: 'Черкаська область' }, place), 'OBLAST');
  assert.equal(relevanceForPush({ region: 'Одеська область' }, place), 'OUTSIDE');
  assert.equal(relevanceForPush({}, place), 'OUTSIDE');
  assert.equal(relevanceForPush({ region: 'Черкаська область' }, null), 'UNKNOWN');
});

test('ballistic keeps its own push category', () => {
  assert.equal(categoryOf({ official: false, category: 'ballistic' }), 'ballistic');
  assert.equal(categoryOf({ official: false, category: 'missile' }), 'missile');
  assert.equal(categoryOf({ official: false, category: 'recon' }), null);
  assert.equal(categoryOf({ official: true }, false), 'officialStart');
  assert.equal(categoryOf({ official: true }, true), 'officialEnd');
});

test('quiet hours handle overnight windows, critical bypasses', () => {
  const night = new Date('2026-10-04T23:30:00');
  const day = new Date('2026-10-04T12:00:00');
  const q = { enabled: true, start: '23:00', end: '07:00' };
  assert.equal(quietActive(q, night), true);
  assert.equal(quietActive(q, day), false);
  assert.equal(quietActive({ enabled: false }, night), false);
  assert.ok(CRITICAL.has('ballistic') && CRITICAL.has('missile') && CRITICAL.has('officialStart'));
  assert.ok(!CRITICAL.has('officialEnd') && !CRITICAL.has('uav'));
});

test('shouldDeliver gates category, place, age and quiet', () => {
  const sub = {
    created_at: '2026-10-04T12:00:00Z',
    places: [place],
    categories: { uav: true, missile: false },
    quiet: { enabled: true, start: '23:00', end: '07:00' },
  };
  const ev = { region: 'Черкаська область', district: 'Уманський район', source: 'NEPTUN' };
  const night = new Date('2026-10-04T23:30:00');
  const day = new Date('2026-10-04T12:00:00');
  assert.equal(shouldDeliver({ ...sub, categories: { uav: false } }, ev, 'uav', { now: day }), 'skipped-category');
  assert.equal(shouldDeliver(sub, { region: 'Одеська область' }, 'uav', { now: day }), 'skipped-place');
  assert.equal(shouldDeliver(sub, ev, 'uav', { now: day, firstSeen: '2026-10-04T11:00:00Z' }), 'skipped-old');
  assert.equal(shouldDeliver(sub, ev, 'uav', { now: night, firstSeen: '2026-10-04T12:30:00Z' }), 'skipped-quiet');
  assert.equal(shouldDeliver(sub, ev, 'missile', { now: night, firstSeen: '2026-10-04T12:30:00Z' }), 'skipped-category');
  assert.equal(shouldDeliver({ ...sub, categories: { uav: true, missile: true } }, ev, 'missile', { now: night, firstSeen: '2026-10-04T12:30:00Z' }), null);
  assert.equal(shouldDeliver(sub, ev, 'uav', { now: day, firstSeen: '2026-10-04T12:30:00Z' }), null);
});

test('payloads carry red level for alerts', () => {
  const p = buildPayload('officialStart', { region: 'Черкаська область', district: 'Уманський район' });
  assert.equal(p.title, 'Повітряна тривога');
  assert.equal(p.level, 'red');
  assert.match(p.tag, /^alert-start:/);
  const t = buildPayload('threat', { id: 'x', category: 'uav', source: 'MAPA', region: 'R' });
  assert.match(t.title, /БПЛА/);
});

test('diffStarted ignores everything on first run', () => {
  assert.deepEqual(diffStarted(null, [{ id: 'a' }]), []);
  assert.deepEqual(diffStarted([], [{ id: 'a' }]).map(e => e.id), ['a']);
  assert.deepEqual(diffStarted(['a'], [{ id: 'a' }, { id: 'b' }]).map(e => e.id), ['b']);
});

test('validateSubscribe rejects garbage, caps places', () => {
  const bad = validateSubscribe({});
  assert.equal(bad.ok, false);
  const many = Array.from({ length: 20 }, (_, i) => ({ oblast: 'Область ' + i }));
  const good = validateSubscribe({
    subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } },
    places: many,
    categories: { uav: false },
  });
  assert.equal(good.ok, true);
  assert.equal(good.places.length, 10);
  assert.equal(good.categories.uav, false);
  assert.equal(good.categories.missile, true);
});
