// Verifies the threat detail panel: compact, no empty half, no dead space,
// no horizontal scroll, and a reachable close button on both form factors.
//
// The snapshot is stubbed at the network layer so the check is deterministic
// and never depends on what the live pipeline happens to be publishing.
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
const URL_ = `http://127.0.0.1:${srv.address().port}/`;

const now = Date.now();
const SNAPSHOT = {
  v: 1,
  alerts: [],
  events: [
    { trackId: 't1', kind: 'uav', lat: 50.45, lon: 30.52, source: 'NEPTUN', eventTime: new Date(now - 60e3).toISOString(), heading: 137, speed: 210, region: 'Київська' },
    { trackId: 't2', kind: 'missile', lat: 48.4, lon: 35.0, source: 'MAPA', eventTime: new Date(now - 180e3).toISOString(), region: 'Дніпропетровська' },
    { trackId: 't3', kind: 'ballistic', lat: 47.1, lon: 31.9, source: 'NEPTUN', eventTime: new Date(now - 240e3).toISOString(), region: 'Миколаївська' },
  ],
  health: {
    NEPTUN: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
    MAPA: { status: 'online', updatedAt: new Date(now).toISOString(), checkedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString() },
  },
  serverTime: new Date(now).toISOString(),
  pipelineCheckedAt: new Date(now).toISOString(),
  dataUpdatedAt: new Date(now).toISOString(),
};

const browser = await chromium.launch({ headless: true });
let failures = 0;

async function check(name, viewport, open) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:')) return route.continue();
    if (u.includes('check-ua-proxy')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SNAPSHOT) });
    }
    return route.abort();
  });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Open the panel the way a user does: click the first row in the feed.
  if (open) {
    const row = await page.$('.rl-event, .rl-contact');
    if (row) await row.click();
    else console.log('  (no feed row found — checking the empty state instead)');
  }
  await page.waitForTimeout(600);

  const r = await page.evaluate(() => {
    const card = document.getElementById('detailCard');
    if (!card || card.hidden) return { hidden: true };
    const cb = card.getBoundingClientRect();
    const head = card.querySelector('.rl-detail-head').getBoundingClientRect();
    const body = card.querySelector('.rl-detail-body');
    const bb = body.getBoundingClientRect();
    const close = card.querySelector('.rl-detail-close').getBoundingClientRect();
    // Primary actions must be reachable without scrolling to the bottom: they
    // dock to the foot of the scroll port.
    const actionRow = card.querySelector('.rl-btn-row');
    const ar = actionRow ? actionRow.getBoundingClientRect() : null;
    const pinned = !!ar && Math.abs(ar.bottom - bb.bottom) <= 2 && getComputedStyle(actionRow).position === 'sticky';
    const buttons = [...card.querySelectorAll('.rl-btn')].map((b) => {
      const x = b.getBoundingClientRect();
      const clipped = x.right > window.innerWidth + 0.5 || x.left < -0.5 || x.width < 8;
      // "Reachable" = fully inside the scroll port, or below it in a body that
      // genuinely scrolls. A button below a clipped, non-scrolling body is
      // unreachable, which is the failure this catches.
      const inside = x.bottom <= bb.bottom + 1 && x.top >= bb.top - 1;
      const scrollable = body.scrollHeight > bb.height + 1;
      return { text: b.textContent.trim().slice(0, 24), clipped, w: Math.round(x.width), reachable: !clipped && (inside || scrollable || pinned) };
    });
    // Ink coverage of the body: how much of the panel actually holds content.
    const kids = [...body.children].map((el) => {
      const x = el.getBoundingClientRect();
      return { cls: el.className || el.tagName, h: Math.round(x.height), w: Math.round(x.width) };
    });
    return {
      hidden: false,
      card: { w: Math.round(cb.width), h: Math.round(cb.height), bottom: Math.round(cb.bottom) },
      head: { h: Math.round(head.height), w: Math.round(head.width) },
      body: {
        h: Math.round(bb.height), w: Math.round(bb.width), bottom: Math.round(bb.bottom),
        scrollH: body.scrollHeight, scrollable: body.scrollHeight > bb.height + 1,
        canScroll: (() => {
          // The body must actually be the scroll container: set a huge value,
          // scroll, and see whether it moved.
          const before = body.scrollTop;
          body.scrollTop = 99999;
          const moved = body.scrollTop > before;
          body.scrollTop = 0;
          return moved || body.scrollHeight <= bb.height + 1;
        })(),
      },
      close: { w: Math.round(close.width), h: Math.round(close.height), inCard: close.right <= cb.right + 0.5 && close.top >= cb.top - 0.5, visible: close.width >= 24 && close.height >= 24 },
      pinned, buttons, kids,
      // On the phone the sheet is modal, so the page behind it must be blocked;
      // on wide screens the panel is an inline card and must not dim anything.
      scrim: (() => {
        const s = document.getElementById('rlSheetScrim');
        if (!s) return null;
        return { hidden: s.hidden, display: getComputedStyle(s).display };
      })(),
      hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      viewportW: window.innerWidth,
      // Largest empty vertical run inside the body.
      biggestGap: (() => {
        const r2 = body.getBoundingClientRect();
        let cursor = r2.top, worst = 0, worstAfter = '';
        for (const el of body.children) {
          const x = el.getBoundingClientRect();
          if (x.height === 0) continue;
          const gap = x.top - cursor;
          if (gap > worst) { worst = gap; worstAfter = el.className || el.tagName; }
          cursor = Math.max(cursor, x.bottom);
        }
        return { px: Math.round(worst), after: worstAfter };
      })(),
    };
  });

  const ok = [];
  const bad = [];
  const t = (cond, msg) => (cond ? ok : bad).push(msg);
  const isPhone = viewport.width <= 900;
  if (r.hidden) {
    if (open) bad.push('detail panel did not open');
    else ok.push('panel correctly stays closed with no threat selected');
  } else {
    // On a phone the panel is a bottom sheet pinned to the screen edges, so it
    // is as wide as the screen by design; only the desktop panel has a target
    // width. Both are checked against the same "fits, nothing clipped" rules.
    if (isPhone) t(r.card.w <= viewport.width - 8, `sheet width ${r.card.w}px fits the ${viewport.width}px screen`);
    else t(r.card.w >= 560 && r.card.w <= 780, `width ${r.card.w}px within 560–780`);
    t(r.card.h <= Math.ceil(viewport.height * 0.9), `height ${r.card.h}px fits the viewport (${viewport.height})`);
    t(r.biggestGap.px <= 40, `largest gap inside the panel ${r.biggestGap.px}px`);
    t(r.close.visible && r.close.inCard, `close button ${r.close.w}x${r.close.h} visible and inside the panel`);
    t(r.buttons.every((b) => !b.clipped), `action buttons fully on screen (${r.buttons.map((b) => b.w).join('/')}px)`);
    t(!r.hScroll, 'no horizontal scroll');
    t(r.pinned, 'primary actions are docked to the panel foot, not below the fold');
    const scrimOn = r.scrim && !r.scrim.hidden && r.scrim.display !== 'none';
    if (isPhone) t(scrimOn, 'backdrop blocks the page behind the sheet');
    else t(!scrimOn, 'no backdrop on wide screens');
    // The whole body must be reachable: either it fits, or it scrolls and the
    // scroll container is the one that is bounded by the panel.
    t(r.body.bottom <= r.card.bottom + 1, `body bottom ${r.body.bottom} inside panel bottom ${r.card.bottom}`);
    t(!r.body.scrollable || r.body.canScroll, `long content ${r.body.scrollH > r.body.h ? 'scrolls' : 'fits'}`);
    t(r.buttons.every((b) => b.reachable), 'action buttons are reachable, not clipped away');
  }
  t(errors.length === 0, `JS errors ${errors.length}${errors[0] ? ': ' + errors[0] : ''}`);

  console.log(`\n=== ${name} ${viewport.width}x${viewport.height}${open ? '' : ' (empty state)'} ===`);
  for (const m of ok) console.log('  ok   ' + m);
  for (const m of bad) { console.log('  FAIL ' + m); failures++; }
  if (!r.hidden) {
    console.log(`  panel ${r.card.w}x${r.card.h} | head ${r.head.h}px | body ${r.body.w}x${r.body.h} (content ${r.body.scrollH}px${r.body.scrollable ? ', scrolls' : ', fits'})`);
    console.log('  body blocks: ' + r.kids.map((k) => `${k.cls.split(' ')[0]}:${k.h}`).join(' '));
  }
  await page.close();
}

await check('desktop', { width: 1440, height: 900 }, true);
await check('wide', { width: 1920, height: 1080 }, true);
await check('mobile', { width: 390, height: 844 }, true);
await check('mobile small', { width: 360, height: 640 }, true);
await check('desktop empty', { width: 1440, height: 900 }, false);

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'all detail-panel checks passed'}`);
process.exitCode = failures ? 1 : 0;