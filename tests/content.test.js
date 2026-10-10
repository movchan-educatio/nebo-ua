import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CANON = 'https://nebo-ua.vercel.app';
const DIRS = ['about', 'how-it-works', 'sources', 'safety', 'faq', 'privacy', 'terms', 'contact'];

test('home is the RADAR.LIVE app: scope, feed, sources, bottom nav, single H1', () => {
  const h = read('index.html');
  assert.ok(h.includes('id="rlScope"'), 'home has radar canvas');
  assert.ok(h.includes('id="rlFeed"'), 'home has events feed');
  assert.ok(h.includes('id="rlSources"'), 'home has sources panel');
  assert.ok(h.includes('rl-bottomnav'), 'home has mobile bottom navigation');
  assert.ok(!h.includes('seo-section'), 'no article section on home');
  assert.ok(!h.includes('seo-faq'), 'no home FAQ accordion (lives on /info/)');
  assert.ok((h.match(/<h1[\s>]/g) || []).length === 1, 'single H1');
  assert.ok(h.includes('РАДАР.LIVE — моніторинг повітряних загроз України онлайн'), 'accessible H1');
});

test('nebo archive keeps the classic dashboard intact', () => {
  const h = read('nebo/index.html');
  assert.ok(h.includes('id="map"'), 'archive has live map');
  assert.ok(h.includes('id="scopeMini"'), 'archive has compact radar');
  assert.ok(h.includes('id="threatList"'), 'archive has threats view');
  assert.ok(h.includes('bottom-nav'), 'archive has app bottom navigation');
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
    assert.ok(h.includes('class="rl-topbar"'), `${d}: radar top bar`);
    assert.ok(h.includes('class="rl-foot"'), `${d}: shared footer`);
    assert.ok(h.includes('class="rl-nav rl-subnav"'), `${d}: section nav`);
    assert.ok(h.includes('href="../radar/radar.css"'), `${d}: radar stylesheet`);
    assert.ok(h.includes('<body class="rl-page">'), `${d}: document body`);
    assert.ok(h.includes('rl-back'), `${d}: a way back to the radar`);
    // The old theme must not creep back in.
    assert.ok(!h.includes('content.css'), `${d}: no old-theme stylesheet`);
    for (const legacy of ['site-header', 'site-footer', 'menuButton', 'mainnav']) {
      assert.ok(!h.includes(legacy), `${d}: no old ${legacy}`);
    }
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
  assert.ok(h.includes('class="rl-topbar"'), 'radar home has topbar');
  assert.ok(h.includes('class="rl-nav"'), 'radar home has section nav');
  for (const t of ['Радар', 'Події', 'Типи загроз', 'Джерела']) {
    assert.ok(h.includes(t), `radar nav has ${t}`);
  }
  const nebo = read('nebo/index.html');
  assert.ok(nebo.includes('class="mainnav"'), 'archive keeps desktop section nav');
  assert.ok(nebo.includes('id="menuButton"'), 'archive keeps mobile menu button');
  // Sections that live in the nav mark themselves; the legal pages are reached
  // from the footer and deliberately claim no nav position.
  const IN_NAV = ['about', 'how-it-works', 'sources', 'safety', 'faq', 'contact'];
  for (const d of DIRS) {
    const p = read(`${d}/index.html`);
    assert.ok(p.includes('class="rl-nav rl-subnav"'), `${d}: desktop nav`);
    if (IN_NAV.includes(d)) {
      assert.ok(p.includes(`<a class="active" href="../${d}/">`), `${d}: active state`);
    } else {
      assert.ok(!/<a class="active"/.test(p), `${d}: not in the nav, so no active state`);
    }
  }
});

test('FAQ lives on /faq/ with matching schema', () => {
  const h = read('faq/index.html');
  const visQs = [...h.matchAll(/<details><summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.ok(visQs.length >= 9, 'faq questions visible');
  const ld = JSON.parse(h.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]);
  const faq = ld['@graph'].find((x) => x['@type'] === 'FAQPage');
  assert.ok(faq && faq.mainEntity.length === visQs.length, 'FAQPage mirrors visible FAQ');
  assert.ok(faq.mainEntity.every((q, i) => q.name === visQs[i]), 'FAQ questions match');
});

test('internal linking: no orphan pages', () => {
  const h = read('index.html');
  // Radar home links the info hub + classic info sections.
  for (const d of ['info', 'about', 'sources', 'faq']) {
    assert.ok(h.includes(`./${d}/`), `home links ${d}`);
  }
  for (const d of DIRS) {
    const p = read(`${d}/index.html`);
    assert.ok(p.includes('href="../"'), `${d}: links back home`);
  }
  assert.ok(read('info/index.html').includes('href="../"'), 'info: links back home');
  assert.ok(read('nebo/index.html').includes('href="../"'), 'nebo archive: links back home');
  const sm = read('sitemap.xml');
  assert.equal((sm.match(/<loc>/g) || []).length, 11, 'sitemap lists exactly 11 canonical URLs (root + 8 sections + info/ + nebo/)');
  assert.ok(sm.includes(`<loc>${CANON}/info/</loc>`), 'sitemap lists info/');
  assert.ok(sm.includes(`<loc>${CANON}/nebo/</loc>`), 'sitemap lists nebo/ (archive)');
  assert.ok(!sm.includes('/radar/'), 'no stale /radar/ URLs left');
  for (const d of DIRS) {
    assert.ok(sm.includes(`<loc>${CANON}/${d}/</loc>`), `sitemap lists ${d}`);
  }
});

test('layout safe-area: header in document flow, content offset, no overlap architecture', () => {
  // content.css is gone with the old theme; the archive stylesheet remains.
  const css = read('assets/css/styles.css');
  assert.ok(css.includes('--header-h:56px'), 'canonical header variable (desktop 56px)');
  assert.ok(css.includes('--safe-gap:12px'), 'safe gap variable');
  assert.ok(/\.app-header\{position:sticky/.test(css), 'app header occupies document flow');
  // The content pages no longer use styles.css: they wear the radar's top bar.
  const radar = read('radar/radar.css');
  assert.ok(/\.rl-topbar\s*\{[^}]*position:\s*sticky/.test(radar), 'content top bar occupies document flow');
  assert.ok(/scroll-margin-top:\s*calc\(var\(--topbar-h\)/.test(radar), 'anchors stop below the sticky bar');
  assert.ok(!css.includes('scroll-margin-top'), 'no duplicate anchor offset competing with the radar one');
  assert.ok(css.includes('safe-area-inset-bottom'), 'iPhone safe area respected');
  const h = read('nebo/index.html');
  const headerAt = h.indexOf('<header class="topbar"');
  const dashAt = h.indexOf('class="dash-main"');
  assert.ok(headerAt > 0 && headerAt < dashAt, 'DOM order: header before dashboard');
  assert.ok(h.includes('env(safe-area-inset-bottom)') || read('assets/css/dashboard.css').includes('env(safe-area-inset-bottom)'), 'dashboard respects iPhone safe area');
  assert.ok(!/\.seo-section/.test(read('assets/css/styles.css')), 'dead article CSS removed from app bundle');
  const r = read('index.html');
  assert.ok(r.includes('class="rl-topbar"'), 'radar home topbar present');
  assert.ok(read('radar/radar.css').includes('safe-area-inset-bottom'), 'radar respects iPhone safe area');
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
  const h = read('nebo/index.html');
  assert.equal((h.match(/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/g) || []).length, 1, 'exactly one script on nebo archive');
  assert.ok(h.includes('client=ca-pub-1051121820445401'), 'publisher untouched');
  assert.ok(!read('index.html').includes('adsbygoogle'), 'radar home stays ad-free');
  assert.equal(read('ads.txt').trim(), 'google.com, pub-1051121820445401, DIRECT, f08c47fec0942fa0', 'ads.txt intact');
});

test('no horizontal overflow vectors, no GitHub canonical', () => {
  const css = read('assets/css/styles.css') + read('radar/radar.css');
  assert.ok(/overflow-x:\s*(clip|hidden)/.test(css), 'horizontal overflow guarded');
  assert.ok(css.includes('minmax(0,1fr)'), 'grids cannot force overflow');
  // The old theme stylesheet is gone with the pages that used it.
  assert.ok(!fs.existsSync(path.join(root, 'assets/css/content.css')), 'old content stylesheet removed');
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
  const css = read('radar/radar.css');
  const rule = css.match(/\.rl-threat-ico\s*\{([^}]+)\}/)[1];
  assert.ok(/width:\s*34px/.test(rule) && /height:\s*34px/.test(rule), 'uniform icon container');
  assert.ok(!/#000|black/.test(rule), 'no black icon paint');
  assert.ok(/fill:\s*none/.test(css) && /stroke:\s*currentColor/.test(css), 'outline style normalized');
  assert.ok(!/svg\.threat/.test(css), 'no threat-size special case left');
  const hover = css.match(/\.rl-info-card:hover\s*\{([^}]+)\}/)[1];
  assert.ok(/box-shadow/.test(hover), 'hover lifts the card');
  assert.ok(!/transform|scale|rotate|animation/.test(hover), 'and adds no motion');
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

test('no legacy *.html content routes in production navigation', () => {
  const legacy = /["'`](?:\.?\/)?(about|how-it-works|sources|safety|faq|privacy|terms|contact)\.html["'`]/;
  const files = ['index.html', '404.html', 'widget/index.html', 'service-worker.js',
    ...DIRS.map((d) => `${d}/index.html`),
    ...fs.readdirSync(path.join(root, 'assets/js')).filter((f) => f.endsWith('.js')).map((f) => `assets/js/${f}`),
    ...fs.readdirSync(path.join(root, 'services')).filter((f) => f.endsWith('.js')).map((f) => `services/${f}`)];
  assert.ok(files.length > 20, 'production file set collected');
  for (const f of files) {
    const m = read(f).match(legacy);
    assert.ok(!m, `${f}: legacy content route ${m ? m[0] : ''} — use canonical /name/ instead`);
  }
});

console.log('All architecture/content tests passed!');
