import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.xml': 'application/xml', '.wav': 'audio/wav' };

function serve(req, res) {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let fp = path.join(root, urlPath);
    if (urlPath.endsWith('/')) fp = path.join(fp, 'index.html');
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      const idx = fp + '/index.html';
      if (fs.existsSync(idx)) fp = idx;
      else { res.writeHead(404); res.end('nf'); return; }
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.writeHead(500); res.end('err'); }
}

const server = http.createServer(serve);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log('serving on', port);

const widths = [1920, 1440, 1024, 768, 430, 390, 375, 360, 320];
const browser = await chromium.launch({ headless: true });
const results = [];
for (const w of widths) {
  const h = w >= 1024 ? 900 : 844;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle', timeout: 20000 }).catch(e => console.log('goto', w, e.message.slice(0, 120)));
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const scr = document.querySelector('.rl-radar-screen');
    const r = scr ? scr.getBoundingClientRect() : null;
    const canvas = document.getElementById('rlScope');
    const cr = canvas ? canvas.getBoundingClientRect() : null;
    const cs = getComputedStyle(scr || document.body);
    return {
      screen: r ? { w: Math.round(r.width), h: Math.round(r.height), ratio: +(r.width / Math.max(1, r.height)).toFixed(4) } : null,
      canvasRect: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null,
      canvasBuf: canvas ? { w: canvas.width, h: canvas.height } : null,
      aspect: cs.aspectRatio || '',
      borderRadius: cs.borderRadius || '',
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      hScroll: document.documentElement.scrollWidth - window.innerWidth,
      live: document.getElementById('rlLive')?.textContent || '',
      cols: getComputedStyle(document.querySelector('.rl-main')).gridTemplateColumns,
      topbarH: Math.round(document.querySelector('.rl-topbar')?.getBoundingClientRect().height || 0),
      bottomnavVisible: getComputedStyle(document.querySelector('.rl-bottomnav')).display !== 'none',
      controlsVisible: getComputedStyle(document.querySelector('.rl-controls')).display !== 'none',
    };
  });
  // settings dialog check (desktop + mobile)
  let settingsOk = false;
  try {
    await page.click('#rlSettingsBtn', { timeout: 3000 });
    await page.waitForTimeout(400);
    settingsOk = await page.evaluate(() => {
      const d = document.getElementById('rlSettings');
      return !!(d && d.open);
    });
    await page.screenshot({ path: `shots/v4-settings-${w}.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } catch (e) { console.log('settings fail', w, e.message.slice(0, 100)); }
  await page.screenshot({ path: `shots/v4-${w}.png`, fullPage: false });
  await page.screenshot({ path: `shots/v4-full-${w}.png`, fullPage: true });
  const circleOk = info.screen && Math.abs(info.screen.w - info.screen.h) <= 2 && Math.abs(info.screen.ratio - 1) < 0.01;
  const noHScroll = info.hScroll <= 1;
  console.log(`W=${w} screen=${info.screen?.w}x${info.screen?.h} ratio=${info.screen?.ratio} buf=${info.canvasBuf?.w}x${info.canvasBuf?.h} circle=${circleOk ? 'OK' : 'FAIL'} hScroll=${info.hScroll} ${noHScroll ? 'OK' : 'FAIL'} cols=[${info.cols}] topbar=${info.topbarH} bottomnav=${info.bottomnavVisible} controls=${info.controlsVisible} settings=${settingsOk} live=${info.live} errors=${errors.length}`);
  results.push({ w, ...info, circleOk, noHScroll, settingsOk, errors });
  await page.close();
}
await browser.close();
server.close();
const fails = results.filter(r => !r.circleOk || !r.noHScroll);
console.log(`\nDone. Circle fails: ${results.filter(r => !r.circleOk).map(r => r.w)} HScroll fails: ${results.filter(r => !r.noHScroll).map(r => r.w)}`);
if (fails.length) process.exitCode = 2;
