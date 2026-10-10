import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSprite } from '../tools/build-threat-icons.mjs';
import { svgBBox, pathBBox } from '../tools/svg-bbox.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const icon = (f) => read(`assets/threats/${f}`);

// The six deliverables. Artwork is TRACED from the approved mockup by
// tools/trace-icons.mjs, so these files are a build artefact, not hand-drawn.
const V5 = ['drone.svg', 'cruise-missile.svg', 'ballistic.svg', 'kab.svg', 'aviation.svg', 'other-threat.svg'];
const WEAPONS = V5.filter((f) => f !== 'other-threat.svg');

const rgb = (h) => { const s = String(h).replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
function hue([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
// Every stop in the file, i.e. the icon's real palette.
const stops = (svg) => [...svg.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => rgb(m[1]));

// ── The six deliverables exist and are valid standalone documents ──────────
test('all six standalone SVG files exist and are valid standalone documents', () => {
  for (const file of V5) {
    const svg = icon(file);
    assert.ok(svg.startsWith('<svg'), `${file}: starts with <svg`);
    assert.ok(svg.includes('viewBox="0 0 32 32"'), `${file}: 32x32 viewBox`);
    assert.ok(!/<text|<tspan|font-family/.test(svg), `${file}: no typography`);
    assert.ok(!/<image/.test(svg), `${file}: vector only, no raster`);
    assert.ok(!/[^k-]width="\d+"|height="\d+"/.test(svg), `${file}: scalable, no fixed size`);
  }
});

test('no white background, no blur, no emoji in any V5 icon', () => {
  for (const file of V5) {
    const svg = icon(file);
    assert.ok(!/filter=|feGaussianBlur/i.test(svg), `${file}: no blur filters`);
    assert.ok(!/<rect/.test(svg), `${file}: no opaque background rect`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), `${file}: no emoji`);
  }
});

test('every icon carries a thin dark outline and stays inside the viewBox', () => {
  for (const file of V5) {
    const svg = icon(file);
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(widths.length, `${file}: has an outline`);
    for (const w of widths) assert.ok(w >= 0.6 && w <= 2.8, `${file}: outline thin but visible (${w})`);
    assert.ok(/stroke="#[0-9A-Fa-f]{6}"/.test(svg), `${file}: dark outline colour`);
    for (const m of svg.matchAll(/stroke="#([0-9A-Fa-f]{6})"/g)) {
      assert.ok(lum(rgb(m[1])) < 90, `${file}: outline is dark (${m[1]})`);
    }
    const b = svgBBox(svg, Math.max(...widths));
    assert.ok(b.minX >= -0.01 && b.minY >= -0.01 && b.maxX <= 32.01 && b.maxY <= 32.01,
      `${file}: stays inside the 32x32 viewBox (x ${b.minX.toFixed(1)}..${b.maxX.toFixed(1)}, y ${b.minY.toFixed(1)}..${b.maxY.toFixed(1)})`);
  }
});

// ── Palette: the traced colours must still be the right FAMILIES ───────────
test('each type keeps the reference colour family', () => {
  const family = { 'drone.svg': [28, 55], 'cruise-missile.svg': [-15, 15], 'ballistic.svg': [-15, 15], 'kab.svg': [10, 40], 'aviation.svg': [195, 245] };
  for (const [file, [lo, hi]] of Object.entries(family)) {
    for (const c of stops(icon(file))) {
      assert.ok(sat(c) > 0.35, `${file}: fill ${c} is strongly coloured`);
      const h = hue(c);
      assert.ok(h >= lo && h <= hi, `${file}: hue ${h.toFixed(0)}deg within ${lo}..${hi}`);
    }
  }
});

test('the unknown-threat plate is a light neutral, not a weapon colour', () => {
  const svg = icon('other-threat.svg');
  const fill = stops(svg);
  assert.ok(fill.length, 'has a plate fill');
  for (const c of fill) {
    assert.ok(sat(c) < 0.12, `plate is neutral grey (sat ${sat(c).toFixed(2)})`);
    assert.ok(lum(c) > 150, `plate is light (lum ${lum(c).toFixed(0)})`);
  }
  const star = rgb((svg.match(/<path d="[^"]+" fill="#([0-9A-Fa-f]{6})"/) || [])[1] || '#000000');
  assert.ok(lum(star) < 90, 'the starburst is dark');
  // It is drawn without an outline: the traced contour self-intersects, and
  // stroking it balloons over the plate it sits on.
  assert.ok(/stroke="none"/.test(svg), 'interior detail is not stroked');
});

// ── Orientation: nose to the north in every weapon glyph ───────────────────
function points(svg) {
  const out = [];
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const b = pathBBox(m[1]);
    if (!b) continue;
    out.push([b.minX, b.minY, b.maxX, b.maxY]);
  }
  return out;
}

test('every weapon silhouette points north: narrow at the top, mass below', () => {
  for (const file of WEAPONS) {
    const svg = icon(file);
    const b = svgBBox(svg, 0);
    const h = b.maxY - b.minY;
    // Width of the artwork in the top fifth versus its widest point. A nose
    // is a point, so the top band must be far narrower than the body.
    let topMax = 0, allMax = 0;
    for (const [x0, y0, x1, y1] of points(svg)) {
      if (y1 <= b.minY + h * 0.2) topMax = Math.max(topMax, x1 - x0);
      allMax = Math.max(allMax, x1 - x0);
    }
    assert.ok(allMax > 0, `${file}: has width`);
    assert.ok(topMax < allMax * 0.55,
      `${file}: nose is at the top, not the side (top band ${topMax.toFixed(1)} vs max ${allMax.toFixed(1)})`);
  }
});

test('shapes are visually distinct from each other', () => {
  const seen = new Map();
  for (const file of V5) {
    const b = svgBBox(icon(file), 0);
    const key = [b.minX, b.maxX, b.minY, b.maxY].map((n) => n.toFixed(1)).join(',');
    assert.ok(!seen.has(key), `${file} is distinguishable from ${seen.get(key) || ''}`);
    seen.set(key, file);
  }
});

test('a wing-bearing type is broader than a fin-only rocket', () => {
  const aspect = (f) => { const b = svgBBox(icon(f), 0); return (b.maxX - b.minX) / (b.maxY - b.minY); };
  const ballistic = aspect('ballistic.svg');
  assert.ok(aspect('cruise-missile.svg') > ballistic, 'the air-launched missile has the broader span');
  assert.ok(aspect('kab.svg') > ballistic, 'the bomb carries a wing span, the rocket does not');
  assert.ok(aspect('aviation.svg') > ballistic, 'the jet carries a wing span, the rocket does not');
});

// ── The sprite is a build artefact, never hand-edited ──────────────────────
test('the sprite is generated from the standalone files (single source of truth)', () => {
  assert.equal(read('assets/threats/sprite.svg'), buildSprite(),
    'run `node tools/build-threat-icons.mjs` after editing any icon');
});

test('sprite exposes the symbol ids every consumer already uses', () => {
  const syms = new Map();
  for (const m of read('assets/threats/sprite.svg')
    .matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"\s*>([\s\S]*?)<\/symbol>/g)) {
    syms.set(m[1], { viewBox: m[2], body: m[3] });
  }
  for (const id of ['shahed', 'uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'aircraft', 'other']) {
    assert.ok(syms.has(id), `sprite has #${id}`);
    assert.equal(syms.get(id).viewBox, '0 0 32 32', `#${id} viewBox`);
  }
});

test('sprite bodies match the standalone artwork exactly', () => {
  const syms = new Map();
  for (const m of read('assets/threats/sprite.svg')
    .matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"\s*>([\s\S]*?)<\/symbol>/g)) {
    syms.set(m[1], m[3]);
  }
  // The generator hoists <defs> to the sprite root so the drone artwork, which
  // backs four symbols, does not declare its gradient four times.
  const strip = (s) => s.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/\s*(role|aria-label)="[^"]*"/g, '')
    .replace(/<defs>[\s\S]*?<\/defs>/, '').trim();
  for (const [id, file] of [['uav', 'drone.svg'], ['shahed', 'drone.svg'], ['missile', 'cruise-missile.svg'],
    ['ballistic', 'ballistic.svg'], ['kab', 'kab.svg'], ['aircraft', 'aviation.svg'], ['other', 'other-threat.svg']]) {
    assert.equal(syms.get(id).trim(), strip(icon(file)), `#${id} is ${file} verbatim`);
  }
});

test('gradient ids are unique across the sprite', () => {
  // The sprite inlines the drone four times (shahed/uav/fpv/recon). Duplicate
  // ids would make <use> resolve against whichever definition came first.
  const ids = [...read('assets/threats/sprite.svg').matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 6, `one gradient per distinct artwork: ${ids.join(', ')}`);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate gradient ids');
});

// ── Every surface ships the new artwork ────────────────────────────────────
test('every radar-owned surface loads the V5 sprite, none loads the legacy one', () => {
  for (const f of ['index.html', 'info/index.html', 'radar/radar.js', 'embed/radar/embed.js']) {
    const s = read(f);
    assert.ok(s.includes('assets/threats/sprite.svg'), `${f} uses the V5 sprite`);
    assert.ok(!s.includes('brand/threat-icons'), `${f} has no legacy icon reference`);
  }
});
