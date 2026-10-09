// Local-only end-to-end fixture server. Never contacts upstream providers.
// Run: node tools/verify-local.mjs (Node 22.13+, Playwright Chromium installed).
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import worker from '../backend/src/index.js';
import { runDurablePipeline } from '../backend/src/pipeline.js';
import { testEnv, sourceRoutes, mockSources } from '../backend/test/helpers/runtime.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const env = testEnv(), routes = sourceRoutes();
globalThis.fetch = mockSources(routes);
await runDurablePipeline(env);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/geo+json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/v1/state') {
      const result = await worker.fetch(new Request(url), env);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(await result.text()); return;
    }
    const file = resolve(root, '.' + decodeURIComponent(url.pathname) + (url.pathname.endsWith('/') ? 'index.html' : ''));
    if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.NEBO_CHROMIUM_PATH ? { executablePath: process.env.NEBO_CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'] } : {}) });
const evidence = { mode: 'LOCAL FIXTURES + SQLite; not production', views: [], icons: [] };
await mkdir(resolve(root, 'temp'), { recursive: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Europe/Kyiv', serviceWorkers: 'block' });
    await context.addInitScript(api => {
      localStorage.setItem('nebo-api-url', api);
      localStorage.setItem('nebo-onboarded', '1');
    }, origin + '/v1/state');
    // Network isolation includes maps, analytics and websocket providers.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await context.routeWebSocket('**', socket => socket.close());
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const response = page.waitForResponse(r => r.url() === origin + '/v1/state' && r.status() === 200);
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await response;
    await page.waitForFunction(() => /Перевірено \d/.test(document.querySelector('#mapUpdated')?.textContent || ''));
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    const before = await page.locator('#mapUpdated').textContent();
    routes['/api/v3/alerts/status'] = new Response('{}', { status: 401 });
    await runDurablePipeline(env);
    const afterRequest = page.waitForResponse(r => r.url() === origin + '/v1/state' && r.status() === 200);
    await page.evaluate(() => dispatchEvent(new Event('online')));
    const data = await (await afterRequest).json();
    assert.equal(data.health.OFFICIAL.status, 'offline');
    assert.equal(data.health.MAPA.status, 'online');
    await page.waitForFunction(() => document.querySelector('#srcList .src-card .pill.off')?.textContent === 'Офлайн');
    const item = { viewport, checkedLabel: before, official401Visible: true, browserErrors: errors,
      horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) };
    assert.equal(item.horizontalOverflow, false);
    evidence.views.push(item);
    await page.screenshot({ path: resolve(root, `temp/qa-${viewport.width}.png`), fullPage: true });
    if (evidence.icons.length === 0) for (const path of ['/favicon.ico', '/favicon-32x32.png', '/favicon-48x48.png', '/favicon-192x192.png', '/favicon-512x512.png', '/apple-touch-icon.png', '/favicon.svg']) {
      const r = await page.request.get(origin + path), contentType = r.headers()['content-type'];
      assert.equal(r.status(), 200); assert.match(contentType, /^image\//);
      const bytes = await r.body(); assert.ok(bytes.length > 100);
      evidence.icons.push({ path, status: r.status(), contentType, bytes: bytes.length });
    }
    await context.close();
    routes['/api/v3/alerts/status'] = { lastActionIndex: 123 };
    await runDurablePipeline(env);
  }
  await writeFile(resolve(root, 'temp/verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close(); await new Promise(r => server.close(r)); env.nebo_journal.sqlite.close();
}
