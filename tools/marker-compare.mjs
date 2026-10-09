// Side-by-side QA sheet: the ACTUAL supplied mockup crop next to the shipped
// artwork, at the sizes the radar really draws them. No hand-tracing, so a
// mismatch here is a real mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const REF = process.argv[2] || 'C:/Users/НР/Desktop/Легенда повітряних загроз України.png';
const dataUrl = `data:image/png;base64,${fs.readFileSync(REF).toString('base64')}`;

// (label, sprite file, mockup origin x, mockup origin y)
const ROWS = [
  ['БпЛА / шахеди', 'drone', 78, 65],
  ['Крилаті ракети', 'cruise-missile', 578, 65],
  ['Балістичні ракети', 'ballistic', 1068, 65],
  ['КАБ', 'kab', 78, 570],
  ['Авіація', 'aviation', 578, 570],
  ['Інші загрози', 'other-threat', 1068, 570],
];
const body = (f) => fs.readFileSync(path.join('assets', 'threats', `${f}.svg`), 'utf8')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const TILE = 190, CELL = 168;
// Zoom chosen so the crop window shows exactly TILE source pixels of the
// mockup — the whole icon tile, no more, no less.
const Z = CELL / TILE;

const rows = ROWS.map(([label, file, x, y]) => `<tr>
  <th>${label}</th>
  <td class="ref"><div class="crop" style="width:${CELL}px;height:${CELL}px">
    <img src="${dataUrl}" style="width:${1536 * Z}px;left:${-x * Z}px;top:${-y * Z}px"></div><span>референс</span></td>
  ${[20, 23, 32].map((s) => `<td><svg width="${s}" height="${s}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${body(file)}</svg><span>${s}px</span></td>`).join('')}
  <td class="big"><svg width="${CELL}px" height="${CELL}px" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${body(file)}</svg></td>
</tr>`).join('\n');

const html = `<!doctype html><meta charset="utf-8"><title>V5 vs reference</title>
<style>
 body{margin:0;padding:26px;background:#F4F6F9;font:13px/1.45 system-ui,sans-serif;color:#14263D}
 h1{font-size:16px;margin:0 0 4px} p.sub{margin:0 0 20px;color:#64748B;font-size:12px}
 table{border-collapse:collapse;background:#fff;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden}
 th{text-align:left;padding:12px 16px;font-weight:600;font-size:12.5px;border-bottom:1px solid #EDF1F6;background:#FAFBFC;white-space:nowrap}
 td{padding:10px 16px;text-align:center;border-bottom:1px solid #EDF1F6;vertical-align:middle}
 tr:last-child th,tr:last-child td{border-bottom:0}
 td span{display:block;font-size:10px;color:#94A3B8;margin-top:4px}
 .crop{overflow:hidden;position:relative;margin:0 auto;outline:1px solid #E2E8F0;border-radius:10px}
 .crop img{position:absolute;image-rendering:auto}
 td.ref{background:#FFFDF5}
 td.big{background:#FBFAF7}
</style>
<h1>РАДАР.LIVE V5 — порівняння з наданим референсом</h1>
<p class="sub">Ліва колонка — кроп із наданого макета. Решта — те, що реально рендериться з assets/threats/sprite.svg. Ніс усіх бойових силуетів — вгору (північ).</p>
<table><tr><th>Тип</th><th>Референс</th><th colspan="3">На радарі</th><th>Крупно</th></tr>${rows}</table>`;

fs.writeFileSync(path.join('shots', 'V5-vs-reference.html'), html);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file:///' + path.resolve('shots/V5-vs-reference.html').replace(/\\/g, '/'));
await page.waitForTimeout(700);
await page.screenshot({ path: 'shots/V5-vs-reference.png', fullPage: true });
await browser.close();
console.log('wrote shots/V5-vs-reference.png');
