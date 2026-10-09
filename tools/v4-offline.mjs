import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.wav': 'audio/wav' };
function serve(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp = path.join(root, p);
  if (p.endsWith('/')) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { const i = fp + '/index.html'; fp = fs.existsSync(i) ? i : null; if (!fp) { res.writeHead(404); return res.end('nf'); } }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}
const server = http.createServer(serve);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// HARD BLOCK the geocoder + the data backend: the radar must still boot.
const blocked = [];
await page.route('**://nominatim.openstreetmap.org/**', r => { blocked.push(r.request().url()); r.abort(); });
await page.route('**://check-ua-proxy.kykyyzka.workers.dev/**', r => { blocked.push('AGGREGATOR'); r.abort(); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const res = await page.evaluate(() => ({
  center: document.getElementById('rlCenterLabel')?.textContent || '',
  chips: [...document.querySelectorAll('#rlPopular .rl-chip')].map(b => b.textContent.trim()),
  note: document.getElementById('rlRadarCount')?.textContent || '',
  feed: document.querySelectorAll('.rl-event').length,
  radius: document.querySelectorAll('#rlRange button').length,
  kinds: document.querySelectorAll('.rl-kind').length,
  circle: (() => { const r = document.querySelector('.rl-radar-screen')?.getBoundingClientRect(); return r ? Math.round(r.width) + 'x' + Math.round(r.height) : null; })(),
}));

const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

ok(/Київ/.test(res.center), `default centre resolved offline -> "${res.center}"`);
ok(res.chips.length === 5, `popular chips rendered (${res.chips.length})`);
ok(res.radius === 6, `radius buttons intact (${res.radius})`);
ok(res.kinds === 7, `filter rows intact (${res.kinds})`);
// With the backend blocked there is legitimately no data; the UI must say so
// honestly rather than pretend or crash.
const honestEmpty = /Очікування|недоступні|немає/i.test(res.note);
ok(res.feed > 0 || honestEmpty, `feed shows an honest state -> "${res.note}" (${res.feed} rows)`);
ok(res.circle === '580x580' || (res.circle && res.circle.split('x')[0] === res.circle.split('x')[1]), `radar still a circle (${res.circle})`);

// Clicking a popular chip must NOT need the network either.
await page.click('#rlPopular .rl-chip:nth-child(2)');
await page.waitForTimeout(1200);
const after = await page.evaluate(() => document.getElementById('rlCenterLabel')?.textContent || '');
ok(/Харків/.test(after), `popular city click works offline -> "${after}"`);

const nomCalls = blocked.filter(u => String(u).includes('nominatim')).length;
ok(nomCalls === 0, `Nominatim was never called for the built-in paths (${nomCalls} calls)`);

await page.screenshot({ path: 'shots/NONOM-1440.png' });
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nRADAR BOOTS FULLY WITHOUT THE GEOCODER');
if (fails.length) process.exitCode = 2;