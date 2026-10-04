import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  b64uEncode, b64uDecode, encryptAes128gcm, vapidSign, derToRaw,
  buildPushRequest, sendNativeOnce, sanitizeErrorText,
} from '../src/webpush-native.js';
import { sendToSubscription } from '../src/push.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
// Reference vector produced by web-push/http_ece with fixed inputs.
const F = {
  receiverPubB64: 'BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q',
  authB64: 'IiIiIiIiIiIiIiIiIiIiIg',
  ephPrivHex: '3333333333333333333333333333333333333333333333333333333333333333',
  ephPubB64: 'BFGnWAgziY6hsYPL1zUKQJkHjG7xweGOlwzXaDA18l59ARBSJxKwtafP8IFoVIaYSpTmgx7axG5zYPqdg0p6gaE',
  saltB64: 'RERERERERERERERERERERA',
  payloadHex: '7b227469746c65223a22d09dd0b5d0b1d0be2e5541222c22626f6479223a22d0a2d0b5d181d182227d',
  cipherHex: '4444444444444444444444444444444400001000410451a7580833898ea1b183cbd7350a4099078c6ef1c1e18e970cd7683035f25e7d0110522712b0b5a7cff081685486984a94e6831edac46e7360fa9d834a7a81a1b9b45da236bc3f0eb05b76c2218803bd413839e885f0cb24f3df5c81307e7dea741ef54d7c225ab689766f047db50f2d9611ae7676c084d2df18',
};
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function ephJwk() {
  const pub = b64uDecode(F.ephPubB64);
  return {
    privateJwk: {
      kty: 'EC', crv: 'P-256',
      x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)),
      d: b64uEncode(hex(F.ephPrivHex)),
    },
    publicRaw: pub,
  };
}

test('b64u round-trips binary data', () => {
  for (const len of [0, 1, 2, 3, 16, 32, 64, 65]) {
    const v = new Uint8Array(len).map((_, i) => (i * 37 + 11) % 256);
    assert.ok(eqBytes(b64uDecode(b64uEncode(v)), v), 'len ' + len);
  }
  assert.throws(() => b64uDecode('!!!'), /base64url/);
});

test('encrypt output matches the reference implementation byte-for-byte', async () => {
  const eph = ephJwk();
  const out = await encryptAes128gcm(
    { p256dh: F.receiverPubB64, auth: F.authB64 },
    hex(F.payloadHex),
    { saltBytes: b64uDecode(F.saltB64), ephemeral: { privateJwk: eph.privateJwk, publicRaw: eph.publicRaw } },
  );
  assert.ok(eqBytes(out.body, hex(F.cipherHex)), 'ciphertext must equal reference bytes');
  assert.equal(out.body.length, 144);
  assert.equal(out.saltB64u, F.saltB64);
  assert.equal(out.senderPubB64u, F.ephPubB64);
});

test('encrypt header layout follows RFC 8291', async () => {
  const eph = ephJwk();
  const out = await encryptAes128gcm(
    { p256dh: F.receiverPubB64, auth: F.authB64 },
    new TextEncoder().encode('hi'),
    { saltBytes: b64uDecode(F.saltB64), ephemeral: { privateJwk: eph.privateJwk, publicRaw: eph.publicRaw } },
  );
  assert.ok(eqBytes(out.body.slice(0, 16), b64uDecode(F.saltB64)));
  assert.deepEqual([...out.body.slice(16, 20)], [0, 0, 0x10, 0x00]);
  assert.equal(out.body[20], 65);
  assert.ok(eqBytes(out.body.slice(21, 86), b64uDecode(F.ephPubB64)));
});

test('encrypt is deterministic on fixed inputs', async () => {
  const eph = ephJwk();
  const opts = { saltBytes: b64uDecode(F.saltB64), ephemeral: { privateJwk: eph.privateJwk, publicRaw: eph.publicRaw } };
  const a = await encryptAes128gcm({ p256dh: F.receiverPubB64, auth: F.authB64 }, hex(F.payloadHex), opts);
  const b = await encryptAes128gcm({ p256dh: F.receiverPubB64, auth: F.authB64 }, hex(F.payloadHex), opts);
  assert.ok(eqBytes(a.body, b.body));
});

test('encrypt rejects bad subscription material with encrypt stage', async () => {
  await assert.rejects(
    encryptAes128gcm({ p256dh: 'short', auth: F.authB64 }, new Uint8Array([1])),
    (e) => e.stage === 'encrypt',
  );
  await assert.rejects(
    encryptAes128gcm({ p256dh: F.receiverPubB64, auth: 'dG9vc2hvcnQ' }, new Uint8Array([1])),
    (e) => e.stage === 'encrypt',
  );
});

test('vapidSign produces verifiable ES256 JWT', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = new Uint8Array(65);
  raw.set(b64uDecode(pubJwk.x), 1);
  raw.set(b64uDecode(pubJwk.y), 33);
  raw[0] = 4;
  const pubB64 = b64uEncode(raw);
  const before = Math.floor(Date.now() / 1000);
  const { jwt, authorization } = await vapidSign({
    subject: 'mailto:t@t.t', publicKey: pubB64, privateKey: privJwk.d,
    audience: 'https://push.example.com', expSeconds: 3600,
  });
  assert.ok(authorization.startsWith('vapid t=') && authorization.includes(', k=' + pubB64));
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(claims.aud, 'https://push.example.com');
  assert.equal(claims.sub, 'mailto:t@t.t');
  assert.ok(claims.exp > before && claims.exp <= before + 3600);
  const sig = b64uDecode(s);
  assert.equal(sig.length, 64);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, new TextEncoder().encode(h + '.' + p));
  assert.equal(ok, true);
});

test('vapidSign rejects bad subject, keys and audience', async () => {
  await assert.rejects(vapidSign({ subject: 'nope', publicKey: F.receiverPubB64, privateKey: 'AA', audience: 'https://x.com' }), /subject|audience|key/i);
  await assert.rejects(vapidSign({ subject: 'mailto:t@t.t', publicKey: 'short', privateKey: 'AA', audience: 'https://x.com' }), (e) => e.stage === 'config-vapid' || /key/i.test(e.message));
  await assert.rejects(vapidSign({ subject: 'mailto:t@t.t', publicKey: F.receiverPubB64, privateKey: 'AA', audience: 'not a url %%' }), /url|audience/i);
});

test('derToRaw converts DER signatures and rejects garbage', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4);
  assert.throws(() => derToRaw(new Uint8Array([1, 2, 3])), /DER/);
});

test('buildPushRequest forms a complete Chromium-compatible POST', async () => {
  const eph = ephJwk();
  const req = await buildPushRequest(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: F.receiverPubB64, auth: F.authB64 },
    JSON.stringify({ title: 't' }),
    {
      vapid: { subject: 'mailto:t@t.t', publicKey: F.ephPubB64, privateKey: b64uEncode(hex(F.ephPrivHex)) },
      ttl: 3600, saltBytes: b64uDecode(F.saltB64),
      ephemeral: { privateJwk: eph.privateJwk, publicRaw: eph.publicRaw },
    },
  );
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(req.headers.TTL, '3600');
  assert.equal(req.headers['Content-Type'], 'application/octet-stream');
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(req.headers.Encryption.startsWith('salt='));
  assert.ok(req.headers['Crypto-Key'].startsWith('dh='));
  assert.ok(req.headers.Authorization.startsWith('vapid t='));
  assert.equal(req.headers.Urgency, 'normal');
  assert.ok(req.body instanceof Uint8Array && req.body.length > 86);
});

test('buildPushRequest rejects non-https endpoints', async () => {
  await assert.rejects(
    buildPushRequest({ endpoint: 'http://x/y', p256dh: F.receiverPubB64, auth: F.authB64 }, 'x', { vapid: { subject: 'mailto:t@t.t', publicKey: 'x', privateKey: 'y' } }),
    /endpoint/i,
  );
});

test('sendNativeOnce maps provider statuses without network', async () => {
  const { sendNativeOnce } = await import('../src/webpush-native.js');
  const mkFetch = (status) => async () => ({ status, arrayBuffer: async () => new ArrayBuffer(0) });
  const vapid = { subject: 'mailto:t@t.t', publicKey: F.ephPubB64, privateKey: b64uEncode(hex(F.ephPrivHex)) };
  const sub = { endpoint: 'https://push.example/x', p256dh: F.receiverPubB64, auth: F.authB64 };
  const okRes = await sendNativeOnce(vapid, sub, 'hi', { fetchFn: mkFetch(201) });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.stage, 'send-notification');
  const gone = await sendNativeOnce(vapid, sub, 'hi', { fetchFn: mkFetch(410) });
  assert.equal(gone.deleted, true);
  const denied = await sendNativeOnce(vapid, sub, 'hi', { fetchFn: mkFetch(401) });
  assert.equal(denied.ok, false);
  assert.equal(denied.retryable, false);
  const throttled = await sendNativeOnce(vapid, sub, 'hi', { fetchFn: mkFetch(429) });
  assert.equal(throttled.retryable, true);
  const down = await sendNativeOnce(vapid, sub, 'hi', { fetchFn: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.ok, false);
  assert.equal(down.retryable, true);
  assert.equal(down.statusCode, null);
});

test('production path uses no Node https and no web-push client', () => {
  const native = fs.readFileSync(path.join(root, 'src', 'webpush-native.js'), 'utf8');
  const push = fs.readFileSync(path.join(root, 'src', 'push.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  for (const [name, src] of [['webpush-native.js', native], ['push.js', push], ['index.js', index]]) {
    assert.ok(!/require\(['"]https['"]\)/.test(src), name + ' must not require node:https');
    assert.ok(!/from ['"]web-push['"]/.test(src), name + ' must not import web-push');
    assert.ok(!/sendNotification/.test(src), name + ' must not call web-push sendNotification');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies?.['web-push'], 'web-push must not be a production dependency');
});

test('sanitizeErrorText still redacts urls and tokens', async () => {
  const { sanitizeErrorText } = await import('../src/webpush-native.js');
  const s = sanitizeErrorText('fetch failed https://push.example/abc ' + 'A'.repeat(50));
  assert.ok(!s.includes('https://') && s.includes('[url]') && s.includes('[key]'));
});
