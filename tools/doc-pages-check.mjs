// Measures the document pages as rendered: CTA buttons, feature cards, icon
// geometry. Reading the CSS tells you what was intended; this reports what the
// browser actually made, which is the only version the user ever sees.
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

const probe = () => {
  const out = { cta: [], cards: [], overflow: document.documentElement.scrollWidth - window.innerWidth };

  for (const el of document.querySelectorAll('a.rl-doc-cta, button')) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(el);
    const svg = el.querySelector('svg');
    const sr = svg ? svg.getBoundingClientRect() : null;
    const scs = svg ? getComputedStyle(svg) : null;
    out.cta.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      href: el.getAttribute('href') || '',
      w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color, background: cs.backgroundColor,
      fontSize: cs.fontSize,
      // An empty-looking button is a contrast or sizing problem, not a missing
      // string: record both so the cause is visible.
      svg: sr ? { w: Math.round(sr.width), h: Math.round(sr.height), fill: scs.fill, stroke: scs.stroke } : null,
    });
  }

  const feats = document.querySelector('.rl-doc-feats, .rl-info-grid');
  if (feats) {
    const fcs = getComputedStyle(feats);
    const cards = [...feats.querySelectorAll('.rl-info-card')];
    const tops = new Set();
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      tops.add(Math.round(r.top));
      const svg = c.querySelector('svg');
      const sr = svg ? svg.getBoundingClientRect() : null;
      const scs = svg ? getComputedStyle(svg) : null;
      // Read the paint from the <use>, not the <svg>. The sprite symbols carry
      // no fill/stroke of their own, so the shapes inherit from <use>; measuring
      // the <svg> reports the SVG default (black) even when the icon renders
      // correctly, which is how the first version of this tool cried wolf on
      // icons that were already fixed.
      const use = c.querySelector('use');
      const ucs = use ? getComputedStyle(use) : null;
      out.cards.push({
        w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
        h3: (c.querySelector('h3')?.textContent || '').trim(),
        svg: sr ? {
          w: Math.round(sr.width), h: Math.round(sr.height),
          fill: ucs ? ucs.fill : scs.fill,
          stroke: ucs ? ucs.stroke : scs.stroke,
          sprite: use ? (use.getAttribute('href') || '').split('/').pop() : '',
        } : null,
      });
    }
    out.grid = {
      cols: fcs.gridTemplateColumns,
      declaredCols: (fcs.gridTemplateColumns.match(/px/g) || []).length,
      display: fcs.display,
      container: Math.round(feats.getBoundingClientRect().width),
      cardCount: cards.length,
      rows: tops.size,
    };
  }
  return out;
};

const WIDTHS = [390, 768, 1440, 1920];
const PAGES = [
  ['info', '/info/'],
  ['how-it-works', '/how-it-works/'],
  ['about', '/about/'],
];

const browser = await chromium.launch({ headless: true });
for (const [name, url] of PAGES) {
  console.log(`\n${'='.repeat(66)}\n${name}  ${url}`);
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const m = await page.evaluate(probe);

    console.log(`\n  ${w}px`);
    if (m.overflow > 1) console.log(`    !! horizontal overflow ${m.overflow}px`);
    for (const c of m.cta) {
      console.log(`    CTA  "${c.text}" ${c.w}x${c.h}  color=${c.color} bg=${c.background}` +
        (c.svg ? `  svg=${c.svg.w}x${c.svg.h} fill=${c.svg.fill} stroke=${c.svg.stroke}` : '  (no svg)'));
    }
    if (m.grid) {
      console.log(`    grid: ${m.grid.cardCount} cards, ${m.grid.declaredCols} columns, ${m.grid.rows} rows, container ${m.grid.container}px`);
      console.log(`      columns: ${m.grid.cols}`);
      // Cards in the SAME row must match: a responsive grid is allowed rows of
      // differing height, only equality within a row is a defect.
      const rows = new Map();
      for (const c of m.cards) {
        if (!rows.has(c.top)) rows.set(c.top, []);
        rows.get(c.top).push(c);
      }
      for (const [top, row] of rows) {
        if (row.length < 2) continue;
        const hs = [...new Set(row.map((c) => c.h))];
        const ws = [...new Set(row.map((c) => c.w))];
        if (hs.length > 1) console.log(`      !! row at ${top}px has unequal heights: ${hs.join(', ')} (${row.map((c) => c.h3).join(', ')})`);
        if (ws.length > 1) console.log(`      !! row at ${top}px has unequal widths: ${ws.join(', ')}`);
      }
      for (const c of m.cards) {
        const bad = [];
        if (c.svg && (c.svg.w > 40 || c.svg.h > 40)) bad.push(`svg ${c.svg.w}x${c.svg.h} > 40px`);
        // A filled silhouette is only wrong when the sprite supplies no paint.
        // threats/sprite.svg sets fill on its own shapes and is meant to be filled.
        if (c.svg && /rgb\(0,\s*0,\s*0\)|black|#000/.test(c.svg.fill) && !/sprite\.svg/.test(c.svg.sprite)) {
          bad.push(`fill ${c.svg.fill} (${c.svg.sprite})`);
        }
        if (bad.length) console.log(`      !! ${c.h3}: ${bad.join(', ')}`);
      }
      const rowsN = m.cards.length ? new Set(m.cards.map((c) => c.top)).size : 0;
      const lastRow = rowsN ? m.cards.filter((c) => c.top === Math.max(...m.cards.map((x) => x.top))).length : 0;
      if (lastRow === 1 && m.cards.length > 1) console.log(`      ragged tail: last row holds a single card`);
      else if (rowsN) console.log(`      rows: ${rowsN}, last row: ${lastRow} card(s)`);
    }
    if (w === 1440) await page.screenshot({ path: path.join('tmp-shots', `doc-${name}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
srv.close();
