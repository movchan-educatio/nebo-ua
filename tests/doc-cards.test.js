// The document pages' feature cards and the red CTA.
//
// Both defects here were invisible to the unit suite because they are cascade
// outcomes, not syntax: a component rule lost a specificity fight, and a
// stylesheet contract ("the sprite carries no paint, CSS supplies it") was
// only honoured where a component rule happened to exist. These pin the
// resolved rules so neither can quietly come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('radar/radar.css');
const PAGES = ['info', 'about', 'how-it-works', 'faq', 'sources', 'safety', 'privacy', 'terms', 'contact'];

// ── The empty red button ────────────────────────────────────────────────────
test('the CTA label is not the same colour as its own background', () => {
  // `.rl-doc a` (0,1,1) used to beat `.rl-doc-cta` (0,1,0), so the label was
  // painted var(--red) on a var(--red) background: contrast 1:1, which reads as
  // an empty button even though the text was in the DOM the whole time.
  const docLink = css.match(/\.rl-doc a\s*\{([^}]*)\}/);
  const cta = css.match(/\.rl-doc-cta\s*\{([^}]*)\}/);
  assert.ok(docLink, '.rl-doc a exists');
  assert.ok(cta, '.rl-doc-cta exists');
  assert.match(cta[1], /color:\s*#fff/, 'the component asks for white text');
  // The fix has to out-specify `.rl-doc a`, not merely come later in the file.
  const override = css.match(/\.rl-doc\s+a\.rl-doc-cta\s*\{([^}]*)\}/);
  assert.ok(override, 'an override keyed on the element exists');
  assert.match(override[1], /color:\s*#fff/, 'and it is white');
});

test('every doc-page CTA carries a real, meaningful label', () => {
  for (const dir of PAGES) {
    const html = read(`${dir}/index.html`);
    for (const m of html.matchAll(/<a class="rl-doc-cta"[^>]*>([\s\S]*?)<\/a>/g)) {
      const label = m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim();
      assert.ok(label.length >= 3, `${dir}: the CTA has a readable label, got "${label}"`);
      assert.match(m[0], /href="[^"]+"/, `${dir}: the CTA goes somewhere`);
      // Keyboard reachability comes free from being a real anchor, but it must
      // not have been turned into a div.
      assert.match(m[0], /^<a\s/, `${dir}: the CTA is an anchor, not a clickable div`);
    }
  }
});

// ── Feature-card icons ─────────────────────────────────────────────────────
test('outline icons get their paint from CSS, and the rule is general', () => {
  // assets/brand/icons.svg deliberately ships 23 symbols with zero fill/stroke
  // (tests/content.test.js pins that contract). Wherever a component rule
  // supplied the paint the icons were fine; everywhere else the browser fell
  // back to fill:black and drew a 300x150 blob.
  const sprite = read('assets/brand/icons.svg');
  const syms = [...sprite.matchAll(/<symbol[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)];
  assert.ok(syms.length >= 18, 'the sprite still has its symbols');
  for (const [, id, inner] of syms) {
    assert.ok(!/fill=/.test(inner), `${id}: still carries no fill of its own`);
    assert.ok(!/stroke=/.test(inner), `${id}: still carries no stroke of its own`);
  }
  // The rule has to reach the <use>, because that is what the shapes inherit
  // from — styling the <svg> leaves the computed fill black and misreports.
  assert.match(css, /use\[href\*="brand\/icons\.svg"\]\s*\{[^}]*fill:\s*none/, 'paint is set on the use element');
  assert.match(css, /use\[href\*="brand\/icons\.svg"\]\s*\{[^}]*stroke:\s*currentColor/, 'stroked in the inherited colour');
});

test('doc feature icons are bounded to 32–40px on every axis', () => {
  // A bare <svg> with no width/height/viewBox takes the CSS default replaced
  // element size of 300x150, which is what made the icons look like posters.
  const rule = css.match(/\.rl-doc-feats \.rl-info-card > svg\s*\{([^}]*)\}/);
  assert.ok(rule, 'the direct-child icon has its own rule');
  const body = rule[1];
  const w = (body.match(/width:\s*(\d+)px/) || [])[1];
  const h = (body.match(/height:\s*(\d+)px/) || [])[1];
  const mw = (body.match(/max-width:\s*(\d+)px/) || [])[1];
  const mh = (body.match(/max-height:\s*(\d+)px/) || [])[1];
  for (const [name, v] of [['width', w], ['height', h], ['max-width', mw], ['max-height', mh]]) {
    assert.ok(v, `${name} is set`);
    assert.ok(Number(v) >= 32 && Number(v) <= 40, `${name}: ${v}px is within 32–40`);
  }
  // Defence in depth: even a stray icon without the class cannot blow up a card.
  assert.match(css, /\.rl-doc-feats \.rl-info-card svg\s*\{|use\[href\*="brand\/icons\.svg"\][^}]*\}/, 'a general guard exists');
});

// Every @media block matching a condition, not just the first: a stylesheet
// this size has several, and the rule that matters may not be in the first one.
const mediaBlocks = (cond) => {
  const out = [];
  let i = 0;
  while ((i = css.indexOf('@media ' + cond, i)) !== -1) {
    let depth = 0, j = css.indexOf('{', i);
    const start = j;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (!depth) { out.push(css.slice(start, j + 1)); break; } }
    }
    if (j >= css.length) break;
    i = j;
  }
  return out;
};

test('doc feature grid is 3 / 2 / 1 and never strands a single card', () => {
  const base = css.match(/\.rl-doc-feats\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),\s*1fr\)/);
  assert.ok(base, 'a base column count is declared');
  assert.equal(base[1], '3', 'desktop is three columns');

  // The four-card groups were the ragged tail: 3 + 1. Two columns make 2x2.
  const four = css.match(/\.rl-doc-feats:has\(> :nth-child\(4\):last-child\)\s*\{[^}]*repeat\((\d+),\s*1fr\)/);
  assert.ok(four, 'a four-card group gets its own column count');
  assert.equal(four[1], '2', 'and it is two, giving a clean 2x2');

  const tablet = mediaBlocks('(max-width: 1180px)').join('\n');
  assert.ok(mediaBlocks('(max-width: 1180px)').length, 'the tablet breakpoint exists');
  assert.match(tablet, /\.rl-doc-feats\s*\{[^}]*repeat\(2,\s*1fr\)/, 'tablet is two columns');

  const phone = mediaBlocks('(max-width: 760px)').join('\n');
  assert.ok(mediaBlocks('(max-width: 760px)').length, 'the phone breakpoint exists');
  assert.match(phone, /\.rl-doc-feats\s*\{[^}]*1fr/, 'phone is one column');
});

// A stray bracket in :has() makes the browser drop the rule silently — which is
// exactly how the 2x2 rule failed to apply the first time.
test('the stylesheet parses: balanced parentheses and no dropped rules', () => {
  for (const ch of css) { /* balance is checked per rule below */ }
  const bad = [];
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim();
    for (const [open, close] of [['(', ')'], ['[', ']']]) {
      const o = (sel.match(new RegExp('\\' + open, 'g')) || []).length;
      const c = (sel.match(new RegExp('\\' + close, 'g')) || []).length;
      if (o !== c) bad.push(`${sel.slice(0, 70)} has ${o} "${open}" and ${c} "${close}"`);
    }
  }
  assert.deepEqual(bad, [], 'every selector is balanced');

  // And the rule is genuinely present in the file, not just in the intent.
  assert.ok(css.includes(':nth-child(4):last-child) {'), 'the :has() rule is well formed');
});

// ── Stale copy ──────────────────────────────────────────────────────────────
test('no page advertises a range or cadence the app does not have', () => {
  // The presets are 25/50/100/200/300/500 km and the live poll is 60s. Pages
  // still said "1 to 100 km" and "45 seconds", which is the sort of stale
  // number that makes a reader distrust everything else on the page.
  for (const dir of PAGES) {
    const html = read(`${dir}/index.html`);
    assert.doesNotMatch(html, /радіусі від 1 до 100/i, `${dir}: no 1–100 km range`);
    assert.doesNotMatch(html, /1[–-]100\s*км/i, `${dir}: no 1–100 km range (dash)`);
    assert.doesNotMatch(html, /45 секунд/i, `${dir}: no 45-second cadence`);
  }
});

test('doc pages declare the light theme colour they actually render in', () => {
  // All of them load radar/radar.css, which is light. A dark theme-color paints
  // the browser's own chrome dark on a light page — the same mismatch that had
  // been sitting on /nebo/.
  for (const dir of PAGES) {
    const html = read(`${dir}/index.html`);
    const m = html.match(/<meta name="theme-color" content="([^"]+)"/);
    assert.ok(m, `${dir}: declares a theme-color`);
    assert.equal(m[1].toUpperCase(), '#F4F6F9', `${dir}: matches the light page`);
    assert.ok(html.includes('radar/radar.css'), `${dir}: and it is a radar-stylesheet page`);
  }
});

test('the radar page is unchanged by the doc-card work', () => {
  const html = read('index.html');
  // The radar's own cards use threats/sprite.svg silhouettes, which carry their
  // own fill and must stay filled; the doc fix only targets brand/icons.svg.
  assert.ok(html.includes('threats/sprite.svg#uav'), 'radar threat cards still use the combat sprite');
  assert.ok(html.includes('radar/radar.css'), 'radar still loads its own stylesheet');
  assert.ok(!html.includes('rl-doc-feats'), 'the radar does not use the doc grid');
});
