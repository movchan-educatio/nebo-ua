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

const browser = await chromium.launch({ headless: true });
for (const [name, url] of [['how', '/how-it-works/'], ['info', '/info/'], ['about', '/about/']]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const el = await page.$('.rl-doc-feats');
  if (!el) { console.log(name + ': no .rl-doc-feats'); await page.close(); continue; }
  const box = await el.boundingBox();
  await page.screenshot({
    path: path.join('tmp-shots', `fixed-${name}.png`),
    clip: { x: Math.max(0, box.x - 14), y: Math.max(0, box.y - 14), width: box.width + 28, height: Math.min(box.height + 28, 560) },
  });
  console.log(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`);
  await page.close();
}
await browser.close();
srv.close();
