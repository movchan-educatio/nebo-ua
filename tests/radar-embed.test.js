import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('embed files exist, embed excluded from index', () => {
  for (const f of ['embed/radar/index.html', 'embed/radar/embed.css', 'embed/radar/embed.js']) {
    assert.ok(existsSync(path.join(root, f)), f);
  }
  const h = read('embed/radar/index.html');
  assert.ok(h.includes('name="robots" content="noindex"'), 'embed is noindex');
  const sm = read('sitemap.xml');
  assert.ok(!sm.includes('/embed/radar/'), 'embed not in sitemap');
  const robots = read('robots.txt');
  assert.ok(robots.includes('Disallow: /embed/radar/'), 'robots disallows embed');
});

test('embed has no ads, audio, geolocation, push or SW registration', () => {
  const h = read('embed/radar/index.html');
  const js = read('embed/radar/embed.js');
  assert.ok(!h.includes('adsbygoogle') && !js.includes('adsbygoogle'), 'no ads');
  assert.ok(!h.includes('data-ad-enabled') || h.includes('data-ad-enabled="false"') === false, 'no ad slots at all');
  assert.ok(!js.includes('AudioContext') && !js.includes('webkitAudioContext'), 'no audio in embed');
  assert.ok(!/getCurrentPosition|watchPosition|navigator\.geolocation/.test(js), 'no geolocation API use in embed');
  assert.ok(!js.includes('serviceWorker') && !js.includes('PushManager') && !js.includes('Notification'), 'no push/SW in embed');
  assert.ok(!/TEST_EVENT|demoThreat|fakeEvent|Math\.random\(\)\s*\*\s*(lat|lon)/.test(js), 'no fake data');
});

test('embed reuses the same data services and geo math, compact UI present', () => {
  const js = read('embed/radar/embed.js');
  assert.ok(js.includes("from '../../services/data.js'"), 'real data service');
  assert.ok(js.includes("from '../../radar/geo.js'") && js.includes("from '../../radar/filters.js'"), 'shared geo + filters');
  assert.ok(js.includes("from '../../services/locations.js'"), 'real city search');
  assert.ok(!js.includes('clusterPoints('), 'each target retains its type glyph without clustering');
  assert.ok(js.includes('KIND_LABEL') && js.includes('KIND_COLOR'), 'shared kind presentation');
  const h = read('embed/radar/index.html');
  for (const r of ['25', '50', '100', '200', '300', '500']) assert.ok(h.includes(`data-range="${r}"`), `range ${r}`);
  assert.ok(h.includes('id="emScope"') && h.includes('id="emCity"'), 'canvas + city search');
  assert.ok(h.includes('Повна версія'), 'link to full version');
  assert.ok(h.includes('target="_blank"'), 'full-version link opens aside, no nav trap');
  assert.ok(h.includes('aria-label'), 'labeled controls');
});
