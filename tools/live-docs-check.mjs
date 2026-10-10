// Verifies the deployed document pages: the CTA must have readable text, and
// the feature-card icons must be bounded and painted — the two defects that a
// local copy proved but which have to hold on the real site too.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://nebo-ua.vercel.app';
let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

const browser = await chromium.launch({ headless: true });
for (const [name, url] of [['info', '/info/'], ['how-it-works', '/how-it-works/'], ['about', '/about/']]) {
  for (const w of [390, 768, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    const m = await page.evaluate(() => {
      const rel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const lum = (s) => {
        const mm = String(s).match(/rgba?\(([^)]+)\)/);
        if (!mm) return null;
        const p = mm[1].split(',').map(parseFloat);
        if (p.length < 3 || (p[3] !== undefined && p[3] === 0)) return null;
        return 0.2126 * rel(p[0] / 255) + 0.7152 * rel(p[1] / 255) + 0.0722 * rel(p[2] / 255);
      };
      const ratio = (a, b) => { const [hi, lo] = [a, b].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

      const ctas = [...document.querySelectorAll('a.rl-doc-cta')].map((el) => {
        const cs = getComputedStyle(el);
        const fg = lum(cs.color), bg = lum(cs.backgroundColor);
        return {
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          contrast: fg !== null && bg !== null ? +ratio(fg, bg).toFixed(2) : null,
          href: el.getAttribute('href'),
          tabbable: el.tabIndex >= 0,
        };
      });

      const cards = [...document.querySelectorAll('.rl-doc-feats .rl-info-card')];
      const icons = cards.map((c) => {
        const svg = c.querySelector('svg');
        const use = c.querySelector('use');
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        const cs = getComputedStyle(use || svg);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          fill: cs.fill, stroke: cs.stroke,
          sprite: use ? (use.getAttribute('href') || '').split('/').pop() : '',
        };
      }).filter(Boolean);

      const rows = new Map();
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        const top = Math.round(r.top);
        if (!rows.has(top)) rows.set(top, []);
        rows.get(top).push({ h: Math.round(r.height), w: Math.round(r.width) });
      }
      const unevenRows = [...rows.values()].filter((r) => r.length > 1 && new Set(r.map((x) => x.h)).size > 1).length;
      const gridEl = document.querySelector('.rl-doc-feats');
      const gridWidth = gridEl ? gridEl.getBoundingClientRect().width : 0;
      const lastRow = rows.size ? [...rows.values()].pop() : [];
      const lastRowSize = lastRow.length;
      // A single card in the last row is only a defect if it does NOT span the
      // row: an odd last card at two columns is deliberately stretched across
      // both, and counting cards alone reported that as stranded.
      const lastSpansFull = lastRowSize === 1 && gridWidth > 0 && lastRow[0].w >= gridWidth - 2;

      return {
        ctas, icons, unevenRows, lastRowSize, lastSpansFull,
        cardCount: cards.length,
        columns: (() => {
          if (!gridEl) return 1;
          return getComputedStyle(gridEl).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
        })(),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });

    const problems = [];
    for (const c of m.ctas) {
      if (c.contrast !== null && c.contrast < 4.5) problems.push(`CTA "${c.text}" contrast ${c.contrast}:1`);
      if (!c.text) problems.push('CTA has no label');
      if (!c.tabbable) problems.push('CTA not keyboard reachable');
    }
    for (const i of m.icons) {
      if (i.w > 40 || i.h > 40) problems.push(`icon ${i.w}x${i.h} over 40px`);
      if (/rgb\(0,\s*0,\s*0\)|black|#000/.test(i.fill) && !/sprite\.svg/.test(i.sprite)) problems.push(`icon filled ${i.fill}`);
    }
      if (m.unevenRows) problems.push(`${m.unevenRows} row(s) with unequal card heights`);
      if (m.cardCount > 1 && m.lastRowSize === 1 && m.columns > 1 && !m.lastSpansFull) problems.push('a lone card in the last row');
      if (m.overflow > 1) problems.push(`horizontal overflow ${m.overflow}px`);

    if (problems.length) { for (const p of problems.slice(0, 4)) fail(`${name} @${w}: ${p}`); }
    else ok(`${name} @${w}: ${m.cardCount} cards, CTA "${m.ctas[0]?.text || '—'}" ${m.ctas[0]?.contrast ?? '—'}:1, icons ${m.icons[0]?.w ?? 0}px`);
    await page.close();
  }
}
await browser.close();
console.log(`\n${failures ? failures + ' findings' : 'deployed doc pages verified at every width'}`);
process.exitCode = failures ? 1 : 0;
