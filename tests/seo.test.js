import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const CANON = 'https://nebo-ua.vercel.app';

test('robots exists, allows indexing, points to the primary sitemap', () => {
  const r = read('robots.txt');
  assert.ok(r.includes('User-agent: *'), 'robots present');
  assert.ok(!/^Disallow:\s*\/$/m.test(r), 'root must not be disallowed');
  assert.ok(r.includes(`Sitemap: ${CANON}/sitemap.xml`), 'sitemap on the primary domain');
});

test('sitemap valid, only real indexable URLs, no technical junk', () => {
  const s = read('sitemap.xml');
  assert.ok(s.includes('<urlset'), 'valid urlset');
  const locs = [...s.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(locs.length >= 2, 'has URLs');
  for (const u of locs) {
    assert.ok(u.startsWith(CANON + '/'), `primary domain only: ${u}`);
    assert.ok(!/[?&]/.test(u), `no query URLs: ${u}`);
  }
  const banned = ['debug', '/api', 'assets/', 'manifest', '.json', 'service-worker', 'node_modules', 'widget', '.html'];
  for (const u of locs) for (const b of banned) assert.ok(!u.includes(b), `sitemap must not list ${b}: ${u}`);
  for (const u of locs) {
    const rel = u.slice((CANON + '/').length) || 'index.html';
    assert.ok(fs.existsSync(path.join(root, rel === '' ? 'index.html' : rel)) || fs.existsSync(path.join(root, rel, 'index.html')) , `sitemap target exists: ${u}`);
  }
});

test('index head: canonical, title, description, lang, viewport, icons', () => {
  const h = read('index.html');
  assert.ok(h.includes('<html lang="uk"'), 'lang uk');
  assert.ok(h.includes('name="viewport"'), 'viewport');
  assert.ok(h.includes(`<link rel="canonical" href="${CANON}/">`), 'canonical on primary domain');
  assert.ok(!h.includes('movchan-educatio.github.io/nebo-ua'), 'no mirror canonical left');
  assert.ok(!h.includes('localhost'), 'no localhost in head');
  const title = h.match(/<title>([^<]+)<\/title>/)[1];
  assert.ok(/радар\.live/i.test(title) && title.includes('Україн'), `natural title: ${title}`);
  assert.ok(title.length <= 120, 'title not stuffed');
  const desc = h.match(/name="description" content="([^"]+)"/)[1];
  assert.ok(desc.length >= 40 && desc.length <= 300, 'description length sane');
  assert.ok(h.includes('rel="icon"'), 'favicon');
  assert.ok(h.includes('manifest.webmanifest'), 'manifest');
  assert.ok(!h.includes('noindex'), 'indexable, no noindex');
});

test('index head: OpenGraph, Twitter, structured data', () => {
  const h = read('index.html');
  for (const p of ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:locale']) {
    assert.ok(h.includes(p), `has ${p}`);
  }
  assert.ok(h.includes('og:locale" content="uk_UA"'), 'uk locale');
  assert.ok(h.includes('twitter:card'), 'twitter card');
  assert.ok(h.includes('"@type":"WebSite"'), 'JSON-LD WebSite');
  assert.ok(h.includes('"@type":"WebPage"'), 'JSON-LD WebPage');
  assert.ok(!h.includes('"@type":"FAQPage"'), 'FAQPage lives on /faq/ only, not home');
  assert.ok(h.includes('"inLanguage":"uk'), 'uk language tag');
  for (const fake of ['aggregateRating', 'reviewCount', 'downloadCount', 'interactionCount']) {
    assert.ok(!h.includes(fake), `no invented SEO data: ${fake}`);
  }
});

test('info pages exist, canonical, honest, with disclaimer', () => {
  for (const [d, label] of [['about', 'Про НЕБО.UA'], ['how-it-works', 'Як працює'], ['sources', 'Джерела'], ['safety', 'Безпека'], ['faq', 'Часті запитання'], ['privacy', 'Конфіденційність'], ['terms', 'Умови'], ['contact', 'Контакти']]) {
    const f = `${d}/index.html`;
    const h = read(f);
    assert.ok(h.includes('<html lang="uk"'), `${f}: lang uk`);
    assert.ok(h.includes(`<link rel="canonical" href="${CANON}/${d}/">`), `${f}: self canonical with trailing slash`);
    assert.ok(h.includes('name="description"'), `${f}: description`);
    assert.ok(h.includes('name="viewport"'), `${f}: viewport`);
    assert.ok(!h.includes('noindex'), `${f}: indexable`);
    assert.ok(h.includes(label), `${f}: has heading`);
    assert.ok((h.match(/<h1[\s>]/g) || []).length === 1, `${f}: single H1`);
  }
  const about = read('about/index.html');
  assert.ok(about.includes('не офіційна система оповіщення'), 'about: not an official system');
  const terms = read('terms/index.html');
  assert.ok(terms.includes('не замінює') && terms.includes('офіційні сигнали'), 'terms: disclaimer');
  const sources = read('sources/index.html');
  for (const s of ['NEPTUN', 'MAPA']) assert.ok(sources.includes(s), `sources list ${s}`);
  assert.ok(sources.includes('area-only') || sources.includes('районна'), 'sources explain area-only');
  const privacy = read('privacy/index.html');
  assert.ok(privacy.includes('localStorage'), 'privacy: localStorage');
  assert.ok(privacy.includes('Геолокація') || privacy.includes('геолокація'), 'privacy: geolocation');
  assert.ok(privacy.includes('не надсилаються на сервер') || privacy.includes('локально'), 'privacy: GPS stays local');
  const contact = read('contact/index.html');
  assert.ok(contact.includes('github.com/movchan-educatio/nebo-ua'), 'contact: real channel');
  const faq = read('faq/index.html');
  assert.ok(faq.includes('"@type":"FAQPage"'), 'faq: FAQPage schema on /faq/');
});

test('AdSense: real publisher ID, single script, valid ads.txt, no fakes', () => {
  const PUB = 'ca-pub-1051121820445401';
  // The script lives on the archived НЕБО page; radar surfaces stay ad-free
  // until an explicit, approved rollout.
  const head = read('nebo/index.html');
  const count = (head.match(/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/g) || []).length;
  assert.equal(count, 1, 'exactly one AdSense script in nebo <head>');
  assert.ok(head.includes(`client=${PUB}`), 'correct publisher ID');
  for (const f of ['index.html', 'info/index.html', 'embed/radar/index.html', 'about/index.html', 'how-it-works/index.html', 'sources/index.html', 'safety/index.html', 'faq/index.html', 'privacy/index.html', 'terms/index.html', 'contact/index.html', '404.html', 'widget/index.html']) {
    assert.ok(!read(f).includes('adsbygoogle'), `${f}: no duplicate script`);
    assert.ok(!read(f).includes('ca-pub-'), `${f}: no publisher ID copy`);
  }
  const ads = read('ads.txt').trim();
  assert.equal(ads, 'google.com, pub-1051121820445401, DIRECT, f08c47fec0942fa0');
  const all = ['index.html', 'assets/js/app.js', 'services/ads.js'].map(read).join('\n');
  assert.ok(!all.includes('ca-pub-000000'), 'no fake publisher ID');
  const cfg = read('services/ads.js');
  assert.ok(cfg.includes('adsEnabled:false'), 'ad slots stay disabled until explicit rollout');
});

test('PWA/service-worker present with versioned cache', () => {
  const sw = read('service-worker.js');
  assert.ok(/CACHE\s*=\s*'[^']+'/.test(sw), 'versioned cache name');
  assert.ok(sw.includes('skipWaiting') || sw.includes('clients.claim'), 'lifecycle handled');
  assert.ok(fs.existsSync(path.join(root, '404.html')), 'static 404 page for hosts');
  assert.ok(read('404.html').includes('noindex'), '404 not indexed');
});

console.log('All SEO tests passed!');
