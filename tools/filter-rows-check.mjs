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
const kinds = ['uav', 'uav', 'missile', 'kab', 'ballistic', 'aircraft', 'other'];
const SNAP = {
  v: 1, alerts: [],
  events: kinds.map((k, i) => ({ trackId: 't' + i, kind: k, lat: 49 + i * 0.7, lon: 30 + i * 0.9, source: i % 2 ? 'MAPA' : 'NEPTUN', eventTime: new Date(now - 6e4 * (i + 1)).toISOString(), region: 'Київська', speed: 150 + i * 30, heading: 40 + i * 30 })),
  health: {
    NEPTUN: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
    MAPA: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
  },
  serverTime: new Date(now).toISOString(), pipelineCheckedAt: new Date(now).toISOString(),
};

const browser = await chromium.launch({ headless: true });
let failures = 0;
for (const [w, h, name] of [[1440, 900, 'desktop'], [1920, 1080, 'wide'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAP) });
    return route.abort();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);

  // Every repeated card-like group on the page, measured the same way, so
  // "these cards must be the same size" is answered by the whole page rather
  // than by whichever group happened to be screenshotted.
  //
  // Legend entries are inline text labels of different lengths, not cards:
  // asking them to share a width would be asking the words to share a length.
  // They are reported separately, height only.
  const { groups } = await page.evaluate(() => {
    const GRID = {
    'filter rows': '.rl-kind',
    'contact rows': '.rl-contact',
    'source cards': '.rl-source-mini',
    'feed rows': '.rl-event',
    'info cards': '.rl-info-card',
    'threat type cards': '.rl-threat-grid .rl-info-card',
  };
  const LABELS = { 'legend labels': '.rl-radar-legend > span' };
  const out = {};
  for (const [label, sel] of Object.entries({ ...GRID, ...LABELS })) {
    const els = [...document.querySelectorAll(sel)];
    out[label] = els.map((el) => {
      const b = el.getBoundingClientRect();
      return { t: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22), h: Math.round(b.height), w: Math.round(b.width) };
    });
  }
  return { groups: out, hScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });

  console.log(`\n=== ${name} ${w}x${h} ===`);
  for (const [label, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows) || !rows.length) { console.log(`  --   ${label.padEnd(18)} none rendered`); continue; }
    const isLabel = label.endsWith('labels');
    const hs = [...new Set(rows.map((x) => x.h))];
    const ws = [...new Set(rows.map((x) => x.w))];
    const spread = Math.max(...hs) - Math.min(...hs);
    const wspread = Math.max(...ws) - Math.min(...ws);
    if (isLabel) {
      console.log(`  ${spread === 0 ? 'ok  ' : 'DIFF'} ${label.padEnd(18)} n=${rows.length}  heights ${[...hs].sort((a, b) => a - b).join('/')}  (width follows the text, not measured)`);
      if (spread) failures++;
      continue;
    }
    const mark = spread === 0 && wspread === 0 ? 'ok  ' : 'DIFF';
    console.log(`  ${mark} ${label.padEnd(18)} n=${rows.length}  heights ${[...hs].sort((a, b) => a - b).join('/')} (spread ${spread})  widths ${[...ws].sort((a, b) => a - b).join('/')} (spread ${wspread})`);
    if (spread || wspread) {
      for (const x of rows) console.log(`         ${String(x.h).padStart(4)}px  w=${String(x.w).padStart(4)}  "${x.t}"`);
      failures++;
    }
  }
  // Cards across different grids must agree too: a card in a titled section
  // and a card in a bare row are the same component and must be the same size.
  const cardSizes = [];
  for (const key of ['info cards', 'threat type cards']) {
    for (const x of groups[key] || []) cardSizes.push(`${x.h}x${x.w}`);
  }
  const distinct = [...new Set(cardSizes)];
  if (distinct.length > 1) { console.log(`  DIFF cards across groups differ: ${distinct.join(', ')}`); failures++; }
  else console.log(`  ok   all cards share one size ${distinct[0]}`);

  await page.close();
}
await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' card groups differ' : 'every repeated card group has one height'}`);
process.exitCode = failures ? 1 : 0;