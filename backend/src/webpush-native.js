// Workers-native Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID).
// Only Web Crypto + fetch. No Node APIs, no dependencies.
// Exceptions from builders carry err.stage: 'config-vapid' | 'vapid-sign' | 'encrypt'.
const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64uEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
    s += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63]
      + (i + 1 < b.length ? B64U[(n >> 6) & 63] : '')
      + (i + 2 < b.length ? B64U[n & 63] : '');
  }
  return s;
}

export function b64uDecode(s) {
  const clean = String(s || '').replace(/=+$/, '');
  const vals = [];
  for (const ch of clean) {
    if (ch === '=') break;
    const v = B64U.indexOf(ch);
    if (v < 0) throw new Error('Invalid base64url input');
    vals.push(v);
  }
  const out = [];
  for (let i = 0; i < vals.length; i += 4) {
    const n = (vals[i] << 18) | ((vals[i + 1] || 0) << 12) | ((vals[i + 2] || 0) << 6) | (vals[i + 3] || 0);
    out.push((n >> 16) & 255);
    if (vals[i + 2] !== undefined) out.push((n >> 8) & 255);
    if (vals[i + 3] !== undefined) out.push(n & 255);
  }
  return new Uint8Array(out);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const ascii = (s) => new TextEncoder().encode(s);
const ZERO = new Uint8Array([0]);

// Redact anything secret-looking before text can reach logs or HTTP.
export function sanitizeErrorText(s) {
  return String(s || 'unknown error')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/['"]?[A-Za-z0-9\-_+/=]{40,}['"]?/g, '[key]')
    .slice(0, 200);
}
export function firstFrames(e, n = 3) {
  return String(e?.stack || '').split('\n').slice(1, n + 1)
    .map(l => sanitizeErrorText(l.trim()).slice(0, 120))
    .filter(Boolean);
}

function coded(stage, message) {
  const e = new Error(message);
  e.stage = stage;
  return e;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}
async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}
async function hkdfExpand(prk, info, len) {
  let t = new Uint8Array(0);
  let out = new Uint8Array(0);
  let counter = 0;
  while (out.length < len) {
    counter += 1;
    t = await hmacSha256(prk, concat(t, info, new Uint8Array([counter])));
    out = concat(out, t);
  }
  return out.slice(0, len);
}

// RFC 8291 §4 aes128gcm. Returns { body, saltB64u, senderPubB64u }.
// saltBytes (16B) and ephemeral ({privateJwk, publicRaw}) are injectable for tests.
export async function encryptAes128gcm({ p256dh, auth }, plaintext, opts = {}) {
  let receiverRaw;
  try { receiverRaw = b64uDecode(p256dh); } catch { throw coded('encrypt', 'Invalid subscription p256dh'); }
  if (receiverRaw.length !== 65 || receiverRaw[0] !== 4) throw coded('encrypt', 'Invalid subscription p256dh');
  let authBytes;
  try { authBytes = b64uDecode(auth); } catch { throw coded('encrypt', 'Invalid subscription auth'); }
  if (authBytes.length < 16) throw coded('encrypt', 'Subscription auth must decode to at least 16 bytes');
  const salt = opts.saltBytes ? new Uint8Array(opts.saltBytes) : crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw coded('encrypt', 'Salt must be 16 bytes');
  let ephPriv, senderPub;
  try {
    if (opts.ephemeral) {
      ephPriv = await crypto.subtle.importKey('jwk', opts.ephemeral.privateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      senderPub = new Uint8Array(opts.ephemeral.publicRaw);
      if (senderPub.length !== 65 || senderPub[0] !== 4) throw new Error('bad ephemeral public key');
    } else {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      ephPriv = kp.privateKey;
      // subtle raw export is already the 65-byte uncompressed point (0x04 || X || Y)
      senderPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
      if (senderPub.length !== 65 || senderPub[0] !== 4) throw new Error('bad ephemeral public key');
    }
  } catch (e) {
    if (e.stage) throw e;
    throw coded('encrypt', 'Ephemeral key failure');
  }
  let receiverPub;
  try {
    receiverPub = await crypto.subtle.importKey('raw', receiverRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch (e) { throw coded('encrypt', 'Invalid receiver public key'); }
  let shared;
  try {
    shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverPub }, ephPriv, 256));
  } catch (e) { throw coded('encrypt', 'ECDH failure'); }
  const infoCtx = concat(ascii('WebPush: info'), ZERO, receiverRaw, senderPub);
  return finishAes128gcm(authBytes, shared, infoCtx, salt, senderPub, plaintext);
}

async function hkdfExpandFull(authBytes, shared, infoCtx) {
  const prk = await hkdfExtract(authBytes, shared);
  return hkdfExpand(prk, infoCtx, 32);
}

async function finishAes128gcm(authBytes, shared, infoCtx, salt, senderPub, plaintext) {
  const secret = await hkdfExpandFull(authBytes, shared, infoCtx);
  const prk = await hkdfExtract(salt, secret);
  const cek = await hkdfExpand(prk, concat(ascii('Content-Encoding: aes128gcm'), ZERO), 16);
  const nonce = await hkdfExpand(prk, concat(ascii('Content-Encoding: nonce'), ZERO), 12);
  const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0x00]);
  const body = concat(salt, rs, new Uint8Array([65]), senderPub, ct);
  return { body, saltB64u: b64uEncode(salt), senderPubB64u: b64uEncode(senderPub) };
}

// RFC 8292 VAPID JWT (ES256). Throws coded('config-vapid' | 'vapid-sign').
export async function vapidSign({ subject, publicKey, privateKey, audience, expSeconds = 43200 }) {
  let aud;
  try { aud = new URL(audience); } catch { throw coded('vapid-sign', 'VAPID audience is not a url'); }
  if (aud.protocol !== 'https:' && aud.protocol !== 'http:') throw coded('vapid-sign', 'VAPID audience must be http(s)');
  if (subject !== undefined) {
    const ok = /^[^\s]+@[^\s]+$/.test(String(subject).replace(/^mailto:/, '')) || /^https?:\/\/\S+$/.test(String(subject));
    const proto = String(subject).startsWith('mailto:') ? 'mailto:' : String(subject).split(':')[0] + ':';
    if (!['mailto:', 'https:'].includes(proto) || !ok) throw coded('vapid-sign', 'VAPID subject must be https: URL or mailto:');
  }
  let pub, priv;
  try { pub = b64uDecode(publicKey); } catch { throw coded('config-vapid', 'Invalid VAPID public key'); }
  try { priv = b64uDecode(privateKey); } catch { throw coded('config-vapid', 'Invalid VAPID private key'); }
  if (pub.length !== 65 || pub[0] !== 4) throw coded('config-vapid', 'Invalid VAPID public key');
  if (priv.length !== 32) throw coded('config-vapid', 'Invalid VAPID private key');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: b64uEncode(priv),
  };
  let key;
  try {
    key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch (e) { throw coded('vapid-sign', 'VAPID key import failed'); }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64uEncode(new TextEncoder().encode(JSON.stringify({ aud: aud.protocol + '//' + aud.host, exp: nowSec + expSeconds, sub: subject })));
  const signingInput = ascii(header + '.' + payload);
  let sig;
  try {
    sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput));
  } catch (e) { throw coded('vapid-sign', 'VAPID sign failed'); }
  // crypto.subtle.sign(ECDSA) returns IEEE P1363 (64-byte raw R||S) in both
  // Cloudflare Workers and Node — NOT DER. Use the bytes directly.
  const jwt = header + '.' + payload + '.' + b64uEncode(sig);
  return { jwt, authorization: 'vapid t=' + jwt + ', k=' + publicKey };
}

// ASN.1 DER ECDSA signature -> 64-byte raw R||S.
export function derToRaw(der) {
  const b = new Uint8Array(der);
  let o = 0;
  if (b[o++] !== 0x30) throw new Error('bad DER sequence');
  let len = b[o++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 2) throw new Error('bad DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[o++];
  }
  const takeInt = () => {
    if (b[o++] !== 0x02) throw new Error('bad DER integer');
    let l = b[o++];
    let v = b.slice(o, o + l);
    o += l;
    while (v.length > 1 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error('bad DER integer length');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = takeInt(), s = takeInt();
  if (o !== b.length) throw new Error('trailing DER bytes');
  return concat(r, s);
}

export async function buildPushRequest(sub, payload, opts = {}) {
  const { endpoint } = sub || {};
  // Support both flat {p256dh,auth} and web-push-style {keys:{p256dh,auth}}.
  const p256dh = sub?.p256dh ?? sub?.keys?.p256dh;
  const auth   = sub?.auth   ?? sub?.keys?.auth;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
    throw coded('encrypt', 'Invalid push endpoint');
  }
  const vapid = opts.vapid || {};
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    throw coded('config-vapid', 'VAPID is not configured');
  }
  const enc = await encryptAes128gcm({ p256dh, auth }, payload, opts);
  const jwt = await vapidSign({
    subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey,
    audience: new URL(endpoint).origin, expSeconds: opts.expSeconds || 43200,
  });
  return {
    url: endpoint,
    method: 'POST',
    headers: {
      TTL: String(opts.ttl || 3600),
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Encryption: 'salt=' + enc.saltB64u,
      'Crypto-Key': 'dh=' + enc.senderPubB64u,
      Authorization: jwt.authorization,
      Urgency: opts.urgency || 'normal',
    },
    body: enc.body,
  };
}

// Single attempt over fetchFn (default global fetch). Never throws.
export async function sendNativeOnce(vapid, sub, payload, deps = {}) {
  const started = Date.now();
  const fetchFn = deps.fetchFn || fetch;
  let req;
  try {
    req = await buildPushRequest(sub, payload, { vapid, ttl: 3600, saltBytes: deps.saltBytes, ephemeral: deps.ephemeral });
  } catch (e) {
    return {
      ok: false, deleted: false, attempts: 0,
      statusCode: null, stage: e?.stage || 'encrypt',
      errorName: e?.name || 'Error', error: sanitizeErrorText(e?.message || e),
      stack: firstFrames(e), latencyMs: Date.now() - started, retryable: false,
    };
  }
  try {
    const res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body });
    try { await res.arrayBuffer(); } catch { /* drain best-effort */ }
    const status = res.status;
    if (status >= 200 && status < 300) {
      return { ok: true, deleted: false, attempts: 1, statusCode: status, stage: 'send-notification', errorName: null, error: null, stack: [], latencyMs: Date.now() - started, retryable: false };
    }
    if (status === 404 || status === 410) {
      return { ok: false, deleted: true, attempts: 1, statusCode: status, stage: 'send-notification', errorName: 'GoneError', error: 'subscription gone', stack: [], latencyMs: Date.now() - started, retryable: false };
    }
    const retryable = status === 429 || status >= 500;
    return { ok: false, deleted: false, attempts: 1, statusCode: status, stage: 'send-notification', errorName: 'PushError', error: 'provider status ' + status, stack: [], latencyMs: Date.now() - started, retryable };
  } catch (e) {
    return {
      ok: false, deleted: false, attempts: 1,
      statusCode: e?.statusCode ?? null, stage: 'send-notification',
      errorName: e?.name || 'Error', error: sanitizeErrorText(e?.message || e),
      stack: firstFrames(e), latencyMs: Date.now() - started, retryable: true,
    };
  }
}
