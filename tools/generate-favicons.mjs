// Deterministic raster exports of the EXISTING radar favicon. No new logo.
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const svg = await readFile(new URL('assets/brand/favicon.svg', root));
await writeFile(new URL('favicon.svg', root), svg);
const sizes = [16, 32, 48, 192, 512];
const images = new Map();
for (const size of sizes) {
  const png = await sharp(svg, { density: 512 }).resize(size, size).png().toBuffer();
  images.set(size, png);
  if (size !== 16) await writeFile(new URL(`favicon-${size}x${size}.png`, root), png);
}
await sharp(svg, { density: 512 }).resize(180, 180).flatten({ background: '#061019' })
  .png().toFile(fileURLToPath(new URL('apple-touch-icon.png', root)));
for (const size of [192, 512]) {
  await writeFile(new URL(`assets/icons/icon-${size}.png`, root), images.get(size));
}
// Maskable artwork stays within the central 80% safe circle.
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#061019' } })
  .composite([{ input: await sharp(svg, { density: 512 }).resize(384, 384).png().toBuffer(), left: 64, top: 64 }])
  .png().toFile(fileURLToPath(new URL('assets/icons/icon-maskable-512.png', root)));
// ICO directory with 16/32/48px PNG frames (standard modern ICO encoding).
const icoSizes = [16, 32, 48];
const directory = Buffer.alloc(6 + 16 * icoSizes.length);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(icoSizes.length, 4);
let offset = directory.length;
icoSizes.forEach((size, i) => {
  const start = 6 + 16 * i, png = images.get(size);
  directory[start] = size; directory[start + 1] = size;
  directory.writeUInt16LE(1, start + 4); directory.writeUInt16LE(32, start + 6);
  directory.writeUInt32LE(png.length, start + 8); directory.writeUInt32LE(offset, start + 12);
  offset += png.length;
});
await writeFile(new URL('favicon.ico', root), Buffer.concat([directory, ...icoSizes.map(s => images.get(s))]));
console.log('Exported existing radar to ICO, PNG, SVG and PWA sizes.');
