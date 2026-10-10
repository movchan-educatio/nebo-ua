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

const snap = (pipeAgeS) => {
  const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    v: 1, pipelineCheckedAt: iso(pipeAgeS), dataUpdatedAt: iso(pipeAgeS + 40), publishedAt: iso(pipeAgeS),
    serverTime: new Date().toISOString(), alerts: [],
    events: [
      { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' },
      { trackId: 't2', kind: 'missile', lat: 50.1, lon: 31.2, source: 'MAPA', eventTime: iso(120), region: 'Київська' },
    ],
    health: {
      NEPTUN: { status: 'online', updatedAt: iso(pipeAgeS) },
      MAPA: { status: 'online', updatedAt: iso(pipeAgeS) },
    },
  };
};

const browser = await chromium.launch({ headless: true });
for (const [name, width, height, age, label] of [
  ['fresh-bar', 1440, 900, 5, 'healthy'],
  ['stale-notice', 1440, 900, 400, 'stale'],
  ['fresh-bar-mobile', 390, 844, 5, 'healthy'],
  ['stale-notice-mobile', 390, 844, 400, 'stale'],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap(age)) });
    return route.abort();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const clip = label === 'stale'
    ? { x: 0, y: 0, width, height: Math.min(height, 240) }
    : { x: 0, y: 0, width, height: Math.min(height, 130) };
  await page.screenshot({ path: path.join('tmp-shots', name + '.png'), clip });
  const st = await page.evaluate(() => ({
    badge: document.getElementById('rlLive')?.textContent,
    alert: document.getElementById('rlAlert')?.hidden ? null : document.getElementById('rlAlertTitle')?.textContent,
    updated: document.getElementById('rlUpdated')?.textContent,
  }));
  console.log(`${name.padEnd(20)} badge=${String(st.badge).padEnd(9)} "${st.updated}"  ${st.alert ? 'notice: ' + st.alert : 'no notice'}`);
  await page.close();
}
await browser.close();
srv.close();