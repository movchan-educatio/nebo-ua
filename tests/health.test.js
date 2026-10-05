import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flowStats, overallStatus, sourceState } from '../services/summary.js';
import { accuracyTier } from '../services/threatClassify.js';
import { rangeRings, RANGE_PRESETS } from '../assets/js/map.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nowIso = new Date().toISOString();

// ── Semantic source health: LIVE / DELAYED / PARTIAL / OFFLINE ───────────────
test('health LIVE: all sources current', () => {
  const h = {
    NEPTUN: { status: 'online', updatedAt: nowIso, error: null },
    MAPA: { status: 'online', updatedAt: nowIso, error: null },
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
  };
  const st = overallStatus(h);
  assert.equal(st.level, 'LIVE');
  assert.equal(st.per.NEPTUN.state, 'LIVE');
  assert.equal(st.per.MAPA.state, 'LIVE');
  assert.ok(!('OFFICIAL' in st.per), 'disabled sources are not counted');
});

test('health DELAYED: backend stale flag means old data, not a dead source', () => {
  const h = {
    NEPTUN: { status: 'offline', updatedAt: null, error: null, delayed: true },
    MAPA: { status: 'online', updatedAt: nowIso, error: null },
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
  };
  const st = overallStatus(h);
  assert.equal(st.level, 'DELAYED');
  assert.equal(st.per.NEPTUN.state, 'DELAYED', 'delayed != offline');
  assert.equal(st.per.MAPA.state, 'LIVE');
});

test('health PARTIAL: one source really down, others work', () => {
  const h = {
    NEPTUN: { status: 'offline', updatedAt: null, error: 'timeout' },
    MAPA: { status: 'online', updatedAt: nowIso, error: null },
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
  };
  const st = overallStatus(h);
  assert.equal(st.level, 'PARTIAL');
  assert.equal(st.per.NEPTUN.state, 'DOWN');
});

test('health OFFLINE: no usable monitoring data at all', () => {
  const h = {
    NEPTUN: { status: 'offline', updatedAt: null, error: 'timeout' },
    MAPA: { status: 'offline', updatedAt: null, error: 'reset' },
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
  };
  assert.equal(overallStatus(h).level, 'OFFLINE');
});

test('delayed != offline: flag decides, not status alone', () => {
  const staleFeed = sourceState('NEPTUN', { status: 'offline', updatedAt: null, error: null, delayed: true });
  const deadFeed = sourceState('NEPTUN', { status: 'offline', updatedAt: null, error: 'timeout' });
  assert.equal(staleFeed.state, 'DELAYED');
  assert.equal(deadFeed.state, 'DOWN');
  assert.notEqual(staleFeed.state, deadFeed.state);
});

test('real snapshot shape: NEPTUN offline+delayed, MAPA online -> DELAYED (not OFFLINE, no red banner)', () => {
  const h = {
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
    NEPTUN: { status: 'offline', updatedAt: null, error: null, delayed: true },
    MAPA: { status: 'online', updatedAt: nowIso, error: null },
  };
  const st = overallStatus(h);
  assert.equal(st.level, 'DELAYED');
  assert.notEqual(st.level, 'OFFLINE');
});

// ── Coordinate count vs rendered count ────────────────────────────────────────
function exactUav(id, stale = false) {
  return {
    id, source: 'MAPA', category: 'uav', kind: null, subtype: 'Дрон',
    lat: 51.5, lon: 32.2, region: null, district: null, settlement: null,
    locationPrecision: 'COORDINATE', areaOnly: false, heading: 224, speed: 165,
    stale, official: false,
  };
}

test('coordinate count != rendered count when stale filter hides tracks', () => {
  const events = [];
  for (let i = 0; i < 30; i++) events.push(exactUav('mapa:s' + i, true));
  for (let i = 0; i < 2; i++) events.push(exactUav('mapa:f' + i, false));
  const all = flowStats(events, { onlyFresh: false });
  const rendered = flowStats(events);
  assert.equal(all.exactTotal, 32, 'received coordinate records');
  assert.equal(rendered.exactTotal, 2, 'actually renderable under fresh-only default');
  assert.equal(rendered.suppressed, 30, 'suppressed count is explicit, never silently dropped');
  assert.notEqual(all.exactTotal, rendered.exactTotal);
});

test('visible-category filter matches the layer toggles', () => {
  const events = [exactUav('a'), { ...exactUav('b'), category: 'kab', kind: 'kab' }];
  const s = flowStats(events, { visible: new Set(['kab']) });
  assert.equal(s.uav, 0);
  assert.equal(s.kab, 1);
  assert.equal(s.exactTotal, 1);
});

// ── Marker eligibility across the full pipeline ───────────────────────────────
test('marker eligibility: exact+fresh renders; stale/area/report do not', () => {
  const fresh = exactUav('f');
  const stale = exactUav('s', true);
  const area = { ...exactUav('a'), areaOnly: true, locationPrecision: 'RAION', district: 'Сумський район' };
  const noCoords = { ...exactUav('n'), lat: null, lon: null, locationPrecision: 'UNKNOWN' };
  assert.equal(accuracyTier(fresh), 'exact');
  assert.equal(flowStats([fresh]).exactTotal, 1);
  assert.equal(flowStats([stale]).exactTotal, 0, 'stale hidden by default fresh filter');
  assert.equal(flowStats([area]).exactTotal, 0, 'area precision never becomes a point');
  assert.equal(flowStats([noCoords]).exactTotal, 0, 'no coords, no marker');
  assert.equal(flowStats([stale], { onlyFresh: false }).exactTotal, 1, 'stale renders when filter is off');
});

// ── Radar ranges: presets 1/3/5/10/25/100 + ring sets ────────────────────────
test('range presets are exactly 1/3/5/10/25/100', () => {
  assert.deepEqual(RANGE_PRESETS, [1, 3, 5, 10, 25, 100]);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const r of [1, 3, 5, 10, 25, 100]) {
    assert.ok(html.includes(`data-range="${r}"`), `preset button ${r} km exists`);
  }
  assert.ok(!html.includes('data-range="50"'), 'old 50 km preset removed');
  assert.ok(!html.includes('data-range="1500"'), 'old 1500 km preset removed');
});

test('rangeRings: logical ring sets per range', () => {
  assert.deepEqual(rangeRings(1), [0.25, 0.5, 1]);
  assert.deepEqual(rangeRings(3), [1, 2, 3]);
  assert.deepEqual(rangeRings(5), [1, 3, 5]);
  assert.deepEqual(rangeRings(10), [1, 3, 5, 10]);
  assert.deepEqual(rangeRings(25), [5, 10, 25]);
  assert.deepEqual(rangeRings(100), [25, 50, 100]);
});

test('rangeRings: legacy/unknown ranges degrade gracefully', () => {
  assert.deepEqual(rangeRings(200), [25, 50, 100, 200]);
  assert.ok(rangeRings(NaN).length > 0);
});

test('radar render uses the selected range (no fixed rings)', () => {
  const src = fs.readFileSync(path.join(root, 'assets/js/map.js'), 'utf8');
  assert.ok(!src.includes('[25,50,100,200].forEach'), 'fixed ring set removed');
  assert.ok(src.includes('rangeRings(opts.range'), 'rings follow the selected range');
});

console.log('All health/radar tests passed!');
