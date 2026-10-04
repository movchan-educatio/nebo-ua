import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNeptunThreat, normalizeMapa } from '../backend/src/normalize.js';
import { accuracyTier, classifyThreat, shouldShowHeading } from '../services/threatClassify.js';

// Realistic NEPTUN & MAPA production JSON fixtures

const PRODUCTION_NEPTUN_SHAHED = {
  id: 101,
  type: 'uav',
  title: 'БПЛА Shahed-136 / Герань-2',
  lat: 49.4444,
  lon: 32.0555,
  region: 'Черкаська область',
  district: 'Черкаський район',
  locality: null,
  areaOnly: false,
  heading: 270,
  velocity: { speedKmh: 180 },
  confidenceLevel: 'HIGH',
  positionQuality: 'source-position',
  uncertaintyKm: 2,
  status: 'active',
  updatedAt: new Date().toISOString(),
};

const PRODUCTION_NEPTUN_RAION_ONLY = {
  id: 102,
  type: 'uav',
  title: 'Загроза БПЛА в районі',
  lat: 49.8,
  lon: 31.5,
  region: 'Черкаська область',
  district: 'Уманський район',
  locality: null,
  areaOnly: true,
  heading: null,
  velocity: null,
  confidenceLevel: 'MEDIUM',
  positionQuality: 'raion',
  uncertaintyKm: 25,
  status: 'active',
  updatedAt: new Date().toISOString(),
};

const PRODUCTION_NEPTUN_CRUISE_MISSILE = {
  id: 103,
  type: 'missile_cruise',
  title: 'Крилата ракета Х-101',
  lat: 50.1,
  lon: 30.5,
  region: 'Київська область',
  district: 'Обухівський район',
  locality: 'Обухів',
  areaOnly: false,
  heading: 310,
  velocity: { speedKmh: 750 },
  confidenceLevel: 'HIGH',
  positionQuality: 'source-position',
  uncertaintyKm: 3,
  status: 'active',
  updatedAt: new Date().toISOString(),
};

const PRODUCTION_NEPTUN_BALLISTIC = {
  id: 104,
  type: 'missile_ballistic',
  title: 'Балістична загроза (Іскандер-М)',
  lat: 48.5,
  lon: 35.0,
  region: 'Дніпропетровська область',
  district: 'Дніпровський район',
  locality: null,
  areaOnly: false,
  heading: null,
  velocity: null,
  confidenceLevel: 'HIGH',
  positionQuality: 'source-position',
  uncertaintyKm: 10,
  status: 'active',
  updatedAt: new Date().toISOString(),
};

const PRODUCTION_NEPTUN_KAB = {
  id: 105,
  type: 'bomb',
  title: 'Пуск КАБ',
  lat: 50.0,
  lon: 36.2,
  region: 'Харківська область',
  district: 'Харківський район',
  locality: null,
  areaOnly: false,
  heading: 220,
  velocity: { speedKmh: 600 },
  confidenceLevel: 'HIGH',
  positionQuality: 'source-position',
  uncertaintyKm: 5,
  status: 'active',
  updatedAt: new Date().toISOString(),
};

const PRODUCTION_MAPA_GERAN = {
  id: 201,
  kind: 'drone_piston',
  subkind: 'Герань-2',
  title: 'БПЛА тип Герань',
  status: 'active',
  lat: 49.2,
  lon: 28.4,
  heading: 290,
  speed_kmh: 175,
  last_seen: Math.floor(Date.now() / 1000),
};

test('Production fixture: Shahed from NEPTUN normalizes with kind=shahed and tier=exact', () => {
  const norm = normalizeNeptunThreat(PRODUCTION_NEPTUN_SHAHED);
  assert.equal(norm.category, 'uav');
  assert.equal(norm.kind, 'shahed');
  assert.equal(classifyThreat(norm), 'shahed');
  assert.equal(accuracyTier(norm), 'exact');
  assert.equal(shouldShowHeading(norm), true);
});

test('Production fixture: Raion-only threat normalizes with areaOnly=true and tier=area', () => {
  const norm = normalizeNeptunThreat(PRODUCTION_NEPTUN_RAION_ONLY);
  assert.equal(norm.areaOnly, true);
  assert.equal(accuracyTier(norm), 'area');
  assert.equal(shouldShowHeading(norm), false);
});

test('Production fixture: Cruise missile normalizes with kind=missile and tier=exact', () => {
  const norm = normalizeNeptunThreat(PRODUCTION_NEPTUN_CRUISE_MISSILE);
  assert.equal(norm.category, 'missile');
  assert.equal(classifyThreat(norm), 'missile');
  assert.equal(accuracyTier(norm), 'exact');
  assert.equal(shouldShowHeading(norm), true);
});

test('Production fixture: Ballistic missile classifies as ballistic and suppresses heading if null', () => {
  const norm = normalizeNeptunThreat(PRODUCTION_NEPTUN_BALLISTIC);
  assert.equal(norm.category, 'ballistic');
  assert.equal(classifyThreat(norm), 'ballistic');
  assert.equal(accuracyTier(norm), 'exact');
  assert.equal(shouldShowHeading(norm), false); // heading is null
});

test('Production fixture: KAB classifies as kab with exact tier', () => {
  const norm = normalizeNeptunThreat(PRODUCTION_NEPTUN_KAB);
  assert.equal(norm.category, 'kab');
  assert.equal(classifyThreat(norm), 'kab');
  assert.equal(accuracyTier(norm), 'exact');
});

test('Production fixture: MAPA Geran classifies as shahed with exact tier', () => {
  const norm = normalizeMapa(PRODUCTION_MAPA_GERAN);
  assert.equal(norm.category, 'uav');
  assert.equal(norm.kind, 'shahed');
  assert.equal(classifyThreat(norm), 'shahed');
  assert.equal(accuracyTier(norm), 'exact');
  assert.equal(shouldShowHeading(norm), true);
});

test('Production fixture: low positionQuality forces area tier', () => {
  const raw = { ...PRODUCTION_NEPTUN_SHAHED, positionQuality: 'raion' };
  const norm = normalizeNeptunThreat(raw);
  assert.equal(accuracyTier(norm), 'area');
});

test('Production fixture: uncertainty >= 20km forces area tier', () => {
  const raw = { ...PRODUCTION_NEPTUN_SHAHED, uncertaintyKm: 30 };
  const norm = normalizeNeptunThreat(raw);
  assert.equal(accuracyTier(norm), 'area');
});

// ── Uman / Raion Alert vs Oblast Alert Tests ──────────────────────────────────

test('Alert hierarchy: Raion alert (Uman) does NOT set wide/oblast-wide flag', () => {
  const alerts = [
    { key: 'cherkasy_uman', region: 'Черкаська область', district: 'Уманський район', official: true }
  ];
  const list = alerts.filter(x => x.region === 'Черкаська область');
  const wide = list.some(x => !x.district);
  assert.equal(wide, false, 'Uman raion alert must not be considered an oblast-wide alert');
});

test('Alert hierarchy: Oblast-wide alert (no district) sets wide flag', () => {
  const alerts = [
    { key: 'cherkasy_all', region: 'Черкаська область', district: null, official: true }
  ];
  const list = alerts.filter(x => x.region === 'Черкаська область');
  const wide = list.some(x => !x.district);
  assert.equal(wide, true, 'Oblast alert with no district must set wide=true');
});

test('Heading behavior: Heading present and valid -> shouldShowHeading is true', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: false, heading: 180, speed: 200 };
  assert.equal(shouldShowHeading(e), true);
});

test('Heading behavior: Heading missing/null -> shouldShowHeading is false', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: false, heading: null, speed: 200 };
  assert.equal(shouldShowHeading(e), false);
});
