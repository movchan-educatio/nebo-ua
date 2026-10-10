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

const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
const snapshot = () => ({
  v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(30), publishedAt: iso(5), serverTime: new Date().toISOString(), alerts: [],
  events: [{ trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' }],
  health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
});

const browser = await chromium.launch({ headless: true });
const width = Number(process.argv[2]) || 1440;
const page = await browser.newPage({ viewport: { width, height: 900 } });
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(BASE)) return route.continue();
  if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) });
  return route.abort();
});
await page.goto(BASE + '/nebo/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const detail = await page.evaluate(() => {
  const want = ['rgb(71, 127, 224)', 'rgb(22, 163, 106)', 'rgb(107, 119, 135)'];
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    if (!want.includes(cs.color)) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 34);
    if (!text) continue;
    let bg = null, bgFrom = null;
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(c)) { bg = c; bgFrom = n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/)[0] : ''); break; }
    }
    out.push({
      text, colour: cs.color, size: cs.fontSize, weight: cs.fontWeight,
      self: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
      parent: el.parentElement ? el.parentElement.tagName.toLowerCase() + (typeof el.parentElement.className === 'string' && el.parentElement.className ? '.' + el.parentElement.className.trim().split(/\s+/)[0] : '') : '',
      bg, bgFrom, bgImage: cs.backgroundImage !== 'none',
      html: el.outerHTML.slice(0, 130),
    });
  }
  return out;
});
console.log(JSON.stringify(detail, null, 1));
await browser.close();
srv.close();
