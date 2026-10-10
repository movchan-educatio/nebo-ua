// Screenshots of the states that were broken, so the fix can be judged by eye
// and not only by numbers. Uses the same stubbed snapshot as
// tools/detail-panel-check.mjs so the shots are deterministic.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const outDir = path.join(root, 'tmp-shots');
fs.mkdirSync(outDir, { recursive: true });
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
const URL_ = `http://127.0.0.1:${srv.address().port}/`;

const now = Date.now();
const spots = [
  [50.45, 30.52], [50.62, 30.9], [49.99, 31.6], [50.31, 30.2],
  [49.6, 32.1], [50.8, 30.05], [48.9, 34.2], [49.4, 33.5],
];
const kinds = ['uav', 'uav', 'missile', 'uav', 'kab', 'uav', 'ballistic', 'uav'];
const SNAPSHOT = {
  v: 1,
  alerts: [],
  events: spots.map(([lat, lon], i) => ({
    trackId: 't' + (i + 1), kind: kinds[i], lat, lon,
    source: i % 2 ? 'MAPA' : 'NEPTUN',
    eventTime: new Date(now - (i + 1) * 95e3).toISOString(),
    heading: 40 + i * 35, speed: 120 + i * 45,
    region: 'Київська',
  })),
  health: {
    NEPTUN: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
    MAPA: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
  },
  serverTime: new Date(now).toISOString(),
  pipelineCheckedAt: new Date(now).toISOString(),
  dataUpdatedAt: new Date(now).toISOString(),
};

const browser = await chromium.launch({ headless: true });

async function shot(name, viewport, action, full = true) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) });
    return route.abort();
  });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);
  if (action === 'open') {
    const row = await page.$('.rl-event, .rl-contact');
    if (row) await row.click();
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('radarCard')?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
  }
  const file = path.join(outDir, name + '.png');
  await page.screenshot({ path: file, fullPage: full });
  console.log('  ' + name + '.png  ' + (full ? 'full page' : 'viewport'));
  await page.close();
}

console.log('screenshots:');
await shot('desktop-closed', { width: 1440, height: 900 });
await shot('desktop-detail', { width: 1440, height: 900 }, 'open');
await shot('mobile-closed', { width: 390, height: 844 });
await shot('mobile-detail', { width: 390, height: 844 }, 'open');

await browser.close();
srv.close();
console.log('written to ' + outDir);