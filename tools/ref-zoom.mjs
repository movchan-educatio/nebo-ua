// Crops each of the six reference icons at high zoom so the artwork can be
// traced accurately instead of guessed. Reads the supplied mockup PNG only.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const REF = process.argv[2] || 'C:/Users/НР/Desktop/Легенда повітряних загроз України.png';
const b64 = fs.readFileSync(REF).toString('base64');
const dataUrl = `data:image/png;base64,${b64}`;

// Icon tile regions inside the mockup (measured from the 1536x1024 source).
const CELLS = [
  ['БпЛА / шахеди', 78, 65], ['Крилаті ракети', 578, 65], ['Балістичні ракети', 1068, 65],
  ['КАБ', 78, 570], ['Авіація', 578, 570], ['Інші загрози', 1068, 570],
];
const S = 190, Z = 4;   // source tile size, zoom factor

const html = `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;background:#fff;font:12px system-ui;padding:10px}
 .g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
 figure{margin:0}
 .box{width:${S * Z}px;height:${S * Z}px;overflow:hidden;position:relative;outline:1px solid #CBD5E1}
 .box img{position:absolute;width:${1536 * Z}px;image-rendering:pixelated;transform-origin:0 0}
 figcaption{font-weight:600;padding:6px 2px}
</style>
<div class="g">${CELLS.map(([n, x, y]) => `<figure>
 <div class="box"><img src="${dataUrl}" style="left:${-x * Z}px;top:${-y * Z}px"></div>
 <figcaption>${n}</figcaption></figure>`).join('')}</div>`;

const file = path.join('shots', '_refzoom.html');
fs.writeFileSync(file, html);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: S * Z * 3 + 60, height: 400 }, deviceScaleFactor: 1 });
await page.goto('file:///' + path.resolve(file).replace(/\\/g, '/'));
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/REF-zoom.png', fullPage: true });
await browser.close();
fs.unlinkSync(file);
console.log('wrote shots/REF-zoom.png');
