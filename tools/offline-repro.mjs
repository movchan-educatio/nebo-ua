// Reproduces the OFFLINE report against the deployed site with NO interception.
//
// The earlier live-check stubbed /v1/state through Playwright routing, which
// replaces the response before CORS is ever evaluated — so it proved the page
// renders, and could not see a request the browser refuses to send. This one
// lets the real cross-origin fetch go out and reports what the page concluded.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://nebo-ua.vercel.app';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const seen = [];
page.on('request', (r) => { if (r.url().includes('/v1/state')) seen.push(['request', r.method(), r.url()]); });
page.on('requestfailed', (r) => {
  if (r.url().includes('/v1/state')) seen.push(['FAILED', r.failure()?.errorText, r.method()]);
});
page.on('response', (r) => { if (r.url().includes('/v1/state')) seen.push(['response', r.status(), r.request().method()]); });
page.on('console', (m) => { if (/cors|preflight|blocked|radar-live/i.test(m.text())) seen.push(['console:' + m.type(), m.text().slice(0, 150), '']); });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(9000);

const ui = await page.evaluate(() => ({
  badge: document.getElementById('rlLive')?.textContent,
  updated: document.getElementById('rlUpdated')?.textContent,
  alertShown: !document.getElementById('rlAlert')?.hidden,
  alertTitle: document.getElementById('rlAlertTitle')?.textContent,
  alertMeta: document.getElementById('rlAlertMeta')?.textContent,
  sources: document.getElementById('rlSources')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120),
  feed: document.getElementById('rlFeedCount')?.textContent,
}));

console.log('--- what the browser did with /v1/state ---');
for (const s of seen) console.log('  ' + s[0].padEnd(16) + ' ' + s[1] + (s[2] ? '  ' + s[2] : ''));
if (!seen.length) console.log('  (no /v1/state activity at all)');

console.log('\n--- what the page told the user ---');
console.log('  badge      :', ui.badge);
console.log('  updated    :', ui.updated);
console.log('  notice     :', ui.alertShown ? ui.alertTitle : '(none)');
console.log('  meta       :', ui.alertMeta);
console.log('  sources    :', ui.sources || '(empty)');
console.log('  feed count :', ui.feed);

await page.screenshot({ path: 'tmp-shots/offline-repro.png', clip: { x: 0, y: 0, width: 1440, height: 260 } });
await browser.close();
