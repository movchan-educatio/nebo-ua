import { chromium } from 'playwright';
const U = 'https://nebo-ua.vercel.app/';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [], failed = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 120)));
p.on('requestfailed', r => failed.push(r.url().slice(0, 80)));
await p.goto(U, { waitUntil: 'domcontentloaded', timeout: 45000 });
await p.waitForTimeout(6000);
const r = await p.evaluate(() => ({
  live: document.getElementById('rlLive')?.textContent,
  updated: document.getElementById('rlUpdated')?.textContent,
  count: document.getElementById('rlRadarCount')?.textContent,
  feed: document.querySelectorAll('.rl-event').length,
  kinds: document.querySelectorAll('.rl-kind').length,
  circle: (() => { const x = document.querySelector('.rl-radar-screen')?.getBoundingClientRect(); return x ? Math.round(x.width) + 'x' + Math.round(x.height) : null; })(),
  centre: document.getElementById('rlCenterLabel')?.textContent,
  nomCalls: performance.getEntriesByType('resource').filter(e => e.name.includes('nominatim')).length,
  srcs: [...document.querySelectorAll('.rl-source-mini')].map(e => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)),
}));
console.log(JSON.stringify(r, null, 2));
console.log('JS errors:', errs.length, '| failed requests:', failed.length, failed.slice(0, 2).join(' | '));
await p.screenshot({ path: 'shots/LIVE-AFTER-FIX.png' });
await b.close();