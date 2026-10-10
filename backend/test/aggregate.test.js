import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeptunThreat, normalizeMapa, normalizeAlert, isFreshEvent } from '../src/normalize.js';
import { correlate, fuse } from '../src/fuse.js';
import { protectAlerts, protectThreats } from '../src/protect.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();

test('neptun threat carries event time, latency and confidence', () => {
  const e = normalizeNeptunThreat(
    { id: 'a', type: 'uav', lat: 49, lon: 31, status: 'active', updatedAt: iso(1), confidenceLevel: 'high' },
    NOW,
  );
  assert.equal(e.id, 'neptun:a');
  assert.equal(e.eventTime, iso(1));
  assert.equal(e.latencyMs, 60000);
  assert.equal(e.confidence, 'high');
  assert.equal(e.stale, false);
});

test('missile freshness window is 2 minutes, uav 5 minutes', () => {
  assert.equal(isFreshEvent('missile', iso(1), NOW.getTime()), true);
  assert.equal(isFreshEvent('missile', iso(3), NOW.getTime()), false);
  assert.equal(isFreshEvent('uav', iso(4), NOW.getTime()), true);
  assert.equal(isFreshEvent('uav', iso(6), NOW.getTime()), false);
  assert.equal(isFreshEvent('uav', null, NOW.getTime()), false);
});

test('mapa only accepts active records with real coordinates', () => {
  assert.equal(normalizeMapa({ id: 1, kind: 'drone_piston', status: 'lost', lat: 49, lon: 31 }, NOW), null);
  const e = normalizeMapa({ id: 2, kind: 'drone_piston', status: 'active', lat: 49, lon: 31, last_seen: 1790973000 }, NOW);
  assert.equal(e.id, 'mapa:2');
  assert.equal(e.category, 'uav');
});

test('air-raid alert shape normalizes raion and oblast', () => {
  const r = normalizeAlert({ key: 'uman', name: 'Уманський район', oblast: 'Черкаська область', since: iso(10), reasons: ['Повітряна тривога'] }, NOW);
  assert.equal(r.region, 'Черкаська область');
  assert.equal(r.district, 'Уманський район');
  // One alert source remains, and it is attributed honestly.
  assert.equal(r.source, 'NEPTUN / офіційні канали');
  assert.equal(r.official, true, 'air-raid alerts still drive the official channel');
  assert.equal(r.latencyMs, 600000);
});

test('correlate merges cross-source neighbours, fuse merges radius', () => {
  const at = iso(1);
  const mk = (id, source, lat, lon) => ({ id, source, category: 'uav', timestamp: undefined, eventTime: at, lat, lon, region: null });
  const r = correlate([mk('a', 'NEPTUN', 49, 31), mk('b', 'MAPA', 49.05, 31.05)]);
  assert.equal(r.length, 1);
  assert.equal(r[0].confirmed, true);
  const f = fuse([
    { id: 'a', source: 'NEPTUN', category: 'uav', eventTime: at, lat: 49, lon: 31 },
    { id: 'b', source: 'NEPTUN', category: 'uav', eventTime: at, lat: 49.02, lon: 31.02 },
    { id: 'c', source: 'MAPA', category: 'missile', eventTime: at, lat: 49.01, lon: 31.01 },
  ]);
  assert.equal(f.length, 2);
  assert.equal(f.find(x => x.category === 'uav').fusedCount, 2);
});

test('alerts survive short gaps, close after the miss limit', () => {
  const a = { id: 'official:x', region: 'R' };
  let p = protectAlerts([], [a], 3);
  assert.equal(p.active.length, 1);
  assert.equal(p.active[0].misses, 0);
  p = protectAlerts(p.active, [], 3);
  assert.equal(p.active.length, 1);
  assert.equal(p.active[0].stale, true);
  p = protectAlerts(p.active, [], 3);
  assert.equal(p.active.length, 1);
  p = protectAlerts(p.active, [], 3);
  assert.equal(p.active.length, 0);
  assert.equal(p.ended.length, 1);
});

test('threats go stale after one miss', () => {
  const e = { id: 'neptun:1' };
  let p = protectThreats([], [e], 3);
  assert.equal(p.active[0].stale || false, false);
  p = protectThreats(p.active, [], 3);
  assert.equal(p.active.length, 1);
  assert.equal(p.active[0].stale, true);
});
