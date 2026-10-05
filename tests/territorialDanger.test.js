import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeptunThreat, normalizeMapa } from '../backend/src/normalize.js';
import { classifyThreat, accuracyTier, shouldShowHeading } from '../services/threatClassify.js';
import { raionAlertActive, oblastRaions, matchRaion, territorialDanger } from '../services/districts.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────
const UmanRaionShahed = {
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
  official: false,
};

const UmanRaionShahedAreaOnly = {
  id: 'neptun:2',
  source: 'NEPTUN',
  category: 'uav',
  kind: 'shahed',
  lat: 49.8,
  lon: 31.5,
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
  heading: null,
  speed: null,
  stale: false,
  official: false,
};

// Missile with raion scope (district set): scope-driven rule -> raion fill, NOT oblast.
const CherkasyRaionMissile = {
  id: 'neptun:3',
  source: 'NEPTUN',
  category: 'missile',
  kind: 'missile',
  lat: 50.1,
  lon: 30.5,
  region: 'Черкаська область',
  district: 'Черкаський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
  heading: 310,
  speed: 750,
  stale: false,
  official: false,
};

// Missile with oblast scope (district==null): whole oblast.
const CherkasyOblastMissile = {
  id: 'neptun:3b',
  source: 'NEPTUN',
  category: 'missile',
  kind: 'missile',
  lat: null,
  lon: null,
  region: 'Черкаська область',
  district: null,
  locationPrecision: 'OBLAST',
  areaOnly: true,
  heading: null,
  speed: null,
  stale: false,
  official: false,
};

// Ballistic with oblast scope (district==null): whole oblast.
const CherkasyOblastBallistic = {
  id: 'neptun:4',
  source: 'NEPTUN',
  category: 'ballistic',
  kind: 'ballistic',
  lat: null,
  lon: null,
  region: 'Черкаська область',
  district: null,
  locationPrecision: 'OBLAST',
  areaOnly: true,
  heading: null,
  speed: null,
  stale: false,
  official: false,
};

const OfficialOblastAlert = {
  id: 'official:cherkasy',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  region: 'Черкаська область',
  district: null,
  locationPrecision: 'OBLAST',
  areaOnly: true,
};

const OfficialRaionAlert = {
  id: 'official:uman',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
};

const OfficialRaionMissileAlert = {
  id: 'official:uman-missile',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  subtype: 'Ракетна загроза (червоний рівень)',
  level: 'red',
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
};

const OfficialRaionDroneAlert = {
  id: 'official:uman-drone',
  source: 'NEPTUN / офіційні канали',
  official: true,
  category: 'alert',
  subtype: 'Дронова загроза (жовтий рівень)',
  level: 'yellow',
  region: 'Черкаська область',
  district: 'Уманський район',
  locationPrecision: 'RAION',
  areaOnly: true,
};

const KabRaionOnly = {
  id: 'neptun:5',
  source: 'NEPTUN',
  category: 'kab',
  kind: 'kab',
  lat: 50.0,
  lon: 36.2,
  region: 'Харківська область',
  district: 'Харківський район',
  locationPrecision: 'RAION',
  areaOnly: true,
  heading: 220,
  speed: 600,
  stale: false,
  official: false,
};

const ReconRaionOnly = {
  id: 'neptun:6',
  source: 'NEPTUN',
  category: 'recon',
  kind: 'recon',
  lat: 48.5,
  lon: 35.0,
  region: 'Дніпропетровська область',
  district: 'Дніпровський район',
  locationPrecision: 'RAION',
  areaOnly: true,
  heading: 180,
  speed: 120,
  stale: false,
  official: false,
};

const AviationRaionOnly = {
  id: 'neptun:7',
  source: 'NEPTUN',
  category: 'aviation',
  kind: 'aviation',
  lat: 47.0,
  lon: 35.0,
  region: 'Запорізька область',
  district: 'Василівський район',
  locationPrecision: 'RAION',
  areaOnly: true,
  heading: 90,
  speed: 800,
  stale: false,
  official: false,
};

const fillsFor = (oblast, fills) => fills.filter(f => f.oblast === oblast);

// ── Scope is driven by district presence, never invented from threat type ─────
test('Missile with oblast scope (district==null) -> whole oblast', () => {
  const { oblasts, fills } = territorialDanger([], [CherkasyOblastMissile]);
  assert.ok(oblasts.includes('Черкаська область'));
  assert.equal(fills.length, 0);
});

test('Missile with raion scope (district set) -> raion fill only, NEVER oblast', () => {
  const { oblasts, fills } = territorialDanger([], [CherkasyRaionMissile]);
  assert.equal(oblasts.length, 0, 'district threat must not activate the oblast');
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Черкаський район', level: 'critical' }]);
});

test('Ballistic with oblast scope (district==null) -> whole oblast', () => {
  const { oblasts, fills } = territorialDanger([], [CherkasyOblastBallistic]);
  assert.ok(oblasts.includes('Черкаська область'));
  assert.equal(fills.length, 0);
});

test('Shahed with raion precision (areaOnly) -> raion fill only, NEVER oblast', () => {
  const { oblasts, fills } = territorialDanger([], [UmanRaionShahedAreaOnly]);
  assert.equal(oblasts.length, 0, 'No oblast danger for Shahed raion');
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'high' }]);
});

test('Shahed with exact coordinates (areaOnly=false) -> NO territorial fill (markers only)', () => {
  const { oblasts, fills } = territorialDanger([], [UmanRaionShahed]);
  assert.equal(oblasts.length, 0);
  assert.equal(fills.length, 0, 'exact-coordinate threats create point markers, not territorial fills');
});

test('UAV with raion precision -> raion fill only', () => {
  const uavRaion = { ...UmanRaionShahedAreaOnly, kind: 'uav', category: 'uav' };
  const { oblasts, fills } = territorialDanger([], [uavRaion]);
  assert.equal(oblasts.length, 0);
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'high' }]);
});

test('Official oblast-wide alert (no district) -> whole oblast', () => {
  const { oblasts, fills } = territorialDanger([OfficialOblastAlert], []);
  assert.ok(oblasts.includes('Черкаська область'));
  assert.equal(fills.length, 0);
});

test('Official raion alert without red level -> orange high fill, NEVER oblast', () => {
  const { oblasts, fills } = territorialDanger([OfficialRaionAlert], []);
  assert.equal(oblasts.length, 0, 'raion alert must not activate the oblast');
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'high' }]);
});

test('Official raion alert with red missile level -> red critical fill (source-confirmed)', () => {
  const { oblasts, fills } = territorialDanger([OfficialRaionMissileAlert], []);
  assert.equal(oblasts.length, 0, 'raion alert must not activate the oblast');
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'critical' }]);
});

test('Official raion alert with yellow drone level -> orange high fill', () => {
  const { oblasts, fills } = territorialDanger([OfficialRaionDroneAlert], []);
  assert.equal(oblasts.length, 0);
  assert.deepEqual(fills, [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'high' }]);
});

test('KAB with raion precision -> raion fill only', () => {
  const { oblasts, fills } = territorialDanger([], [KabRaionOnly]);
  assert.equal(oblasts.length, 0);
  assert.deepEqual(fills, [{ oblast: 'Харківська область', district: 'Харківський район', level: 'high' }]);
});

test('areaOnly monitor WITHOUT district -> NO fill (never invent a raion, never auto-paint oblast)', () => {
  const oblastUav = { ...UmanRaionShahedAreaOnly, district: null, locationPrecision: 'OBLAST' };
  const { oblasts, fills } = territorialDanger([], [oblastUav]);
  assert.equal(oblasts.length, 0);
  assert.equal(fills.length, 0);
});

// ── Priority: oblast danger coexists with raion fills (raion info on top) ─────
test('Oblast missile + raion alerts/fills -> oblast kept, raion fills scoped to their raions', () => {
  const { oblasts, fills } = territorialDanger([OfficialRaionMissileAlert], [CherkasyOblastMissile, KabRaionOnly]);
  assert.ok(oblasts.includes('Черкаська область'), 'oblast-scope missile activates the oblast');
  assert.ok(!oblasts.includes('Харківська область'), 'Kharkiv has only a raion fill, not oblast danger');
  assert.deepEqual(
    fills.filter(f => f.district === 'Уманський район'),
    [{ oblast: 'Черкаська область', district: 'Уманський район', level: 'critical' }],
  );
  assert.deepEqual(fillsFor('Харківська область', fills), [{ oblast: 'Харківська область', district: 'Харківський район', level: 'high' }]);
});

// ── Recon/Aviation raion -> medium ────────────────────────────────────────────
test('Recon with raion precision -> medium fill', () => {
  const { oblasts, fills } = territorialDanger([], [ReconRaionOnly]);
  assert.equal(oblasts.length, 0);
  assert.deepEqual(fills, [{ oblast: 'Дніпропетровська область', district: 'Дніпровський район', level: 'medium' }]);
});

test('Aviation with raion precision -> medium fill', () => {
  const { oblasts, fills } = territorialDanger([], [AviationRaionOnly]);
  assert.equal(oblasts.length, 0);
  assert.deepEqual(fills, [{ oblast: 'Запорізька область', district: 'Василівський район', level: 'medium' }]);
});

test('Real-data level split: red missile alerts -> critical, yellow drone alerts -> high', () => {
  const alerts = [
    { region: 'Донецька область', district: 'Бахмутський район', level: 'red', subtype: 'Ракетна загроза (червоний рівень)' },
    { region: 'Запорізька область', district: 'Бердянський район', level: 'yellow', subtype: 'Дронова загроза (жовтий рівень)' },
    { region: 'Сумська область', district: 'Конотопський район', level: 'red', subtype: 'Ракетна загроза (червоний рівень)' },
    { region: 'Київська область', district: 'Броварський район', level: 'yellow', subtype: 'Дронова загроза (жовтий рівень)' },
  ];
  const { oblasts, fills } = territorialDanger(alerts, []);
  assert.equal(oblasts.length, 0);
  const byLevel = {};
  for (const f of fills) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  assert.deepEqual(byLevel, { critical: 2, high: 2 });
});

test('Multiple shahed in different raions -> one fill per raion, oblast untouched', () => {
  const shahedZveny = { ...UmanRaionShahedAreaOnly, district: 'Звенигородський район', id: 'neptun:8' };
  const { oblasts, fills } = territorialDanger([], [UmanRaionShahedAreaOnly, shahedZveny]);
  assert.equal(oblasts.length, 0);
  assert.equal(fills.length, 2);
  assert.ok(fills.every(f => f.level === 'high'));
});

// ── Exact/marker behavior unchanged ───────────────────────────────────────────
test('Exact Shahed (COORDINATE precision) -> accuracyTier=exact, shouldShowHeading=true', () => {
  assert.equal(accuracyTier(UmanRaionShahed), 'exact');
  assert.equal(shouldShowHeading(UmanRaionShahed), true);
  assert.equal(classifyThreat(UmanRaionShahed), 'shahed');
});

test('Area-only Shahed (RAION precision) -> accuracyTier=area, shouldShowHeading=false, NO fake marker', () => {
  assert.equal(accuracyTier(UmanRaionShahedAreaOnly), 'area');
  assert.equal(shouldShowHeading(UmanRaionShahedAreaOnly), false);
  assert.equal(classifyThreat(UmanRaionShahedAreaOnly), 'shahed');
});

console.log('All territorial danger tests passed!');
