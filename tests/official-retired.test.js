// The official source is retired. These tests pin what the public site must
// now say and show: two monitoring sources, no card, no mention, and no
// dependency left behind in the parts of the UI that used to read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceCards, systemBadge } from '../services/overview.js';
import { overallStatus } from '../services/summary.js';
import { snapshotForRegion, audioTransitions, DEFAULT_AUDIO_PREFS } from '../services/audio.js';
import { deriveNotificationCandidates, DEFAULT_NOTIFICATION_PREFS } from '../services/notifications.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const AT = Date.parse('2026-10-10T02:00:00Z');

// The public pages a visitor can reach. UkraineAlarm must not be advertised on
// any of them; the safety disclaimers ("official signals have priority") stay,
// because they are about the user's safety and are still true.
const PUBLIC_PAGES = [
  'index.html', 'info/index.html', 'sources/index.html', 'faq/index.html',
  'about/index.html', 'how-it-works/index.html', 'safety/index.html',
  'terms/index.html', 'contact/index.html', 'embed/radar/index.html',
];

const health = {
  NEPTUN: { status: 'online', updatedAt: '2026-10-10T01:59:30Z' },
  MAPA: { status: 'online', updatedAt: '2026-10-10T01:59:30Z' },
};

// ── Public copy ────────────────────────────────────────────────────────────
test('no public page advertises the retired source', () => {
  for (const page of PUBLIC_PAGES) {
    assert.ok(fs.existsSync(path.join(root, page)), `${page} exists`);
    const html = read(page);
    assert.ok(!html.includes('UkraineAlarm'), `${page}: no UkraineAlarm in markup or structured data`);
    assert.ok(!/api\.ukrainealarm\.com/i.test(html), `${page}: no provider link`);
  }
});

test('no public script references the retired source', () => {
  for (const file of ['assets/js/dashboard.js', 'assets/js/widget.js', 'radar/radar.js']) {
    assert.ok(!read(file).includes('UkraineAlarm'), `${file}: no retired-source reference`);
  }
});

test('the safety disclaimers survive: official signals still have priority', () => {
  assert.ok(read('index.html').includes('офіційні сповіщення'), 'the radar page still defers to official signals');
  assert.ok(read('faq/index.html').includes('офіційні сигнали'), 'the FAQ still defers to official signals');
});

test('the two monitoring sources are still documented', () => {
  for (const page of ['index.html', 'info/index.html', 'sources/index.html']) {
    const html = read(page);
    assert.ok(html.includes('NEPTUN'), `${page}: NEPTIN documented`);
    assert.ok(html.includes('MAPA'), `${page}: MAPA documented`);
  }
});

// ── The source-status block ────────────────────────────────────────────────
test('the source block shows exactly two cards', () => {
  const cards = sourceCards(health, AT);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.name), ['NEPTUN', 'MAPA']);
  assert.ok(cards.every((c) => c.state === 'ONLINE'));
});

test('a disabled OFFICIAL entry is filtered out, not rendered as offline', () => {
  const cards = sourceCards({ ...health, OFFICIAL: { status: 'disabled', error: null } }, AT);
  assert.equal(cards.length, 2);
  assert.equal(cards.some((c) => c.label === 'Офлайн'), false, 'nothing is reported as offline');
});

test('the overall badge is healthy with only the two monitoring sources', () => {
  const st = overallStatus(health);
  assert.equal(st.level, 'LIVE');
  assert.deepEqual(Object.keys(st.per).sort(), ['MAPA', 'NEPTUN']);
  assert.equal(systemBadge(sourceCards(health, AT), 30000).level, 'ok');
});

test('a monitoring outage is still reported honestly', () => {
  const down = { NEPTUN: { status: 'offline' }, MAPA: { status: 'online', updatedAt: '2026-10-10T01:59:30Z' } };
  assert.equal(overallStatus(down).level, 'PARTIAL');
  const both = { NEPTUN: { status: 'offline' }, MAPA: { status: 'offline' } };
  assert.equal(overallStatus(both).level, 'OFFLINE', 'no false all-clear');
  assert.equal(systemBadge(sourceCards(both, AT), 30000).level, 'bad');
});

// ── Nothing else depended on the retired source ───────────────────────────
test('monitoring sound is unaffected by the retirement', () => {
  const before = snapshotForRegion({ health, alerts: [], events: [] }, 'Одеська область');
  const after = snapshotForRegion({
    health,
    alerts: [{ id: 'n1', source: 'NEPTUN', region: 'Одеська область', category: 'uav' }],
    events: [{ id: 'e1', category: 'uav', region: 'Одеська область' }],
  }, 'Одеська область');
  const sounds = audioTransitions(before, after, { ...DEFAULT_AUDIO_PREFS, enabled: true });
  assert.ok(sounds.includes('uav'), 'a new monitoring contact still sounds');
});

test('official start/end sounds stay gated on a verified official source', () => {
  // Unchanged on purpose: an all-clear we cannot verify must not be claimed.
  // With the source retired the sound stays silent, exactly as it is today
  // while that source is offline.
  const previous = { region: 'Одеська область', officialKnown: true, officialActive: false, eventIds: {} };
  const current = snapshotForRegion({
    health, alerts: [{ id: 'a1', region: 'Одеська область' }], events: [],
  }, 'Одеська область');
  const sounds = audioTransitions(previous, current, { ...DEFAULT_AUDIO_PREFS, enabled: true, officialStart: true });
  assert.equal(sounds.includes('officialStart'), false, 'no unverified all-clear sound');
});

test('monitoring notifications still work with no official source present', () => {
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true, uav: true, myOblast: true };
  const event = {
    id: 'n1', source: 'NEPTUN', category: 'uav', region: 'Одеська область',
    district: 'Уманський район', timestamp: new Date(),
  };
  const current = { alerts: [], events: [event], health };
  const out = deriveNotificationCandidates({ alerts: [], events: [] }, current, {
    oblast: 'Одеська область', raion: 'Уманський район',
  }, prefs);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'uav');
  assert.match(out[0].body, /Моніторингове повідомлення/);
});

test('no notification claims an official all-clear when the source is gone', () => {
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true, officialStart: true };
  const previous = { alerts: [], events: [] };
  const current = { alerts: [], events: [], health };
  const out = deriveNotificationCandidates(previous, current, { oblast: 'Одеська область' }, prefs);
  assert.deepEqual(out, []);
});

// ── Nothing throws on a payload with no OFFICIAL key at all ────────────────
test('every view tolerates a payload with no OFFICIAL entry whatsoever', () => {
  const snapshot = { alerts: [], events: [], health, publishedAt: new Date().toISOString() };
  assert.doesNotThrow(() => sourceCards(snapshot.health, AT));
  assert.doesNotThrow(() => overallStatus(snapshot.health));
  assert.doesNotThrow(() => systemBadge(sourceCards(snapshot.health, AT), 1000));
  assert.doesNotThrow(() => snapshotForRegion(snapshot, 'Київ'));
  assert.doesNotThrow(() => deriveNotificationCandidates(snapshot, snapshot, { oblast: 'Київ' }, DEFAULT_NOTIFICATION_PREFS));
});
