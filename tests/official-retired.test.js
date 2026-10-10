// The official source is gone — not switched off, removed: adapter, config,
// endpoints, pipeline lane and card definition. These tests pin that it cannot
// come back by accident, and that the two monitoring sources plus the official
// alert channel they carry are untouched.
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

test('the source is absent from the entire working tree', () => {
  const skip = new Set(['.git', 'node_modules', '.vercel']);
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(js|mjs|css|html|json|toml|sql|md)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  // These files exist to forbid the name, so they necessarily contain it.
  const guards = new Set([
    'tests/official-retired.test.js',
    'tests/overview.test.js',
    'tests/radar-page.test.js',
  ]);
  const hits = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (guards.has(rel)) continue;
    if (/ukrainealarm/i.test(fs.readFileSync(file, 'utf8'))) hits.push(rel);
  }
  assert.deepEqual(hits, [], 'no file in the repository names the removed source');
});

test('no runtime source, config or schema names the removed lane', () => {
  for (const file of ['backend/src/index.js', 'backend/src/pipeline.js', 'backend/src/store.js',
    'backend/wrangler.toml', 'backend/schema.sql', 'services/overview.js',
    'radar/radar.js', 'assets/js/dashboard.js', 'assets/js/widget.js']) {
    assert.ok(!/OFFICIAL_SOURCE_ENABLED|UKRAINEALARM/i.test(read(file)),
      `${file}: no configuration or lane for the removed source`);
  }
  // The OFFICIAL health key and the OFFICIAL check row are gone with it.
  assert.doesNotMatch(read('backend/src/pipeline.js'), /source: 'OFFICIAL'/);
  assert.doesNotMatch(read('services/overview.js'), /key: 'OFFICIAL'/);
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

test('an OFFICIAL entry in the payload cannot produce a card', () => {
  for (const status of ['disabled', 'online', 'offline']) {
    const cards = sourceCards({ ...health, OFFICIAL: { status, error: null } }, AT);
    assert.equal(cards.length, 2, `no card when the payload reports ${status}`);
    assert.equal(cards.some((c) => c.label === 'Офлайн'), false, 'nothing is reported as offline');
  }
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
test('monitoring sound is unaffected by the removal', () => {
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

test('monitoring notifications still work with only the two monitoring sources', () => {
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
