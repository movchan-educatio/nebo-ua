import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CANON = 'https://nebo-ua.vercel.app';
const DIRS = ['about', 'how-it-works', 'sources', 'safety', 'faq', 'privacy', 'terms', 'contact'];

test('home is a LIVE app again: map present, no article section', () => {
  const h = read('index.html');
  assert.ok(h.includes('id="map"'), 'home has live map');
  assert.ok(h.includes('id="scopeCanvas"'), 'home has radar');
  assert.ok(h.includes('id="threatList"'), 'home has threats view');
  assert.ok(h.includes('id="skyView"') || h.includes('skyView'), 'home has my-sky view');
  assert.ok(h.includes('bottom-nav'), 'home has app bottom navigation');
  assert.ok(!h.includes('seo-section'), 'no article section on home');
  assert.ok(!h.includes('seo-faq'), 'no home FAQ accordion (lives on /faq/)');
  assert.ok((h.match(/<h1[\s>]/g) || []).length === 1, 'single H1');
  assert.ok(h.includes('<h1 id="mapTitle" class="sr-only">Карта повітряних тривог України онлайн</h1>'), 'accessible H1, not display:none');
});

test('LIVE data architecture intact', () => {
  const app = read('assets/js/app.js');
  assert.ok(app.includes('neptun') || app.includes('NEPTUN'), 'neptun data path present');
  assert.ok(app.includes('mapa') || app.includes('MAPA'), 'mapa data path present');
  assert.ok(app.includes('invalidateSize'), 'viewport resize handled via invalidateSize');
  assert.ok(app.includes('WebSocket') || read('services/neptun-live.js').includes('WebSocket'), 'live socket client present');
});

test('content pages: no app chrome, document flow, unique SEO', () => {
  const titles = new Set();
  const descs = new Set();
  for (const d of DIRS) {
    const h = read(`${d}/index.html`);
    assert.ok(!h.includes('bottom-nav'), `${d}: no app bottom navigation`);
    assert.ok(!h.includes('id="map"'), `${d}: no map engine markup`);
    assert.ok(!h.includes('adsbygoogle'), `${d}: no ad script`);
    assert.ok(!h.includes('app.js'), `${d}: no live app bundle`);
    assert.ok(h.includes('class="site-header"'), `${d}: content header`);
    assert.ok(h.includes('class="site-footer"'), `${d}: content footer`);
    assert.ok(h.includes('id="menuButton"') && h.includes('id="siteMenu"'), `${d}: mobile menu`);
    assert.ok(h.includes('aria-expanded'), `${d}: menu aria state`);
    const title = h.match(/<title>([^<]+)<\/title>/)[1];
    assert.ok(title.length > 10 && !titles.has(title), `${d}: unique title`);
    titles.add(title);
    const desc = h.match(/name="description" content="([^"]+)"/)[1];
    assert.ok(desc.length >= 40 && !descs.has(desc), `${d}: unique description`);
    descs.add(desc);
    assert.ok((h.match(/<h1[\s>]/g) || []).length === 1, `${d}: single H1`);
    assert.ok(h.includes(`"url":"${CANON}/${d}/"`), `${d}: schema URL on production domain`);
  }
});

test('desktop header nav + active state on every page', () => {
  const h = read('index.html');
  assert.ok(h.includes('class="top-links"'), 'home has desktop section links');
  assert.ok(h.includes('id="menuButton"'), 'home has mobile menu button');
  for (const d of DIRS) {
    const p = read(`${d}/index.html`);
    assert.ok(p.includes('class="site-nav"'), `${d}: desktop nav`);
    assert.ok(p.includes(`href="../${d}/" aria-current="page"`), `${d}: active state`);
  }
});

test('FAQ lives on /faq/ with matching schema', () => {
  const h = read('faq/index.html');
  const visQs = [...h.matchAll(/<details class="faq"><summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.ok(visQs.length >= 9, 'faq questions visible');
  const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]);
  const faq = ld['@graph'].find((x) => x['@type'] === 'FAQPage');
  assert.ok(faq && faq.mainEntity.length === visQs.length, 'FAQPage mirrors visible FAQ');
  assert.ok(faq.mainEntity.every((q, i) => q.name === visQs[i]), 'FAQ questions match');
});

test('internal linking: no orphan pages', () => {
  const h = read('index.html');
  for (const d of DIRS) {
    assert.ok(h.includes(`href="./${d}/"`), `home links ${d}`);
    const p = read(`${d}/index.html`);
    assert.ok(p.includes('href="../"'), `${d}: links back home`);
  }
  const sm = read('sitemap.xml');
  assert.equal((sm.match(/<loc>/g) || []).length, 9, 'sitemap lists exactly 9 canonical URLs');
  for (const d of DIRS) {
    assert.ok(sm.includes(`<loc>${CANON}/${d}/</loc>`), `sitemap lists ${d}`);
  }
});

test('layout safe-area: header in document flow, content offset, no overlap architecture', () => {
  const css = read('assets/css/styles.css') + '\n' + read('assets/css/content.css');
  assert.ok(css.includes('--header-h:56px'), 'canonical header variable (desktop 56px)');
  assert.ok(css.includes('--safe-gap:12px'), 'safe gap variable');
  assert.ok(/\.app-header\{position:sticky/.test(css), 'app header occupies document flow');
  assert.ok(/\.site-header\{[^}]*position:sticky/.test(css) || /\.site-header\{position:sticky/.test(css), 'content header occupies document flow');
  assert.ok(css.includes('scroll-margin-top:calc(var(--header-h)'), 'anchors stop below header');
  assert.ok(css.includes('safe-area-inset-bottom'), 'iPhone safe area respected');
  const h = read('index.html');
  const headerAt = h.indexOf('<header class="app-header');
  const appAt = h.indexOf('id="app"');
  assert.ok(headerAt > 0 && headerAt < appAt, 'DOM order: header before app');
  assert.ok(!/\.seo-section/.test(read('assets/css/styles.css')), 'dead article CSS removed from app bundle');
});

test('right control rail: single axis, derived tops, no desktop overlap', () => {
  const css = read('assets/css/styles.css');
  assert.ok(css.includes('--rail-right:12px') && css.includes('--rail-gap:8px'), 'rail variables defined once');
  assert.ok(css.includes('--rail-btn:44px') && css.includes('.map-view{--rail-btn:40px}'), 'rail button size per breakpoint (44 desktop / 40 mobile)');
  for (const sel of ['.map-controls', '.layer-panel', '.map-side']) {
    assert.ok(new RegExp(sel.replace('.', '\\.') + '\\{[^}]*right:var\\(--rail-right\\)').test(css), `${sel} shares the rail axis`);
  }
  assert.ok(!/\.map-controls\{[^}]*top:calc\(84px/.test(css), 'no stale desktop top override that overlapped .map-side');
  assert.ok(css.includes('top:calc(12px + env(safe-area-inset-top) + var(--rail-btn)*3 + var(--rail-gap)*3)'), '.map-side top derived from button size + gap (=168px, unchanged)');
  assert.ok(css.includes('top:calc(12px + env(safe-area-inset-top) + var(--rail-btn) + var(--rail-gap))'), '.layer-panel top derived (=64px, unchanged)');
  assert.ok(css.includes('width:var(--rail-btn)'), 'icon column width matches button size (no stretch, no resize)');
  assert.ok(css.includes('width:var(--rail-wide)'), 'wide column width unchanged (172px)');
  assert.ok(!/#map\s*\{[^}]*width|#map\s*\{[^}]*(left|margin)/.test(css), 'map canvas geometry untouched');
});

test('AdSense untouched: single script, publisher intact', () => {
  const h = read('index.html');
  assert.equal((h.match(/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/g) || []).length, 1, 'exactly one script');
  assert.ok(h.includes('client=ca-pub-1051121820445401'), 'publisher untouched');
  assert.equal(read('ads.txt').trim(), 'google.com, pub-1051121820445401, DIRECT, f08c47fec0942fa0', 'ads.txt intact');
});

test('no horizontal overflow vectors, no GitHub canonical', () => {
  const css = read('assets/css/styles.css') + read('assets/css/content.css');
  assert.ok(css.includes('overflow-x:hidden'), 'horizontal overflow guarded');
  assert.ok(css.includes('minmax(0,1fr)'), 'grids cannot force overflow');
  for (const f of ['index.html', 'sitemap.xml', 'robots.txt', ...DIRS.map((d) => `${d}/index.html`)]) {
    assert.ok(!read(f).includes('movchan-educatio.github.io/nebo-ua'), `${f}: no mirror canonical`);
  }
});

test('content icon system: single outline set, gold token, uniform box', () => {
  const sprite = read('assets/brand/icons.svg');
  const syms = [...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">(.*?)<\/symbol>/gs)];
  assert.ok(syms.length >= 18, 'icon set complete (16 + bomb + bell)');
  for (const [, id, vb, inner] of syms) {
    assert.equal(vb, '0 0 24 24', `${id}: uniform 24x24 bounding box`);
    assert.ok(!/fill=/.test(inner) && !/stroke=/.test(inner), `${id}: no hardcoded paint, inherits CSS`);
  }
  assert.ok(sprite.includes('id="i-bomb"'), 'bomb icon exists (KAB)');
  assert.ok(sprite.includes('id="i-bell"'), 'bell icon exists (notifications)');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(sprite), 'no emoji in icon set');
  const css = read('assets/css/content.css');
  const rule = css.match(/\.card>svg\{([^}]+)\}/)[1];
  assert.ok(rule.includes('width:40px') && rule.includes('height:40px'), 'uniform 40px icon container');
  assert.ok(rule.includes('color:var(--gold)'), 'gold design token, not hardcoded black');
  assert.ok(!/#000|black/.test(rule), 'no black icon paint');
  assert.ok(rule.includes('fill:none') && rule.includes('stroke:currentColor'), 'outline style normalized');
  assert.ok(!/\.card[^{]*svg\.threat/.test(css) && !/svg\.threat/.test(css), 'no threat-size special case left');
  const hover = css.match(/\.card:hover>svg\{([^}]+)\}/)[1];
  assert.ok(!/transform|scale|rotate|animation/.test(hover), 'hover is glow only, no motion');
});

test('content cards use one icon set, map markers untouched', () => {
  const cardUses = [];
  for (const d of ['about', 'how-it-works']) {
    const h = read(`${d}/index.html`);
    assert.ok(!h.includes('threat-icons.svg'), `${d}: no filled combat silhouettes in info cards`);
    assert.ok(!h.includes('svg class="threat"'), `${d}: no threat size hack`);
    cardUses.push(...[...h.matchAll(/<use href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.includes('#i-list')));
  }
  assert.ok(cardUses.length >= 10, 'all card icons collected');
  assert.ok(cardUses.every((u) => u.includes('assets/brand/icons.svg#')), 'single icon library');
  const counts = {};
  for (const u of cardUses) counts[u] = (counts[u] || 0) + 1;
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  assert.ok(dupes.length === 1 && dupes[0][0].endsWith('#i-radar'), 'only radar is legitimately reused across pages (same component)');
  assert.ok(cardUses.some((u) => u.endsWith('#i-bomb')), 'KAB has its own bomb icon, not an airplane');
  assert.ok(cardUses.some((u) => u.endsWith('#i-bell')), 'notifications use bell, not gear');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(cardUses.join()), 'no emoji icons');
  const mapJs = read('assets/js/map.js') + read('assets/js/scope.js') + read('assets/js/app.js');
  assert.ok(mapJs.includes('threat-icons.svg'), 'LIVE map markers still use combat sprite (untouched)');
});

console.log('All architecture/content tests passed!');
