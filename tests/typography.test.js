// The footer note, and the typographic rules that came with fixing it.
//
// `.rl-foot-note` carried `max-width: 62ch` — a measure rule, which belongs to
// body copy, applied to a 75-character single-line disclaimer. The cap resolved
// to 418px where the text needed 466px and the container offered 840px, so it
// broke in two on every document page. These pin the fix and the reasoning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const css = read('radar/radar.css');

const rule = (sel) => {
  const i = css.indexOf(sel + ' {');
  if (i === -1) return '';
  return css.slice(i, css.indexOf('}', i));
};

test('the footer disclaimer is not capped at a measure it cannot hold', () => {
  const body = rule('.rl-foot-note');
  assert.ok(body, '.rl-foot-note exists');
  // A ch/em max-width on a short single-line note is the whole defect.
  assert.doesNotMatch(body, /max-width:\s*\d+(ch|rem|em)/, 'no character-based cap on the note');
});

test('no stylesheet reintroduces a ch/rem/em max-width on prose', () => {
  // Surveyed across all three stylesheets: this was the only one in the codebase.
  // A measure belongs to body copy, where it stops a paragraph running to 140
  // characters; it does not belong on a single-line footer.
  for (const f of ['radar/radar.css', 'assets/css/styles.css', 'assets/css/dashboard.css']) {
    const src = read(f);
    const hits = [...src.matchAll(/([^{}]*)\{([^}]*max-width:\s*[0-9.]+(?:ch|rem|em)[^}]*)\}/g)];
    assert.deepEqual(
      hits.map((m) => m[1].trim().replace(/\s+/g, ' ')),
      [],
      `${f} has no character-unit max-width`,
    );
  }
});

test('headings balance their lines and body copy avoids stranded words', () => {
  // 63 typographic widows were measured across the site before this; every one
  // in a heading is gone. text-wrap is progressive enhancement — a browser
  // without it wraps normally, which is the behaviour before.
  assert.match(css, /h1,\s*h2,\s*h3,\s*h4[^{]*\{[^}]*text-wrap:\s*balance/, 'headings balance');
  assert.match(css, /p,\s*li[^{]*\{[^}]*text-wrap:\s*pretty/, 'body copy reflows');
});
