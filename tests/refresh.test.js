// The refresh system, tested as logic rather than as a page.
//
// Each scenario in the specification is a case here, because every one of them
// is a way for a radar to look alive while serving data it cannot vouch for.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assess, describe, validate, backoffMs, formatAge, formatClock, nextDelayMs,
  STATUS, FRESH_WINDOW_MS, DATA_WINDOW_MS, POLL_NORMAL_MS, POLL_HIDDEN_MS,
  REPORTED_SOURCES,
} from '../radar/refresh.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

function snap(over = {}) {
  return {
    v: 1,
    pipelineCheckedAt: ago(5000),
    dataUpdatedAt: ago(30000),
    publishedAt: ago(5000),
    events: [],
    alerts: [],
    health: {
      NEPTUN: { status: 'online', updatedAt: ago(5000) },
      MAPA: { status: 'online', updatedAt: ago(5000) },
    },
    ...over,
  };
}

const healthy = () => snap();

// ── 1. Fresh API, healthy sources ─────────────────────────────────────────
test('a fresh payload with healthy sources is LIVE', () => {
  const a = assess(healthy(), { now: NOW });
  assert.equal(a.status, STATUS.LIVE);
  assert.equal(describe(a).tone, 'ok');
  assert.deepEqual(Object.keys(a.sources).sort(), [...REPORTED_SOURCES].sort());
});

// ── 2. HTTP 200 with an old pipelineCheckedAt ─────────────────────────────
test('a 200 carrying an old snapshot is STALE, not LIVE', () => {
  // The case the whole system exists for: the server answered, the data did not.
  const a = assess(snap({ pipelineCheckedAt: ago(4 * 60_000) }), { now: NOW });
  assert.equal(a.status, STATUS.STALE);
  assert.equal(describe(a).title, 'Увага! Дані радара можуть бути застарілими');
  assert.ok(a.pipeAgeMs > FRESH_WINDOW_MS);
});

test('the freshness window is three minutes and it is not negotiable', () => {
  assert.equal(FRESH_WINDOW_MS, 180_000);
  assert.equal(assess(snap({ pipelineCheckedAt: ago(179_000) }), { now: NOW }).status, STATUS.LIVE);
  assert.equal(assess(snap({ pipelineCheckedAt: ago(181_000) }), { now: NOW }).status, STATUS.STALE);
});

// ── 3/4/5. Transport failures ─────────────────────────────────────────────
test('no snapshot and an unreachable API is OFFLINE', () => {
  const a = assess(null, { now: NOW, reachable: false });
  assert.equal(a.status, STATUS.OFFLINE);
  assert.equal(describe(a).tone, 'bad');
});

test('an unreachable API outranks a fresh snapshot: we cannot confirm it now', () => {
  const a = assess(healthy(), { now: NOW, reachable: false });
  assert.equal(a.status, STATUS.OFFLINE);
  // The previous state is kept for the user, but never called current.
  assert.equal(a.hasSnapshot, true);
});

test('an empty snapshot is a warning state, not a quiet one', () => {
  // The specification puts a missing pipelineCheckedAt in the emergency
  // branch: we received a response but cannot confirm anything about the data.
  // Calling that OFFLINE would suggest the network is down; it is not.
  const a = assess({}, { now: NOW });
  assert.equal(a.status, STATUS.STALE);
  assert.equal(a.pipeProblem, 'missing');
});

// ── 6/7/8. Malformed payloads ─────────────────────────────────────────────
test('validate rejects invalid JSON', () => {
  assert.equal(validate('{not json', { now: NOW }).reason, 'invalid-json');
  assert.equal(validate('[]', { now: NOW }).reason, 'invalid-json');
  assert.equal(validate('null', { now: NOW }).reason, 'invalid-json');
});

test('validate rejects a payload with no verification time', () => {
  const r = validate(JSON.stringify(snap({ pipelineCheckedAt: undefined })), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-timestamp');
  // The payload is still handed back so the UI can say what it received.
  assert.ok(r.snapshot);
});

test('validate rejects a timestamp implausibly far in the future', () => {
  const r = validate(JSON.stringify(snap({ pipelineCheckedAt: new Date(NOW + 10 * 60_000).toISOString() })), { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'future-timestamp');
});

test('a future timestamp never reads as a fresh check', () => {
  // The old code clamped a negative age to zero, so a broken clock produced
  // "підтверджено щойно" — the most dangerous possible reading.
  const a = assess(snap({ pipelineCheckedAt: new Date(NOW + 10 * 60_000).toISOString() }), { now: NOW });
  assert.equal(a.status, STATUS.STALE);
  assert.equal(a.pipeProblem, 'future');
  assert.ok(a.pipeAgeMs < 0, 'the age is reported as the distance, not hidden');
});

test('a small clock skew is tolerated, a large one is not', () => {
  assert.equal(assess(snap({ pipelineCheckedAt: new Date(NOW + 20_000).toISOString() }), { now: NOW }).status, STATUS.LIVE);
  assert.equal(assess(snap({ pipelineCheckedAt: new Date(NOW + 5 * 60_000).toISOString() }), { now: NOW }).status, STATUS.STALE);
});

test('validate rejects a payload that is not the agreed shape', () => {
  assert.equal(validate(JSON.stringify({ v: 2, events: [], alerts: [] }), { now: NOW }).reason, 'unsupported-version');
  assert.equal(validate(JSON.stringify({ v: 1, alerts: [] }), { now: NOW }).reason, 'no-events');
  assert.equal(validate(JSON.stringify({ v: 1, events: [] }), { now: NOW }).reason, 'no-alerts');
});

test('validate accepts a well-formed payload', () => {
  const r = validate(JSON.stringify(healthy()), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.v, 1);
});

// ── 9/10. Source-level problems ───────────────────────────────────────────
test('a failing source with a fresh pipeline is DEGRADED, not OFFLINE', () => {
  const a = assess(snap({
    health: {
      NEPTUN: { status: 'offline', error: 'HTTP 500' },
      MAPA: { status: 'online', updatedAt: ago(5000) },
    },
  }), { now: NOW });
  assert.equal(a.status, STATUS.DEGRADED);
  assert.ok(a.pipeAgeMs < FRESH_WINDOW_MS, 'the pipeline itself is still fresh');
  assert.ok(describe(a).detail.includes('NEPTUN'));
});

test('a delayed source is DEGRADED even when it reports online', () => {
  const a = assess(snap({
    health: {
      NEPTUN: { status: 'online', delayed: true, updatedAt: ago(400_000) },
      MAPA: { status: 'online', updatedAt: ago(5000) },
    },
  }), { now: NOW });
  assert.equal(a.status, STATUS.DEGRADED);
  assert.equal(a.sources.NEPTUN.delayed, true);
});

test('a MAPA failure is reported the same way', () => {
  const a = assess(snap({
    health: {
      NEPTUN: { status: 'online', updatedAt: ago(5000) },
      MAPA: { status: 'offline', error: 'timeout' },
    },
  }), { now: NOW });
  assert.equal(a.status, STATUS.DEGRADED);
  assert.ok(describe(a).detail.includes('MAPA'));
});

test('a source missing from the payload is never reported on', () => {
  const a = assess(snap({ health: { NEPTUN: { status: 'online', updatedAt: ago(5000) } } }), { now: NOW });
  assert.deepEqual(Object.keys(a.sources), ['NEPTUN']);
});

test('a stale pipeline outranks a healthy source set', () => {
  const a = assess(snap({ pipelineCheckedAt: ago(10 * 60_000) }), { now: NOW });
  assert.equal(a.status, STATUS.STALE);
});

// ── 11/12/20. Requests do not overlap or burst ────────────────────────────
test('the recovery ladder is 15, 30, 60, 120 and then never faster than 120', () => {
  const steps = [0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, () => 0));
  assert.deepEqual(steps, [15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000]);
});

test('recovery carries jitter so a crowd does not return in lockstep', () => {
  const a = backoffMs(0, () => 0);
  const b = backoffMs(0, () => 0.999);
  assert.equal(a, 15_000);
  assert.ok(b > a && b <= 18_000, `${a} and ${b} must differ`);
});

test('the next poll is not scheduled while a request is in flight', () => {
  assert.equal(nextDelayMs({ assessment: null, checking: true }), 1000);
});

test('a healthy radar polls once a minute, a backgrounded tab far less', () => {
  const a = assess(healthy(), { now: NOW });
  assert.equal(nextDelayMs({ assessment: a, rand: () => 0 }), POLL_NORMAL_MS);
  assert.equal(nextDelayMs({ assessment: a, hidden: true, rand: () => 0 }), POLL_HIDDEN_MS);
  assert.ok(POLL_NORMAL_MS >= 60_000, 'never faster than the specified minute');
});

// ── 13/14/15. Visibility and long outages ──────────────────────────────────
test('STALE and OFFLINE shorten the next poll to the recovery ladder', () => {
  const stale = assess(snap({ pipelineCheckedAt: ago(10 * 60_000) }), { now: NOW });
  assert.equal(nextDelayMs({ assessment: stale, attempt: 0, rand: () => 0 }), 15_000);
  const offline = assess(null, { reachable: false });
  assert.equal(nextDelayMs({ assessment: offline, attempt: 2, rand: () => 0 }), 60_000);
});

test('a server Retry-After overrides our own ladder', () => {
  const stale = assess(snap({ pipelineCheckedAt: ago(10 * 60_000) }), { now: NOW });
  assert.equal(nextDelayMs({ assessment: stale, attempt: 0, retryAfter: 900_000, rand: () => 0 }), 900_000);
});

test('recovery from a long outage returns to the normal cadence', () => {
  const recovered = assess(healthy(), { now: NOW });
  assert.equal(nextDelayMs({ assessment: recovered, rand: () => 0 }), POLL_NORMAL_MS);
});

// ── 17/18. Losing and regaining the network ───────────────────────────────
test('losing the network after a good load downgrades to OFFLINE but keeps the data', () => {
  const a = assess(healthy(), { now: NOW, reachable: false });
  assert.equal(a.status, STATUS.OFFLINE);
  assert.equal(a.hasSnapshot, true);
  assert.equal(describe(a).tone, 'bad');
  assert.ok(describe(a).detail.includes('останній'), 'it says the state on screen is the last known one');
});

// ── 19. State transitions ─────────────────────────────────────────────────
test('LIVE -> STALE -> LIVE is reported without inventing a recovery', () => {
  const fresh = assess(healthy(), { now: NOW });
  assert.equal(fresh.status, STATUS.LIVE);

  const stale = assess(snap({ pipelineCheckedAt: ago(5 * 60_000) }), { now: NOW });
  assert.equal(stale.status, STATUS.STALE);
  // While stale, nothing may claim recovery.
  assert.doesNotMatch(describe(stale).title, /відновлен/i);

  const again = assess(healthy(), { now: NOW });
  assert.equal(again.status, STATUS.LIVE);
});

// ── Data freshness is separate from pipeline freshness ───────────────────
test('old but honestly unchanged data is not an alarm', () => {
  // A calm sky is a real state: the pipeline verified a minute ago and the
  // content has not moved for an hour. That is not an outage.
  const a = assess(snap({ pipelineCheckedAt: ago(20_000), dataUpdatedAt: ago(90 * 60_000) }), { now: NOW });
  assert.equal(a.status, STATUS.LIVE);
  assert.equal(a.dataStale, true, 'and the age is still available to disclose');
});

test('a missing data timestamp is not invented', () => {
  const a = assess(snap({ dataUpdatedAt: undefined }), { now: NOW });
  assert.equal(a.dataAt, null);
  assert.equal(a.dataAgeMs, null);
  assert.equal(a.dataStale, false);
});

// ── Time formatting ───────────────────────────────────────────────────────
test('time is rendered in Ukrainian and never from a bad instant', () => {
  assert.equal(formatAge(null), '—');
  assert.equal(formatAge(NaN), '—');
  assert.equal(formatClock(null), '—');
  assert.equal(formatAge(5000), 'щойно');
  assert.equal(formatAge(45_000), '45 с тому');
  assert.equal(formatAge(5 * 60_000), '5 хв тому');
  assert.equal(formatAge(3 * 3_600_000), '3 год тому');
  assert.match(formatClock(NOW), /\d{2}:\d{2}:\d{2}/);
});

test('every status has a distinct, non-overclaiming wording', () => {
  const seen = new Set();
  for (const s of [
    assess(healthy(), { now: NOW }),
    assess(snap({ pipelineCheckedAt: ago(9 * 60_000) }), { now: NOW }),
    assess(null, { reachable: false, now: NOW }),
  ]) {
    const d = describe(s);
    assert.ok(d.title && !seen.has(d.title), 'distinct titles');
    seen.add(d.title);
    assert.doesNotMatch(d.title, /все добре|немає загроз|безпечно/i);
  }
});

// ── The wiring, not the rules ─────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const radarJs = read('radar/radar.js');
const indexHtml = read('index.html');
const css = read('radar/radar.css');
// Comments explain these decisions and name the very identifiers the checks
// below forbid, so assertions run against code only.
const radarCode = radarJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

test('the refresh control exists once and is reachable from the keyboard', () => {
  assert.equal((indexHtml.match(/id="rlRefreshBtn"/g) || []).length, 1, 'exactly one button');
  assert.ok(indexHtml.includes('type="button"'), 'it is not a submit');
  assert.ok(indexHtml.includes('aria-label="Оновити дані"'), 'it has an accessible name');
  assert.ok(indexHtml.includes('i-refresh'), 'and the refresh icon');
});

test('one scheduler, and it cannot overlap itself', () => {
  // The previous pair of setInterval calls polled on a fixed cadence whether or
  // not the previous request had finished.
  assert.equal((radarJs.match(/setInterval\(\s*load/g) || []).length, 0, 'no fixed-interval poller');
  assert.equal((radarJs.match(/setTimeout\(/g) || []).length > 0, true, 'a self-rescheduling timeout instead');
  assert.match(radarJs, /function scheduleNext/, 'the scheduler exists');
  assert.match(radarJs, /clearTimeout\(pollTimer\)/, 'and cancels before re-arming');
  // A manual press and an automatic tick share one in-flight guard.
  assert.match(radarJs, /if \(inFlight\) return inFlight/, 'concurrent requests are refused');
  assert.match(radarJs, /let inFlight = null/, 'the guard is a single shared flag');
});

test('a manual refresh only reads the public endpoint', () => {
  // It must not reach the admin refresh route or start the server-side cron.
  const press = radarCode.slice(radarCode.indexOf('const pressRefresh'), radarCode.indexOf('const rb ='));
  assert.match(press, /load\('manual'\)/, 'it goes through the same loader as the poller');
  assert.doesNotMatch(press, /\/v1\/refresh/, 'never the admin refresh route');
  assert.doesNotMatch(press, /scheduled|trigger|cron/i, 'never a cron trigger');
});

test('requests are uncacheable and bounded', () => {
  assert.match(radarCode, /cache: 'no-store'/, 'no-store on the request');
  assert.match(radarCode, /ac\.abort\(\)/, 'every request can be aborted');
  assert.match(radarCode, /setTimeout\(\(\) => ac\.abort\(\)/, 'and the abort is scheduled');
  assert.doesNotMatch(radarCode, /\?t=\$\{Date\.now\(\)\}/, 'no cache-busting query parameter');
});

// This assertion used to require the two headers that caused the outage. It
// passed, and the radar still went dark for every visitor: a source-level check
// cannot know which request headers are CORS-safelisted, so "we set a header"
// looked like thoroughness while actually breaking the request.
test('the state request sets no header that triggers a CORS preflight', () => {
  const fn = radarCode.slice(radarCode.indexOf('async function fetchSnapshot'), radarCode.indexOf('function retryAfterMs'));
  assert.ok(fn.length > 0, 'fetchSnapshot exists');

  // Scope to the fetch options object. Scanning the whole function picks up
  // ordinary object properties like `reason: 'timeout'` and calls them headers.
  const call = fn.slice(fn.indexOf('fetch(aggregatorUrl()'), fn.indexOf('});', fn.indexOf('fetch(aggregatorUrl()')));
  assert.ok(call.length > 0, 'the fetch call is found');

  const safelist = ['accept', 'accept-language', 'content-language', 'content-type'];
  const headersProp = call.match(/headers\s*:\s*\{([^}]*)\}/);
  if (headersProp) {
    for (const m of headersProp[1].matchAll(/['"]([a-z-]+)['"]\s*:/gi)) {
      const h = m[1].toLowerCase();
      assert.ok(safelist.includes(h), `"${h}" is not CORS-safelisted; a preflight the aggregator may refuse would take the radar offline`);
    }
  } else {
    // No headers at all is the strongest possible position: nothing to preflight.
    assert.doesNotMatch(call, /pragma/i, 'no pragma header');
    assert.doesNotMatch(call, /cache-control/i, 'no cache-control request header — cache mode does that without preflighting');
  }
  assert.match(call, /cache:\s*'no-store'/, 'still uncacheable, via the fetch cache mode');
});

test('the aggregator preflight echoes the headers the browser asked for', async () => {
  const src = read('backend/src/index.js');
  assert.match(src, /Access-Control-Request-Headers/, 'reads the requested header list');
  assert.match(src, /['"]Access-Control-Allow-Headers['"]:\s*allowHeaders/, 'and answers with it');
  // A fixed allow-list is what let the radar be refused by its own API.
  assert.doesNotMatch(src, /'Access-Control-Allow-Headers':\s*'Content-Type'/, 'no hardcoded single-header allow-list');
});

test('the recovery notice is a compact strip, not a modal', () => {
  assert.match(cssCode, /\.rl-alert\s*\{[^}]*display:\s*flex/, 'a strip');
  assert.doesNotMatch(cssCode, /\.rl-alert[^}]*position:\s*fixed/, 'not floating over the page');
  assert.match(css, /\.rl-alert\[hidden\]\s*\{\s*display:\s*none/, 'reserves no space while hidden');
  // The radar must stay usable underneath it.
  assert.match(indexHtml, /id="rlAlert"[\s\S]{0,80}hidden/, 'it ships hidden');
});

test('the live badge says verification, not "updated"', () => {
  // A 200 with an old snapshot must never relabel itself as updated. The clock
  // that says when the SERVER verified belongs to renderFreshness alone;
  // tickClock must not write it back from a received timestamp.
  assert.match(radarCode, /Перевірка/, 'the clock states when the server verified');
  const tick = radarCode.slice(radarCode.indexOf('function tickClock'), radarCode.indexOf('function syncRangeButtons'));
  assert.doesNotMatch(tick, /rlUpdated/, 'the clock does not touch the freshness line');
  assert.doesNotMatch(tick, /state\.lastSuccess/, 'and no longer reads a received timestamp');
});

test('the refresh module is free of DOM and network', () => {
  const src = read('radar/refresh.js');
  assert.doesNotMatch(src, /\bdocument\./, 'no DOM');
  assert.doesNotMatch(src, /\bfetch\(/, 'no network');
  assert.doesNotMatch(src, /window\./, 'no globals');
});