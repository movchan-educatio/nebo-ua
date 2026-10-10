import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// V4 premium: radar must always render as a perfect circle (1:1).
// Guards the oval regression: square box + round clip + square canvas buffer.
function ruleBlock(css, selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `${selector} exists`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

test('radar screen is a square box with round clipping', () => {
  const css = read('radar/radar.css');
  // The square is owned by .rl-compass, whose box the cardinal labels are also
  // measured against; the screen fills it. The guarantee under test is that the
  // disc is a true circle sized by width, so it is checked where that decision
  // now lives.
  const compass = ruleBlock(css, '.rl-compass');
  const screen = ruleBlock(css, '.rl-radar-screen');
  assert.ok(/aspect-ratio\s*:\s*1(\s*\/\s*1)?/.test(compass), 'aspect-ratio 1/1 keeps width == height');
  assert.ok(/width\s*:\s*min\(/.test(compass), 'width uses min() so the square fits viewport + vh');
  // Never constrain height alone: that breaks aspect-ratio into an oval.
  assert.ok(!/max-height\s*:/.test(compass), 'no max-height on the radar box (width-driven square only)');
  assert.ok(/width\s*:\s*100%/.test(screen) && /height\s*:\s*100%/.test(screen), 'the screen fills the square exactly');
  assert.ok(!/max-height\s*:/.test(screen), 'and never constrains its own height');
  assert.ok(/border-radius\s*:\s*50%/.test(screen), '50% radius clips to a disc');
  assert.ok(/overflow\s*:\s*hidden/.test(screen), 'overflow hidden keeps the disc clean');
  const canvas = ruleBlock(css, '.rl-radar-screen canvas');
  assert.ok(/width\s*:\s*100%/.test(canvas) && /height\s*:\s*100%/.test(canvas), 'canvas fills the square 1:1');
});

test('compass labels are measured from the disc, not from the card', () => {
  // Pinned to the card they drifted to the edges of the viewport while the disc
  // stayed capped at 640px: 67px adrift at 1440, 261px at 1920. A direction
  // label that far from what it names stops being a reading of the instrument.
  const css = read('radar/radar.css');
  const html = read('index.html');
  assert.ok(/\.rl-compass\s*\{[^}]*position:\s*relative/.test(css), 'the compass box is the positioning context');
  for (const dir of ['n', 's', 'w', 'e']) {
    const r = ruleBlock(css, '.rl-cw-' + dir);
    // Every label is offset by the disc's own size, so all four keep one gap.
    assert.ok(/100%\s*\+\s*var\(--rl-cw-gap\)/.test(r), `${dir} is placed relative to the disc edge`);
  }
  // The labels must live inside that box, alongside the disc — not as siblings
  // of it, which is what put them a screen-width away.
  const wrap = html.slice(html.indexOf('class="rl-radar-wrap"'), html.indexOf('class="rl-radar-wrap"') + 600);
  assert.ok(/class="rl-compass"/.test(wrap), 'the compass box exists in the markup');
  const compassInner = wrap.slice(wrap.indexOf('class="rl-compass"'));
  assert.ok(compassInner.indexOf('rl-cw-w') > 0, 'the labels are inside the compass box');
  assert.ok(compassInner.indexOf('rl-radar-screen') > 0, 'as is the disc they name');
});

test('embed radar keeps the same circle guarantee', () => {
  const css = read('embed/radar/embed.css');
  assert.ok(/aspect-ratio\s*:\s*1/.test(css), 'embed keeps aspect-ratio 1');
  assert.ok(/border-radius\s*:\s*50%/.test(css), 'embed stays round');
});

test('canvas buffer is square with identical X/Y scale + DPR', () => {
  for (const f of ['radar/radar.js', 'embed/radar/embed.js']) {
    const js = read(f);
    assert.ok(js.includes('Math.min(r.width'), `${f}: square side from Math.min(w,h)`);
    assert.ok(js.includes('devicePixelRatio'), `${f}: DPR handled`);
    // Buffer assigns the same side to width and height (no axis stretch).
    assert.ok(/canvas\.width\s*=\s*\w+\s*\*\s*dpr;\s*\n?\s*canvas\.height\s*=\s*\w+\s*\*\s*dpr/.test(js)
      || /canvas\.width\s*=\s*css\s*\*\s*dpr/.test(js), `${f}: square backing store`);
  }
});

test('design tokens match the premium palette', () => {
  const css = read('radar/radar.css');
  for (const [name, hex] of [
    ['--bg', '#F4F6F9'], ['--surface', '#FFFFFF'], ['--text', '#14263D'],
    ['--muted', '#64748B'], ['--line', '#E2E8F0'], ['--red', '#EF3F36'],
    ['--red-hover', '#DC3029'], ['--drone', '#EBAA19'], ['--ballistic', '#D92D2D'],
    ['--kab', '#F08B2F'], ['--aviation', '#477FE0'], ['--success', '#16A36A'],
  ]) {
    assert.ok(css.includes(`${name}: ${hex}`) || css.includes(`${name}:${hex}`), `token ${name} = ${hex}`);
  }
  assert.ok(css.includes('prefers-reduced-motion'), 'reduced motion respected');
  assert.ok(css.includes('safe-area-inset-bottom'), 'iPhone safe area respected');
});

test('markers have premium sizes and no dark discs', () => {
  const js = read('radar/radar.js');
  // Desktop 20–24px, mobile 18–21px device-independent.
  assert.ok(js.includes('cssW < 420 ? 20 : 23'), 'marker sizes 20 mobile / 23 desktop');
  assert.ok(!/shadowBlur/.test(js), 'no aggressive glow on canvas');
  const svg = read('assets/brand/threat-icons.svg');
  assert.ok(!svg.includes('#050a0f'), 'no large black outlines around glyphs');
});
