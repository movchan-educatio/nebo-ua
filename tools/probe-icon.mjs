// Probe: dump a luminance grid over one icon so the artwork can be inspected
// numerically instead of guessed at. Read-only.
import fs from 'node:fs';
import { chromium } from 'playwright';

const REF = process.argv[2] || 'C:/Users/НР/Desktop/Легенда повітряних загроз України.png';
const which = process.argv[3] || 'other-threat';
const TILE = { drone: [78, 65], 'cruise-missile': [578, 65], ballistic: [1068, 65], kab: [78, 570], aviation: [578, 570], 'other-threat': [1068, 570] }[which];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');
const out = await page.evaluate(async ({ src, tx, ty }) => {
  const img = new Image(); img.src = src; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(tx, ty, 190, 190).data;
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rows = [];
  for (let y = 40; y < 150; y += 3) {
    let s = '';
    for (let px = 40; px < 150; px += 2) {
      const i = (y * 190 + px) * 4;
      const L = lum(d[i], d[i + 1], d[i + 2]);
      s += L < 60 ? '#' : L < 120 ? '+' : L < 200 ? '.' : ' ';
    }
    rows.push(String(y).padStart(3) + ' ' + s);
  }
  return rows.join('\n');
}, { src: `data:image/png;base64,${fs.readFileSync(REF).toString('base64')}`, tx: TILE[0], ty: TILE[1] });
await browser.close();
console.log(`# ${which}  (# = very dark, + = dark, . = mid, ' ' = light)`);
console.log(out);
