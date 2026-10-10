// End-to-end CORS regression test for the OFFLINE outage.
//
// The failure this covers was invisible to every other check we had: the unit
// suite read the source, the live check stubbed /v1/state through Playwright
// routing (which replaces the response before CORS is evaluated), and the API
// answered 200 to curl. The only thing that can see it is a real cross-origin
// fetch in a real browser with CORS actually enforced.
//
// So: the site is served on one port, a stand-in aggregator on another, and the
// page is pointed at the second through the supported localStorage override.
// The stand-in is deliberately given the OLD broken preflight — a fixed
// Access-Control-Allow-Headers list — to prove the frontend fix stands on its
// own and does not depend on the server being fixed first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const site = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  let f = path.join(root, p);
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { const i = f + '/index.html'; f = fs.existsSync(i) ? i : null; if (!f) { r.writeHead(404); return r.end('nf'); } }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

// The stand-in aggregator. STRICT = the historical broken preflight.
const STRICT = process.argv.includes('--strict');
const preflights = [];
const api = http.createServer((q, r) => {
  const origin = q.headers.origin || '*';
  if (q.method === 'OPTIONS') {
    preflights.push(q.headers['access-control-request-headers'] || '(none)');
    const allow = STRICT ? 'Content-Type' : (q.headers['access-control-request-headers'] || 'Content-Type');
    r.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': allow,
      'Access-Control-Max-Age': '86400',
    });
    return r.end();
  }
  const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
  r.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  r.end(JSON.stringify({
    v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(30), publishedAt: iso(5), serverTime: new Date().toISOString(),
    alerts: [],
    events: [
      { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська', locationPrecision: 'COORDINATE' },
      { trackId: 't2', kind: 'missile', lat: 50.18, lon: 31.1, source: 'MAPA', eventTime: iso(120), region: 'Київська', locationPrecision: 'COORDINATE' },
    ],
    health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
  }));
});

await new Promise((r) => site.listen(0, '127.0.0.1', r));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const API = `http://127.0.0.1:${api.address().port}/v1/state`;

let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

console.log(`site ${SITE}`);
console.log(`api  ${API}`);
console.log(`preflight behaviour: ${STRICT ? 'STRICT (old, broken)' : 'permissive (current)'}\n`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const corsErrors = [];
page.on('console', (m) => { if (/blocked by CORS/i.test(m.text())) corsErrors.push(m.text().slice(0, 140)); });
page.on('requestfailed', (r) => { if (r.url().includes('/v1/state')) corsErrors.push('requestfailed: ' + r.failure()?.errorText); });

// Point the page at the stand-in through the supported override.
await page.addInitScript((url) => {
  try { localStorage.setItem('nebo-api-url', url); } catch { /* ignore */ }
}, API);

await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const ui = await page.evaluate(() => ({
  badge: document.getElementById('rlLive')?.textContent,
  updated: document.getElementById('rlUpdated')?.textContent,
  alertShown: !document.getElementById('rlAlert')?.hidden,
  alertTitle: document.getElementById('rlAlertTitle')?.textContent,
  sources: document.getElementById('rlSources')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80),
  contacts: document.querySelectorAll('.rl-contact').length,
}));

console.log('preflights sent :', preflights.length ? preflights.join(' | ') : '(none — nothing needed a preflight)');
console.log('badge           :', ui.badge);
console.log('updated         :', ui.updated);
console.log('sources         :', ui.sources || '(empty)');
console.log('contacts        :', ui.contacts);
console.log('notice          :', ui.alertShown ? ui.alertTitle : '(none)');

if (corsErrors.length) { for (const e of corsErrors.slice(0, 3)) fail('CORS: ' + e); }
else ok('no CORS failure');

if (ui.badge !== 'LIVE') fail(`badge is "${ui.badge}" — the radar did not recover`);
else ok('radar is LIVE across origins');

if (ui.contacts < 1) fail('no contacts plotted — the payload never reached the page');
else ok(`${ui.contacts} contact(s) plotted from the cross-origin payload`);

if (/невідома|невідоме|Час перевірки —/.test(ui.updated + ui.sources)) fail('still reporting unknown verification time');
else ok('verification time is real, not unknown');

if (ui.alertShown) fail(`a warning is showing on healthy data: "${ui.alertTitle}"`);
else ok('no warning on healthy data');

// The strongest form of the fix: with no non-safelisted headers there is
// nothing to preflight, so the radar works against the OLD broken server too.
if (STRICT && preflights.length) fail(`a preflight was sent (${preflights.length}); the client must not need one`);
else ok('client never needed a preflight');

await browser.close();
site.close();
api.close();
console.log(`\n${failures ? failures + ' findings' : 'cross-origin state fetch works'}`);
process.exitCode = failures ? 1 : 0;
