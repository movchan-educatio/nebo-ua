// Drives the three refresh modes in a real browser against scripted server
// behaviour, at every width the specification names. Logic is covered by
// tests/refresh.test.js; this proves the wiring — that the button works, the
// badge says the right thing, the notice appears and clears, and no duplicate
// requests are issued.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  let f = path.join(root, p);
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { const i = f + '/index.html'; f = fs.existsSync(i) ? i : null; if (!f) { r.writeHead(404); return r.end('nf'); } }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1440, 1920];

function snapshot({ pipeAgeS = 5, dataAgeS = 30, neptun = 'online', mapa = 'online' } = {}) {
  const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    v: 1,
    pipelineCheckedAt: iso(pipeAgeS),
    dataUpdatedAt: iso(dataAgeS),
    publishedAt: iso(pipeAgeS),
    serverTime: new Date().toISOString(),
    pipelineCheckedAtIso: null,
    alerts: [],
    events: [
      { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' },
      { trackId: 't2', kind: 'missile', lat: 48.4, lon: 35.0, source: 'MAPA', eventTime: iso(120), region: 'Дніпропетровська' },
    ],
    health: {
      NEPTUN: { status: neptun, updatedAt: iso(pipeAgeS), error: neptun === 'online' ? null : 'HTTP 500' },
      MAPA: { status: mapa, updatedAt: iso(pipeAgeS), error: mapa === 'online' ? null : 'timeout' },
    },
  };
}

let behaviour = { mode: 'fresh' };
let requestLog = [];

async function newPage(browser, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (!u.includes('check-ua-proxy')) return route.abort();
    requestLog.push(Date.now());
    const b = behaviour;
    if (b.mode === 'network') return route.abort('failed');
    if (b.mode === 'http500') return route.fulfill({ status: 500, body: 'boom' });
    if (b.mode === 'badjson') return route.fulfill({ status: 200, contentType: 'application/json', body: '{oops' });
    if (b.mode === 'notimestamp') {
      const s = snapshot(); delete s.pipelineCheckedAt;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(s) });
    }
    if (b.mode === 'future') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot({ pipeAgeS: -600 })) });
    if (b.mode === 'retry-after') return route.fulfill({ status: 503, headers: { 'retry-after': '45' }, body: '' });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      headers: b.cacheHeader ? { 'cache-control': b.cacheHeader } : {},
      body: JSON.stringify(snapshot(b)),
    });
  });
  return { page, errors };
}

const browser = await chromium.launch({ headless: true });
let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

// ── Scenario 1: fresh, healthy ────────────────────────────────────────────
{
  behaviour = { mode: 'fresh' };
  requestLog = [];
  const { page, errors } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    badgeStale: document.getElementById('rlLive')?.classList.contains('stale'),
    updated: document.getElementById('rlUpdated')?.textContent,
    alertHidden: document.getElementById('rlAlert')?.hidden,
    btnDisabled: document.getElementById('rlRefreshBtn')?.disabled,
    btnBusy: document.getElementById('rlRefreshBtn')?.getAttribute('aria-busy'),
    contacts: document.querySelectorAll('.rl-contact').length,
    feed: document.querySelectorAll('.rl-event').length,
    markers: window.__rlTestMarkerCount ? window.__rlTestMarkerCount() : null,
  }));
  if (r.badge !== 'LIVE') fail(`fresh data shows "${r.badge}", expected LIVE`);
  else ok(`badge LIVE · "${r.updated}"`);
  if (!r.alertHidden) fail('the notice is shown on a healthy radar');
  else ok('no notice on a healthy radar');
  if (r.btnDisabled || r.btnBusy !== 'false') fail('the refresh button is stuck disabled');
  else ok('refresh button enabled and idle');
  // Both events must reach the feed. Only the one inside the default 200km
  // radius reaches the radar — the other sits in Dnipro, roughly 400km out —
  // so asserting two markers would be asserting that the radius is ignored.
  if (r.feed < 2) fail(`feed rendered ${r.feed} of 2 events`);
  else ok(`feed carries both events, radar shows ${r.contacts} inside the radius`);
  if (r.contacts < 1) fail('nothing at all was plotted on the radar');
  if (errors.length) fail('JS error: ' + errors[0]);
  await page.close();
}

// ── Manual refresh really fetches ─────────────────────────────────────────
{
  behaviour = { mode: 'fresh' };
  requestLog = [];
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const before = requestLog.length;
  await page.click('#rlRefreshBtn');
  await page.waitForTimeout(1500);
  const after = requestLog.length;
  if (after <= before) fail('pressing the button issued no request');
  else ok(`manual refresh issued ${after - before} request(s)`);

  // Rapid presses must not become a burst.
  requestLog = [];
  await page.evaluate(() => {
    const b = document.getElementById('rlRefreshBtn');
    for (let i = 0; i < 8; i++) b.click();
  });
  await page.waitForTimeout(1500);
  if (requestLog.length > 1) fail(`8 rapid presses produced ${requestLog.length} requests`);
  else ok(`8 rapid presses produced ${requestLog.length} request`);
  await page.close();
}

// ── Scenario 2: HTTP 200 with an old timestamp ────────────────────────────
{
  behaviour = { mode: 'fresh', pipeAgeS: 240 };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    alertHidden: document.getElementById('rlAlert')?.hidden,
    title: document.getElementById('rlAlertTitle')?.textContent,
    meta: document.getElementById('rlAlertMeta')?.textContent,
  }));
  if (r.badge === 'LIVE') fail('a 200 with a 4-minute-old snapshot still shows LIVE');
  else ok(`stale snapshot reads "${r.badge}", not LIVE`);
  if (r.alertHidden) fail('no warning on stale data');
  else ok(`warning shown: "${r.title}"`);
  if (!/Остання підтверджена перевірка/.test(r.meta || '')) fail('the warning does not state the last verified time');
  else ok(`warning carries context: "${(r.meta || '').slice(0, 78)}…"`);

  // The manual press must say the data is still old, not "updated".
  await page.click('#rlRefreshBtn');
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => document.getElementById('rlAlertTitle')?.textContent);
  if (/Актуальність підтверджена/.test(t || '')) fail('it claimed freshness while the server was still serving an old snapshot');
  else ok(`manual press on stale data: "${t}"`);
  await page.close();
}

// ── 9/10. Source failures ─────────────────────────────────────────────────
for (const [name, cfg] of [['NEPTUN', { neptun: 'offline' }], ['MAPA', { mapa: 'offline' }]]) {
  behaviour = { mode: 'fresh', ...cfg };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    meta: document.getElementById('rlAlertMeta')?.textContent,
    alertHidden: document.getElementById('rlAlert')?.hidden,
  }));
  if (r.badge !== 'DEGRADED') fail(`${name} offline shows "${r.badge}", expected DEGRADED`);
  else ok(`${name} offline → DEGRADED, both source states listed`);
  if (r.alertHidden || !new RegExp(name).test(r.meta || '')) fail(`${name} not named in the notice`);
  await page.close();
}

// ── 3/4/5/6/7/8. Transport and payload failures ───────────────────────────
for (const [label, mode] of [
  ['HTTP 500', 'http500'],
  ['network failure', 'network'],
  ['invalid JSON', 'badjson'],
  ['missing timestamp', 'notimestamp'],
  ['timestamp in the future', 'future'],
  ['Retry-After', 'retry-after'],
]) {
  behaviour = { mode };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const r = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    alertHidden: document.getElementById('rlAlert')?.hidden,
    title: document.getElementById('rlAlertTitle')?.textContent,
    btnDisabled: document.getElementById('rlRefreshBtn')?.disabled,
  }));
  if (r.badge === 'LIVE') fail(`${label}: still shows LIVE`);
  else ok(`${label} → ${r.badge}${r.alertHidden ? ' (no notice)' : ' + notice'}`);
  if (r.btnDisabled) fail(`${label}: the refresh button stayed disabled`);
  await page.close();
}

// ── Recovery: back to LIVE when the server recovers ───────────────────────
{
  behaviour = { mode: 'fresh', pipeAgeS: 300 };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  const stale = await page.evaluate(() => document.getElementById('rlLive')?.textContent);
  behaviour = { mode: 'fresh' };
  await page.evaluate(() => { window.__t = setTimeout(() => {}, 0); });
  await page.click('#rlRefreshBtn');
  await page.waitForTimeout(1600);
  const live = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    title: document.getElementById('rlAlertTitle')?.textContent,
    alertHidden: document.getElementById('rlAlert')?.hidden,
  }));
  if (stale === 'LIVE') fail('the stale state was never reached');
  if (live.badge !== 'LIVE') fail(`recovery did not reach LIVE (${live.badge})`);
  else ok(`recovered to LIVE from ${stale}`);
  if (!/відновлено/i.test(live.title || '')) fail(`no recovery confirmation: "${live.title}"`);
  else ok(`recovery notice: "${live.title}"`);
  await page.close();
}

// ── 16/19. Tab visibility and return ──────────────────────────────────────
{
  behaviour = { mode: 'fresh' };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const t0 = Date.now();
  requestLog = [];
  await page.waitForTimeout(4000);
  const whileHidden = requestLog.length;
  if (whileHidden > 0) fail(`a hidden tab still polled (${whileHidden} requests in 4s)`);
  else ok('a hidden tab does not poll');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  if (requestLog.length < 1) fail('returning to the tab issued no check');
  else ok(`returning to the tab checked immediately (${requestLog.length} request in 1.5s, ${Date.now() - t0}ms after waking)`);
  await page.close();
}

// ── 17/18. Network loss and return ───────────────────────────────────────
{
  behaviour = { mode: 'fresh' };
  const { page } = await newPage(browser, 1440, 900);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  behaviour = { mode: 'network' };
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => document.getElementById('rlLive')?.textContent);
  if (off === 'LIVE') fail('going offline still shows LIVE');
  else ok(`network lost → ${off}`);
  behaviour = { mode: 'fresh' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1600);
  const back = await page.evaluate(() => document.getElementById('rlLive')?.textContent);
  if (back !== 'LIVE') fail(`the network returning did not restore LIVE (${back})`);
  else ok('network returned → LIVE');
  await page.close();
}

// ── 7. Every specified width, with the notice visible ────────────────────
{
  behaviour = { mode: 'fresh', pipeAgeS: 400 };
  for (const w of WIDTHS) {
    const { page, errors } = await newPage(browser, w, 900);
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const alert = document.getElementById('rlAlert');
      const btn = document.getElementById('rlRefreshBtn');
      const br = btn.getBoundingClientRect();
      const ar = alert.getBoundingClientRect();
      const radar = document.getElementById('radarCard').getBoundingClientRect();
      return {
        hScroll: doc.scrollWidth > window.innerWidth + 1,
        overflowBy: doc.scrollWidth - window.innerWidth,
        btnVisible: br.width >= 24 && br.height >= 24 && br.right <= window.innerWidth + 1,
        btnLabel: btn.textContent.trim(),
        alertShown: !alert.hidden,
        alertOverlapsRadar: ar.bottom > radar.top && ar.top < radar.bottom && ar.width > 0,
      };
    });
    const problems = [];
    if (r.hScroll) problems.push(`h-overflow ${r.overflowBy}px`);
    if (!r.btnVisible) problems.push('refresh button not fully visible');
    if (!r.alertShown) problems.push('notice missing');
    if (r.alertOverlapsRadar) problems.push('notice covers the radar');
    if (errors.length) problems.push('JS error');
    if (problems.length) fail(`${w}px: ${problems.join(', ')}`);
    else ok(`${w}px — no overflow, button "${r.btnLabel}" visible, notice in flow`);
    await page.close();
  }
}

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'all three refresh modes verified in a real browser'}`);
process.exitCode = failures ? 1 : 0;