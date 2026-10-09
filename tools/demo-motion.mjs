// DEMO — synthetic data only, recorded to video.
//
// services/config.js points at the real Cloudflare aggregator, so this harness
// intercepts that URL in the browser and serves a scripted flight instead.
// Nothing here touches production.
//
// ONE stable trackId across the whole script:
//   step 0        confirmed fix, heading 090 (EAST)
//   step 0 -> 1   +0.10 deg east in 60 s   -> the marker glides EAST
//   step 1 -> 2   move north-east, heading 090 -> 045 (a real turn)
//   step 2 -> 3   no new data for 6 s       -> the marker must STOP dead
//
// Control cases that MUST NOT move and are shown in the panel on the right:
//   - a missile with no heading from the source -> stays neutral, north-up
//   - a stale track                            -> never animates
//   - an area-only record                      -> never becomes a point marker
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const base = Date.parse('2026-10-10T00:00:00Z');
const AGG = 'https://check-ua-proxy.kykyyzka.workers.dev/**';

const ev = (o) => ({
  v: 1, id: o.id, trackId: o.id, source: o.source, sourceEventId: o.id,
  category: o.category, subtype: o.category,
  lat: o.lat, lon: o.lon, region: o.region ?? null, district: null, settlement: o.settlement ?? 'DEMO-зона',
  locationPrecision: o.lat != null ? 'COORDINATE' : 'OBLAST',
  heading: o.heading ?? null, speed: o.speed ?? null, direction: null, destination: null,
  confidence: 'demo', positionQuality: o.areaOnly ? null : 'source-position', uncertaintyKm: null,
  sourceCount: 1, count: 1, areaOnly: !!o.areaOnly, advisory: false,
  status: o.stale ? 'stale' : 'active', stale: !!o.stale, trail: [],
  sourceUrl: 'https://demo.invalid/',
  eventTime: new Date(base + 60000).toISOString(),
  receivedAt: new Date(base + 60000).toISOString(), latencyMs: 0, misses: 0,
});

const STEPS = [
  ev({ id: 'neptun:demo-flight', source: 'NEPTUN', category: 'uav', lat: 50.30, lon: 30.20, heading: 90, speed: 620 }),
  ev({ id: 'neptun:demo-flight', source: 'NEPTUN', category: 'uav', lat: 50.30, lon: 30.30, heading: 90, speed: 620 }),
  ev({ id: 'neptun:demo-flight', source: 'NEPTUN', category: 'uav', lat: 50.40, lon: 30.40, heading: 45, speed: 620 }),
];
const CONTROLS = [
  ev({ id: 'mapa:demo-noheading', source: 'MAPA', category: 'missile', lat: 50.08, lon: 30.62, heading: null }),
  ev({ id: 'mapa:demo-stale', source: 'MAPA', category: 'uav', lat: 50.80, lon: 30.08, heading: 180, stale: true }),
  ev({ id: 'neptun:demo-area', source: 'NEPTUN', category: 'ballistic', lat: null, lon: null, heading: 90, areaOnly: true, region: 'Донецька область' }),
  ev({ id: 'mapa:demo-kab', source: 'MAPA', category: 'kab', lat: 50.62, lon: 30.30, heading: 200, speed: 700 }),
];
let step = 0;
const snapshot = () => ({
  v: 1, serverTime: new Date().toISOString(), receivedAt: new Date().toISOString(),
  pipelineCheckedAt: new Date().toISOString(), dataUpdatedAt: new Date().toISOString(),
  publishedAt: new Date().toISOString(),
  health: {
    OFFICIAL: { status: 'disabled', updatedAt: null, error: null },
    NEPTUN: { status: 'online', updatedAt: new Date().toISOString(), error: null },
    MAPA: { status: 'online', updatedAt: new Date().toISOString(), error: null },
  },
  alerts: [], events: [STEPS[step], ...CONTROLS], disagreement: null,
});

function serve(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(root, p);
  if (p.endsWith('/')) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { const i = fp + '/index.html'; fp = fs.existsSync(i) ? i : null; if (!fp) { res.writeHead(404); return res.end('nf'); } }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}
const server = http.createServer(serve);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 1,
  recordVideo: { dir: 'shots/_video', size: { width: 1280, height: 860 } },
});
const page = await context.newPage();
await page.route(AGG, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }));

// A visible DEMO banner: nothing in this recording is real.
await page.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'DEMO — синтетичні дані. Жодної реальної цілі.';
    b.style.cssText = 'position:fixed;z-index:99999;left:0;right:0;top:0;padding:9px 14px;background:#B91C1C;color:#fff;font:600 13px system-ui;text-align:center;letter-spacing:.02em';
    document.body.appendChild(b);
  });
});

await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Centroid of the amber drone pixels — the moving track.
const centroid = () => page.evaluate(() => {
  const c = document.getElementById('rlScope');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 200 && d[i + 1] > 130 && d[i + 1] < 215 && d[i + 2] < 110) { sx += (i / 4) % c.width; sy += Math.floor(i / 4 / c.width); n++; }
  }
  return n ? { x: sx / n, y: sy / n, px: n } : null;
});
const next = () => page.evaluate(() => window.dispatchEvent(new Event('online')));

const log = [];
const sample = async (label) => { const c = await centroid(); log.push(`${label.padEnd(28)} ${c ? `${c.x.toFixed(1)},${c.y.toFixed(1)}` : 'n/a'}`); return c; };

const a0 = await sample('step 0  heading 090');
await page.waitForTimeout(1500);
step = 1; await next();
await page.waitForTimeout(900);
await sample('step 1  mid-glide');
await page.waitForTimeout(2400);
const a1 = await sample('step 1  settled');
await page.waitForTimeout(1500);
step = 2; await next();
await page.waitForTimeout(900);
await sample('step 2  mid-turn');
await page.waitForTimeout(2400);
const a2 = await sample('step 2  settled');

// No new data: the marker must come to rest.
await page.waitForTimeout(4000);
const a3 = await sample('no data for 4 s');
const drift = a2 && a3 ? Math.hypot(a3.x - a2.x, a3.y - a2.y) : -1;

await page.screenshot({ path: 'shots/DEMO-final.png' });
await context.close();          // flushes the video
await browser.close();
server.close();

const vdir = 'shots/_video';
const file = fs.readdirSync(vdir).find((f) => f.endsWith('.webm'));
fs.mkdirSync('shots', { recursive: true });
fs.renameSync(path.join(vdir, file), 'shots/DEMO-motion.webm');
fs.rmSync(vdir, { recursive: true, force: true });

console.log('DEMO — synthetic data only. Trajectory of the amber track:\n');
for (const l of log) console.log('  ' + l);
console.log(`\n  step 0 -> 1 : dx=${(a1.x - a0.x).toFixed(1)} dy=${(a1.y - a0.y).toFixed(1)}  (heading 090 = EAST)`);
console.log(`  step 1 -> 2 : dx=${(a2.x - a1.x).toFixed(1)} dy=${(a2.y - a1.y).toFixed(1)}  (turning to 045 = NE)`);
console.log(`  drift with no new data for 4 s: ${drift.toFixed(1)} px -> ${drift <= 2 ? 'STOPS (correct)' : 'DRIFTS (wrong)'}`);
console.log('\n  video: shots/DEMO-motion.webm   still: shots/DEMO-final.png');
