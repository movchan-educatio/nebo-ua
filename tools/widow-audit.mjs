// Typographic widows: a single short word stranded on the last line of a
// paragraph, or a one-word last row in a heading.
//
// These are the quiet design errors nobody reports but everybody feels — a
// heading reads as two unrelated lines, a paragraph ends on a stub. This
// measures the actual last line of every block and flags the short ones, and
// also flags headings that wrap to a single trailing word.
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

const scan = () => {
  const out = [];
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  };
  for (const el of document.querySelectorAll('h1, h2, h3, h4, p, li, .rl-info-card p, .lead, .rl-foot-note')) {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 8);
    if (!node) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
    if (rects.length < 2) continue;

    // Group rects into visual lines by their vertical midpoint.
    const lines = [];
    for (const r of rects) {
      const mid = r.top + r.height / 2;
      const line = lines.find((l) => Math.abs(l.mid - mid) < r.height * 0.5);
      if (line) { line.width += r.width; line.words++; line.right = Math.max(line.right, r.right); }
      else lines.push({ mid, width: r.width, words: 1, left: r.left, right: r.right });
    }
    if (lines.length < 2) continue;
    const last = lines[lines.length - 1];
    const widest = Math.max(...lines.map((l) => l.width));
    const lastIsStub = last.width < widest * 0.34 && last.words <= 2;

    if (lastIsStub) {
      out.push({
        el: describe(el),
        tag: el.tagName.toLowerCase(),
        lines: lines.length,
        lastWords: last.words,
        lastPct: Math.round((last.width / widest) * 100),
        text: node.textContent.trim().replace(/\s+/g, ' '),
      });
    }
  }
  return out;
};

const PAGES = [['/', 'radar'], ['/info/', 'info'], ['/about/', 'about'], ['/how-it-works/', 'how'], ['/faq/', 'faq'], ['/sources/', 'sources'], ['/safety/', 'safety'], ['/nebo/', 'nebo']];
const WIDTHS = [390, 768, 1440];

const browser = await chromium.launch({ headless: true });
let total = 0;
for (const [url, name] of PAGES) {
  const seen = new Set();
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const found = await page.evaluate(scan);
    for (const f of found) {
      const key = name + f.el + f.text.slice(0, 30);
      if (seen.has(key)) continue;
      seen.add(key); total++;
      const tail = f.text.split(/\s+/).slice(-3).join(' ');
      console.log(`${name} @${w}  ${f.el}  — ${f.lines} lines, last line is ${f.lastWords} word(s) at ${f.lastPct}% of the widest`);
      console.log(`    …${tail}`);
    }
    await page.close();
  }
}
await browser.close();
srv.close();
console.log(`\n${total} typographic widows across ${PAGES.length} pages x ${WIDTHS.length} widths`);
