// End-to-end check against the DEPLOYED site, not a local copy. Everything up
// to now proved the working tree; this proves what a visitor actually gets.
//
// The radar's /v1/state is stubbed with a known snapshot so the result does not
// depend on whether an alert happens to be flying right now. Tiles, CSS, JS and
// the service worker are the real deployed ones.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://nebo-ua.vercel.app';
let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
const snapshot = () => ({
  v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(30), publishedAt: iso(5), serverTime: new Date().toISOString(), alerts: [],
  events: [
    { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' },
    { trackId: 't2', kind: 'missile', lat: 50.18, lon: 31.1, source: 'MAPA', eventTime: iso(120), region: 'Київська' },
  ],
  health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
});

const browser = await chromium.launch({ headless: true });
const tileHosts = new Set();

for (const [name, path, width] of [['radar', '/', 1440], ['nebo', '/nebo/', 1440], ['nebo-mobile', '/nebo/', 390]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 100)));
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('openfreemap') || u.includes('tile.openstreetmap.org')) tileHosts.add(new URL(u).host);
  });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('/v1/state')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) });
    return route.continue();
  });

  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(name === 'radar' ? 6000 : 11000);

  const m = await page.evaluate(() => {
    const parse = (s) => {
      const mm = String(s).match(/rgba?\(([^)]+)\)/);
      if (!mm) return null;
      const p = mm[1].split(',').map(parseFloat);
      if (p.length < 3 || (p[3] !== undefined && p[3] === 0) || (p[3] !== undefined && p[3] < 0.6)) return null;
      return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    };
    const dark = [];
    let scanned = 0;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      scanned++;
      const l = parse(cs.backgroundColor);
      if (l !== null && l < 0.25) dark.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] + ' ' + cs.backgroundColor);
    }
    return {
      dark, scanned,
      hOverflow: document.documentElement.scrollWidth - window.innerWidth,
      badge: document.getElementById('rlLive')?.textContent || null,
      compass: !!document.querySelector('.rl-compass'),
      cwGap: (() => {
        const d = document.querySelector('.rl-radar-screen'), w = document.querySelector('.rl-cw-w'), e = document.querySelector('.rl-cw-e');
        if (!d || !w || !e) return null;
        const dr = d.getBoundingClientRect();
        return Math.round(Math.max(dr.left - w.getBoundingClientRect().right, e.getBoundingClientRect().left - dr.right));
      })(),
      scopeCanvas: !!document.querySelector('#map canvas, .radar-screen canvas'),
    };
  });

  console.log(`\n${name} (${path} @${width}) — scanned ${m.scanned}`);
  if (m.hOverflow > 1) fail(`${name}: horizontal overflow ${m.hOverflow}px`);
  if (m.dark.length) {
    console.log('  dark surfaces:', m.dark.slice(0, 5).join(' | '));
    fail(`${name}: ${m.dark.length} dark surfaces on the deployed page`);
  } else ok(`${name}: no dark surfaces`);
  if (errors.length) fail(`${name}: JS error — ${errors[0]}`);
  else ok(`${name}: no JS errors`);
  if (name === 'radar') {
    if (m.badge !== 'LIVE') fail(`radar badge is "${m.badge}", expected LIVE`);
    else ok(`radar badge ${m.badge}`);
    if (!m.compass) fail('radar compass box missing');
    else ok(`compass box present, west/east gap ${m.cwGap}px`);
  }
  await page.screenshot({ path: `tmp-shots/live-${name}.png` });
  await page.close();
}

if (!tileHosts.size) fail('no tile host contacted — the basemap never loaded on production');
else ok(`basemap served by ${[...tileHosts].join(', ')}`);

await browser.close();
console.log(`\n${failures ? failures + ' findings' : 'deployed site verified end to end'}`);
process.exitCode = failures ? 1 : 0;
