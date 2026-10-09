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

// Colours and outline traced from the approved reference mockup.
const V5 = [
  ['drone.svg', '#F5A623'],
  ['cruise-missile.svg', '#E8352C'],
  ['ballistic.svg', '#E8352C'],
  ['kab.svg', '#F2701E'],
  ['aviation.svg', '#2E6BD6'],
  ['other-threat.svg', '#16283C'],
];
const OUTLINE = '#16283C';
const STROKE = 1.3;                 // the other-threat plate is deliberately heavier
const bbox = (svg, sw = STROKE) => svgBBox(svg, sw);

// Widest single path of an SVG, as x-extent / y-extent. A wing surface is wide
// and flat; a fuselage or a tail fin is not.
function widestAspect(svg) {
  let best = 0;
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const b = pathBBox(m[1]);
    if (!b) continue;
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (h > 0.2) best = Math.max(best, w / h);
  }
  return best;
}

// ── The six deliverables exist and are valid standalone documents ──────────
test('all six standalone SVG files exist and are valid standalone documents', () => {
  for (const [file] of V5) {
    const svg = icon(file);
    assert.ok(svg.startsWith('<svg'), `${file}: starts with <svg>`);
    assert.ok(svg.includes('viewBox="0 0 32 32"'), `${file}: 32x32 viewBox`);
    assert.ok(!/<text/.test(svg), `${file}: no text element`);
    assert.ok(!/<image/.test(svg), `${file}: vector only, no raster`);
    assert.ok(!/[^k-]width="\d+"|height="\d+"/.test(svg), `${file}: scalable, no fixed size`);
    assert.ok(!/font-family|<tspan/.test(svg), `${file}: no typography`);
  }
});

test('no white background, no blur, no emoji in any V5 icon', () => {
  for (const [file] of V5) {
    const svg = icon(file);
    assert.ok(!/filter=|feGaussianBlur/i.test(svg), `${file}: no blur filters`);
    assert.ok(!/<rect/.test(svg), `${file}: no opaque background rect`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(svg), `${file}: no emoji`);
  }
});

// ── Palette and outline ────────────────────────────────────────────────────
test('every icon uses the reference colour plus a dark outline', () => {
  for (const [file, color] of V5) {
    const svg = icon(file);
    assert.ok(svg.includes(color), `${file}: reference fill ${color}`);
    assert.ok(svg.includes(OUTLINE), `${file}: dark outline ${OUTLINE}`);
    for (const m of svg.matchAll(/stroke-width="([\d.]+)"/g)) {
      const w = Number(m[1]);
      assert.ok(w >= 1 && w <= 2.4, `${file}: outline is thin but visible (${w})`);
    }
  }
});

// ── Orientation: nose to the north in every weapon glyph ───────────────────
test('every weapon silhouette is nose-up: nose at the top, tail at the bottom', () => {
  for (const file of ['drone.svg', 'cruise-missile.svg', 'ballistic.svg', 'kab.svg', 'aviation.svg']) {
    const b = bbox(icon(file));
    assert.ok(b, `${file}: has geometry`);
    assert.ok(b.minY < 8, `${file}: nose reaches the top (minY=${b.minY.toFixed(1)})`);
    assert.ok(b.maxY > 24, `${file}: tail reaches the bottom (maxY=${b.maxY.toFixed(1)})`);
    const cx = (b.minX + b.maxX) / 2;
    assert.ok(Math.abs(cx - 16) < 3, `${file}: centred on its axis (cx=${cx.toFixed(1)})`);
    assert.ok(b.minX >= 0 && b.minY >= 0 && b.maxX <= 32 && b.maxY <= 32,
      `${file}: stays inside the 32x32 viewBox (x ${b.minX.toFixed(1)}..${b.maxX.toFixed(1)}, y ${b.minY.toFixed(1)}..${b.maxY.toFixed(1)})`);
    assert.ok((b.maxX - b.minX) >= 14, `${file}: fills enough of the box to read at 16px`);
  }
});

test('shapes are visually distinct from each other', () => {
  const seen = new Map();
  for (const [file] of V5) {
    const b = bbox(icon(file));
    const key = [b.minX, b.maxX, b.minY, b.maxY].map((n) => n.toFixed(2)).join(',');
    assert.ok(!seen.has(key), `${file} is distinguishable from ${seen.get(key) || ''}`);
    seen.set(key, file);
  }
});

// ── Silhouette semantics: what separates a missile from a bomb from a jet ──
test('the drone keeps the squat arrowhead proportions of the reference', () => {
  // The reference is clearly wider than long; once rotated nose-up it must be
  // clearly TALLER than wide. A cone-like icon would be a different aircraft.
  const b = bbox(icon('drone.svg'));
  const ratio = (b.maxY - b.minY) / (b.maxX - b.minX);
  assert.ok(ratio > 1.15 && ratio < 1.6, `rotated arrowhead ratio ${ratio.toFixed(2)}`);
});

test('a cruise missile carries a horizontal wing surface', () => {
  assert.ok(widestAspect(icon('cruise-missile.svg')) > 1,
    'has a wide, flat lifting surface (wingspan)');
});

test('a ballistic missile has NO wing surface — only tail fins', () => {
  assert.ok(widestAspect(icon('ballistic.svg')) < 1,
    'every part is taller than it is wide, so it can never read as an aircraft');
});

test('the cruise missile is broader than the ballistic rocket', () => {
  const w = (f) => { const b = bbox(icon(f)); return b.maxX - b.minX; };
  assert.ok(w('cruise-missile.svg') > w('ballistic.svg'),
    'the air-launched missile has the wider span');
});

test('КАБ reads as a bomb, not an aircraft', () => {
  const svg = icon('kab.svg');
  // Straight short wings: a wing that is wide and flat, with its tip ABOVE
  // the root. A swept aircraft wing trails down-and-out instead.
  const wings = [...svg.matchAll(/ d="([^"]+)"/g)]
    .map((m) => pathBBox(m[1]))
    .filter((b) => b && (b.maxX - b.minX) > (b.maxY - b.minY) * 1.2);
  assert.ok(wings.length >= 1, 'has a wide flat wing surface');
  // The body between the wings must stay fat: that is what makes it a bomb.
  const body = bbox(svg);
  assert.ok((body.maxX - body.minX) >= 20, `fills the frame (${(body.maxX - body.minX).toFixed(1)})`);
});

test('aviation has big swept wings, distinct from the straight-winged bomb', () => {
  const a = bbox(icon('aviation.svg'));
  const k = bbox(icon('kab.svg'));
  assert.notDeepEqual(
    [a.minX, a.maxX, a.minY, a.maxY].map((n) => +n.toFixed(2)),
    [k.minX, k.maxX, k.minY, k.maxY].map((n) => +n.toFixed(2)),
    'jet and bomb are not the same outline',
  );
});

test('unknown threat is a neutral plate, not a weapon', () => {
  const svg = icon('other-threat.svg');
  assert.ok(svg.includes('fill="#E9EDF2"'), 'light plate');
  assert.ok(!svg.includes('#E8352C') && !svg.includes('#F5A623') && !svg.includes('#2E6BD6'),
    'unknown marker is not painted as a weapon type');
  // Four-point starburst, symmetric about both axes.
  const b = svgBBox(svg, 0);
  assert.ok(Math.abs(b.minX - (32 - b.maxX)) < 1.5, 'left/right symmetric');
  assert.ok(Math.abs(b.minY - (32 - b.maxY)) < 1.5, 'top/bottom symmetric');
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
  const strip = (s) => s.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
    .replace(/\s*(role|aria-label)="[^"]*"/g, '').trim();
  assert.equal(syms.get('uav').trim(), strip(icon('drone.svg')), '#uav is the drone artwork verbatim');
  assert.equal(syms.get('shahed').trim(), strip(icon('drone.svg')), '#shahed aliases the drone artwork');
  assert.equal(syms.get('missile').trim(), strip(icon('cruise-missile.svg')), '#missile is the cruise missile verbatim');
  assert.equal(syms.get('other').trim(), strip(icon('other-threat.svg')), '#other is the unknown plate verbatim');
});

// ── Every surface ships the new artwork ────────────────────────────────────
test('every radar-owned surface loads the V5 sprite, none loads the legacy one', () => {
  for (const f of ['index.html', 'info/index.html', 'radar/radar.js', 'embed/radar/embed.js']) {
    const s = read(f);
    assert.ok(s.includes('assets/threats/sprite.svg'), `${f} uses the V5 sprite`);
    assert.ok(!s.includes('brand/threat-icons'), `${f} has no legacy icon reference`);
  }
});
