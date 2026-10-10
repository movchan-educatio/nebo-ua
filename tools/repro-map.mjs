// Reproduces the "map disappears after reload" bug and measures it.
//
// The static layer (disc + oblast contours + rings) is rebuilt only when
// staticCacheKey() changes. This counts the pixels painted in the contour fill
// colour inside the disc, so "the map is there" is a measurement, not an
// opinion. Run it against the local build before and after the fix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const RUNS = Number(process.argv[2] || 20);

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

// The scope draws the cached static layer onto rlScope each frame, so sampling
// rlScope measures what the user actually sees.
const probe = () => {
  const c = document.getElementById('rlScope');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let contour = 0, painted = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    if (r > 250 && gg > 250 && b > 250) continue;   // page background
    painted++;
    // contour fill #F0EDE6 / stroke #DCD5C7
    if ((Math.abs(r - 240) < 9 && Math.abs(gg - 237) < 9 && Math.abs(b - 230) < 9)
      || (Math.abs(r - 220) < 10 && Math.abs(gg - 213) < 10 && Math.abs(b - 199) < 12)) contour++;
  }
  return { contour, painted, ratio: +(contour / Math.max(1, painted)).toFixed(4) };
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 100)));

console.log(`Reloading the radar ${RUNS} times and measuring the map layer.\n`);
const results = [];
for (let i = 1; i <= RUNS; i++) {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);           // well past the async contour fetch
  const r = await page.evaluate(probe);
  results.push(r);
  console.log(`  reload ${String(i).padStart(2)}  contour px ${String(r.contour).padStart(6)}  share ${(r.ratio * 100).toFixed(2)}%  ${r.contour > 500 ? 'map OK' : 'MAP MISSING'}`);
}

// Hard reload (cache bypass) and a fresh tab.
console.log('\nHard reload (Cache-Control: no-cache):');
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const hard = await page.evaluate(probe);
console.log(`  contour px ${hard.contour}  ${hard.contour > 500 ? 'map OK' : 'MAP MISSING'}`);

console.log('\nNew tab (no warm cache):');
const page2 = await ctx.newPage();
await page2.goto(URL_, { waitUntil: 'domcontentloaded' });
await page2.waitForTimeout(3500);
const fresh = await page2.evaluate(probe);
console.log(`  contour px ${fresh.contour}  ${fresh.contour > 500 ? 'map OK' : 'MAP MISSING'}`);

const bad = results.filter((r) => r.contour <= 500).length;
console.log(`\nsummary: ${results.length - bad}/${results.length} reloads drew the map` +
  (bad ? `  —  ${bad} FAILED (flaky)` : '  — stable'));
console.log(`JS errors: ${errors.length}${errors[0] ? ' — ' + errors[0] : ''}`);
await browser.close();
server.close();
process.exitCode = bad || errors.length ? 1 : 0;
