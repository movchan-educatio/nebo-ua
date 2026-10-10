// Moves the document routes onto the radar's own design system.
//
// The old pages carried their own dark theme, header and footer. Their content
// is plain semantic markup and stays exactly as written: only the chrome and
// the stylesheet change. Head metadata (title, description, canonical, Open
// Graph, JSON-LD, icons) is preserved verbatim — losing a canonical or a
// structured-data block would quietly break SEO, which is not a visual fix.
import fs from 'node:fs';

const NAV = [
  ['Радар', '../'],
  ['Про проєкт', '../about/'],
  ['Як працює', '../how-it-works/'],
  ['Джерела', '../sources/'],
  ['Безпека', '../safety/'],
  ['FAQ', '../faq/'],
  ['Контакти', '../contact/'],
];

const FOOT_LINKS = [
  ['Радар', '../'], ['Про РАДАР.LIVE', '../info/'], ['Про проєкт', '../about/'],
  ['Як працює', '../how-it-works/'], ['Джерела', '../sources/'], ['Безпека', '../safety/'],
  ['FAQ', '../faq/'], ['Конфіденційність', '../privacy/'], ['Умови', '../terms/'],
  ['Контакти', '../contact/'],
];

const PAGES = ['about', 'how-it-works', 'sources', 'safety', 'faq', 'terms', 'privacy', 'contact', 'info'];

function header(active) {
  const links = NAV.map(([label, href]) =>
    `<a class="${href === active ? 'active' : ''}" href="${href}">${label}</a>`).join('\n      ');
  return `<header class="rl-topbar">
  <a class="rl-brand" href="../" aria-label="РАДАР.LIVE — на радар">
    <img src="../assets/brand/radar-mark.svg" alt="РАДАР.LIVE">
    <span><b>РАДАР.<span>LIVE</span></b><small>Моніторинг повітряних загроз України</small></span>
  </a>
  <nav class="rl-nav rl-subnav" aria-label="Розділи">
      ${links}
  </nav>
  <div class="rl-top-right">
    <a class="rl-icon-btn" href="../" aria-label="На радар" title="На радар"><svg aria-hidden="true"><use href="../assets/brand/icons.svg#i-radar"/></svg></a>
  </div>
</header>`;
}

function footer() {
  return `<footer class="rl-foot">
  <div class="rl-foot-in">
    <nav class="rl-foot-links" aria-label="Розділи сайту">
      ${FOOT_LINKS.map(([l, h]) => `<a href="${h}">${l}</a>`).join('\n      ')}
    </nav>
    <p class="rl-foot-note">РАДАР.LIVE — інформаційний сервіс. Не замінює офіційної системи оповіщення.</p>
  </div>
</footer>`;
}

// Old content classes mapped onto the radar's. `card`/`cards` become the shared
// surface so a card on a sub-page is literally the same component as on the
// radar; `lead` and `note` keep their names and are styled inside .rl-doc.
//
// `faq` was the class on every accordion, not on a wrapper: mapping it to
// `rl-doc` gave each <details> a centred 880px grid box and the whole page came
// out as a narrow column of pills. The class is simply dropped — .rl-doc
// already styles bare <details>.
function mapContent(inner) {
  return inner
    // The shell provides the back link; pages that already had one would show
    // it twice.
    .replace(/<p[^>]*>\s*(?:<a[^>]*>\s*)?←\s*Назад до радара(?:\s*<\/a>)?\s*<\/p>/g, '')
    .replace(/class="cards"/g, 'class="rl-doc-feats"')
    .replace(/class="card"/g, 'class="rl-card rl-info-card"')
    .replace(/class="content"/g, 'class="rl-doc"')
    .replace(/\s*class="[^"]*\bfaq\b[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');
}

let changed = 0;
for (const page of PAGES) {
  const file = `${page}/index.html`;
  if (!fs.existsSync(file)) { console.log('skip (missing):', file); continue; }
  let html = fs.readFileSync(file, 'utf8');

  // 1. Stylesheet: the radar's own design tokens, not the old dark theme.
  html = html.replace(/<link rel="stylesheet" href="\.\.\/assets\/css\/content\.css">/,
    '<link rel="stylesheet" href="../radar/radar.css">');

  // 2. Content is preserved; only its wrapper class changes.
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/);
  if (!mainMatch) { console.log('skip (no main):', file); continue; }
  const content = mapContent(mainMatch[1]);

  const titleMatch = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
  const active = '../' + page + '/';

  // 3. Rebuild the body around it.
  const head = html.slice(0, html.indexOf('</head>') + 7);
  let out = head + '\n' + `<body class="rl-page">
${header(active)}
<main class="rl-doc">
  <p class="rl-back"><a href="../">← Назад до радара</a></p>

${content}
</main>
${footer()}
</body>
</html>
`;
  // A canonical for the route is part of the SEO contract: keep it if the old
  // page had one, and supply the obvious one if it did not.
  if (!/<link rel="canonical"/.test(out)) {
    out = out.replace('</head>', `<link rel="canonical" href="https://nebo-ua.vercel.app/${page}/">\n</head>`);
  }
  fs.writeFileSync(file, out, 'utf8');
  console.log(`migrated ${file}  (${titleMatch ? titleMatch[1].slice(0, 40) : '?'})`);
  changed++;
}
console.log(`\n${changed} pages moved onto the radar design.`);