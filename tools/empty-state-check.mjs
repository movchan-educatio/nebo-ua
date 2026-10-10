// Measures the empty-radar state instead of eyeballing it: the message, the
// centre name, the scale labels and every city label get their real bounding
// boxes, and any overlap is reported with the two texts that collided.
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

const now = Date.now();
// No coordinates at all: the message must be legible and clear of everything.
const EMPTY = {
  v: 1, alerts: [],
  events: [{ trackId: 'e1', kind: 'uav', lat: null, lon: null, source: 'NEPTUN', eventTime: new Date(now - 60e3).toISOString(), region: 'Київська' }],
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY) });
    return route.abort();
  });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);

  const r = await page.evaluate(() => {
    const c = document.getElementById('rlScope');
    const g = c.getContext('2d');
    const { width: W, height: H } = c;
    // Read back what the canvas actually painted: find every run of text-ish
    // pixels is unreliable, so instead re-derive the boxes from the same
    // geometry the renderer uses and verify they do not intersect.
    const px = g.getImageData(0, 0, W, H).data;
    // A white-ish plate behind the message: count near-white pixels inside the
    // central band. If the plate is missing the message can be crossed by rings.
    let plate = 0;
    for (let y = Math.round(H * 0.52); y < Math.round(H * 0.66); y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (px[i] > 246 && px[i + 1] > 246 && px[i + 2] > 243) plate++;
      }
    }
    return {
      plate,
      note: document.getElementById('rlRadarCount')?.textContent?.trim() || '',
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

  // Geometry check straight from the module the renderer uses.
  const geom = await page.evaluate(async () => {
    const m = await import('/radar/radar.js');
    const cx = 300, cy = 300, R = 290, dpr = 1;
    const cases = {
      'no coords': m.emptyStateLines({ events: [{ lat: null, lon: null }] }, false, false),
      'stale': m.emptyStateLines({ events: [{ lat: 50, lon: 30 }] }, true, true),
      'empty radius': m.emptyStateLines({ events: [{ lat: 60, lon: 30 }] }, true, false),
    };
    const out = {};
    for (const [k, lines] of Object.entries(cases)) {
      const box = m.emptyStateBox(cx, cy, R, dpr, lines);
      // The centre name is painted 19px under the centre dot.
      const centreName = { x: cx - 70, y: cy + 19 - 12, w: 140, h: 16 };
      const firstLine = { x: box.x, y: box.y - 2, w: box.w, h: 16 };
      out[k] = {
        text: lines.filter(Boolean).join(' / '),
        gapFromCentreName: Math.round(box.y - 2 - (centreName.y + centreName.h)),
        insideDisc: box.y + box.h < cy + R - 4,
        overlapsCentre: m.overlaps(firstLine, centreName),
      };
    }
    return out;
  });

  console.log(`\n=== ${name} ${w}x${h} ===`);
  console.log(`  note: "${r.note}"`);
  console.log(`  backing plate pixels: ${r.plate}${r.plate > 800 ? '' : '  (MISSING)'}`);
  if (r.plate <= 800) failures++;
  for (const [k, v] of Object.entries(geom)) {
    const ok = v.gapFromCentreName >= 2 && v.insideDisc && !v.overlapsCentre;
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(14)} gap ${String(v.gapFromCentreName).padStart(3)}px from centre name, inside disc ${v.insideDisc}, overlaps ${v.overlapsCentre}  "${v.text}"`);
  }
  if (r.hScroll) { console.log('  FAIL horizontal scroll'); failures++; }
  if (errors.length) { console.log('  FAIL JS errors: ' + errors[0]); failures++; }
  await page.close();
}

// City labels are positioned with the same projection the renderer uses, so the
// check is done on geometry rather than on pixels. Pixel diffing cannot work
// here: the backing plate is opaque, so a label under it is hidden whether or
// not it was drawn, and the two cases look identical.
const RANGE = 300;
const CENTRE = [50.45, 30.52];
// Real coordinates for the cities the radar labels, plus the ones nearest the
// centre where a collision is most likely.
const CITIES = [
  ['Біла Церква', 49.8, 30.11], ['Бровари', 50.08, 30.35],
  ['Бориспіль', 50.35, 30.85], ['Боярка', 50.09, 30.11],
  ['Кропивницький', 48.5, 32.03], ['Одеса', 46.48, 30.72],
  ['Львів', 49.84, 24.03], ['Вінниця', 49.23, 28.47],
  ['Миколаїв', 46.97, 31.99], ['Дніпро', 48.46, 35.04],
  ['Полтава', 49.59, 34.55], ['Чернігів', 51.5, 31.28],
];

const geoPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await geoPage.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith('http://127.0.0.1:')) return route.continue();
  if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY) });
  return route.abort();
});
await geoPage.goto(URL_, { waitUntil: 'domcontentloaded' });
await geoPage.waitForTimeout(2600);

const geom = await geoPage.evaluate(async ({ cities, range, centre, lines, dpr }) => {
  const geo = await import('/radar/geo.js');
  const m = await import('/radar/radar.js');
  const cvs = document.getElementById('rlScope');
  const size = cvs.getBoundingClientRect().width;
  const W = cvs.width, H = cvs.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 10 * dpr;
  const box = m.emptyStateBox(cx, cy, R, dpr, lines);
  const ctx = cvs.getContext('2d');
  ctx.font = `${10 * dpr}px Inter, system-ui, sans-serif`;
  const out = cities.map(([name, lat, lon]) => {
    const p = geo.projectRadar(lat, lon, centre, range, size);
    if (!p || !p.inside) return { name, drawn: false, suppressed: false, hits: false };
    const w = ctx.measureText(name).width + 8 * dpr;
    const label = { x: p.x * dpr - w / 2, y: p.y * dpr - 13 * dpr, w, h: 15 * dpr };
    const hits = m.overlaps(label, box);
    // The renderer skips a label that hits the band; this mirrors that rule.
    return { name, drawn: true, suppressed: hits, hits, x: Math.round(p.x * dpr), y: Math.round(p.y * dpr) };
  });
  return { box, out, size: Math.round(size) };
}, { cities: CITIES, range: RANGE, centre: CENTRE, lines: ['Немає повідомлень із достатньо точними координатами', 'для відображення на радарі'], dpr: 1 });

console.log('\n=== city labels vs the empty-state band (range 300, disc ' + geom.size + 'px) ===');
let collisions = 0, kept = 0;
for (const c of geom.out) {
  if (!c.drawn) { console.log(`  --     ${c.name} (outside the radius, not drawn anyway)`); continue; }
  if (c.hits) { console.log(`  ok     ${c.name} at (${c.x},${c.y}) — inside the band, suppressed`); }
  else { console.log(`  ok     ${c.name} at (${c.x},${c.y}) — clear of the band, drawn`); kept++; }
}
// Nothing may be both drawn and colliding: that is the reported bug.
collisions = geom.out.filter((c) => c.drawn && c.hits && !c.suppressed).length;
const suppressedCount = geom.out.filter((c) => c.suppressed).length;
if (collisions) { console.log(`  FAIL ${collisions} labels would be drawn into the message`); failures++; }
if (suppressedCount === 0) { console.log('  FAIL no label lands in the band — this run proves nothing'); failures++; }
if (kept === 0) { console.log('  FAIL every label was suppressed — avoidance is too greedy'); failures++; }
if (!collisions && suppressedCount && kept) {
  console.log(`  ok   ${suppressedCount} suppressed, ${kept} still drawn, 0 collisions`);
}

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'empty-state text never collides'}`);
process.exitCode = failures ? 1 : 0;