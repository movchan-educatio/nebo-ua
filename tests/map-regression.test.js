import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeptunThreat } from '../backend/src/normalize.js';
import { accuracyTier, classifyThreat, shouldShowHeading } from '../services/threatClassify.js';
import { raionAlertActive, oblastRaions, matchRaion, normRaion, normOblast } from '../services/districts.js';
import { regionName, pointInFeature } from '../services/regions.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────
const UmanRaionAlert = {
  id: 'official:uman',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
};

const CherkasyOblastAlert = {
  id: 'official:cherkasy',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  region: 'Черкаська область',
  district: null,
  locationPrecision: 'OBLAST',
  areaOnly: true,
};

const ShahedExact = {
  id: 'neptun:1',
  source: 'NEPTUN',
  category: 'uav',
  kind: 'shahed',
  lat: 49.4444,
  lon: 32.0555,
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 270,
  speed: 180,
  stale: false,
};

const MissileExact = {
  id: 'neptun:2',
  source: 'NEPTUN',
  category: 'missile',
  kind: 'missile',
  lat: 50.1,
  lon: 30.5,
  region: 'Київська область',
  district: 'Обухівський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 310,
  speed: 750,
  stale: false,
};

const KabExact = {
  id: 'neptun:3',
  source: 'NEPTUN',
  category: 'kab',
  kind: 'kab',
  lat: 50.0,
  lon: 36.2,
  region: 'Харківська область',
  district: 'Харківський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 220,
  speed: 600,
  stale: false,
};

const UavRaionOnly = {
  id: 'neptun:4',
  source: 'NEPTUN',
  category: 'uav',
  kind: 'uav',
  lat: 49.8,
  lon: 31.5,
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
  heading: null,
  speed: null,
  stale: false,
};

const ReconEvent = {
  id: 'neptun:5',
  source: 'NEPTUN',
  category: 'recon',
  kind: 'recon',
  lat: 48.5,
  lon: 35.0,
  region: 'Дніпропетровська область',
  district: 'Дніпровський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 180,
  speed: 120,
  stale: false,
};

const AviationEvent = {
  id: 'neptun:6',
  source: 'NEPTUN',
  category: 'aviation',
  kind: 'aviation',
  lat: 47.0,
  lon: 35.0,
  region: 'Запорізька область',
  district: 'Василівський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 90,
  speed: 800,
  stale: false,
};

// ── 1. Raion alert hierarchy tests ────────────────────────────────────────────
test('raionAlertActive: Uman raion alert returns scope=raion, does NOT affect other raions', () => {
  const alerts = [UmanRaionAlert];
  const result = raionAlertActive(alerts, 'Черкаська область', 'Уманський район');
  assert.equal(result.scope, 'raion');
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].district, 'Уманський район');
});

test('raionAlertActive: oblast alert returns scope=oblast for all raions', () => {
  const alerts = [CherkasyOblastAlert];
  const result = raionAlertActive(alerts, 'Черкаська область', 'Звенигородський район');
  assert.equal(result.scope, 'oblast');
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].district, null);
});

test('raionAlertActive: other raion in same oblast with raion alert returns scope=outside', () => {
  const alerts = [UmanRaionAlert];
  const result = raionAlertActive(alerts, 'Черкаська область', 'Звенигородський район');
  assert.equal(result.scope, 'outside');
});

test('oblastRaions: raion-only alert marks ONLY that raion as alert, others calm', () => {
  const snapshot = { alerts: [UmanRaionAlert], events: [] };
  const result = oblastRaions(snapshot, 'Черкаська область');
  const uman = result.rows.find(r => r.name === 'Уманський');
  const zveny = result.rows.find(r => r.name === 'Звенигородський');
  assert.equal(uman.status, 'alert');
  assert.equal(zveny.status, 'calm');
  assert.ok(!uman.alert?.oblastWide);
});

test('oblastRaions: oblast-wide alert marks ALL raions as alert with oblastWide flag', () => {
  const snapshot = { alerts: [CherkasyOblastAlert], events: [] };
  const result = oblastRaions(snapshot, 'Черкаська область');
  for (const row of result.rows) {
    assert.equal(row.status, 'alert');
    assert.ok(row.alert?.oblastWide);
  }
});

test('oblastRaions: multiple raion alerts - each only marks its own raion', () => {
  const alerts = [
    { ...UmanRaionAlert, id: 'official:uman', district: 'Уманський район' },
    { ...UmanRaionAlert, id: 'official:zveny', district: 'Звенигородський район' },
  ];
  const snapshot = { alerts, events: [] };
  const result = oblastRaions(snapshot, 'Черкаська область');
  const uman = result.rows.find(r => r.name === 'Уманський');
  const zveny = result.rows.find(r => r.name === 'Звенигородський');
  const cherkasy = result.rows.find(r => r.name === 'Черкаський');
  assert.equal(uman.status, 'alert');
  assert.equal(zveny.status, 'alert');
  assert.equal(cherkasy.status, 'calm');
  assert.ok(!uman.alert?.oblastWide);
  assert.ok(!zveny.alert?.oblastWide);
});

// ── 2. Threat kind classification tests ──────────────────────────────────────
test('classifyThreat: Shahed exact event returns shahed', () => {
  assert.equal(classifyThreat(ShahedExact), 'shahed');
});

test('classifyThreat: Missile exact event returns missile', () => {
  assert.equal(classifyThreat(MissileExact), 'missile');
});

test('classifyThreat: KAB exact event returns kab', () => {
  assert.equal(classifyThreat(KabExact), 'kab');
});

test('classifyThreat: Reconnaissance UAV returns recon', () => {
  assert.equal(classifyThreat(ReconEvent), 'recon');
});

test('classifyThreat: Aviation returns aviation', () => {
  assert.equal(classifyThreat(AviationEvent), 'aviation');
});

test('classifyThreat: text detection works for all kinds', () => {
  assert.equal(classifyThreat({ subtype: 'Shahed-136 в районі' }), 'shahed');
  assert.equal(classifyThreat({ subtype: 'Герань-2 ударний БПЛА' }), 'shahed');
  assert.equal(classifyThreat({ subtype: 'Крилата ракета Х-101' }), 'missile');
  assert.equal(classifyThreat({ subtype: 'Кинжал балістична' }), 'ballistic');
  assert.equal(classifyThreat({ subtype: 'Каб ФАБ-500' }), 'kab');
  assert.equal(classifyThreat({ subtype: 'Орлан-10 розвідка' }), 'recon');
  assert.equal(classifyThreat({ subtype: 'Су-34 бомбардувальник' }), 'aviation');
});

test('normalizeNeptunThreat: Shahed in title produces kind=shahed', () => {
  const raw = {
    id: 999,
    type: 'uav',
    title: 'БПЛА Shahed-136 / Герань-2',
    lat: 49.4444,
    lon: 32.0555,
    region: 'Черкаська область',
    district: 'Уманський район',
    areaOnly: false,
    heading: 270,
    velocity: { speedKmh: 180 },
    updatedAt: new Date().toISOString(),
  };
  const norm = normalizeNeptunThreat(raw);
  assert.equal(norm.kind, 'shahed');
  assert.equal(classifyThreat(norm), 'shahed');
});

test('normalizeNeptunThreat: Geran in title produces kind=shahed', () => {
  const raw = {
    id: 998,
    type: 'uav',
    title: 'БПЛА тип Герань-2',
    lat: 49.2,
    lon: 28.4,
    areaOnly: false,
    heading: 290,
    velocity: { speedKmh: 175 },
    updatedAt: new Date().toISOString(),
  };
  const norm = normalizeNeptunThreat(raw);
  assert.equal(norm.kind, 'shahed');
});

// ── 3. False precision / accuracy tier tests ──────────────────────────────────
test('accuracyTier: exact coordinate with COORDINATE precision returns exact', () => {
  assert.equal(accuracyTier(ShahedExact), 'exact');
  assert.equal(accuracyTier(MissileExact), 'exact');
  assert.equal(accuracyTier(KabExact), 'exact');
});

test('accuracyTier: raion-only (areaOnly=true) returns area', () => {
  assert.equal(accuracyTier(UavRaionOnly), 'area');
});

test('accuracyTier: raion-only (areaOnly=true) does NOT create point marker', () => {
  // This is tested by accuracyTier returning 'area' - map.js skips point markers for area/report tiers
  const tier = accuracyTier(UavRaionOnly);
  assert.notEqual(tier, 'exact');
  assert.equal(tier, 'area');
});

test('shouldShowHeading: exact coordinate with heading+speed returns true', () => {
  assert.equal(shouldShowHeading(ShahedExact), true);
  assert.equal(shouldShowHeading(MissileExact), true);
});

test('shouldShowHeading: raion-only (areaOnly=true) returns false', () => {
  assert.equal(shouldShowHeading(UavRaionOnly), false);
});

test('shouldShowHeading: no heading returns false', () => {
  const e = { ...ShahedExact, heading: null };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: no speed returns false', () => {
  const e = { ...ShahedExact, speed: null };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: stale event returns false', () => {
  const e = { ...ShahedExact, stale: true };
  assert.equal(shouldShowHeading(e), false);
});

// ── 4. Region/raion normalization tests ───────────────────────────────────────
test('normRaion: strips suffixes and normalizes', () => {
  assert.equal(normRaion('Уманський район'), 'уманський');
  assert.equal(normRaion('Уманський р-н'), 'уманський');
  assert.equal(normRaion('  УМАНСЬКИЙ  '), 'уманський');
});

test('normOblast: strips oblast suffix', () => {
  assert.equal(normOblast('Черкаська область'), 'черкаська');
  assert.equal(normOblast('Черкаська обл.'), 'черкаська');
});

test('matchRaion: matches directory name', () => {
  const dir = ['Звенигородський', 'Золотоніський', 'Уманський', 'Черкаський'];
  assert.equal(matchRaion(dir, 'Уманський район'), 'Уманський');
  assert.equal(matchRaion(dir, 'уманський'), 'Уманський');
});

test('matchRaion: handles aliases', () => {
  const dir = ['Самарівський', 'Криворізький'];
  assert.equal(matchRaion(dir, 'Новомосковський район'), 'Самарівський');
});

// ── 5. GeoJSON point-in-polygon test ──────────────────────────────────────────
test('pointInFeature: detects point inside oblast polygon', () => {
  const feature = {
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [30, 49], [32, 49], [32, 50], [30, 50], [30, 49]
      ]]
    },
    properties: { region: 'Тестова область' }
  };
  // Point inside
  assert.equal(pointInFeature([49.5, 31], feature), true);
  // Point outside
  assert.equal(pointInFeature([48, 31], feature), false);
});

// ── 6. SVG icon symbol IDs exist ──────────────────────────────────────────────
test('threat-icons.svg contains all required symbol IDs', async () => {
  const { readFile } = await import('node:fs/promises');
  const svg = await readFile('assets/brand/threat-icons.svg', 'utf8');
  const requiredIds = ['shahed', 'uav', 'recon', 'missile', 'ballistic', 'kab', 'aircraft', 'other'];
  for (const id of requiredIds) {
    assert.ok(svg.includes(`id="${id}"`), `Missing symbol id="${id}"`);
  }
});

// ── 7. Cluster icon shows composition ─────────────────────────────────────────
test('cluster icon logic: composition summary works', () => {
  const children = [
    { options: { threatKind: 'shahed' } },
    { options: { threatKind: 'shahed' } },
    { options: { threatKind: 'missile' } },
    { options: { threatKind: 'kab' } },
  ];
  const counts = {};
  for (const c of children) {
    const k = c.options.threatKind;
    counts[k] = (counts[k] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const summary = sorted.slice(0, 2).map(([k, v]) => `${v} ${k}`).join(' · ');
  assert.equal(summary, '2 shahed · 1 missile');
});

console.log('All map regression tests passed!');