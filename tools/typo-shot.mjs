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

// The footer, wide.
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(BASE + '/how-it-works/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const f = await page.$('.rl-foot');
  await f.screenshot({ path: path.join('tmp-shots', 'fix-footer-wide.png') });
  const m = await page.evaluate(() => {
    const n = document.querySelector('.rl-foot-note');
    const range = document.createRange();
    range.selectNodeContents(n);
    return { lines: [...range.getClientRects()].filter((r) => r.width > 1).length, text: n.textContent.trim() };
  });
  console.log(`footer note at 1440: ${m.lines} line(s)`);
  console.log(`  "${m.text}"`);
  await page.close();
}

// A heading that used to strand a word.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.goto(BASE + '/safety/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const h = await page.$('h1');
  await h.screenshot({ path: path.join('tmp-shots', 'fix-heading.png') });
  const m = await page.evaluate(() => {
    const el = document.querySelector('h1');
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1);
    return { lines: rects.length, widths: rects.map((r) => Math.round(r.width)), text: el.textContent.trim() };
  });
  console.log(`\nh1 at 390: ${m.lines} lines, line widths ${m.widths.join(' / ')}`);
  console.log(`  "${m.text}"`);
  await page.close();
}

await browser.close();
srv.close();
