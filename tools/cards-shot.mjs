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
const now = Date.now();
const SNAP = {
  v: 1, alerts: [],
  events: [{ trackId: 't0', kind: 'uav', lat: 50, lon: 31, source: 'NEPTUN', eventTime: new Date(now - 6e4).toISOString(), region: 'Київська' }],
  health: {
    NEPTUN: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
    MAPA: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
  },
  serverTime: new Date(now).toISOString(), pipelineCheckedAt: new Date(now).toISOString(),
};
fs.mkdirSync('tmp-shots', { recursive: true });
const browser = await chromium.launch({ headless: true });
for (const [w, h, name] of [[1440, 900, 'cards-desk'], [390, 844, 'cards-mob']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAP) });
    return route.abort();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  // Element screenshot: the section is far below the fold, so a viewport clip
  // would miss it and a document clip fights with scroll offsets.
  await page.locator('.rl-info').screenshot({ path: path.join('tmp-shots', name + '.png') });
  console.log(name + ' shot');
  await page.close();
}
await browser.close();
srv.close();