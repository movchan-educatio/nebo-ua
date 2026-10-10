// The preflight decides whether a cross-origin browser request is ever sent.
//
// It shipped wrong for a long time: the aggregator answered OPTIONS with
// Access-Control-Allow-Headers: Content-Type, so any client that added a
// cache-control header was refused before the request left the browser. The
// radar did exactly that, and the visible symptom was not a CORS message — it
// was a radar that read OFFLINE with no data and no explanation.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const origin = 'https://nebo-ua.vercel.app';

function preflight(asked) {
  const headers = {
    Origin: origin,
    'Access-Control-Request-Method': 'GET',
  };
  if (asked) headers['Access-Control-Request-Headers'] = asked;
  return worker.fetch(new Request('https://worker.test/v1/state', { method: 'OPTIONS', headers }), {});
}

test('preflight allows the headers the browser actually asked about', async () => {
  // The exact set the radar used to send.
  const res = await preflight('cache-control,pragma');
  assert.equal(res.status, 200);
  const allowed = (res.headers.get('Access-Control-Allow-Headers') || '').toLowerCase();
  const requested = 'cache-control,pragma'.split(',').map((h) => h.trim());
  for (const h of requested) {
    assert.ok(
      allowed.split(',').map((x) => x.trim()).includes(h),
      `preflight must allow "${h}", got "${allowed}" — the browser would refuse to send the request`,
    );
  }
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'still a public read endpoint');
  assert.ok((res.headers.get('Access-Control-Allow-Methods') || '').includes('GET'));
});

test('preflight with no requested headers still answers something usable', async () => {
  const res = await preflight(null);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok((res.headers.get('Access-Control-Allow-Headers') || '').length > 0);
});

test('preflight answers every path, not just /v1/state', async () => {
  // The handler sits above the routing, so a preflight for an unknown path must
  // still succeed; otherwise a client gets a CORS error instead of a 404 and
  // cannot tell which it is.
  const res = await worker.fetch(new Request('https://worker.test/v1/metrics', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
  }), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('a plain cross-origin GET is not preflighted away', async () => {
  // No env, so this 503s — but it must be a real HTTP answer with CORS headers,
  // not a thrown error. The distinction is what the radar reports to the user.
  const res = await worker.fetch(new Request('https://worker.test/v1/state', {
    headers: { Origin: origin },
  }), {});
  assert.equal(res.status, 503, 'honest unavailable, never a fake success');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'and readable by the page');
});
