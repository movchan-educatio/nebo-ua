import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_FILTERS, normalizeKind, isNew, isActive, isCompleted, hasCoords,
  applyFeedFilters, radarEvents, countByKind,
} from '../radar/filters.js';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const min = (n) => new Date(NOW - n * 60000).toISOString();
const ev = (o) => ({ id: o.id, kind: o.kind, category: o.category, lat: o.lat, lon: o.lon, areaOnly: o.areaOnly, stale: o.stale, status: o.status, eventTime: o.eventTime, region: o.region, source: o.source });

test('shahed folds into uav; unknown kinds become other', () => {
  assert.equal(normalizeKind(ev({ id: 'a', kind: 'shahed' })), 'uav');
  assert.equal(normalizeKind(ev({ id: 'b', kind: 'missile' })), 'missile');
  assert.equal(normalizeKind(ev({ id: 'c', kind: 'explosion' })), 'other');
  assert.equal(normalizeKind(ev({ id: 'd', kind: 'fpv' })), 'other');
  assert.deepEqual(KIND_FILTERS, ['uav', 'missile', 'ballistic', 'kab', 'aviation', 'other']);
});

test('new = within 10 minutes; stale + ended-out status drive active/completed', () => {
  assert.equal(isNew(ev({ id: 'a', eventTime: min(5) }), NOW), true);
  assert.equal(isNew(ev({ id: 'b', eventTime: min(30) }), NOW), false);
  assert.equal(isNew(ev({ id: 'c' }), NOW), false);
  assert.equal(isActive(ev({ id: 'a', stale: false })), true);
  assert.equal(isActive(ev({ id: 'b', stale: true })), false);
  assert.equal(isActive(ev({ id: 'c', stale: false, status: 'ended' })), false);
  assert.equal(isCompleted(ev({ id: 'd', stale: true })), true);
  assert.equal(isCompleted(ev({ id: 'e', stale: false, status: 'ended' })), true);
  assert.equal(isCompleted(ev({ id: 'f', stale: false })), false);
});

test('feed tabs: all/new/active/completed + coords-only toggle', () => {
  const list = [
    ev({ id: 'fresh', kind: 'uav', lat: 49, lon: 31, stale: false, eventTime: min(3) }),
    ev({ id: 'old', kind: 'uav', lat: 49, lon: 31, stale: false, eventTime: min(60) }),
    ev({ id: 'ended', kind: 'missile', lat: 49, lon: 31, stale: true, eventTime: min(2) }),
    ev({ id: 'region', kind: 'uav', region: 'Київська область', stale: false, eventTime: min(1) }),
  ];
  assert.deepEqual(applyFeedFilters(list, { tab: 'all' }, NOW).map(e => e.id), ['region', 'ended', 'fresh', 'old']);
  assert.deepEqual(applyFeedFilters(list, { tab: 'new' }, NOW).map(e => e.id), ['region', 'ended', 'fresh']);
  assert.deepEqual(applyFeedFilters(list, { tab: 'active' }, NOW).map(e => e.id), ['region', 'fresh', 'old']);
  assert.deepEqual(applyFeedFilters(list, { tab: 'completed' }, NOW).map(e => e.id), ['ended']);
  assert.deepEqual(applyFeedFilters(list, { tab: 'all', onlyWithCoords: true }, NOW).map(e => e.id), ['ended', 'fresh', 'old']);
});

test('kind filter syncs feed and radar; radar drops region-only and area-only', () => {
  const list = [
    ev({ id: 'u1', kind: 'uav', lat: 49, lon: 31, stale: false, eventTime: min(3) }),
    ev({ id: 'm1', kind: 'missile', lat: 49, lon: 31, stale: false, eventTime: min(3) }),
    ev({ id: 'r1', kind: 'uav', region: 'Київська область', stale: false, eventTime: min(1) }),
    ev({ id: 'a1', kind: 'uav', lat: 49, lon: 31, areaOnly: true, stale: false, eventTime: min(1) }),
  ];
  assert.deepEqual(applyFeedFilters(list, { kinds: ['uav'] }, NOW).map(e => e.id), ['r1', 'a1', 'u1']);
  assert.deepEqual(radarEvents(list, { kinds: ['uav'] }, NOW).map(e => e.id), ['u1']);
  assert.deepEqual(radarEvents(list, {}, NOW).map(e => e.id).sort(), ['m1', 'u1']);
});

test('counts feed the filter toggles honestly', () => {
  const list = [ev({ id: 'a', kind: 'shahed' }), ev({ id: 'b', kind: 'missile' }), ev({ id: 'c', kind: 'kab' })];
  assert.deepEqual(countByKind(list), { uav: 1, missile: 1, ballistic: 0, kab: 1, aviation: 0, other: 0 });
});

test('hasCoords never treats area-only as plottable', () => {
  assert.equal(hasCoords(ev({ id: 'a', lat: 49, lon: 31 })), true);
  assert.equal(hasCoords(ev({ id: 'b', lat: 49, lon: 31, areaOnly: true })), false);
  assert.equal(hasCoords(ev({ id: 'c', region: 'X' })), false);
});
