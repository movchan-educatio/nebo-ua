import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeFix, planTransition, interpolateFix, shortestTurnDeg, tweenProgress, headingFor,
  MIN_STEP_MS, MAX_STEP_MS, MAX_IMPLIED_KMH, MIN_TWEEN_MS, MAX_TWEEN_MS,
} from '../radar/motion.js';
import { haversineKm, bearingDeg } from '../radar/geo.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = Date.parse('2026-10-09T23:00:00Z');
const ev = (o = {}) => ({
  trackId: 'neptun:trk_1', id: 'neptun:trk_1', source: 'NEPTUN',
  lat: 50.0, lon: 30.0, eventTime: new Date(T).toISOString(),
  areaOnly: false, stale: false, status: 'active', heading: null, ...o,
});

// ── 1. makeFix: what may ever become a moving marker ───────────────────────
test('makeFix accepts a confirmed coordinate fix', () => {
  const f = makeFix(ev());
  assert.equal(f.id, 'neptun:trk_1');
  assert.equal(f.lat, 50.0);
  assert.equal(f.atMs, T);
});

test('makeFix refuses area-only records (no point, so no motion)', () => {
  assert.equal(makeFix(ev({ areaOnly: true })), null);
});

test('makeFix refuses stale and ended tracks', () => {
  assert.equal(makeFix(ev({ stale: true })), null);
  assert.equal(makeFix(ev({ status: 'ended' })), null);
});

test('makeFix refuses missing coordinates, id or clock', () => {
  assert.equal(makeFix(ev({ lat: null })), null);
  assert.equal(makeFix(ev({ lon: 'abc' })), null);
  assert.equal(makeFix(ev({ trackId: null, id: null })), null);
  assert.equal(makeFix(ev({ eventTime: 'не дата' })), null);
});

test('makeFix normalises heading and keeps unknown heading as null', () => {
  assert.equal(makeFix(ev({ heading: 311 })).heading, 311);
  assert.equal(makeFix(ev({ heading: 450 })).heading, 90);
  assert.equal(makeFix(ev({ heading: -90 })).heading, 270);
  assert.equal(makeFix(ev({ heading: null })).heading, null);
  assert.equal(makeFix(ev({ heading: 'x' })).heading, null);
});

// ── 2. planTransition: the guard that stops decorative motion ──────────────
test('two confirmed fixes of the same track animate', () => {
  const a = makeFix(ev({ lat: 50.0, eventTime: new Date(T).toISOString() }));
  const b = makeFix(ev({ lat: 50.5, eventTime: new Date(T + 120_000).toISOString() }));
  const p = planTransition(a, b, { nowMs: 5000 });
  assert.ok(p, 'transition allowed');
  assert.ok(p.distanceKm > 50 && p.distanceKm < 60, `distance sane (${p.distanceKm.toFixed(1)})`);
  assert.ok(p.durationMs >= MIN_TWEEN_MS && p.durationMs <= MAX_TWEEN_MS);
});

test('NO animation between two different tracks, however close they are', () => {
  const a = makeFix(ev({ trackId: 'neptun:A', id: 'neptun:A' }));
  const b = makeFix(ev({ trackId: 'neptun:B', id: 'neptun:B', lat: 50.001 }));
  assert.equal(planTransition(a, b), null, 'identity must match before any motion');
});

test('NO animation for sub-threshold gaps (refresh jitter would flicker)', () => {
  const a = makeFix(ev({ lat: 50.0, eventTime: new Date(T).toISOString() }));
  const b = makeFix(ev({ lat: 50.4, eventTime: new Date(T + MIN_STEP_MS - 1).toISOString() }));
  assert.equal(planTransition(a, b), null);
});

test('NO animation when the fixes are out of order', () => {
  const a = makeFix(ev({ lat: 50.0, eventTime: new Date(T + 60_000).toISOString() }));
  const b = makeFix(ev({ lat: 50.4, eventTime: new Date(T).toISOString() }));
  assert.equal(planTransition(a, b), null, 'never move a marker backwards in time');
});

test('NO animation across a long quiet gap (staleness, not travel)', () => {
  const a = makeFix(ev({ lat: 50.0, eventTime: new Date(T).toISOString() }));
  const b = makeFix(ev({ lat: 50.9, eventTime: new Date(T + MAX_STEP_MS + 1).toISOString() }));
  assert.equal(planTransition(a, b), null);
});

test('NO animation for an impossible coordinate jump', () => {
  const a = makeFix(ev({ lat: 48.0, eventTime: new Date(T).toISOString() }));
  // ~500 km in 20 seconds -> far beyond MAX_IMPLIED_KMH
  const b = makeFix(ev({ lat: 52.5, eventTime: new Date(T + 20_000).toISOString() }));
  assert.equal(planTransition(a, b), null, 'data discontinuity snaps, never glides');
});

test('a fast but plausible target still animates', () => {
  const a = makeFix(ev({ lat: 48.0, eventTime: new Date(T).toISOString() }));
  const b = makeFix(ev({ lat: 50.0, eventTime: new Date(T + 600_000).toISOString() }));
  const p = planTransition(a, b);
  assert.ok(p, 'a ~200 km hop over 10 minutes is ordinary for a missile');
});

test('sub-kilometre jitter does not animate', () => {
  const a = makeFix(ev({ lat: 50.0, eventTime: new Date(T).toISOString() }));
  const b = makeFix(ev({ lat: 50.001, eventTime: new Date(T + 60_000).toISOString() }));
  assert.equal(planTransition(a, b), null);
});

test('planTransition is null-safe', () => {
  assert.equal(planTransition(null, makeFix(ev())), null);
  assert.equal(planTransition(makeFix(ev()), null), null);
});

// ── 3. Interpolation is a DISPLAY technique, never a prediction ────────────
test('interpolateFix stays strictly between the two confirmed fixes', () => {
  const a = { lat: 50, lon: 30 }, b = { lat: 51, lon: 31 };
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const p = interpolateFix(a, b, t);
    const along = haversineKm(a.lat, a.lon, p.lat, p.lon);
    const total = haversineKm(a.lat, a.lon, b.lat, b.lon);
    assert.ok(along <= total + 0.01, `t=${t} never overshoots`);
    assert.ok(along >= 0, `t=${t} never goes backwards`);
  }
  assert.deepEqual(interpolateFix(a, b, 0), a);
  assert.deepEqual(interpolateFix(a, b, 1), b);
});

test('interpolateFix clamps t outside [0,1] — no extrapolation', () => {
  const a = { lat: 50, lon: 30 }, b = { lat: 51, lon: 31 };
  assert.deepEqual(interpolateFix(a, b, 5), b, 'never predicts past the last confirmed fix');
  assert.deepEqual(interpolateFix(a, b, -3), a);
});

// ── 4. Progress always comes to rest ───────────────────────────────────────
test('tweenProgress reaches exactly 1 and stays there (motion stops)', () => {
  const plan = { startedAtMs: 1000, durationMs: 1000 };
  assert.equal(tweenProgress(plan, 1000), 0);
  assert.ok(tweenProgress(plan, 1500) > 0 && tweenProgress(plan, 1500) < 1);
  assert.equal(tweenProgress(plan, 2000), 1);
  assert.equal(tweenProgress(plan, 999999), 1, 'never keeps moving after the update');
  assert.equal(tweenProgress(null, 0), 1);
});

test('tweenProgress is monotonic (no stutter or reversal)', () => {
  const plan = { startedAtMs: 0, durationMs: 1500 };
  let last = -1;
  for (let t = 0; t <= 2000; t += 50) {
    const p = tweenProgress(plan, t);
    assert.ok(p >= last, `progress must not go backwards at t=${t}`);
    last = p;
  }
});

// ── 5. Orientation: source heading vs bearing-to-target ───────────────────
test('shortestTurnDeg always takes the short way round', () => {
  assert.equal(shortestTurnDeg(0, 90), 90);
  assert.equal(shortestTurnDeg(0, 270), -90, 'never a 270-degree spin');
  assert.equal(shortestTurnDeg(350, 10), 20, 'wraps across north');
  assert.equal(shortestTurnDeg(90, 180), 90);
  assert.equal(shortestTurnDeg(10, 10), 0);
  assert.equal(shortestTurnDeg(null, 90), 0);
});

test('headingFor returns null when the source has no heading (never guessed)', () => {
  assert.equal(headingFor(90, null, 0.5), null);
  assert.equal(headingFor(90, undefined, 1), null);
  assert.equal(headingFor(null, null, 0), null);
});

test('headingFor returns the confirmed heading unchanged once settled', () => {
  assert.equal(headingFor(null, 311, 1), 311);
  assert.equal(headingFor(311, 311, 1), 311);
  assert.equal(headingFor(10, 350, 1), 350);
});

test('headingFor rotates smoothly and lands exactly on the target', () => {
  const start = headingFor(null, 0, 0);
  const mid = headingFor(0, 90, 0.5);
  const end = headingFor(0, 90, 1);
  assert.equal(start, 0);
  assert.ok(Math.abs(mid) <= 90 + 1e-9, 'never overshoots the final heading');
  assert.equal(end, 90);
});

test('0=N, 90=E, 180=S, 270=W is preserved verbatim (no axis swap)', () => {
  for (const [deg, name] of [[0, 'north'], [90, 'east'], [180, 'south'], [270, 'west']]) {
    assert.equal(headingFor(null, deg, 1), deg, `${name} (${deg}deg) kept as-is`);
  }
});

test('movement heading is independent of the bearing to the target', () => {
  // Two different quantities that must never be confused.
  const target = { lat: 51.0, lon: 30.0 };
  const centre = [50.0, 30.0];
  const bearingToTarget = bearingDeg(centre[0], centre[1], target.lat, target.lon);
  const sourceHeading = headingFor(null, 90, 1);
  assert.equal(bearingToTarget, 0, 'target due north of the centre');
  assert.equal(sourceHeading, 90, 'source says the object flies east');
  assert.notEqual(bearingToTarget, sourceHeading);
});

test('the renderer never derives a heading from coordinate deltas', () => {
  // makeFix stores only the SOURCE heading. Two fixes at different positions
  // must not synthesise a heading when the source reported none.
  const a = makeFix(ev({ lat: 50.0, heading: null }));
  const b = makeFix(ev({ lat: 50.5, heading: null }));
  assert.equal(a.heading, null);
  assert.equal(b.heading, null);
  assert.equal(headingFor(a.heading, b.heading, 0.5), null);
});

test('an unidentified contact is never rotated, whatever the source claims', () => {
  // The unknown-threat marker is a neutral plate. Spinning it would imply a
  // heading the operator cannot actually have, so the renderer suppresses the
  // rotation upstream — see radar.js: `rotatable = p.kind !== 'other'`.
  // This pins that contract: headingFor must be handed null for that kind.
  assert.equal(headingFor(null, null, 0.5), null);
  const suppressed = headingFor(null, null, 1);
  assert.equal(suppressed, null, 'no source heading -> plate stays north-up');
  const radar = fs.readFileSync(path.join(root, 'radar', 'radar.js'), 'utf8');
  assert.ok(/rotatable = p\.kind !== 'other'/.test(radar), 'the neutral plate is excluded from rotation');
  assert.ok(/rotatable && shouldShowHeading\(p\.e\)/.test(radar),
    'and that exclusion actually gates the heading read');
});