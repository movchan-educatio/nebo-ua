// Render one traced icon large, next to a hand-drawn control, so a single
// shape can actually be judged instead of squinted at in a 20px cell.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const name = process.argv[2] || 'other-threat';
const body = fs.readFileSync(`assets/threats/${name}.svg`, 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
fs.writeFileSync('shots/_one.html', `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#F4F5F8;display:flex;gap:24px;padding:24px;font:12px system-ui">
  <figure style="margin:0;text-align:center">
    <svg width="240" height="240" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${body}</svg>
    <figcaption>${name} — traced</figcaption></figure>
  <figure style="margin:0;text-align:center">
    <svg width="240" height="240" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" fill="#E9EDF2"/>
      <path d="M16 3 29 16 16 29 3 16Z" fill="none" stroke="#2D3A46" stroke-width="2.6"/>
    </svg><figcaption>control</figcaption></figure>
</body>`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 560, height: 300 }, deviceScaleFactor: 2 });
await p.goto('file:///' + path.resolve('shots/_one.html').replace(/\\/g, '/'));
await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/_one.png' });
await b.close();
fs.unlinkSync('shots/_one.html');
console.log('wrote shots/_one.png');
