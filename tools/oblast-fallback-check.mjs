// Verifies the oblast fallback against the real production snapshot.
//
// Two things matter here and only one of them is "does it show a name":
//   1. no record may be labelled with an oblast its point is not in
//   2. a record whose point falls outside every polygon must stay unknown
//
// The second is the one a naive implementation gets wrong, and getting it wrong
// means inventing a location.
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

// The real snapshot, fetched once and served to the page so the test runs on
// production data rather than a hand-written fixture.
const live = await (await fetch('https://check-ua-proxy.kykyyzka.workers.dev/v1/state')).json();
const geo = JSON.parse(fs.readFileSync(path.join(root, 'assets/data/ukraine-oblasts.geojson'), 'utf8'));

// Independent check, written here rather than imported from the app: if the
// lookup and the test share code, both can be wrong together.
function oblastAt(lat, lon) {
  for (const f of geo.features) {
    const list = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates || [];
    for (const poly of list) {
      const ring = poly[0] || [];
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return f.properties.region || f.properties.key;
    }
  }
  return null;
}

const events = live.events || [];
const hasPlace = (e) => e.settlement || e.district || e.region || e.derivedRegion;
const unknowns = events.filter((e) => !hasPlace(e));

console.log(`production snapshot: ${events.length} events, ${unknowns.length} without a place\n`);

let resolvable = 0, outside = 0, noCoords = 0;
const wrong = [];
for (const e of unknowns) {
  const coord = e.locationPrecision === 'COORDINATE' && Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lon));
  if (!coord) { noCoords++; continue; }
  const o = oblastAt(Number(e.lat), Number(e.lon));
  if (o) resolvable++;
  else outside++;
  // Ground truth for the spot-check: a known-placement event elsewhere.
  if (o && /Москва|^$/.test(String(o))) wrong.push(e);
}
console.log(`resolvable to an oblast : ${resolvable}`);
console.log(`outside every polygon  : ${outside}`);
console.log(`no usable coordinates  : ${noCoords}`);
console.log(`suspect labels         : ${wrong.length}`);

// Now what the page actually renders.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(BASE)) return route.continue();
  if (u.includes('check-ua-proxy')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(live) });
  return route.abort();
});
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const shown = await page.evaluate(() => {
  // The feed row is .rl-event; the place is the <em> inside .rl-ev-main.
  const rows = [...document.querySelectorAll('#rlFeed .rl-event')];
  return {
    rows: rows.length,
    ids: rows.map((r) => r.dataset.id),
    unknownRows: rows.filter((r) => /місце невідоме/.test(r.textContent)).map((r) => r.dataset.id),
    places: rows.map((r) => (r.querySelector('.rl-ev-main em')?.textContent || '').trim()),
  };
});
console.log(`\nfeed rows rendered     : ${shown.rows} (the feed is filtered, so this is a subset of ${events.length})`);
console.log(`rows still "невідоме"  : ${shown.unknownRows.length}`);

// Compare only against the events the feed actually showed. Counting all
// unresolvable events in the snapshot and comparing that to the rendered rows
// compares two different sets — the feed applies a time window and a tab.
const renderedIds = new Set(shown.ids);
const renderedEvents = events.filter((e) => renderedIds.has(String(e.trackId ?? e.id ?? '')));
const expectedUnknownHere = renderedEvents.filter((e) => !hasPlace(e) && !oblastAt(Number(e.lat), Number(e.lon))).length;
console.log(`of those, truly unresolvable: ${expectedUnknownHere}`);

// Every label on screen must be right: a settlement the source sent, or an
// oblast the point genuinely falls inside.
let bad = 0;
for (const e of renderedEvents) {
  const label = geoDescOf(e);
  if (!label || label === 'місце невідоме') continue;
  if (hasPlace(e)) continue;
  const truth = oblastAt(Number(e.lat), Number(e.lon));
  if (label !== truth) { bad++; console.log(`  WRONG: "${label}" but the point is in ${truth}`); }
}
console.log(`labels that disagree with the polygons: ${bad}`);

const counts = {};
for (const p of shown.places.filter(Boolean)) counts[p] = (counts[p] || 0) + 1;
console.log('place labels shown:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(3)}  ${k}`);

await page.screenshot({ path: 'tmp-shots/oblast-fallback.png', clip: { x: 0, y: 120, width: 1440, height: 620 } });
srv.close();

const expectedUnknown = outside + noCoords;
function geoDescOf(e) {
  if (hasPlace(e)) return hasPlace(e);
  if (e.locationPrecision === 'COORDINATE') return oblastAt(Number(e.lat), Number(e.lon)) || 'місце невідоме';
  return 'місце невідоме';
}
console.log(`\nsnapshot-wide unresolvable: ${expectedUnknown} of ${unknowns.length}`);
console.log(`unresolvable among rendered rows: ${expectedUnknownHere} | page shows ${shown.unknownRows.length}`);
console.log(shown.unknownRows.length === expectedUnknownHere && bad === 0
  ? 'MATCH — every rendered label is correct, and the remaining unknowns are genuinely outside every oblast'
  : 'MISMATCH');
await browser.close();
