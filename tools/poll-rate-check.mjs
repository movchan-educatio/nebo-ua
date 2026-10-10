// Measures the polling interval the radar actually uses in two states.
//
// The analysis question: how much does request volume rise when the API is
// reachable but the pipeline is stale? The recovery ladder is supposed to back
// off 15s, 30s, 60s, 120s, but the attempt counter is reset by any successful
// HTTP response — and a 200 carrying an old timestamp IS a successful response.
// If that is what happens, the ladder never advances and every client sits on
// its first rung indefinitely.
//
// Local stand-in only; nothing about the deployed site is touched.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const site = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  let f = path.join(root, p);
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { const i = f + '/index.html'; f = fs.existsSync(i) ? i : null; if (!f) { r.writeHead(404); return r.end('nf'); } }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

let stale = true;
const stamps = [];
const api = http.createServer((q, r) => {
  const origin = q.headers.origin || '*';
  if (q.method === 'OPTIONS') {
    r.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': q.headers['access-control-request-headers'] || 'Content-Type' });
    return r.end();
  }
  const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
  // "stale" = a well-formed 200 whose pipeline is old. "fresh" = current.
  const age = stale ? 600 : 5;
  stamps.push(Date.now());
  r.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  r.end(JSON.stringify({
    v: 1, pipelineCheckedAt: iso(age), dataUpdatedAt: iso(age + 30), publishedAt: iso(age), serverTime: new Date().toISOString(),
    alerts: [], events: [],
    health: { NEPTUN: { status: 'online', updatedAt: iso(age) }, MAPA: { status: 'online', updatedAt: iso(age) } },
  }));
});

await new Promise((r) => site.listen(0, '127.0.0.1', r));
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const API = `http://127.0.0.1:${api.address().port}/v1/state`;

const OBSERVE_MS = 100_000;
const browser = await chromium.launch({ headless: true });

async function measure(label) {
  stamps.length = 0;
  stale = label === 'STALE';
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((u) => { try { localStorage.setItem('nebo-api-url', u); } catch { /* ignore */ } }, API);
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);            // let it boot and settle
  const from = Date.now();
  stamps.length = 0;                           // count only after boot
  const badge = await page.evaluate(() => document.getElementById('rlLive')?.textContent);
  await page.waitForTimeout(OBSERVE_MS);
  const span = (Date.now() - from) / 1000;
  await page.close();

  const gaps = stamps.slice(1).map((t, i) => Math.round((t - stamps[i]) / 1000));
  const avg = gaps.length ? Math.round(span / gaps.length) : null;
  console.log(`${label.padEnd(6)} badge=${String(badge).padEnd(7)} requests in ${span}s: ${stamps.length}  → avg every ${avg}s`);
  console.log(`       intervals seen: ${gaps.join('s, ')}s`);
  return { avg, count: stamps.length, span };
}

console.log('One client, 100s window, radar page open and visible.\n');
const fresh = await measure('FRESH');
console.log('');
const old = await measure('STALE');

console.log(`\nAmplification when the pipeline goes stale: ${(fresh.avg / old.avg).toFixed(1)}x more requests per client`);
console.log(`Per client per day: fresh ≈ ${Math.round(86400 / fresh.avg)}, stale ≈ ${Math.round(86400 / old.avg)}`);

await browser.close();
site.close();
api.close();
