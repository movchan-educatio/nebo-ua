// Layout audit: reports real box geometry and finds dead vertical space, so
// "huge empty area" becomes a number instead of an impression.
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
const URL_ = `http://127.0.0.1:${srv.address().port}/`;

const browser = await chromium.launch({ headless: true });
for (const [w, h, name] of [[1440, 900, 'desktop'], [1920, 1080, 'wide'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const r = await page.evaluate(() => {
    const box = (el) => {
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
        x: Math.round(b.x), y: Math.round(b.y + window.scrollY),
        w: Math.round(b.width), h: Math.round(b.height),
        display: cs.display, minH: cs.minHeight, height: cs.height,
        overflow: cs.overflow,
      };
    };
    // Direct children of the page container, plus the radar/feed columns.
    const main = document.querySelector('.rl-main') || document.body;
    const kids = [...main.children].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    }).map(box);

    // Dead space = vertical run with no card in the same column. For each card we
    // find the NEAREST card below it that shares horizontal space; anything
    // further down belongs to a different row and must not be counted, or every
    // full-width section looks like a hole under every column above it.
    // Cards that are position:fixed (the mobile bottom sheet) do not occupy
    // document flow, so measuring gaps against them is meaningless. A card
    // nested inside another card is not an independent block either: the
    // enclosing card already accounts for the space around it, so comparing a
    // nested card against the next sibling card reports the parent's own
    // padding as dead space.
    const cards = [...document.querySelectorAll('.rl-card')]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .filter((el) => getComputedStyle(el).position !== 'fixed')
      .filter((el) => !el.parentElement?.closest('.rl-card'))
      .map(box);
    const gaps = [];
    for (let i = 0; i < cards.length; i++) {
      const a = cards[i];
      let next = null;
      for (let j = 0; j < cards.length; j++) {
        if (i === j) continue;
        const b = cards[j];
        if (b.y < a.y + a.h) continue;                       // not strictly below
        const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (overlap < Math.min(a.w, b.w) * 0.5) continue;    // different column
        if (!next || b.y < next.y) next = b;
      }
      if (next) {
        const gap = next.y - (a.y + a.h);
        if (gap > 120) gaps.push({ between: [a.sel, next.sel], gap: Math.round(gap) });
      }
    }
    // Anything absolutely positioned that may be reserving space invisibly.
    const suspects = [...document.querySelectorAll('.rl-main *')].filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute') return false;
      const b = el.getBoundingClientRect();
      return b.height > 200 && cs.opacity === '0';
    }).map((el) => ({ sel: el.id || el.className, h: Math.round(el.getBoundingClientRect().height) }));

    return {
      docHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      mainDisplay: getComputedStyle(main).display,
      mainAlign: getComputedStyle(main).alignItems,
      mainRows: getComputedStyle(main).gridTemplateRows,
      kids, cards: cards.slice(0, 14), gaps, suspects,
    };
  });

  console.log(`\n=== ${name} ${w}x${h} ===`);
  console.log(`  document ${r.docHeight}px, viewport ${r.viewport}px`);
  console.log(`  .rl-main display=${r.mainDisplay} align-items=${r.mainAlign} rows=${r.mainRows}`);
  console.log('  children:');
  for (const k of r.kids) console.log(`    ${k.sel.padEnd(46).slice(0, 46)} y=${String(k.y).padStart(5)} h=${String(k.h).padStart(5)} w=${String(k.w).padStart(5)} minH=${k.minH}`);
  console.log('  cards:');
  for (const c of r.cards) console.log(`    ${c.sel.padEnd(46).slice(0, 46)} y=${String(c.y).padStart(5)} h=${String(c.h).padStart(5)} minH=${c.minH} display=${c.display}`);
  if (r.gaps.length) { console.log('  DEAD SPACE between cards:'); for (const g of r.gaps) console.log(`    ${g.gap}px between ${g.between[0]} and ${g.between[1]}`); }
  if (r.suspects.length) { console.log('  invisible absolutely-positioned boxes:'); for (const s of r.suspects) console.log(`    ${s.sel} h=${s.h}`); }
  await page.close();
}
await browser.close();
srv.close();
