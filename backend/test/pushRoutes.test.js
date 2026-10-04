import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { toTestResult } from '../src/push.js';
import { sendToSubscription, sanitizeErrorText } from '../src/push.js';

// Minimal in-memory D1 stub: programmable SELECT results, records writes.
function fakeDb({ selectRows = [] } = {}) {
  const log = [];
  return {
    log,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            run: async () => { log.push({ sql, args }); return { success: true }; },
            all: async () => { log.push({ sql, args }); return { results: selectRows }; },
          };
        },
      };
    },
  };
}
const fakeKv = () => ({ get: async () => null, put: async () => {} });
const req = (path, body) => new Request('https://worker.test' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const noVapidEnv = (db) => ({ NEBO_STATE: fakeKv(), nebo_journal: db });
const vapidEnv = (db) => ({
  ...noVapidEnv(db),
  VAPID_PUBLIC_KEY: 'BPub359s41x6hOT1T7yqSvkvvx1x0hqxF4x3Qd2x2Jc1x0hqx',
  VAPID_PRIVATE_KEY: 'bogus-private-key',
  VAPID_SUBJECT: 'mailto:test@example.com',
});

test('toTestResult maps every send outcome without secrets', () => {
  assert.deepEqual(toTestResult({ ok: true }), { http: 200, body: { ok: true } });
  assert.deepEqual(toTestResult(null), { http: 502, body: { ok: false, code: 'send-failed', message: 'Немає результату відправки.' } });
  const gone = toTestResult({ ok: false, deleted: true });
  assert.equal(gone.body.code, 'gone');
  assert.ok(!JSON.stringify(gone).includes('p256dh'));
  const auth = toTestResult({ ok: false, deleted: false, statusCode: 401, error: 'x' });
  assert.equal(auth.body.code, 'send-failed');
  assert.equal(auth.body.status, 401);
  const net = toTestResult({ ok: false, deleted: false, statusCode: null, error: 'boom' });
  assert.equal(net.body.code, 'send-failed');
  assert.ok(!('status' in net.body));
});

test('POST /v1/push/subscribe stores the row', async () => {
  const db = fakeDb();
  const res = await worker.fetch(req('/v1/push/subscribe', {
    subscription: { endpoint: 'https://push.example/sub-1', keys: { p256dh: 'p', auth: 'a' } },
    places: [{ oblast: 'Черкаська область' }],
    categories: {},
    quiet: {},
  }), noVapidEnv(db));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const insert = db.log.find(e => e.sql.includes('INSERT INTO push_subscriptions'));
  assert.ok(insert, 'expected INSERT logged');
  assert.equal(insert.args[0], 'https://push.example/sub-1');
  assert.match(insert.args[3], /Черкаська область/);
});

test('POST /v1/push/test on unknown subscription is a structured 404', async () => {
  const db = fakeDb({ selectRows: [] });
  const res = await worker.fetch(req('/v1/push/test', { endpoint: 'https://push.example/nope' }), vapidEnv(db));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'unknown-subscription');
});

test('POST /v1/push/test without VAPID configured is vapid-missing, not ok:false', async () => {
  const db = fakeDb({ selectRows: [{ endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }] });
  const res = await worker.fetch(req('/v1/push/test', { endpoint: 'https://push.example/sub-1' }), noVapidEnv(db));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'vapid-missing');
});

test('POST /v1/push/test with unusable VAPID/backend is send-failed, never ok:false alone', async () => {
  const db = fakeDb({ selectRows: [{ endpoint: 'https://push.example/sub-1', p256dh: 'p', auth: 'a' }] });
  const env = { ...vapidEnv(db), VAPID_PRIVATE_KEY: 'bogus-not-a-real-key' };
  const res = await worker.fetch(req('/v1/push/test', { endpoint: 'https://push.example/sub-1' }), env);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(['send-failed', 'gone'].includes(body.code), 'got: ' + body.code);
  assert.equal(typeof body.message, 'string');
  assert.ok(!JSON.stringify(body).includes('bogus-private-key'));
  assert.ok(!JSON.stringify(body).includes('push.example/sub-1'));
});

test('GET /v1/push/vapid-public-key reports presence without values', async () => {  const withKey = await worker.fetch(new Request('https://worker.test/v1/push/vapid-public-key'), vapidEnv(fakeDb()));
  assert.deepEqual(await withKey.json(), { publicKey: 'BPub359s41x6hOT1T7yqSvkvvx1x0hqxF4x3Qd2x2Jc1x0hqx', hasPrivateKey: true });
  const withoutKey = await worker.fetch(
    new Request('https://worker.test/v1/push/vapid-public-key'),
    { NEBO_STATE: fakeKv(), nebo_journal: fakeDb() },
  );
  assert.deepEqual(await withoutKey.json(), { publicKey: null, hasPrivateKey: false });
  const withSecret = await worker.fetch(
    new Request('https://worker.test/v1/push/vapid-public-key'),
    { NEBO_STATE: fakeKv(), nebo_journal: fakeDb(), VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'shh', VAPID_SUBJECT: 'mailto:t@t.t' },
  );
  const body = await withSecret.json();
  assert.equal(body.hasPrivateKey, true);
  assert.ok(!JSON.stringify(body).includes('shh'));
});

test('sendToSubscription reports config stage without touching network', async () => {
  const r = await sendToSubscription({}, { endpoint: 'https://push.example/x', keys: {} }, { title: 't' }, { attempts: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'config-vapid');
  assert.equal(r.attempts, 0);
});

test('sanitizeErrorText redacts urls, tokens and headers', () => {
  const secret = 'A'.repeat(50);
  const s = sanitizeErrorText('fetch failed https://push.example/abc ' + secret + ' Crypto-Key: dh=xyz');
  assert.ok(!s.includes('https://'));
  assert.ok(!s.includes(secret));
  assert.ok(s.includes('[url]') && s.includes('[key]'));
  assert.ok(s.length <= 200);
  assert.equal(sanitizeErrorText(null), 'unknown error');
});
