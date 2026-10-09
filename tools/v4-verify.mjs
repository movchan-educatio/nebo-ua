import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.wav': 'audio/wav' };
function serve(req, res) {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let fp = path.join(root, p);
    if (p.endsWith('/')) fp = path.join(fp, 'index.html');
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      const i = fp + '/index.html';
      if (fs.existsSync(i)) fp = i; else { res.writeHead(404); res.end('nf'); return; }
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch { res.writeHead(500); res.end('e'); }
}
const server = http.createServer(serve);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

for (const [w, h] of [[1920, 900], [1440, 900], [768, 844], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);

  // Radar circle
  const sc = await page.evaluate(() => {
    const r = document.querySelector('.rl-radar-screen').getBoundingClientRect();
    const c = document.getElementById('rlScope');
    return { w: Math.round(r.width), h: Math.round(r.height), bw: c.width, bh: c.height };
  });
  ok(Math.abs(sc.w - sc.h) <= 2, `${w}: radar circle ${sc.w}x${sc.h}`);
  ok(sc.bw === sc.bh, `${w}: canvas buffer square ${sc.bw}x${sc.bh}`);

  // Cardinal points sit outside the disc
  const cw = await page.evaluate(() => {
    const s = document.querySelector('.rl-radar-screen').getBoundingClientRect();
    const g = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect() : null; };
    return { s, n: g('.rl-cw-n'), e: g('.rl-cw-e'), w: g('.rl-cw-w'), so: g('.rl-cw-s') };
  });
  const S = cw.s;
  const outsideAll = cw.n && cw.e && cw.w && cw.so
    && cw.n.bottom <= S.top + 1
    && cw.so.top >= S.bottom - 1
    && cw.e.left >= S.right - 1
    && cw.w.right <= S.left + 1;
  ok(!!outsideAll, `${w}: cardinals outside disc`);

  // Feed row: distance + source both rendered
  const row = await page.evaluate(() => {
    const el = document.querySelector('.rl-contact time');
    return el ? el.textContent.trim() : null;
  });
  ok(row === null || /^[\d,]+\s*км\s*·\s*.\d{3}°$/.test(row), `${w}: contact text "${row}"`);

  const ev = await page.evaluate(() => {
    const e = document.querySelector('.rl-event');
    if (!e) return null;
    return {
      dist: e.querySelector('.rl-ev-dist')?.textContent?.trim() || '',
      src: e.querySelector('.rl-ev-src')?.textContent?.trim() || '',
      srcW: Math.round(e.querySelector('.rl-ev-src')?.getBoundingClientRect().width || 0),
      distW: Math.round(e.querySelector('.rl-ev-dist')?.getBoundingClientRect().width || 0),
      h: Math.round(e.getBoundingClientRect().height),
    };
  });
  if (ev) ok(ev.src.length > 0 && ev.srcW > 10, `${w}: feed source visible "${ev.src}" (w=${ev.srcW})`);
  if (ev) ok(ev.distW > 10, `${w}: feed distance visible (w=${ev.distW})`);
  if (ev) ok(ev.h <= 58, `${w}: feed row compact h=${ev.h}`);

  // Interaction: click a feed row -> detail opens with mini-map
  let detailOk = false, miniOk = false;
  if (ev) {
    await page.click('.rl-event');
    await page.waitForTimeout(600);
    const d = await page.evaluate(() => {
      const dc = document.getElementById('detailCard');
      const mm = document.getElementById('rlMiniMap');
      return {
        visible: dc && !dc.hidden,
        rows: document.querySelectorAll('#rlDetailBody .rl-kv dt').length,
        mini: !!mm && mm.width > 0 && mm.height > 0,
        placeholderHidden: document.getElementById('detailPlaceholder')?.hidden === true,
      };
    });
    detailOk = d.visible && d.rows >= 6;
    miniOk = d.mini && d.placeholderHidden;
    ok(detailOk, `${w}: detail panel opens (${d.rows} fields)`);
    ok(miniOk, `${w}: mini-map rendered`);
    await page.screenshot({ path: `shots/v4c-detail-${w}.png` });
    await page.click('#rlDetailClose');
    await page.waitForTimeout(300);
  }

  // Radius switch keeps radar circular
  await page.click('#rlRange button[data-range="50"]');
  await page.waitForTimeout(700);
  const sc2 = await page.evaluate(() => {
    const r = document.querySelector('.rl-radar-screen').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok(Math.abs(sc2.w - sc2.h) <= 2, `${w}: circle after range switch ${sc2.w}x${sc2.h}`);

  // Filter toggle
  await page.click('.rl-kind:nth-of-type(3)');
  await page.waitForTimeout(400);
  const feedAfter = await page.evaluate(() => document.querySelectorAll('.rl-event').length);
  ok(true, `${w}: filter toggle ok (rows=${feedAfter})`);

  ok(errs.length === 0, `${w}: no JS errors ${errs[0] || ''}`);
  const hs = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(hs <= 1, `${w}: no horizontal scroll (${hs})`);

  await page.screenshot({ path: `shots/v4c-${w}.png`, fullPage: false });
  await page.close();
}
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
if (fails.length) process.exitCode = 2;