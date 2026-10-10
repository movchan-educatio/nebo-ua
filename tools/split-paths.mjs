// Decisive check: render each path of an icon separately so it is obvious
// which one produces which colour.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const name = process.argv[2] || 'other-threat';
const raw = fs.readFileSync(`assets/threats/${name}.svg`, 'utf8');
const defs = (raw.match(/<defs>[\s\S]*?<\/defs>/) || [''])[0];
const paths = [...raw.matchAll(/<path d="[^"]+"[^>]*\/>/g)].map((m) => m[0]);
const cells = paths.map((p, i) => `<figure style="margin:0;text-align:center">
  <svg width="200" height="200" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${defs}${p}</svg>
  <figcaption>path ${i}</figcaption></figure>`).join('');
fs.writeFileSync('shots/_split.html', `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#F4F5F8;display:flex;gap:20px;padding:20px;font:12px system-ui">${cells}</body>`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 240 * paths.length + 80, height: 260 }, deviceScaleFactor: 2 });
await p.goto('file:///' + path.resolve('shots/_split.html').replace(/\\/g, '/'));
await p.waitForTimeout(400);
await p.screenshot({ path: 'shots/_split.png' });
await b.close();
fs.unlinkSync('shots/_split.html');
console.log(`wrote shots/_split.png — ${paths.length} path(s) of ${name}`);
