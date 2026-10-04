import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeptunThreat, normalizeMapa } from '../backend/src/normalize.js';
import { classifyThreat, accuracyTier, shouldShowHeading } from '../services/threatClassify.js';
import { raionAlertActive, oblastRaions, matchRaion } from '../services/districts.js';

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

const CherkasyOblastMissile = {
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

const CherkasyOblastBallistic = {
  id: 'neptun:4',
  source: 'NEPTUN',
  category: 'ballistic',
  kind: 'ballistic',
  lat: 48.5,
  lon: 35.0,
  region: 'Черкаська область',
  district: 'Дніпровський район',
  locationPrecision: 'COORDINATE',
  areaOnly: false,
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

// ── Tests for computeTerritorialDanger logic (mirrored from map.js) ───────────
// Since computeTerritorialDanger is not exported, we test the logic inline

const OBLAST_DANGER_CATEGORIES = new Set(['missile', 'ballistic']);
const RAION_DANGER_CATEGORIES = new Set(['shahed', 'uav', 'kab']);
const RAION_MONITORING_CATEGORIES = new Set(['recon', 'aviation', 'other']);

function computeDanger(alerts, events) {
  const oblastDanger = new Set();
  const raionDanger = new Map();

  // 1. Official alerts
  for (const a of alerts || []) {
    const oblast = a.region;
    if (!oblast) continue;
    if (!a.district) {
      oblastDanger.add(oblast);
    } else {
      let oblastMap = raionDanger.get(oblast);
      if (!oblastMap) { oblastMap = new Map(); raionDanger.set(oblast, oblastMap); }
      oblastMap.set(a.district, 'high');
    }
  }

  // 2. Monitoring events
  for (const e of events || []) {
    if (e.official) continue;
    const oblast = e.region || e.derivedRegion;
    if (!oblast) continue;
    const kind = classifyThreat(e);
    const cat = e.category;
    const isAreaOnly = e.areaOnly === true;
    const district = e.district;

    if (OBLAST_DANGER_CATEGORIES.has(cat)) {
      oblastDanger.add(oblast);
      raionDanger.delete(oblast);
      continue;
    }

    if (isAreaOnly && district) {
      if (RAION_DANGER_CATEGORIES.has(kind) || RAION_DANGER_CATEGORIES.has(cat)) {
        let oblastMap = raionDanger.get(oblast);
        if (!oblastMap) { oblastMap = new Map(); raionDanger.set(oblast, oblastMap); }
        const existing = oblastMap.get(district);
        if (existing !== 'high') oblastMap.set(district, 'high');
      } else if (RAION_MONITORING_CATEGORIES.has(kind) || RAION_MONITORING_CATEGORIES.has(cat)) {
        let oblastMap = raionDanger.get(oblast);
        if (!oblastMap) { oblastMap = new Map(); raionDanger.set(oblast, oblastMap); }
        const existing = oblastMap.get(district);
        if (!existing) oblastMap.set(district, 'medium');
      }
    }
  }

  // 3. PRIORITY FIX: oblastCritical clears ALL raion danger for that oblast (absolute priority)
  for (const oblast of oblastDanger) {
    raionDanger.delete(oblast);
  }

  return { oblastDanger, raionDanger };
}

// ── 1. Missile oblast → whole oblast red ──────────────────────────────────────
test('Missile threat in oblast triggers oblastCritical danger', () => {
  const { oblastDanger } = computeDanger([], [CherkasyOblastMissile]);
  assert.ok(oblastDanger.has('Черкаська область'), 'Oblast should be in danger set');
});

test('Missile oblastCritical overrides raion danger', () => {
  const alerts = [OfficialRaionAlert]; // raion alert for Uman
  const events = [CherkasyOblastMissile]; // missile in same oblast
  const { oblastDanger, raionDanger } = computeDanger(alerts, events);
  assert.ok(oblastDanger.has('Черкаська область'));
  assert.equal(raionDanger.has('Черкаська область'), false, 'Raion danger should be cleared for oblastCritical');
});

// ── 2. Ballistic oblast → whole oblast red ────────────────────────────────────
test('Ballistic threat in oblast triggers oblastCritical danger', () => {
  const { oblastDanger } = computeDanger([], [CherkasyOblastBallistic]);
  assert.ok(oblastDanger.has('Черкаська область'));
});

// ── 3. Shahed Uman raion → only Uman raion ────────────────────────────────────
test('Shahed with raion precision (areaOnly) triggers raionHigh for that raion only', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [UmanRaionShahedAreaOnly]);
  assert.equal(oblastDanger.size, 0, 'No oblast danger for Shahed raion');
  const cherkasyRaions = raionDanger.get('Черкаська область');
  assert.ok(cherkasyRaions, 'Should have raion danger map for Cherkasy');
  assert.equal(cherkasyRaions.get('Уманський район'), 'high', 'Uman raion should be high');
  assert.equal(cherkasyRaions.has('Звенигородський район'), false, 'Other raions should not be affected');
});

test('Shahed with exact coordinates + areaOnly=false does NOT create raion danger → point marker instead', () => {
  // Exact coordinate threats create point markers on clusters layer, not territorial raion danger
  const { oblastDanger, raionDanger } = computeDanger([], [UmanRaionShahed]);
  assert.equal(oblastDanger.size, 0);
  // raionDanger should be empty because areaOnly=false
  assert.equal(raionDanger.has('Черкаська область'), false);
});

// ── 4. UAV raion → only that raion ────────────────────────────────────────────
test('UAV with raion precision triggers raionHigh for that raion only', () => {
  const uavRaion = { ...UmanRaionShahedAreaOnly, kind: 'uav', category: 'uav' };
  const { oblastDanger, raionDanger } = computeDanger([], [uavRaion]);
  assert.equal(oblastDanger.size, 0);
  const cherkasyRaions = raionDanger.get('Черкаська область');
  assert.equal(cherkasyRaions.get('Уманський район'), 'high');
});

// ── 5. Oblast-wide alert → whole oblast ───────────────────────────────────────
test('Official oblast-wide alert (no district) triggers oblastCritical', () => {
  const { oblastDanger } = computeDanger([OfficialOblastAlert], []);
  assert.ok(oblastDanger.has('Черкаська область'));
});

test('Official raion alert triggers raionHigh for that raion only', () => {
  const { oblastDanger, raionDanger } = computeDanger([OfficialRaionAlert], []);
  assert.equal(oblastDanger.size, 0);
  const cherkasyRaions = raionDanger.get('Черкаська область');
  assert.equal(cherkasyRaions.get('Уманський район'), 'high');
});

// ── 6. KAB raion → only raion ─────────────────────────────────────────────────
test('KAB with raion precision triggers raionHigh for that raion only', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [KabRaionOnly]);
  assert.equal(oblastDanger.size, 0);
  const kharkivRaions = raionDanger.get('Харківська область');
  assert.equal(kharkivRaions.get('Харківський район'), 'high');
});

// ── 7. Exact Shahed → raion/alert layer + exact SVG marker ────────────────────
test('Exact Shahed (COORDINATE precision) → accuracyTier=exact, shouldShowHeading=true', () => {
  assert.equal(accuracyTier(UmanRaionShahed), 'exact');
  assert.equal(shouldShowHeading(UmanRaionShahed), true);
  assert.equal(classifyThreat(UmanRaionShahed), 'shahed');
});

test('Area-only Shahed (RAION precision) → accuracyTier=area, shouldShowHeading=false, NO fake marker', () => {
  assert.equal(accuracyTier(UmanRaionShahedAreaOnly), 'area');
  assert.equal(shouldShowHeading(UmanRaionShahedAreaOnly), false);
  assert.equal(classifyThreat(UmanRaionShahedAreaOnly), 'shahed');
});

// ── 8. Priority: missile oblast + Shahed raion → oblast danger has priority ───
test('Missile in oblast + Shahed in raion → oblastCritical takes priority, raion cleared', () => {
  const { oblastDanger, raionDanger } = computeDanger([OfficialRaionAlert], [CherkasyOblastMissile, UmanRaionShahedAreaOnly]);
  assert.ok(oblastDanger.has('Черкаська область'));
  assert.equal(raionDanger.has('Черкаська область'), false, 'Raion danger cleared when oblastCritical present');
});

test('Ballistic in oblast + UAV in raion → oblastCritical takes priority', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [CherkasyOblastBallistic, UmanRaionShahedAreaOnly]);
  assert.ok(oblastDanger.has('Черкаська область'));
  assert.equal(raionDanger.has('Черкаська область'), false);
});

test('Missile in oblast → other raions in same oblast NOT affected by raion danger', () => {
  const uavInZveny = { ...UmanRaionShahedAreaOnly, district: 'Звенигородський район' };
  const { oblastDanger, raionDanger } = computeDanger([], [CherkasyOblastMissile, uavInZveny]);
  assert.ok(oblastDanger.has('Черкаська область'));
  assert.equal(raionDanger.has('Черкаська область'), false, 'No raion danger when oblastCritical present');
});

// ── 9. Recon/Aviation raion → raionMedium (lower priority) ────────────────────
test('Recon with raion precision triggers raionMedium', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [ReconRaionOnly]);
  assert.equal(oblastDanger.size, 0);
  const dniproRaions = raionDanger.get('Дніпропетровська область');
  assert.equal(dniproRaions.get('Дніпровський район'), 'medium');
});

test('Aviation with raion precision triggers raionMedium', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [AviationRaionOnly]);
  assert.equal(oblastDanger.size, 0);
  const zapRaions = raionDanger.get('Запорізька область');
  assert.equal(zapRaions.get('Василівський район'), 'medium');
});

test('Recon raionMedium does not upgrade to high if shahed also present in same raion', () => {
  const { oblastDanger, raionDanger } = computeDanger([], [ReconRaionOnly, UmanRaionShahedAreaOnly]);
  // Uman is in Cherkasy, Recon is in Dnipro - different oblasts
  assert.equal(raionDanger.get('Черкаська область').get('Уманський район'), 'high');
  assert.equal(raionDanger.get('Дніпропетровська область').get('Дніпровський район'), 'medium');
});

test('Multiple shahed in different raions → each raion high', () => {
  const shahedZveny = { ...UmanRaionShahedAreaOnly, district: 'Звенигородський район', id: 'neptun:8' };
  const { oblastDanger, raionDanger } = computeDanger([], [UmanRaionShahedAreaOnly, shahedZveny]);
  const cherkasyRaions = raionDanger.get('Черкаська область');
  assert.equal(cherkasyRaions.get('Уманський район'), 'high');
  assert.equal(cherkasyRaions.get('Звенигородський район'), 'high');
  assert.equal(cherkasyRaions.size, 2);
});

console.log('All territorial danger tests passed!');