// Checks every document route on the radar's design: light tokens, the shared
// header and footer, no leftover markup from the old theme, and no page that
// silently lost its SEO head.
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

const ROUTES = [
  ['/about/', 'about'], ['/how-it-works/', 'how'], ['/sources/', 'sources'],
  ['/safety/', 'safety'], ['/faq/', 'faq'], ['/terms/', 'terms'],
  ['/privacy/', 'privacy'], ['/contact/', 'contact'], ['/info/', 'info'],
];
const shotDir = path.join(root, 'tmp-shots');
fs.mkdirSync(shotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
let failures = 0;
const fail = (r, msg) => { console.log(`  FAIL ${r}: ${msg}`); failures++; };

for (const [route, name] of ROUTES) {
  for (const vp of [{ width: 1440, height: 900, tag: 'desk' }, { width: 390, height: 844, tag: 'mob' }]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 100)));
    await page.route('**/*', (route2) => {
      const u = route2.request().url();
      if (u.startsWith('http://127.0.0.1:')) return route2.continue();
      return route2.abort();
    });
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const bar = document.querySelector('.rl-topbar');
      const foot = document.querySelector('.rl-foot');
      const navLinks = [...document.querySelectorAll('.rl-nav a')].map((a) => a.getAttribute('href'));
      // Hrefs are page-relative ("../about/"); compare them as routes.
      const navRoutes = navLinks.map((h) => new URL(h, location.href).pathname);
      const active = document.querySelector('.rl-nav a.active');
      const h1 = document.querySelector('h1');
      // Anything left from the old dark theme? `lead` and `note` are not
      // legacy: they are the old semantic names, deliberately kept and styled
      // inside .rl-doc so the page bodies need no rewriting.
      const old = [...document.querySelectorAll('[class]')]
        .map((e) => e.className).filter((c) => /^(content|cards|card|faq)$/.test(c));
      // Broken relative links: every internal href must resolve to a real file.
      const hrefs = [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && !/^(https?:|mailto:|#|\/\/)/.test(h));
      return {
        bg: body.backgroundColor, color: body.color,
        barH: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        hasFoot: !!foot, footLinks: foot ? foot.querySelectorAll('a').length : 0,
        navLinks, navRoutes, active: active ? active.getAttribute('href') : null,
        h1: h1 ? h1.textContent.trim() : null,
        old,
        hrefs,
        hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        title: document.title,
        canonical: document.querySelector('link[rel=canonical]')?.href || null,
        desc: document.querySelector('meta[name=description]')?.content || null,
        styleSheets: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
      };
    });

    const label = `${name}/${vp.tag}`;
    // Light, not the old dark theme.
    if (r.bg !== 'rgb(244, 246, 249)' && r.bg !== 'rgb(251, 252, 253)') fail(label, `background ${r.bg} is not the radar surface`);
    if (r.barH < 50 || r.barH > 70) fail(label, `topbar ${r.barH}px`);
    if (!r.hasFoot) fail(label, 'no shared footer');
    else if (r.footLinks < 8) fail(label, `footer has only ${r.footLinks} links`);
    if (r.navLinks.length < 6) fail(label, `nav has ${r.navLinks.length} links`);
    // Legal pages are reachable from the footer but have no nav entry, so only
    // a route that IS in the nav must mark itself active.
    const inNav = r.navRoutes.includes(route);
    if (inNav && !r.active) fail(label, 'no active section marked');
    else if (inNav && !r.navRoutes[r.navLinks.indexOf(r.active)].endsWith(route)) fail(label, `active is ${r.active}, expected ${route}`);
    else if (!inNav && r.active) fail(label, `active ${r.active} on a route that is not in the nav`);
    if (!r.h1) fail(label, 'no h1');
    if (r.old.length) fail(label, `old theme classes left: ${[...new Set(r.old)].join(',')}`);
    if (r.hScroll) fail(label, 'horizontal scroll');
    if (!r.title) fail(label, 'no title');
    if (!r.canonical) fail(label, 'no canonical');
    if (!r.desc) fail(label, 'no meta description');
    if (!r.styleSheets.some((s) => s.includes('radar.css'))) fail(label, `stylesheet ${r.styleSheets.join(',')} is not the radar one`);
    if (errors.length) fail(label, `JS error: ${errors[0]}`);

    if (vp.tag === 'desk') {
      await page.screenshot({ path: path.join(shotDir, 'page-' + name + '.png'), fullPage: true });
    }
    if (vp.tag === 'desk' || vp.tag === 'mob') {
      const broken = [];
      for (const h of r.hrefs) {
        const res = await page.request.get(new URL(h, BASE + route).href);
        if (res.status() >= 400) broken.push(`${h} (${res.status()})`);
      }
      if (broken.length) fail(label, `broken links: ${broken.join(', ')}`);
    }
    if (!r.old.length && r.hasFoot && !r.hScroll) {
      console.log(`  ok   ${label.padEnd(14)} bar ${r.barH}px  ${r.navLinks.length} nav  ${r.footLinks} footer links  h1 "${(r.h1 || '').slice(0, 34)}"`);
    }
    await page.close();
  }
}

await browser.close();
srv.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'every document route is on the radar design'}`);
process.exitCode = failures ? 1 : 0;