// Confirms the OpenFreeMap positron tiles actually render, which no other check
// covers: nebo-light-check.mjs blocks external requests on purpose, so it proves
// the page is light but says nothing about whether there is a map under it.
//
// This one lets the tile CDN through and then asks the rendered canvas whether
// anything was drawn, and what colour it was. A light page with no map still
// scores "fully light".
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

let failures = 0;
const fail = (m) => { console.log('  FAIL ' + m); failures++; };
const ok = (m) => console.log('  ok   ' + m);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// Only the data endpoint is faked. Tiles and scripts reach the real CDN.
const tileHits = new Set();
const styleRequests = [];
page.on('request', (r) => {
  const u = r.url();
  if (u.includes('tiles.openfreemap.org') || u.includes('tile.openstreetmap.org')) tileHits.add(new URL(u).host);
  if (u.includes('maplibre-gl')) styleRequests.push(u);
});
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(BASE)) return route.continue();
  if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) });
  return route.continue();
});

await page.goto(BASE + '/nebo/', { waitUntil: 'domcontentloaded' });
// Tiles stream in; give MapLibre time to fetch, decode and paint.
await page.waitForTimeout(12000);

const state = await page.evaluate(() => {
  const map = document.getElementById('map');
  const container = document.querySelector('#map.leaflet-container, .leaflet-container');
  const canvas = document.querySelector('.leaflet-maplibre-gl canvas, .basemap-vector canvas, .leaflet-container canvas');
  return {
    // Leaflet puts the class on the container element itself on this page, so
    // looking for a descendant of #map found nothing.
    hasContainer: !!container,
    containerIsMap: !!(map && map.classList.contains('leaflet-container')),
    hasCanvas: !!canvas,
    canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
    rasterFallback: !!document.querySelector('.nebo-raster-tiles, .basemap-raster'),
  };
});

// A WebGL canvas cannot be read back with drawImage unless the context was
// created with preserveDrawingBuffer, which MapLibre does not use — so the
// first version of this check reported an empty canvas on a fully working map.
// Screenshot the compositor's output instead, which captures WebGL correctly.
const shot = await page.locator('#map').screenshot();
const pixels = await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  let lumSum = 0, n = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4 * 37) {
    seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4));
    const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    lumSum += l; n++;
    if (l < 0.2) dark++;
  }
  return { distinctColours: seen.size, meanLum: +(lumSum / n).toFixed(3), darkFraction: +(dark / n).toFixed(3), size: c.width + 'x' + c.height };
}, shot.toString('base64'));

console.log('  tile hosts contacted :', [...tileHits].join(', ') || '(none)');
console.log('  maplibre scripts     :', styleRequests.length);
console.log('  leaflet container    :', state.hasContainer);
console.log('  basemap canvas       :', state.hasCanvas ? state.canvasSize : 'none');
console.log('  raster fallback used :', state.rasterFallback);
console.log('  painted pixels       :', JSON.stringify(pixels));

if (!state.hasContainer) fail('no Leaflet container');
if (!state.hasCanvas) fail('no basemap canvas — neither vector nor raster drew');
if (pixels.distinctColours < 6) fail(`map looks empty (${pixels.distinctColours} distinct colours in ${pixels.size})`);
else ok(`map painted: ${pixels.distinctColours} distinct colours in ${pixels.size}`);
// The whole point: a light basemap. A dark one means the old style is still in
// play, and a light page around a dark map is exactly the failure this exists
// to catch.
if (pixels.darkFraction > 0.5) fail(`basemap is dark (${(pixels.darkFraction * 100).toFixed(0)}% of pixels below 0.2 luminance) — the dark style is still in play`);
else ok(`basemap is light (mean luminance ${pixels.meanLum}, ${(pixels.darkFraction * 100).toFixed(0)}% dark pixels)`);
if (!tileHits.size) fail('no tile host was contacted at all');
else ok(`tiles served by ${[...tileHits].join(', ')}`);

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' findings' : 'positron tiles render on a light basemap'}`);
process.exitCode = failures ? 1 : 0;
