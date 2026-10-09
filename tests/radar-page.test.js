import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('radar files exist', () => {
  for (const f of ['index.html', 'radar/radar.css', 'radar/radar.js', 'radar/geo.js', 'radar/filters.js', 'info/index.html', 'nebo/index.html', 'embed/radar/index.html']) {
    assert.ok(existsSync(path.join(root, f)), f);
  }
});

test('radar SEO: title, description, h1, canonical, OG, JSON-LD', () => {
  const h = read('index.html');
  const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  assert.ok(title.includes('РАДАР.LIVE'), 'title brand');
  assert.ok(title.length <= 70, `title len ${title.length}`);
  const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  assert.ok(desc.length >= 50 && desc.length <= 200, `description len ${desc.length}`);
  assert.equal((h.match(/<h1[^>]*>/g) || []).length, 1, 'exactly one h1');
  assert.ok(h.includes('rel="canonical" href="https://nebo-ua.vercel.app/"'), 'root canonical');
  assert.ok(h.includes('og:title') && h.includes('og:image'), 'opengraph');
  assert.ok(h.includes('"@type":"WebSite"') && h.includes('"@type":"WebPage"'), 'json-ld');
  assert.ok(h.includes('rel="icon"') && h.includes('rel="manifest"'), 'favicon+manifest');
  assert.ok(!h.includes('noindex'), 'indexable (no noindex)');
});

test('radar ads: no auto ads, slots disabled and off the radar', () => {
  const h = read('index.html');
  assert.ok(!h.includes('adsbygoogle'), 'no adsense script');
  assert.ok(!h.includes('pagead2.'), 'no pagead');
  const slots = [...h.matchAll(/<div class="rl-ad-slot"([^>]*)>/g)].map(m => m[1]);
  assert.ok(slots.length >= 1, 'ad zones exist');
  for (const s of slots) assert.ok(s.includes('data-ad-enabled="false"'), 'each slot disabled');
  const radarSection = h.slice(h.indexOf('id="radarCard"'), h.indexOf('id="feedCard"'));
  assert.ok(!radarSection.includes('rl-ad-slot'), 'no ad slot inside radar card');
});

test('radar markup: ranges, tabs, filters, bottom nav, settings, a11y', () => {
  const h = read('index.html');
  for (const r of ['25', '50', '100', '200', '300', '500']) assert.ok(h.includes(`data-range="${r}"`), `range ${r}`);
  for (const t of ['all', 'new', 'active', 'completed']) assert.ok(h.includes(`data-tab="${t}"`), `tab ${t}`);
  assert.ok(h.includes('id="rlScope"'), 'canvas');
  assert.ok(h.includes('aria-label="Радар повітряних загроз"'), 'canvas label');
  assert.ok(h.includes('id="detailCard"'), 'detail panel');
  assert.ok(h.includes('id="rlSettings"'), 'settings dialog');
  const nav = h.match(/<nav class="rl-bottomnav"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/<button/g) || []).length, 4, 'four bottom nav buttons');
  assert.ok(read('radar/radar.css').includes('prefers-reduced-motion'), 'reduced motion handled');
  assert.ok(h.includes('Тільки нові') && h.includes('Тільки активні') && h.includes('Тільки з координатами'), 'extra filters');
  assert.ok(h.includes('Показувати контури'), 'contours toggle');
});

test('radar info: honest copy, no tracking promises, links to info pages', () => {
  const h = read('index.html');
  assert.ok(h.includes('без вигаданих координат'), 'honesty note');
  assert.ok(h.includes('./about/') && h.includes('./sources/') && h.includes('./faq/'), 'info links');
  assert.ok(!/точне відстеження|гарантуємо перехоплення/i.test(h), 'no false promises');
});

test('radar.js uses real data services, no fake events', () => {
  const js = read('radar/radar.js');
  assert.ok(js.includes("from '../services/data.js'"), 'uses data service');
  assert.ok(js.includes('fetchAll'), 'fetches snapshot');
  assert.ok(js.includes("from '../services/locations.js'"), 'real city search');
  assert.ok(!/Math\.random\(\)\s*\*\s*(lat|lon|360)/.test(js), 'no random coordinates');
  assert.ok(!/TEST_EVENT|demoThreat|fakeEvent/i.test(js), 'no demo threats');
  assert.ok(js.includes('sweep') && js.includes('decorative'), 'sweep marked decorative');
});

test('radar info page: light design system, real content, SEO, no ads', () => {
  assert.ok(existsSync(path.join(root, 'info/index.html')), 'info page exists');
  const h = read('info/index.html');
  const title = (h.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  assert.ok(title.includes('РАДАР.LIVE'), 'info title brand');
  const desc = (h.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
  assert.ok(desc.length >= 50 && desc.length <= 200, `info description len ${desc.length}`);
  assert.equal((h.match(/<h1[^>]*>/g) || []).length, 1, 'exactly one h1');
  assert.ok(h.includes('rel="canonical" href="https://nebo-ua.vercel.app/info/"'), 'canonical');
  assert.ok(h.includes('FAQPage'), 'faq structured data');
  assert.ok(h.includes('stylesheet" href="../radar/radar.css"'), 'same design tokens');
  assert.ok(!h.includes('adsbygoogle') && !h.includes('pagead2.'), 'no ads running');
  assert.ok(h.includes('data-ad-enabled="false"'), 'ad slot disabled');
  assert.ok(h.includes('../privacy/') && h.includes('../terms/') && h.includes('../contact/'), 'legal links reused, not duplicated');
  assert.ok(h.includes('NEPTUN') && h.includes('MAPA') && h.includes('UkraineAlarm'), 'sources documented');
  assert.ok(!/точне відстеження|гарантуємо/i.test(h), 'no false promises');
});

test('radar markers reuse the shared threat sprite (no emoji markers)', () => {
  const js = read('radar/radar.js');
  assert.ok(js.includes('threat-icons.svg'), 'shared sprite');
  const html = read('index.html');
  const legend = html.slice(html.indexOf('rl-radar-legend'), html.indexOf('rl-radar-legend') + 800);
  assert.ok(!/[\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/u.test(legend), 'no emoji in legend');
});
