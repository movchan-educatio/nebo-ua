// Measures how far the cardinal labels sit from the disc they point at.
// The report is in millimetres of dead space, not pixels, because "looks far"
// is a print-design judgement about the gap, not about the viewport size.
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

const snap = () => {
  const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(40), publishedAt: iso(5),
    serverTime: new Date().toISOString(), alerts: [],
    events: [{ trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' }],
    health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
  };
};

const browser = await chromium.launch({ headless: true });
console.log('width  disc    label-size  N-gap   S-gap   W-gap   E-gap   verdict');
for (const [w, h] of [[1440, 900], [1920, 1080], [1280, 800], [768, 1024], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snap()) });
    return route.abort();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s).getBoundingClientRect();
    const disc = q('.rl-radar-screen');
    const label = q('.rl-cw-w');
    const n = q('.rl-cw-n'), s = q('.rl-cw-s'), w = q('.rl-cw-w'), e = q('.rl-cw-e');
    return {
      disc: disc.width,
      label: label.height,
      // Gap is measured from the DISC EDGE to the NEAREST edge of the label,
      // which is the space a reader's eye has to cross.
      nGap: Math.round(disc.top - n.bottom),
      sGap: Math.round(s.top - disc.bottom),
      wGap: Math.round(disc.left - w.right),
      eGap: Math.round(e.left - disc.right),
    };
  });
  const max = Math.max(m.nGap, m.sGap, m.wGap, m.eGap);
  const verdict = max > 3 * m.label ? 'DETACHED' : max > 1.6 * m.label ? 'loose' : 'ok';
  console.log(
    `${String(w).padEnd(6)}${String(Math.round(m.disc)).padEnd(8)}${String(Math.round(m.label)).padEnd(11)}` +
    `${String(m.nGap).padEnd(8)}${String(m.sGap).padEnd(8)}${String(m.wGap).padEnd(8)}${String(m.eGap).padEnd(8)}${verdict}` +
    (verdict === 'DETACHED' ? `  (${max}px of empty space, label is only ${Math.round(m.label)}px tall)` : ''),
  );
  await page.close();
}
await browser.close();
srv.close();
