// Screenshots the LIVE production radar so the shipped result can be judged,
// not assumed. Desktop and mobile.
import { chromium } from 'playwright';

const SITE = process.argv[2] || 'https://nebo-ua.vercel.app';
const browser = await chromium.launch({ headless: true });
const errs = [];
let failed = 0;

for (const [w, h, name] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  page.on('requestfailed', (r) => failed++);
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const r = await page.evaluate(() => {
    const uses = [...document.querySelectorAll('use')].map((u) => u.getAttribute('href') || u.getAttribute('xlink:href') || '');
    return {
      spriteRefs: uses.filter((h) => h.includes('sprite.svg')).length,
      legacyRefs: uses.filter((h) => h.includes('threat-icons')).length,
      legend: document.querySelectorAll('.rl-radar-legend svg').length,
      feedIcons: document.querySelectorAll('.rl-event svg').length,
      feedRows: document.querySelectorAll('.rl-event').length,
      circle: (() => { const s = document.querySelector('.rl-radar-screen'); if (!s) return 'n/a'; const b = s.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })(),
      count: document.getElementById('rlRadarCount')?.textContent || '',
      live: document.getElementById('rlLive')?.textContent?.trim() || '',
      kinds: document.querySelectorAll('.rl-kind-dot').length,
      hScroll: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  console.log(`\n[${name}]`);
  console.log(`  new sprite refs   ${r.spriteRefs}   legacy refs ${r.legacyRefs}`);
  console.log(`  legend icons      ${r.legend}`);
  console.log(`  feed icons        ${r.feedIcons}/${r.feedRows}`);
  console.log(`  filters           ${r.kinds}`);
  console.log(`  radar circle      ${r.circle}`);
  console.log(`  targets           ${r.count}`);
  console.log(`  badge             ${r.live}`);
  console.log(`  horizontal scroll ${r.hScroll}`);

  await page.screenshot({ path: `shots/LIVE-v5-${name}.png` });
  await page.close();
}

console.log(`\nJS errors: ${errs.length}${errs[0] ? ' — ' + errs[0] : ''} | failed requests: ${failed}`);
await browser.close();
