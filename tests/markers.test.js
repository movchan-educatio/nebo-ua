import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { META, smallGroupHTML, clusterBadgeHTML } from '../assets/js/map.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapSrc = fs.readFileSync(path.join(root, 'assets/js/map.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/css/styles.css'), 'utf8');

// ── Palette: every combat kind visually distinct ─────────────────────────────
test('palette: shahed/uav/kab/missile/ballistic/recon all differ', () => {
  const colors = ['shahed', 'uav', 'recon', 'missile', 'ballistic', 'kab', 'aviation'].map(k => META[k].color);
  assert.equal(new Set(colors).size, colors.length, 'each kind must have its own color: ' + colors.join(', '));
  assert.equal(META.shahed.color.toLowerCase(), '#ffaa32');
  assert.equal(META.ballistic.color.toLowerCase(), '#ff2a55');
});

// ── Small groups: footprint, spacing, honesty, no card ───────────────────────
function centers(html) {
  return [...html.matchAll(/left:(\d+)px;top:(\d+)px/g)].map(m => [Number(m[1]), Number(m[2])]);
}

test('smallGroup: 2/3/4 footprints stay compact (<=70px), gaps >= 4px', () => {
  const minis = 26;
  for (const n of [2, 3, 4]) {
    const items = Array.from({ length: n }, () => ({ kind: 'uav' }));
    const g = smallGroupHTML(items);
    assert.ok(g.w <= 70 && g.h <= 70, `group of ${n}: footprint ${g.w}x${g.h} must fit ~70px`);
    const pts = centers(g.html);
    assert.equal(pts.length, n);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        assert.ok(d - minis >= 4, `group of ${n}: icons must not overlap (gap ${(d - minis).toFixed(1)}px)`);
      }
    }
  }
});

test('smallGroup: 3 uses triangle arrangement', () => {
  const g = smallGroupHTML([{ kind: 'uav' }, { kind: 'uav' }, { kind: 'uav' }]);
  const [top, left, right] = centers(g.html);
  assert.ok(top[1] < left[1] && top[1] < right[1], 'one icon on top');
  assert.ok(Math.abs(left[1] - right[1]) <= 2, 'two icons share the bottom row');
  assert.ok(left[0] < top[0] && top[0] < right[0], 'top icon centered horizontally');
});

test('smallGroup: mixed kinds keep their own icons and colors (no dominant rewrite)', () => {
  const g = smallGroupHTML([{ kind: 'kab' }, { kind: 'uav' }, { kind: 'uav' }]);
  assert.ok(g.html.includes('#kab') && g.html.includes('#uav'), 'each silhouette keeps its own kind');
  assert.ok(g.html.includes(META.kab.color) && g.html.includes(META.uav.color), 'each keeps its own color');
});

test('smallGroup: no card, no count text, transparent', () => {
  const g = smallGroupHTML([{ kind: 'uav' }, { kind: 'uav' }, { kind: 'uav' }]);
  assert.ok(!g.html.includes('background'), 'no background card');
  assert.ok(!g.html.includes('cluster-summary'), 'no cluster summary line');
  assert.ok(!/<b>\d+<\/b>/.test(g.html), 'no count number for 2-4 targets');
  assert.ok(g.html.includes('threat-group'), 'transparent group container');
});

test('badge 5+: compact ≤70px badge, mini silhouettes + ×N, composition in title', () => {
  const html = clusterBadgeHTML(8, 'uav', '7 БПЛА · 1 КАБ', '8 повідомлень: 7 БПЛА, 1 КАБ', ['uav', 'kab']);
  assert.ok(html.includes('<b>×8</b>'), 'compact ×N count');
  assert.ok(html.includes('is-badge'), 'badge styling hook');
  assert.ok(!html.includes('<small'), 'no big composition text on the map');
  assert.ok(html.includes('title="8 повідомлень: 7 БПЛА, 1 КАБ"'), 'composition available on tap/hover');
  assert.ok(html.includes('#uav') && html.includes('#kab'), 'mixed group shows its own silhouettes');
  assert.equal((html.match(/<svg class="tg-mini"/g) || []).length, 3, 'three mini silhouettes + ×N');
});

// ── Threat pane / z-index ────────────────────────────────────────────────────
test('marker sprite refs are absolute (no bare #fragment that breaks outside index.html)', () => {
  assert.ok(!mapSrc.includes('<use href="#'), 'bare fragment refs render blank wherever no inline sprite exists');
  assert.ok(mapSrc.includes('THREAT_SVG'), 'sprite URL derives from import.meta.url (base-independent)');
});

test('threatPane: dedicated pane above fills, below popups; markers + clusters use it', () => {
  assert.ok(mapSrc.includes("createPane('threatPane')"), 'threatPane is created');
  assert.ok(mapSrc.includes('zIndex') && mapSrc.includes('625'), 'threatPane z-index 625 (fills ~400 < 625 < popups 700)');
  const markerPanes = (mapSrc.match(/pane:'threatPane'/g) || []).length;
  assert.ok(markerPanes >= 2, 'single threat markers render into threatPane');
  assert.ok(mapSrc.includes("clusterPane:'threatPane'"), 'clusters render into threatPane');
});

// ── Zoom bands + hover + touch ───────────────────────────────────────────────
// ── Map UI contract: every mapUI.* call in app.js must exist ─────────────────
test('mapUI contract: called methods exist on the situation map', () => {
  const appSrc = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
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

console.log('All marker tests passed!');
