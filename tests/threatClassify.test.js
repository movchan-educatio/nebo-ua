import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accuracyTier, classifyThreat, TTL_MINUTES,
  isWithinTTL, freshnessScore, ageMinutes, ageClass, shouldShowHeading,
} from '../services/threatClassify.js';

// ── accuracyTier ──────────────────────────────────────────────────────────────

test('accuracyTier: COORDINATE + valid coords + !areaOnly → exact', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, lat: 49, lon: 31 };
  assert.equal(accuracyTier(e), 'exact');
});

test('accuracyTier: COORDINATE + areaOnly → area', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: true, lat: 49, lon: 31 };
  assert.equal(accuracyTier(e), 'area');
});

test('accuracyTier: RAION → area', () => {
  assert.equal(accuracyTier({ locationPrecision: 'RAION', areaOnly: false, lat: null, lon: null }), 'area');
});

test('accuracyTier: OBLAST → area', () => {
  assert.equal(accuracyTier({ locationPrecision: 'OBLAST', areaOnly: false, lat: null, lon: null }), 'area');
});

test('accuracyTier: SETTLEMENT → area', () => {
  assert.equal(accuracyTier({ locationPrecision: 'SETTLEMENT', areaOnly: false, lat: 49, lon: 31 }), 'area');
});

test('accuracyTier: UNKNOWN → report', () => {
  assert.equal(accuracyTier({ locationPrecision: 'UNKNOWN', areaOnly: false, lat: null, lon: null }), 'report');
});

test('accuracyTier: null event → report', () => {
  assert.equal(accuracyTier(null), 'report');
});

test('accuracyTier: COORDINATE but lat/lon null → report', () => {
  assert.equal(accuracyTier({ locationPrecision: 'COORDINATE', areaOnly: false, lat: null, lon: null }), 'report');
});

// ── classifyThreat ────────────────────────────────────────────────────────────

test('classifyThreat: kind=shahed wins over category', () => {
  assert.equal(classifyThreat({ kind: 'shahed', category: 'uav' }), 'shahed');
});

test('classifyThreat: category=uav → uav', () => {
  assert.equal(classifyThreat({ kind: null, category: 'uav' }), 'uav');
});

test('classifyThreat: category=missile → missile', () => {
  assert.equal(classifyThreat({ kind: null, category: 'missile' }), 'missile');
});

test('classifyThreat: category=ballistic → ballistic', () => {
  assert.equal(classifyThreat({ kind: null, category: 'ballistic' }), 'ballistic');
});

test('classifyThreat: category=kab → kab', () => {
  assert.equal(classifyThreat({ kind: null, category: 'kab' }), 'kab');
});

test('classifyThreat: category=recon → recon', () => {
  assert.equal(classifyThreat({ kind: null, category: 'recon' }), 'recon');
});

test('classifyThreat: category=aviation → aviation', () => {
  assert.equal(classifyThreat({ kind: null, category: 'aviation' }), 'aviation');
});

test('classifyThreat: category=other → other', () => {
  assert.equal(classifyThreat({ kind: null, category: 'other' }), 'other');
});

test('classifyThreat: null → other', () => {
  assert.equal(classifyThreat(null), 'other');
});

// ── TTL_MINUTES ───────────────────────────────────────────────────────────────

test('TTL_MINUTES: missile and ballistic are 2 min', () => {
  assert.equal(TTL_MINUTES.missile, 2);
  assert.equal(TTL_MINUTES.ballistic, 2);
});

test('TTL_MINUTES: uav, kab, aviation are 5 min', () => {
  assert.equal(TTL_MINUTES.uav, 5);
  assert.equal(TTL_MINUTES.kab, 5);
  assert.equal(TTL_MINUTES.aviation, 5);
});

// ── isWithinTTL ───────────────────────────────────────────────────────────────

test('isWithinTTL: missile 1 min ago → within TTL', () => {
  const ts = new Date(Date.now() - 60000);
  assert.equal(isWithinTTL({ category: 'missile', timestamp: ts }), true);
});

test('isWithinTTL: missile 3 min ago → outside TTL', () => {
  const ts = new Date(Date.now() - 3 * 60000);
  assert.equal(isWithinTTL({ category: 'missile', timestamp: ts }), false);
});

test('isWithinTTL: uav 4 min ago → within TTL', () => {
  const ts = new Date(Date.now() - 4 * 60000);
  assert.equal(isWithinTTL({ category: 'uav', timestamp: ts }), true);
});

test('isWithinTTL: uav 6 min ago → outside TTL', () => {
  const ts = new Date(Date.now() - 6 * 60000);
  assert.equal(isWithinTTL({ category: 'uav', timestamp: ts }), false);
});

test('isWithinTTL: no timestamp → false', () => {
  assert.equal(isWithinTTL({ category: 'uav', timestamp: null }), false);
});

// ── freshnessScore ────────────────────────────────────────────────────────────

test('freshnessScore: brand new → 1.0', () => {
  const e = { category: 'uav', timestamp: new Date() };
  const score = freshnessScore(e);
  assert.ok(score >= 0.99, `expected ~1.0, got ${score}`);
});

test('freshnessScore: at TTL boundary → ~0.0', () => {
  const ttl = TTL_MINUTES.uav;
  const e = { category: 'uav', timestamp: new Date(Date.now() - ttl * 60000) };
  const score = freshnessScore(e);
  assert.ok(score <= 0.01, `expected ~0.0, got ${score}`);
});

test('freshnessScore: halfway → ~0.5', () => {
  const ttl = TTL_MINUTES.uav;
  const e = { category: 'uav', timestamp: new Date(Date.now() - (ttl / 2) * 60000) };
  const score = freshnessScore(e);
  assert.ok(score >= 0.45 && score <= 0.55, `expected ~0.5, got ${score}`);
});

test('freshnessScore: no timestamp → 0', () => {
  assert.equal(freshnessScore({ category: 'uav', timestamp: null }), 0);
});

// ── ageClass ──────────────────────────────────────────────────────────────────

test('ageClass: <2min → fresh', () => {
  const e = { timestamp: new Date(Date.now() - 90000) };
  assert.equal(ageClass(e), 'fresh');
});

test('ageClass: 3min → recent', () => {
  const e = { timestamp: new Date(Date.now() - 3 * 60000) };
  assert.equal(ageClass(e), 'recent');
});

test('ageClass: 7min → aging', () => {
  const e = { timestamp: new Date(Date.now() - 7 * 60000) };
  assert.equal(ageClass(e), 'aging');
});

test('ageClass: 15min → old', () => {
  const e = { timestamp: new Date(Date.now() - 15 * 60000) };
  assert.equal(ageClass(e), 'old');
});

test('ageClass: no timestamp → old', () => {
  assert.equal(ageClass({ timestamp: null }), 'old');
});

// ── shouldShowHeading ─────────────────────────────────────────────────────────

test('shouldShowHeading: COORDINATE + finite heading + !stale → true', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: false, heading: 135, speed: 200 };
  assert.equal(shouldShowHeading(e), true);
});

test('shouldShowHeading: RAION precision without coords → false', () => {
  const e = { locationPrecision: 'RAION', areaOnly: false, stale: false, heading: 135, speed: 200 };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: heading=null → false', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: false, heading: null, speed: 200 };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: course without speed still orients the glyph (speed not required)', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: false, heading: 90, speed: null };
  assert.equal(shouldShowHeading(e), true, 'source course alone is a confirmed direction');
});

test('shouldShowHeading: stale=true → false', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: false, stale: true, heading: 90, speed: 200 };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: areaOnly=true → false', () => {
  const e = { locationPrecision: 'COORDINATE', areaOnly: true, stale: false, heading: 90, speed: 200 };
  assert.equal(shouldShowHeading(e), false);
});

test('shouldShowHeading: null event → false', () => {
  assert.equal(shouldShowHeading(null), false);
});
