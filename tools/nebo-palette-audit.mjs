// Extracts every colour literal from the /nebo/ stylesheets, with the rules it
// appears in, so the light conversion is built from what is actually in the
// files rather than from a guess about what is probably there.
//
// Also answers the question that decides how careful this has to be: does any
// page that must stay dark or stay on the radar load these sheets?
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['assets/css/styles.css', 'assets/css/dashboard.css'];

// Anything that looks like a colour: #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(),
// hsl()/hsla(). Word-boundaried so it does not match inside a url() or a class.
const COLOUR = /(#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\))/g;

const rows = [];
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  // Walk rule by rule so every colour is attributed to a selector.
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(src))) {
    const selector = m[1].trim().split(/\n/).pop().trim().slice(0, 70);
    const body = m[2];
    for (const c of body.match(COLOUR) || []) {
      rows.push({ file: f, selector, colour: c, line: src.slice(0, m.index).split('\n').length });
    }
  }
}

const byColour = new Map();
for (const r of rows) {
  const k = r.colour.toLowerCase().replace(/\s+/g, '');
  if (!byColour.has(k)) byColour.set(k, { n: 0, where: new Set() });
  const e = byColour.get(k);
  e.n++;
  if (e.where.size < 3) e.where.add(`${path.basename(r.file)} ${r.selector}`);
}

console.log(`total colour occurrences: ${rows.length}, distinct: ${byColour.size}\n`);
const sorted = [...byColour.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [c, e] of sorted) {
  console.log(`${String(e.n).padStart(3)}  ${c.padEnd(26)} ${[...e.where].join(' | ').slice(0, 96)}`);
}

// Which pages load these sheets? The radar and the document pages must be
// unaffected by anything done here.
console.log('\n=== who loads these stylesheets ===');
const pages = [];
for (const dir of ['.', 'nebo', 'info', 'widget', 'embed', 'radar']) {
  const d = path.join('.', dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.html')) pages.push(path.join(dir, f).replace(/^\.\\/, ''));
  }
}
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  const hits = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((x) => x[1]);
  console.log(`${p.padEnd(28)} ${hits.join(' ') || '(none)'}`);
}
