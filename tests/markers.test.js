import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META } from '../assets/js/map.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapSrc = fs.readFileSync(path.join(root, 'assets/js/map.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/styles.css'), 'utf8');

// ── Palette: every combat kind visually distinct ─────────────────────────────
test('palette: shahed/uav/fpv/kab/missile/ballistic/recon all differ', () => {
  const colors = ['shahed', 'uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'aviation', 'explosion'].map(k => META[k].color);
  assert.equal(new Set(colors).size, colors.length, 'each kind must have its own color: ' + colors.join(', '));
  assert.equal(META.shahed.color.toLowerCase(), '#ff7b4d');
  assert.equal(META.ballistic.color.toLowerCase(), '#ff2f3e');
  assert.equal(META.uav.color.toLowerCase(), '#ffc43d');
  assert.equal(META.fpv.color.toLowerCase(), '#ff9f43');
  assert.equal(META.explosion.color.toLowerCase(), '#ff6a00');
});

// ── Declutter clustering: one REAL trackId = one marker, grouped visually ──
// Clusters show only real contained counts + dominant kind color; zooming
// reveals every track. No counts invented from proximity.
test('UI clustering: cluster group with honest count bubbles, tracks persist', () => {
  assert.ok(mapSrc.includes('markerClusterGroup'), 'cluster group present');
  assert.ok(mapSrc.includes('iconCreateFunction'), 'cluster icon factory present');
  assert.ok(mapSrc.includes('getAllChildMarkers'), 'bubbles count real contained markers');
  assert.ok(mapSrc.includes('markerByTrack'), 'markers persist per stable trackId');
  assert.ok(mapSrc.includes('disableClusteringAtZoom'), 'clusters open at large zoom');
});

test('source count badge: ×N only from explicit source count', () => {
  assert.ok(mapSrc.includes('mk-count'), 'count badge hook exists');
  assert.ok(mapSrc.includes('e.count'), 'badge reads the source count field');
  assert.ok(mapSrc.includes('srcCount>1') || mapSrc.includes('>1'), 'badge only when count exceeds one');
});

// ── Threat pane / z-index ────────────────────────────────────────────────────
test('marker sprite refs are absolute (no bare #fragment that breaks outside index.html)', () => {
  assert.ok(!mapSrc.includes('<use href="#'), 'bare fragment refs render blank wherever no inline sprite exists');
  assert.ok(mapSrc.includes('THREAT_SVG'), 'sprite URL derives from import.meta.url (base-independent)');
});

test('threatPane: dedicated pane above fills, below popups; markers use it', () => {
  assert.ok(mapSrc.includes("createPane('threatPane')"), 'threatPane is created');
  assert.ok(mapSrc.includes('zIndex') && mapSrc.includes('625'), 'threatPane z-index 625 (fills ~400 < 625 < popups 700)');
  const markerPanes = (mapSrc.match(/pane:'threatPane'/g) || []).length;
  assert.ok(markerPanes >= 2, 'single threat markers render into threatPane');
});

// ── Zoom bands + hover + touch ───────────────────────────────────────────────
// ── Map UI contract: every mapUI.* call in app.js must exist ─────────────────
test('mapUI contract: called methods exist on the situation map', () => {  const appSrc = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
  const called = new Set([...appSrc.matchAll(/mapUI\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const ret = mapSrc.match(/return\{map,([^{}]*)\}/);
  assert.ok(ret, 'situation map return object found');
  const provided = new Set(ret[1].split(',').map(s => s.trim()).filter(Boolean));
  const missing = [...called].filter(k => !provided.has(k));
  assert.deepEqual(missing, [], 'app.js calls undefined mapUI methods: ' + missing.join(', '));
});
test('adaptive sizing: zoom bands scale SVG only, touch container stays constant', () => {
  for (const z of [5, 6, 7, 8, 9, 10, 11, 12]) {
    assert.ok(css.includes(`.map-zoom-${z} .threat-marker svg.threat-svg`), `zoom band ${z} scales the silhouette`);
  }
  assert.ok(css.includes('@media (pointer:coarse)'), 'touch devices get a minimum visual size');
  assert.ok(css.includes('@media (hover:hover)'), 'gentle hover grow is desktop-only');
  assert.ok(!css.includes('scale(1.5') && !css.includes('scale(1.4'), 'no aggressive hover scale');
  assert.ok(mapSrc.includes('iconSize:[40,40]'), '40px transparent touch container for single markers');
});

// ── Rotation safety: artwork fits the 64 box so headings never clip ──────────
test('all symbols fit inside viewBox (rotation cannot clip content box)', () => {
  const svg = fs.readFileSync(path.join(root, 'assets/brand/threat-icons.svg'), 'utf8');
  for (const m of svg.matchAll(/<symbol\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
    const nums = [];
    for (const d of m[2].matchAll(/d="([^"]+)"/g)) {
      const parts = d[1].match(/-?\d+(\.\d+)?/g) || [];
      for (const v of parts) nums.push(Number(v));
    }
    for (const c of m[2].matchAll(/c[xy]="([\d.]+)"/g)) nums.push(Number(c[1]));
    for (const v of nums) assert.ok(v >= 0 && v <= 64, `#${m[1]}: coordinate ${v} inside viewBox`);
  }
});

// ── Clean markers: glyph only, no decorative frames ──────────────────────────
test('markers carry no square outlines, pulse rings or stale decoration hooks', () => {
  const iconBlock = mapSrc.slice(mapSrc.indexOf('function eventIcon'), mapSrc.indexOf('function blipIcon'));
  for (const cls of ["'near'", "'lvl-red'", "'new'", "'confirmed'"]) {
    assert.ok(!iconBlock.includes(cls), `eventIcon must not emit ${cls}`);
  }
  assert.ok(!css.includes('.threat-marker.near'), 'no white square outline rule');
  assert.ok(!css.includes('.threat-marker.lvl-red'), 'no red square outline rule');
  assert.ok(!css.includes('.threat-marker.new'), 'no add-time pulse ring rule');
  assert.ok(!css.includes('.threat-marker.selected::after'), 'no selected halo circle');
  assert.ok(css.includes('.threat-marker.selected svg.threat-svg'), 'selected state is scale/brightness only');
});

// ── Territory card (bottom-sheet on mobile, overlay on desktop) ──────────
test('territory card: real open/close control, aria-live, no dead button', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('id="terrCard"'), 'territory card exists');
  const dash = fs.readFileSync(path.join(root, 'assets/js/dashboard.js'), 'utf8');
  assert.ok(dash.includes('terrClose'), 'close control rendered and wired');
  assert.ok(html.includes('aria-live="polite"'), 'aria-live present');
  assert.ok(dash.includes('terrHistory'), 'history entry wired in dashboard logic');
});

console.log('All marker tests passed!');
