// Probes the live UkraineAlarm API to find out what its 401 actually MEANS.
// A 401 body/headers usually distinguish "wrong key" from "no key" from
// "quota" — which is the difference between a code bug and a dead credential.
// Read-only GETs against a public API; no key is used or transmitted.
const BASE = 'https://api.ukrainealarm.com';
const PATHS = ['/api/v3/alerts/status', '/api/v3/alerts'];
const AGENTS = [
  ['no auth header', null],
  ['raw dummy key', 'test-invalid-key-0000'],
  ['Token <dummy>', 'Token test-invalid-key-0000'],
  ['Bearer <dummy>', 'Bearer test-invalid-key-0000'],
];

const show = (label, res, body) => {
  const h = (n) => res.headers.get(n);
  console.log(`  ${label.padEnd(18)} ${res.status}  ${(h('content-type') || '').split(';')[0].padEnd(18)} www-auth=${h('www-authenticate') || '-'}  retry-after=${h('retry-after') || '-'}`);
  const trimmed = (body || '').replace(/\s+/g, ' ').slice(0, 220);
  if (trimmed) console.log(`  ${''.padEnd(18)} body: ${trimmed}`);
};

for (const path of PATHS) {
  console.log(`\n=== ${path} ===`);
  for (const [label, auth] of AGENTS) {
    try {
      const headers = { Accept: 'application/json', 'User-Agent': 'nebo-ua-check-proxy/1.0 (+https://nebo-ua.vercel.app)' };
      if (auth) headers.Authorization = auth;
      const res = await fetch(BASE + path, { headers });
      show(label, res, await res.text());
    } catch (e) {
      console.log(`  ${label.padEnd(18)} ERROR ${String(e).slice(0, 90)}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

// Repeat one shape to see whether the status is stable or flickers.
console.log('\n=== stability: same request x6 (raw key omitted, no auth) ===');
const seen = {};
for (let i = 0; i < 6; i++) {
  try {
    const res = await fetch(BASE + '/api/v3/alerts/status', { headers: { Accept: 'application/json', 'User-Agent': 'nebo-ua-check-proxy/1.0' } });
    seen[res.status] = (seen[res.status] || 0) + 1;
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 700));
}
console.log('  statuses:', JSON.stringify(seen));

console.log('\n=== server headers ===');
try {
  const res = await fetch(BASE + '/api/v3/alerts/status', { headers: { Accept: 'application/json' } });
  for (const [k, v] of res.headers) if (!/^(set-cookie|cf-|report-to)$/i.test(k)) console.log(`  ${k}: ${String(v).slice(0, 90)}`);
} catch (e) { console.log('  ' + String(e).slice(0, 90)); }
