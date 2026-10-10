// Browser verification of the V5 marker behaviour on real layouts.
// Uses synthetic DEMO data so every rule can be checked deterministically.
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
  category: o.category, kind: null, subtype: o.category,
  lat: o.lat, lon: o.lon, region: o.region ?? null, district: null, settlement: o.settlement ?? 'DEMO',
  locationPrecision: o.lat != null ? 'COORDINATE' : 'OBLAST',
  heading: o.heading ?? null, speed: o.speed ?? null, direction: null, destination: null,
  confidence: 'demo', positionQuality: o.areaOnly ? null : 'source-position', uncertaintyKm: null,
  sourceCount: 1, count: 1, areaOnly: !!o.areaOnly, advisory: false,
  status: o.stale ? 'stale' : 'active', stale: !!o.stale, trail: [],
  sourceUrl: 'https://demo.invalid/',
  eventTime: new Date(base + 60000).toISOString(),
  receivedAt: new Date(base + 60000).toISOString(), latencyMs: 0, misses: 0,
});

// One of every kind, each with its own real heading, plus the control cases.
const EVENTS = [
  ev({ id: 'n:d1', source: 'NEPTUN', category: 'uav',       lat: 50.10, lon: 30.10, heading: 0,   speed: 180 }),
  ev({ id: 'n:d2', source: 'NEPTUN', category: 'missile',   lat: 49.80, lon: 30.60, heading: 90,  speed: 800 }),
  ev({ id: 'n:d3', source: 'NEPTUN', category: 'ballistic', lat: 50.40, lon: 30.20, heading: 180, speed: 3000 }),
  ev({ id: 'n:d4', source: 'NEPTUN', category: 'kab',       lat: 49.60, lon: 30.40, heading: 270, speed: 700 }),
  ev({ id: 'n:d5', source: 'NEPTUN', category: 'aviation',  lat: 50.60, lon: 30.80, heading: 45,  speed: 650 }),
  ev({ id: 'n:d6', source: 'NEPTUN', category: 'other',     lat: 50.20, lon: 29.80, heading: 135 }),
  // control: no heading -> must stay neutral. Placed close enough to the
  // centre to appear in the "5 nearest" list, so the card can be inspected.
  ev({ id: 'm:nohead', source: 'MAPA', category: 'missile', lat: 50.15, lon: 30.45, heading: null }),
  // control: area-only -> never a point marker
  ev({ id: 'n:area', source: 'NEPTUN', category: 'ballistic', lat: null, lon: null, areaOnly: true, region: 'Донецька область' }),
  // control: stale -> never plotted, never animated
  ev({ id: 'm:stale', source: 'MAPA', category: 'uav', lat: 48.90, lon: 30.90, heading: 180, stale: true }),
];
const snapshot = () => ({
  v: 1, serverTime: new Date().toISOString(), receivedAt: new Date().toISOString(),
  pipelineCheckedAt: new Date().toISOString(), dataUpdatedAt: new Date().toISOString(),
  publishedAt: new Date().toISOString(),
  health: {
    // Retired in production: absent from the payload, so the public block has
    // nothing to render for it.
    NEPTUN: { status: 'online', updatedAt: new Date().toISOString(), error: null },
    MAPA: { status: 'online', updatedAt: new Date().toISOString(), error: null },
  },
  alerts: [], events: EVENTS, disagreement: null,
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
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URL_ = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({ headless: true });
const fails = [];
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails.push(m); };

for (const [w, h, name] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e).slice(0, 120)));
  await page.route(AGG, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot()) }));
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2600);

  const r = await page.evaluate(() => {
    const scr = document.querySelector('.rl-radar-screen').getBoundingClientRect();
    const c = document.getElementById('rlScope');
    return {
      circle: Math.round(scr.width) + 'x' + Math.round(scr.height),
      ratio: +(scr.width / scr.height).toFixed(4),
      buffer: c.width + 'x' + c.height,
      legend: document.querySelectorAll('.rl-radar-legend svg').length,
      feedIcons: document.querySelectorAll('.rl-event svg').length,
      filterDots: document.querySelectorAll('.rl-kind-dot').length,
      // Public source-status block: the retired source must not appear.
      sourceCards: document.querySelectorAll('#rlSources .rl-source-mini').length,
      sourceNames: [...document.querySelectorAll('#rlSources .rl-src-name')].map((n) => n.textContent.trim()),
      sourceLabels: [...document.querySelectorAll('#rlSources .rl-src-state')].map((n) => n.textContent.trim()),
      // The retired source appeared under this key; nothing else uses it.
      mentionsRetired: /OFFICIAL/.test(document.getElementById('rlSources')?.textContent || ''),
      badge: document.getElementById('rlLive')?.textContent?.trim() || '',
      contacts: document.querySelectorAll('.rl-contact').length,
      radarCount: document.getElementById('rlRadarCount')?.textContent || '',
      scopeLabel: document.getElementById('rlScope')?.getAttribute('aria-label') || '',
      feedRows: document.querySelectorAll('.rl-event').length,
      spriteUsed: [...performance.getEntriesByType('resource')].some(e => e.name.includes('threats/sprite.svg')),
      hScroll: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  ok(Math.abs(r.ratio - 1) < 0.01, `${name}: radar still a perfect circle (${r.circle})`);
  ok(r.buffer.split('x')[0] === r.buffer.split('x')[1], `${name}: square canvas buffer (${r.buffer})`);
  ok(r.spriteUsed, `${name}: V5 sprite loaded`);
  ok(r.legend === 5, `${name}: legend uses the new SVG set (${r.legend})`);
  ok(r.feedIcons === r.feedRows, `${name}: every feed row has an SVG icon (${r.feedIcons}/${r.feedRows})`);
  ok(r.filterDots === 7, `${name}: filters intact (${r.filterDots})`);
  // 9 demo events. The scope must plot only the 7 that carry real coordinates
  // and are not stale: the area-only record and the stale track are excluded.
  ok(/^7 /.test(r.radarCount), `${name}: area-only + stale excluded -> "${r.radarCount}"`);
  ok(/Радар: 7 цілей/.test(r.scopeLabel), `${name}: canvas aria-label agrees (${r.scopeLabel})`);
  // The contact list is a deliberate "5 nearest" summary, not the full set.
  ok(r.contacts === 5, `${name}: contact list caps at the 5 nearest (${r.contacts})`);
  ok(r.sourceCards === 2, `${name}: source block shows exactly 2 cards (${r.sourceCards})`);
  ok(JSON.stringify(r.sourceNames) === JSON.stringify(['NEPTUN', 'MAPA']),
    `${name}: only the monitoring sources — ${r.sourceNames.join(', ')}`);
  ok(!r.mentionsRetired, `${name}: the retired source is not shown`);
  ok(!r.sourceLabels.includes('Офлайн'), `${name}: nothing is reported as offline (${r.sourceLabels.join(', ')})`);
  ok(r.badge === 'LIVE', `${name}: the aggregate badge is healthy (${r.badge})`);
  ok(r.hScroll <= 1, `${name}: no horizontal scroll (${r.hScroll})`);
  ok(errs.length === 0, `${name}: no JS errors ${errs[0] || ''}`);

  // ── Detail card: must print only what the source actually reported ───────
  const detail = await page.evaluate(async () => {
    const pick = (id) => {
      const el = document.querySelector(`.rl-contact[data-id="${id}"]`)
        || [...document.querySelectorAll('.rl-contact')].find((b) => (b.dataset.id || '').includes(id));
      if (!el) return null;
      el.click();
      const body = document.getElementById('rlDetailBody');
      const dt = [...body.querySelectorAll('dt')].map((n, i) => [n.textContent, body.querySelectorAll('dd')[i]?.textContent]);
      return Object.fromEntries(dt);
    };
    return {
      drone: pick('n:d1'),        // heading 0,   speed 180
      nohead: pick('nohead'),     // heading null, speed null
    };
  });
  ok(detail.drone != null, `${name}: detail card opens for a target`);
  ok(detail.drone && /Напрямок руху/.test(Object.keys(detail.drone).join()), `${name}: card shows movement heading`);
  ok(detail.drone && /Пн · 0°/.test(detail.drone['Напрямок руху']), `${name}: heading 0 reads NORTH (${detail.drone && detail.drone['Напрямок руху']})`);
  ok(detail.drone && /180 км\/год/.test(detail.drone['Швидкість'] || ''), `${name}: reported speed is shown (${detail.drone && detail.drone['Швидкість']})`);
  ok(detail.nohead && /невідомий/.test(detail.nohead['Напрямок руху'] || ''), `${name}: absent heading says "unknown", not a guess (${detail.nohead && detail.nohead['Напрямок руху']})`);
  ok(detail.nohead && /невідома/.test(detail.nohead['Швидкість'] || ''), `${name}: absent speed says "unknown" (${detail.nohead && detail.nohead['Швидкість']})`);

  // Screenshot the top of the page, with no modal open: the detail-card probe
  // above scrolls the view and covers the source-status block.
  await page.evaluate(() => document.getElementById('rlDetailClose')?.click());
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `shots/V5-${name}.png` });
  await page.close();
}

await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL BROWSER CHECKS PASSED');
if (fails.length) process.exitCode = 2;