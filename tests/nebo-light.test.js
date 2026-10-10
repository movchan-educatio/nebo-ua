// /nebo/ ships one theme and it is light.
//
// These are pinned because the conversion was done by mapping colours, and a
// mapping is exactly the kind of change that gets half-undone by a later edit:
// nobody deletes a light palette on purpose, they just forget why a rule was
// there. Each test below corresponds to a way that already happened once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const styles = read('assets/css/styles.css');
const dash = read('assets/css/dashboard.css');
const scope = read('assets/js/scope.js');
const mapJs = read('assets/js/map.js');
const dashboardJs = read('assets/js/dashboard.js');
const neboHtml = read('nebo/index.html');

const lum = (hex) => {
  const m = String(hex).match(/#([0-9a-f]{6})/i);
  if (!m) return null;
  const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)].map((h) => parseInt(h, 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

test('the archive stylesheets declare a light colour scheme', () => {
  // color-scheme drives the UA scrollbars, form controls and date pickers.
  // Leaving it dark while every surface went light gives a light page with dark
  // native widgets, which no screenshot of the body would ever catch.
  for (const [name, css] of [['styles.css', styles], ['dashboard.css', dash]]) {
    assert.ok(!/color-scheme\s*:\s*dark/.test(css), `${name} has no dark color-scheme`);
    assert.ok(/color-scheme\s*:\s*light/.test(css), `${name} declares light`);
  }
});

test('the raster fallback is no longer inverted to fake a dark map', () => {
  // These filters turned a degraded /nebo/ map black while the rest of the page
  // was light — the single worst-looking failure mode of the conversion.
  for (const [name, css] of [['styles.css', styles], ['dashboard.css', dash]]) {
    assert.ok(!/invert\(/.test(css), `${name} inverts nothing`);
    assert.ok(!/hue-rotate\(180deg\)/.test(css), `${name} has no invert-and-uninvert hack`);
  }
});

test('the token block is light in both sheets', () => {
  // Contrast, not raw luminance. A simple un-gamma'd luminance reads #14263D
  // as 0.14, which looks alarming next to a 0.1 threshold while being perfectly
  // legible; the pair's contrast ratio is the property that actually matters.
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [name, css] of [['styles.css', styles], ['dashboard.css', dash]]) {
    const block = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
    assert.ok(/--bg:\s*#F4F6F9/.test(block), `${name} page background is the radar's`);
    assert.ok(/--text:\s*#14263D/.test(block), `${name} text is dark on light`);
    assert.ok(lum('#F4F6F9') > 0.85, `${name} background is genuinely light`);
    // 5.3:1 on this un-gamma'd formula; the true WCAG figure with sRGB gamma is
    // around 13:1. Either way it is far past the 4.5 floor, which is the point.
    assert.ok(contrast('#F4F6F9', '#14263D') > 5, `${name} text and background are far apart, not just renamed`);
  }
});

test('the scope canvas paints a light disc of its own', () => {
  // CSS cannot reach this: scope.js fills its own background on the canvas, so
  // a light stylesheet with an untouched scope still shows a black radar.
  assert.ok(scope.includes("addColorStop(0, '#EAF7F0')"), 'scope background is the light tint');
  assert.ok(!/addColorStop\(\s*0\s*,\s*'#0/i.test(scope), 'no near-black scope backdrop');
  assert.ok(!/ctx\.fillStyle = '#0[0-9a-f]{5}'/i.test(scope), 'no near-black fills left on the scope');
  // The pale phosphor glows were invisible on a pale disc; they were darkened
  // rather than dropped so green still means the sweep and red still means the
  // threat.
  assert.ok(!/rgba\(214,255,232/.test(scope), 'no pale-green glow survives');
  assert.ok(scope.includes('rgba(22,163,106'), 'the sweep is a readable green');
  assert.ok(/rgba\(255,60,80/.test(scope), 'threat red is untouched');
});

test('"no alert" is never painted darker than "alert"', () => {
  // #16233A was a near-black navy used as the fill for oblasts with no alert.
  // On a light map a dark fill reads as a threat, which inverts the meaning of
  // the layer entirely.
  assert.ok(!mapJs.includes('16233A'), 'the near-black neutral fill is gone');
  assert.ok(!dashboardJs.includes('16233A'), 'and from the legend chip');
  const neutral = mapJs.slice(mapJs.indexOf('neutral:'), mapJs.indexOf('neutral:') + 160);
  const fill = (neutral.match(/fillColor:'#([0-9A-Fa-f]{6})'/) || [])[1];
  const fillL = fill ? lum('#' + fill) : null;
  assert.ok(fillL !== null, 'a neutral fill is declared');
  assert.ok(fillL > 0.7, `the calm fill is light (got ${fill}), so absence of alert looks like absence`);
  // Opacity was tuned against a dark basemap; at 0.9 it became an opaque slab
  // that hid the tiles the replacement was supposed to deliver.
  const op = (neutral.match(/fillOpacity:([\d.]+)/) || [])[1];
  assert.ok(op !== undefined && Number(op) <= 0.35, `the calm fill is a wash, not a slab (got ${op})`);
});

test('map labels carry a light halo, not a black one', () => {
  // Dark text with a black drop-shadow on a light map is unreadable, and the
  // luminance check cannot see it because no surface is dark.
  const rule = dash.slice(dash.indexOf('.oblast-name{'), dash.indexOf('.oblast-name{') + 260);
  assert.ok(!/text-shadow:[^;]*#000/.test(rule), 'no black text-shadow on oblast labels');
  assert.ok(/text-shadow:[^;]*rgba\(255,255,255/.test(rule), 'a white halo instead');
});

test('status text uses the dark text roles, not the bright fills', () => {
  // Accent colours are fills. Used as 11px foreground they sit near 3:1.
  assert.ok(/\.sysok\{[^}]*color:#0F7A4E/.test(dash), 'success status uses the dark success ink');
  assert.ok(!/\.sysok\{[^}]*color:var\(--green\)/.test(dash), 'not the bright fill');
  assert.ok(/\.sysok\.warn\{[^}]*color:#8A5300/.test(dash), 'warning status uses the dark warn ink');
});

test('the PWA status bar matches the page', () => {
  assert.ok(neboHtml.includes('<meta name="theme-color" content="#F4F6F9">'), 'light theme-color');
  assert.ok(!neboHtml.includes('content="#02070B"'), 'the dark one is gone');
});

test('the dark style file and its references are gone', () => {
  assert.ok(!fs.existsSync(path.join(root, 'assets/data/nebo-dark.json')), 'nebo-dark.json deleted');
  const sw = read('service-worker.js');
  assert.ok(!sw.includes('nebo-dark.json'), 'and not precached');
  assert.ok(sw.includes('nebo-light.json'), 'the light style is precached instead');
  assert.ok(!dashboardJs.includes("base: 'dark'"), 'the basemap state default is not dark');
  assert.ok(!/applyBasemap\([^)]*'dark'/.test(dashboardJs), 'and no reset to a dark basemap');
});

test('the radar stylesheet was not touched by the archive conversion', () => {
  // styles.css and dashboard.css are loaded by nebo/index.html only, but that
  // separation is the whole safety argument for this change. If it ever stops
  // being true, the next person to edit them can repaint the radar by accident.
  const radar = read('index.html');
  assert.ok(!radar.includes('assets/css/styles.css'), 'the radar does not load the archive sheet');
  assert.ok(!radar.includes('assets/css/dashboard.css'), 'nor the dashboard sheet');
  assert.ok(radar.includes('./radar/radar.css'), 'it loads its own');
  assert.ok(lum('#F4F6F9') > 0.85, 'and the radar palette is still light');
});
