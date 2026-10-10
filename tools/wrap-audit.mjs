// Finds text that wraps when it did not need to.
//
// The previous version estimated this by multiplying the longest rendered line
// by the line count, which makes every paragraph look like it "needs" the
// width and hides the real defect. This measures instead: the text is cloned
// into an off-screen box with white-space:nowrap, and its natural single-line
// width is compared against the space it was actually given. If the text would
// have fit, the wrap came from a constraint nobody chose.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  let f = path.join(root, p);
  if (p.endsWith('/')) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { const i = f + '/index.html'; f = fs.existsSync(i) ? i : null; if (!f) { r.writeHead(404); return r.end('nf'); } }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const audit = () => {
  const describe = (el) => {
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  };

  // One measuring frame, reused.
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:nowrap;';
  document.body.appendChild(stage);

  const naturalWidth = (node, cs) => {
    stage.textContent = node.textContent;
    stage.style.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    stage.style.letterSpacing = cs.letterSpacing;
    stage.style.textTransform = cs.textTransform;
    return Math.ceil(stage.getBoundingClientRect().width);
  };

  const findings = [];
  for (const el of document.querySelectorAll('body *')) {
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (!node) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (/nowrap|pre/.test(cs.whiteSpace)) continue;
    if (cs.overflow !== 'visible' && cs.overflow !== '') continue; // clipped/truncated text is intentional
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.height < 6) continue;

    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((x) => x.width > 1 && x.height > 1);
    if (rects.length < 2) continue;

    const natural = naturalWidth(node, cs);
    const contentWidth = el.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);

    // The constraint has to be LOCAL. Walking up to an ancestor whose max-width
    // is narrower than the viewport blames a container that has nothing to do
    // with it: the second version of this reported 81 findings that all named
    // a 1720px wrapper while the real limit was a 123px grid column.
    //
    // The case that matters is the element's OWN max-width, which is what a
    // stray `max-width: 62ch` on a short sentence looks like from the outside.
    let culprit = null;
    const parent = el.parentElement;
    const parentContent = parent
      ? parent.clientWidth - parseFloat(getComputedStyle(parent).paddingLeft || 0) - parseFloat(getComputedStyle(parent).paddingRight || 0)
      : Infinity;
    if (cs.maxWidth && cs.maxWidth !== 'none') {
      const declared = parseFloat(cs.maxWidth);
      if (declared > 0 && declared < parentContent - 2) {
        culprit = { el: describe(el), rule: `max-width: ${cs.maxWidth}`, inBox: Math.round(parentContent) };
      }
    }

    findings.push({
      el: describe(el),
      text: node.textContent.trim().replace(/\s+/g, ' ').slice(0, 70),
      lines: rects.length,
      chars: node.textContent.trim().length,
      box: Math.round(contentWidth),
      natural,
      slack: contentWidth - natural,
      culprit,
      fontSize: cs.fontSize,
      // The case the first version missed entirely: the text is too wide for
      // its own max-width, so it wraps — but it would have fitted the container
      // that max-width is cutting into. That is a constraint nobody chose, and
      // it looks identical from the outside to text that is simply long.
      forcedByConstraint: !!(culprit && natural <= culprit.inBox),
      wouldFitContainer: culprit ? natural <= culprit.inBox : false,
    });
  }
  stage.remove();
  return { findings, overflow: document.documentElement.scrollWidth - window.innerWidth };
};

const PAGES = [['/', 'radar'], ['/info/', 'info'], ['/about/', 'about'], ['/how-it-works/', 'how'], ['/faq/', 'faq'], ['/sources/', 'sources'], ['/safety/', 'safety'], ['/privacy/', 'privacy'], ['/terms/', 'terms'], ['/contact/', 'contact'], ['/nebo/', 'nebo']];
const WIDTHS = [390, 768, 1440, 1920];

const browser = await chromium.launch({ headless: true });
// Only report widths where the wrap is clearly unnecessary: the text needed
// less than the space it was given, with a margin so rounding is not noise.
const UNNECESSARY = 12;
const byElement = new Map();
let overflows = 0;

for (const [url, name] of PAGES) {
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(650);
    const { findings, overflow } = await page.evaluate(audit);
    if (overflow > 1) { console.log(`  !! ${name} @${w}: horizontal overflow ${overflow}px`); overflows++; }
    for (const f of findings) {
      // Two ways a wrap is unnecessary: the text simply had room (slack), or a
      // max-width cut a container it already fitted into.
      const forced = f.forcedByConstraint;
      if (!forced && f.slack < UNNECESSARY) continue;
      const key = name + '|' + f.el + '|' + f.text.slice(0, 40);
      const prev = byElement.get(key);
      const score = forced ? f.culprit.inBox - f.natural : f.slack;
      if (!prev || score > prev.score) byElement.set(key, { ...f, score, page: name, width: w });
    }
    await page.close();
  }
}

console.log(`\n${byElement.size} text elements wrap although they would have fit:\n`);
for (const f of [...byElement.values()].sort((a, b) => b.score - a.score)) {
  console.log(`${f.page} @${f.width}  ${f.el}   ${f.fontSize}${f.forcedByConstraint ? '   [forced by a constraint]' : ''}`);
  console.log(`   "${f.text}"`);
  console.log(`   ${f.lines} lines | ${f.chars} chars | box ${f.box}px | needs ${f.natural}px`);
  console.log(`   cause: ${f.culprit ? f.culprit.el + ' { ' + f.culprit.rule + ' } in a ' + f.culprit.inBox + 'px box' : 'inherited width'}`);
  if (f.forcedByConstraint) console.log(`   fix: it needs ${f.natural}px and the container is ${f.culprit.inBox}px — the constraint is ${f.culprit.inBox - f.natural}px too tight`);
  console.log('');
}
console.log(overflows === 0 ? 'no horizontal overflow anywhere' : `${overflows} overflow findings`);
await browser.close();
srv.close();
