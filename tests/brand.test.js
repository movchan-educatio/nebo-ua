import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const PAGES = ['index.html', 'info/index.html', 'about/index.html', 'how-it-works/index.html',
  'sources/index.html', 'safety/index.html', 'faq/index.html', 'privacy/index.html',
  'terms/index.html', 'contact/index.html', 'nebo/index.html', 'widget/index.html', '404.html'];

// Old brand spellings that must never reach a title, meta tag, visible
// heading or notification title again.
const OLD_BRAND = [/НЕБО\.?UA/gi, /Небо\.UA/g];

test('no page exposes the old НЕБО/Небо brand in SEO metadata or headings', () => {
  const bad = [];
  for (const p of PAGES) {
    const h = read(p);
    for (const re of OLD_BRAND) {
      const m = h.match(re);
      if (m) bad.push(`${p}: ${m.length}x "${m[0]}"`);
    }
  }
  assert.deepEqual(bad, [], 'old brand must be gone: ' + bad.join('; '));
});

test('every indexed page names РАДАР.LIVE in its title', () => {
  for (const p of PAGES) {
    const t = read(p).match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    assert.ok(t.includes('РАДАР.LIVE'), `${p}: title must contain РАДАР.LIVE -> "${t}"`);
  }
});

test('manifest and service-worker push titles use the current brand', () => {
  const man = JSON.parse(read('manifest.webmanifest'));
  assert.equal(man.name, 'РАДАР.LIVE');
  assert.equal(man.short_name, 'РАДАР.LIVE');
  const sw = read('service-worker.js');
  const titles = [...sw.matchAll(/title:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(titles.length > 0, 'SW has at least one push title');
  for (const t of titles) assert.ok(!/Небо|NEBO/i.test(t), `push title still old: "${t}"`);
});

test('sitemap has no legacy or mirror host', () => {
  const sm = read('sitemap.xml');
  assert.ok(!/movchan|github\.io/i.test(sm), 'no mirror host in sitemap');
  for (const u of sm.match(/<loc>([^<]+)<\/loc>/g) || []) {
    assert.ok(u.includes('nebo-ua.vercel.app'), `canonical host only: ${u}`);
  }
});