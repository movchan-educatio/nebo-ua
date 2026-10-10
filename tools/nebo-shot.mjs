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
const OUT = path.join(root, 'tmp-shots');
fs.mkdirSync(OUT, { recursive: true });

const SNAP = {
  v: 1, alerts: [],
  events: [
    { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: new Date(Date.now() - 6e4).toISOString(), speed: 180, heading: 120, region: 'Київська' },
    { trackId: 't2', kind: 'missile', lat: 48.4, lon: 35.0, source: 'MAPA', eventTime: new Date(Date.now() - 12e4).toISOString(), region: 'Дніпропетровська' },
    { trackId: 't3', kind: 'kab', lat: 49.8, lon: 31.2, source: 'NEPTUN', eventTime: new Date(Date.now() - 3e5).toISOString(), region: 'Полтавська' },
  ],
  health: {
    NEPTUN: { status: 'online', updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() },
    MAPA: { status: 'online', updatedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() },
  },
  serverTime: new Date().toISOString(), pipelineCheckedAt: new Date().toISOString(),
};

const browser = await chromium.launch({ headless: true });
const errors = [];
for (const [w, h, name] of [[1440, 900, 'nebo-desk'], [390, 844, 'nebo-mob']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e).slice(0, 90)}`));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAP) });
    if (/tiles|openfreemap|basemaps|leaflet/.test(u) && !u.includes('127.0.0.1')) return route.abort();
    return route.abort();
  });
  await page.goto(BASE + '/nebo/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  const r = await page.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
    return {
      bg: g('body').backgroundColor,
      topbarH: document.querySelector('.topbar') ? Math.round(document.querySelector('.topbar').getBoundingClientRect().height) : 0,
      panels: document.querySelectorAll('.panel').length,
      mapTiles: document.querySelectorAll('.leaflet-tile').length,
      rows: document.querySelectorAll('.threat-row, .event-row').length,
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  console.log(`${name}: bg ${r.bg}  topbar ${r.topbarH}px  panels ${r.panels}  threats ${r.rows}  mapTiles ${r.mapTiles}  hScroll ${r.hScroll}`);
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  await page.close();
}
await browser.close();
srv.close();
console.log(errors.length ? 'JS errors:\n  ' + errors.join('\n  ') : 'no JS errors');