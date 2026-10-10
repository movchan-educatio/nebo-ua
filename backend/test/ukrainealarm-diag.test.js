import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authHeaderValue, describeKey, keyFingerprint, classifyUaResponse,
  UA_FP_PEPPER, UA_ENDPOINTS,
} from '../src/ukrainealarm.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'sk-test-0123456789abcdef-not-a-real-key';

// ── describeKey: proves shape, never reveals ───────────────────────────────
test('an absent key is reported as absent, with the scheme still shown', () => {
  const d = describeKey(null, '');
  assert.equal(d.present, false);
  assert.equal(d.scheme, '(none)');
  assert.equal('length' in d, false, 'no length when there is nothing to measure');
});

test('describeKey exposes length and paste problems but never the value', () => {
  const d = describeKey(SECRET, '');
  assert.equal(d.present, true);
  assert.equal(d.length, SECRET.length);
  assert.equal(d.trimmedLength, SECRET.length);
  assert.equal(d.surroundingWhitespace, false);
  assert.equal(d.whitespaceCount, 0);
  assert.equal(d.nonAsciiCount, 0);
  assert.equal(JSON.stringify(d).includes(SECRET), false, 'the key never appears in the report');
  assert.equal(Object.values(d).some((v) => v === SECRET), false);
});

test('a pasted key with stray whitespace is detectable without reading it', () => {
  const d = describeKey(`  ${SECRET}\n`, '');
  assert.equal(d.present, true);
  assert.equal(d.surroundingWhitespace, true, 'this is exactly the paste accident that breaks auth');
  assert.equal(d.length, d.trimmedLength + 3);
  assert.equal(JSON.stringify(d).includes(SECRET), false);
});

test('non-ASCII characters in a key are counted, not printed', () => {
  const d = describeKey(`${SECRET}ключ`, '');
  assert.equal(d.nonAsciiCount, 4);
  assert.equal(JSON.stringify(d).includes('ключ'), false);
});

test('the scheme is reported as configured, from the var not the secret', () => {
  assert.equal(describeKey(SECRET, 'Token').scheme, 'Token');
  assert.equal(describeKey(SECRET, '  ').scheme, '(none)', 'blank scheme means raw key');
  assert.equal(authHeaderValue(SECRET, 'Token'), 'Token ' + SECRET);
  assert.equal(authHeaderValue(SECRET, ''), SECRET, 'unchanged: no scheme was altered');
});

// ── keyFingerprint: identifies without disclosing ──────────────────────────
test('the fingerprint is stable for the same key and differs for another', async () => {
  const a = await keyFingerprint(SECRET);
  const b = await keyFingerprint(SECRET);
  const c = await keyFingerprint('sk-test-0000000000000000-another-key');
  assert.equal(a, b, 'stable across calls');
  assert.notEqual(a, c, 'different key -> different fingerprint');
  assert.match(a, /^[0-9a-f]{12}$/, 'truncated, fixed width');
  assert.equal(a.includes(SECRET), false);
});

test('the fingerprint depends on the documented pepper, so it is reproducible', async () => {
  const withDefault = await keyFingerprint(SECRET);
  const withExplicit = await keyFingerprint(SECRET, UA_FP_PEPPER);
  assert.equal(withDefault, withExplicit, 'the holder can recompute it locally');
  const other = await keyFingerprint(SECRET, 'different-pepper');
  assert.notEqual(withDefault, other);
});

test('no fingerprint exists for an absent key', async () => {
  assert.equal(await keyFingerprint(null), null);
  assert.equal(await keyFingerprint(''), null);
});

// ── classifyUaResponse: a 401 is never confused with anything else ──────────
test('classification separates credential, edge, rate and server failures', () => {
  assert.equal(classifyUaResponse(200, 'application/json'), 'ok');
  assert.equal(classifyUaResponse(204, null), 'ok');
  assert.equal(classifyUaResponse(401, null), 'auth_rejected');
  assert.equal(classifyUaResponse(401, 'application/json'), 'auth_rejected');
  // A 403 with an HTML body is a Cloudflare bot challenge, NOT a bad key.
  assert.equal(classifyUaResponse(403, 'text/html'), 'edge_blocked');
  assert.equal(classifyUaResponse(403, 'application/json'), 'forbidden');
  assert.equal(classifyUaResponse(404, null), 'endpoint_missing');
  assert.equal(classifyUaResponse(429, null), 'rate_limited');
  assert.equal(classifyUaResponse(408, null), 'timeout');
  assert.equal(classifyUaResponse(504, null), 'timeout');
  assert.equal(classifyUaResponse(500, null), 'upstream_error');
  assert.equal(classifyUaResponse(503, null), 'upstream_error');
  assert.equal(classifyUaResponse(418, null), 'http_418');
  assert.equal(classifyUaResponse(null, null), 'network');
});

test('the observed provider behaviour is classified honestly', () => {
  // Measured live: no Authorization -> 403 + HTML challenge; ANY
  // Authorization value -> 401 + empty body.
  assert.equal(classifyUaResponse(403, 'text/html; charset=UTF-8'), 'edge_blocked');
  assert.equal(classifyUaResponse(401, null), 'auth_rejected');
});

// ── Configuration consistency between the two endpoints ────────────────────
test('both monitored endpoints go through one choke point with one auth config', async () => {
  const src = fs.readFileSync(path.join(root, 'backend', 'src', 'ukrainealarm.js'), 'utf8');
  // Every endpoint is reached via uaGet/uaGetRaw -> uaFetch, so the header can
  // only be built one way.
  for (const call of [
    'await uaGetRaw(env, \'/api/v3/alerts/status\', opts)',
    'await uaGet(env, \'/api/v3/alerts\', opts)',
  ]) {
    assert.ok(src.includes(call), `pipeline uses ${call}`);
  }
  assert.equal((src.match(/Authorization: authHeaderValue\(/g) || []).length, 1,
    'exactly one place builds the Authorization header');
  assert.ok(src.includes('const ENDPOINT_NAMES'), 'endpoints are named for telemetry');
  for (const name of Object.values(UA_ENDPOINTS)) {
    assert.ok(src.includes(name), `endpoint ${name} is a known, named route`);
  }
});

// ── The credential must never reach a log ──────────────────────────────────
test('no logging call in the adapter can receive the key or the header', () => {
  const src = fs.readFileSync(path.join(root, 'backend', 'src', 'ukrainealarm.js'), 'utf8');
  const logged = [...src.matchAll(/console\.log\(JSON\.stringify\(([\s\S]*?)\)\);/g)].map((m) => m[1]);
  assert.ok(logged.length >= 3, 'the adapter does log telemetry');
  for (const raw of logged) {
    // Neutralise the two sanctioned wrappers, then nothing secret may remain.
    const expr = raw
      .replace(/describeKey\([^)]*\)/g, 'SAFE()')
      .replace(/keyFingerprint\([^)]*\)/g, 'SAFE()');
    assert.equal(/UKRAINEALARM_API_KEY/.test(expr), false,
      'no raw secret in a log line');
    assert.equal(/authHeaderValue\(/.test(raw), false,
      'the Authorization header value is never logged');
    assert.equal(/\bkey\b/.test(expr), false,
      'no bare `key` variable in a log line');
  }
});

test('the fingerprint helper never returns anything derived from the raw key', async () => {
  const fp = await keyFingerprint(SECRET);
  assert.equal(fp.length, 12);
  assert.equal(/[a-z]/i.test(fp.replace(/[0-9a-f]/g, '')), false, 'hex only');
  for (const n of [3, 6, 9]) assert.equal(fp.includes(SECRET.slice(0, n)), false);
});
