// Screenshot of the radar card alone, so the compass labels can be judged as
// part of the instrument rather than as stray text on a page.
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
fs.mkdirSync('tmp-shots', { recursive: true });

const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
const snap = () => ({
  v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(40), publishedAt: iso(5),
  serverTime: new Date().toISOString(), alerts: [],
  events: [
    { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' },
    { trackId: 't2', kind: 'missile', lat: 50.18, lon: 31.1, source: 'MAPA', eventTime: iso(120), region: 'Київська' },
    { trackId: 't3', kind: 'aircraft', lat: 50.6, lon: 30.2, source: 'NEPTUN', eventTime: iso(200), region: 'Київська' },
  ],
  health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
});

const browser = await chromium.launch({ headless: true });
for (const [name, w, h] of [['radar-1920', 1920, 1080], ['radar-1440', 1440, 900], ['radar-390', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap()) });
    return route.abort();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const card = await page.$('#radarCard');
  await card.screenshot({ path: path.join('tmp-shots', name + '.png') });
  // Does any label escape the card it belongs to?
  const esc = await page.evaluate(() => {
    const c = document.getElementById('radarCard').getBoundingClientRect();
    return ['n', 's', 'w', 'e'].filter((k) => {
      const r = document.querySelector('.rl-cw-' + k).getBoundingClientRect();
      return r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5;
    });
  });
  console.log(`${name}: ${esc.length ? 'ESCAPED -> ' + esc.join(',') : 'labels inside the card'}`);
  await page.close();
}
await browser.close();
srv.close();
