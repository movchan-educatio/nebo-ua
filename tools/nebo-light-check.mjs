// Measures how much dark surface is left on /nebo/, by computed style rather
// than by eye. Reading ~900 lines of CSS and eyeballing the result is how a
// theme conversion ships with a black card nobody opened; this walks the real
// rendered page and reports anything still dark, so "the redesign is done" is a
// measurement instead of an opinion.
//
// Works on the rendered DOM, so it also catches colours set from JavaScript and
// inline styles, which a source-level grep cannot see.
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
  v: 1, pipelineCheckedAt: iso(5), dataUpdatedAt: iso(30), publishedAt: iso(5),
  serverTime: new Date().toISOString(), alerts: [],
  events: [
    { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: iso(60), speed: 180, heading: 90, region: 'Київська' },
    { trackId: 't2', kind: 'missile', lat: 50.18, lon: 31.1, source: 'MAPA', eventTime: iso(120), region: 'Київська' },
  ],
  health: { NEPTUN: { status: 'online', updatedAt: iso(5) }, MAPA: { status: 'online', updatedAt: iso(5) } },
});

// Luminance of an rgba() string. Returns null for transparent / unparseable,
// so an element with no background is never counted as dark.
const probe = () => {
  const out = { darkSurfaces: [], darkText: [], scanned: 0, lightSurfaces: 0 };
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    if (p.length < 3 || (p[3] !== undefined && p[3] === 0)) return null;
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
  };
  const label = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // Skip the map surface itself: tiles are not the theme.
    if (el.closest('.leaflet-container, #map, .map')) continue;
    out.scanned++;

    const bg = parse(cs.backgroundColor);
    if (bg !== null) {
      const area = r.width * r.height;
      if (bg < 0.25) out.darkSurfaces.push({ el: label(el), colour: cs.backgroundColor, lum: +bg.toFixed(3), area: Math.round(area) });
      else out.lightSurfaces++;
    }
    // Dark text is only a problem on a light background.
    const fg = parse(cs.color);
    if (fg !== null && bg !== null && bg > 0.6 && fg < 0.08) {
      out.darkText.push({ el: label(el), colour: cs.color, lum: +fg.toFixed(3) });
    }
  }
  // Any element that still filters itself dark is faking the old theme.
  out.darkFilters = [...document.querySelectorAll('*')]
    .map((el) => ({ el, f: getComputedStyle(el).filter }))
    .filter((x) => x.f && /invert|brightness\(0\.|hue-rotate/.test(x.f))
    .map((x) => ({ el: label(x.el), filter: x.f }));

  // Contrast, not just darkness.
  //
  // The first version of this tool reported "fully light" on a page whose map
  // labels were dark grey on a mid-grey fill with a black drop-shadow — every
  // surface passed, and the text was unreadable. "Not dark" is not "legible".
  // This walks up for each piece of text and compares it against the first
  // opaque background behind it, which is what a reader actually resolves
  // against.
  const rel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const contrast = (a, b) => {
    const [l1, l2] = [a, b].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const chan = (rgbStr) => {
    const m = String(rgbStr).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    if (p.length < 3) return null;
    if (p[3] !== undefined && p[3] === 0) return null;
    // A translucent colour is not a backdrop. Treating rgba(22,163,106,.063) as
    // an opaque green made the checker compare green text against green and
    // report 1:1 for a pair that is plainly legible — the tint is 6% over
    // white. Anything under 0.6 alpha keeps the walk going to the parent.
    if (p[3] !== undefined && p[3] < 0.6) return null;
    return 0.2126 * rel(p[0] / 255) + 0.7152 * rel(p[1] / 255) + 0.0722 * rel(p[2] / 255);
  };
  const pageL = chan(getComputedStyle(document.body).backgroundColor) || 1;

  out.lowContrast = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length) continue; // leaves only, keeps this cheap
    const text = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;

    const fg = chan(cs.color);
    if (fg === null) continue;
    // A gradient is not in backgroundColor, so the walk below would fall
    // through to a white ancestor and report white-on-blue as 1.08:1. That is
    // the checker being wrong, not the page: report it separately instead of
    // guessing a backdrop it cannot resolve.
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      out.onGradient = (out.onGradient || 0) + 1;
      continue;
    }
    // Nearest opaque background behind this element.
    let bg = null;
    for (let n = el; n; n = n.parentElement) {
      bg = chan(getComputedStyle(n).backgroundColor);
      if (bg !== null) break;
    }
    if (bg === null) bg = pageL;

    const ratio = contrast(fg, bg);
    // Large text (>=18.66px bold or >=24px) is legible at a lower ratio.
    const size = parseFloat(cs.fontSize);
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    if (ratio < need) {
      out.lowContrast.push({ el: label(el), ratio: +ratio.toFixed(2), need, size, colour: cs.color });
    }
  }
  return out;
};

const WIDTHS = [320, 390, 768, 1024, 1440, 1920];
const browser = await chromium.launch({ headless: true });
let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

fs.mkdirSync('tmp-shots', { recursive: true });

for (const w of WIDTHS) {
  const pg = await browser.newPage({ viewport: { width: w, height: 900 } });
  await pg.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) });
    return route.abort();
  });
  await pg.goto(BASE + '/nebo/', { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(probe);
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const bigDark = r.darkSurfaces.filter((d) => d.area > 4000);
  console.log(`\n${w}px — scanned ${r.scanned}, light surfaces ${r.lightSurfaces}`);
  if (overflow > 1) fail(`${w}px: horizontal overflow ${overflow}px`);
  if (r.darkSurfaces.length) {
    console.log(`  ${r.darkSurfaces.length} dark surfaces, ${bigDark.length} over 4000px²`);
    for (const d of r.darkSurfaces.slice(0, 8)) console.log(`    ${d.el.padEnd(34)} ${d.colour.padEnd(22)} lum ${d.lum}  ${d.area}px²`);
    fail(`${w}px: ${r.darkSurfaces.length} dark surfaces remain`);
  } else ok(`${w}px: no dark surfaces`);
  if (r.darkText.length) {
    console.log(`  ${r.darkText.length} dark-text-on-light:`);
    for (const d of r.darkText.slice(0, 6)) console.log(`    ${d.el.padEnd(34)} ${d.colour}`);
    fail(`${w}px: ${r.darkText.length} dark text on light surfaces`);
  }
  if (r.darkFilters.length) {
    for (const d of r.darkFilters) console.log(`    filter: ${d.el} -> ${d.filter}`);
    fail(`${w}px: ${r.darkFilters.length} elements still filter themselves dark`);
  }
  if (r.lowContrast.length) {
    console.log(`  ${r.lowContrast.length} below contrast:`);
    for (const d of r.lowContrast.slice(0, 8)) {
      console.log(`    ${d.el.padEnd(30)} ${d.colour.padEnd(20)} ${d.ratio}:1 (needs ${d.need}, ${Math.round(d.size)}px)`);
    }
    fail(`${w}px: ${r.lowContrast.length} pieces of text below the contrast floor`);
  }
  await pg.screenshot({ path: path.join('tmp-shots', `nebo-${w}.png`) });
  await pg.close();
}

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' findings' : '/nebo/ is fully light at every width'}`);
process.exitCode = failures ? 1 : 0;
