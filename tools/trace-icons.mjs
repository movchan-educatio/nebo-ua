// Traces the six reference icons 1:1 out of the supplied mockup PNG.
//
// Hand-drawing "close enough" is guesswork. This reads the actual pixels,
// follows the real silhouette, and writes SVG paths — so fidelity comes from
// the source image, not from my eye.
//
//   1. DISCOVER: saturated-or-dark ink finds the six icon blobs automatically,
//      so no tile coordinates are hardcoded and can silently rot.
//   2. SILHOUETTE: within each blob's box, flood the backdrop inward from the
//      box border. A sealed outline stops the flood, so a light plate inside
//      a dark ring is correctly "inside the icon" even though its colour
//      matches the backdrop almost exactly.
//   3. OUTLINE: the navy ring is the dark, neutral part reachable from the
//      silhouette edge. We trace the FILL side of that ring and re-stroke it
//      to the same measured width, which reproduces the original outer edge
//      instead of fattening the silhouette.
//   4. SIMPLIFY: Douglas-Peucker, then smooth through segment midpoints.
//   5. ORIENT: the mockup draws some icons sideways, so each is rotated about
//      its own centre until the nose points NORTH, then fitted to 32x32 with
//      the stroke inset by half its width.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const REF = process.argv[2] || 'C:/Users/НР/Desktop/Легенда повітряних загроз України.png';
const dataUrl = `data:image/png;base64,${fs.readFileSync(REF).toString('base64')}`;

const EPSILON = 0.5;
const VIEW = 32;
const MARGIN = 0.9;
// Degrees to rotate each traced icon so its nose points NORTH (up). The
// mockup draws the drone pointing left and the cruise missile pointing right.
const ROTATE = {
  drone: 90, 'cruise-missile': -90, ballistic: 0, kab: 0, aviation: 0, 'other-threat': 0,
};
const NAMES = ['drone', 'cruise-missile', 'ballistic', 'kab', 'aviation', 'other-threat'];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('about:blank');

const traced = await page.evaluate(async ({ src, epsilon }) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

  const components = (mask, w, h, ox = 0, oy = 0) => {
    const seen = new Uint8Array(w * h);
    const out = [];
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || seen[s]) continue;
      const cells = [];
      const stack = [s % w, (s / w) | 0];
      seen[s] = 1;
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        cells.push(x + ox, y + oy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (mask[k] && !seen[k]) { seen[k] = 1; stack.push(nx, ny); }
        }
      }
      out.push(cells);
    }
    return out;
  };
  const bounds = (cells) => {
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < cells.length; i += 2) {
      const x = cells[i], y = cells[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  const traceOuter = (cells) => {
    const set = new Set();
    for (let i = 0; i < cells.length; i += 2) set.add(cells[i + 1] * 100000 + cells[i]);
    const has = (x, y) => set.has(y * 100000 + x);
    let sx = cells[0], sy = cells[1];
    for (let i = 0; i < cells.length; i += 2) {
      if (cells[i + 1] < sy || (cells[i + 1] === sy && cells[i] < sx)) { sx = cells[i]; sy = cells[i + 1]; }
    }
    const d = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    let dir = 6, cx = sx, cy = sy, guard = 0;
    const pts = [];
    do {
      pts.push(cx, cy);
      let moved = false;
      for (let i = 0; i < 8; i++) {
        const k = (dir + 6 + i) % 8;
        if (has(cx + d[k][0], cy + d[k][1])) { cx += d[k][0]; cy += d[k][1]; dir = k; moved = true; break; }
      }
      if (!moved) break;
    } while ((cx !== sx || cy !== sy) && ++guard < 400000);
    return pts;
  };
  const rdp = (p, eps) => {
    const n = p.length / 2;
    if (n < 3) return p;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let best = -1, bd = 0;
      for (let i = a + 1; i < b; i++) {
        const dd = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / len;
        if (dd > bd) { bd = dd; best = i; }
      }
      if (bd > eps) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
  };

  // 1. discovery
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = px(x, y);
    ink[y * W + x] = (sat(r, g, b) > 42 || lum(r, g, b) < 118) ? 1 : 0;
  }
  const blobs = components(ink, W, H)
    .map((c) => ({ c, b: bounds(c) }))
    .filter((o) => o.c.length / 2 > 1200 && o.b.w > 24 && o.b.h > 24);
  const mids = blobs.map((o) => (o.b.y0 + o.b.y1) / 2).sort((a, b) => a - b);
  const split = mids.length >= 6 ? (mids[2] + mids[3]) / 2 : Infinity;
  const picked = [
    ...blobs.filter((o) => (o.b.y0 + o.b.y1) / 2 < split).sort((a, b) => a.b.x0 - b.b.x0).slice(0, 3),
    ...blobs.filter((o) => (o.b.y0 + o.b.y1) / 2 >= split).sort((a, b) => a.b.x0 - b.b.x0).slice(0, 3),
  ];
  if (picked.length < 6) return { error: `only found ${picked.length} icon blobs` };

  return picked.map((blob) => {
    const G = 14;                                   // search margin around the blob
    const rx = blob.b.x0 - G, ry = blob.b.y0 - G;
    const w = blob.b.w + G * 2, h = blob.b.h + G * 2;

    // 2. silhouette: flood the backdrop inward from this window's border.
    const backdrops = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2],
      [G - 2, G - 2], [G - 2, h - G], [w - G, G - 2], [w - G, h - G]];
    const nearBackdrop = (x, y) => {
      const [r, g, b] = px(rx + x, ry + y);
      for (const [bx, by] of backdrops) {
        const [br, bgc, bb] = px(rx + bx, ry + by);
        if (Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb) < 30) return true;
      }
      return false;
    };
    const bg = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) stack.push(x, 0, x, h - 1);
    for (let y = 0; y < h; y++) stack.push(0, y, w - 1, y);
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = y * w + x;
      if (bg[k] || !nearBackdrop(x, y)) continue;
      bg[k] = 1;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    const sil = new Uint8Array(w * h);
    for (let i = 0; i < sil.length; i++) sil[i] = bg[i] ? 0 : 1;
    const silCells = [];
    // ABSOLUTE coordinates, matching the cell lists returned by components()
    // below — mixing local and absolute here silently shifts every icon.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sil[y * w + x]) silCells.push(x + rx, y + ry);
    if (!silCells.length) return { error: 'empty silhouette' };
    const sb = bounds(silCells);

    // 3. navy ring: dark neutral pixels reachable from the silhouette edge.
    // ring/dark/fillMask are indexed in LOCAL window coords; sb is absolute.
    const lx0 = sb.x0 - rx, lx1 = sb.x1 - rx, ly0 = sb.y0 - ry, ly1 = sb.y1 - ry;
    const dark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!sil[y * w + x]) continue;
      const [r, g, b] = px(rx + x, ry + y);
      dark[y * w + x] = lum(r, g, b) < 120 && sat(r, g, b) < 72 ? 1 : 0;
    }
    // 3. Outline thickness, measured by crossing the border on several
    //    scanlines. Flooding "dark pixels" instead would leak along the
    //    anti-aliased inner edge and eat into the artwork.
    const thicknesses = [];
    for (const frac of [0.25, 0.4, 0.5, 0.6, 0.75]) {
      const y = Math.round(ly0 + (ly1 - ly0) * frac);
      for (const dir of [1, -1]) {
        let x = dir === 1 ? lx0 : lx1;
        const stop = dir === 1 ? lx1 : lx0;
        while (dir === 1 ? x <= stop : x >= stop) {
          if (sil[y * w + x]) break;
          x += dir;
        }
        let t = 0;
        while (dir === 1 ? x + t <= stop : x - t >= stop) {
          const k = y * w + (x + dir * t);
          if (!sil[k] || !dark[k]) break;
          t++;
        }
        if (t > 0 && t < 22) thicknesses.push(t);
      }
    }
    thicknesses.sort((a, c) => a - c);
    const strokePx = thicknesses.length ? thicknesses[thicknesses.length >> 1] : 6;

    // Ring = silhouette pixels within one measured stroke of the edge, via a
    // BFS depth map. No colour heuristics, so it cannot leak.
    const depth = new Int32Array(w * h).fill(-1);
    const dq = [];
    for (let y = ly0; y <= ly1; y++) for (let x = lx0; x <= lx1; x++) {
      const k = y * w + x;
      if (!sil[k]) continue;
      if (x === lx0 || y === ly0 || x === lx1 || y === ly1 || !sil[k - 1] || !sil[k + 1] || !sil[k - w] || !sil[k + w]) {
        depth[k] = 1; dq.push(k);
      }
    }
    for (let qi = 0; qi < dq.length; qi++) {
      const k = dq[qi], x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (sil[nk] && depth[nk] === -1) { depth[nk] = depth[k] + 1; dq.push(nk); }
      }
    }
    const ring = new Uint8Array(w * h);
    for (let i = 0; i < ring.length; i++) ring[i] = sil[i] && depth[i] > 0 && depth[i] <= strokePx ? 1 : 0;

    // Fill = the artwork's colour. The ring is the outline; anything dark
    // left over is an INTERIOR detail (the star on the unknown-threat plate)
    // and must be excluded here, or it merges with the fill around it into a
    // single blob and the detail disappears.
    const fillMask = new Uint8Array(w * h);
    for (let i = 0; i < fillMask.length; i++) fillMask[i] = sil[i] && !ring[i] && !dark[i] ? 1 : 0;
    // Interior detail = dark artwork well inside the silhouette (the star on
    // the unknown-threat plate). Collected separately so it is drawn, not lost.
    const detailMask = new Uint8Array(w * h);
    for (let i = 0; i < detailMask.length; i++) detailMask[i] = sil[i] && !ring[i] && dark[i] ? 1 : 0;

    const fits = (o) => o.c.length > 20 && o.b.w > 2 && o.b.h > 2 && o.b.w <= sb.w && o.b.h <= sb.h;
    // Interior details are small marks inside a much larger body. Anything
    // approaching the silhouette's own size is the outline's anti-aliased
    // halo, not artwork, and would swallow the shape it sits on.
    const detail = (o) => fits(o) && o.b.w * o.b.h <= sb.w * sb.h * 0.35;
    const parts = components(fillMask, w, h, rx, ry).map((c) => ({ c, b: bounds(c) })).filter(fits)
      .sort((a, c) => c.c.length - a.c.length);
    const details = components(detailMask, w, h, rx, ry).map((c) => ({ c, b: bounds(c) })).filter(detail)
      .sort((a, c) => c.c.length - a.c.length);
    if (!parts.length) return { error: 'no fill region' };
    const mainFill = parts[0];

    // colours: dominant fill colour, then the luminance spread around it
    const hist = new Map();
    const all = [];
    for (let i = 0; i < mainFill.c.length; i += 2) {
      const col = px(mainFill.c[i], mainFill.c[i + 1]);
      all.push(col);
      const k = `${col[0] >> 4},${col[1] >> 4},${col[2] >> 4}`;
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const dom = [...hist.entries()].sort((a, c) => c[1] - a[1])[0][0].split(',').map((v) => (Number(v) << 4) + 8);
    const nearCol = all.filter((c) => Math.abs(c[0] - dom[0]) + Math.abs(c[1] - dom[1]) + Math.abs(c[2] - dom[2]) < 46);
    const pool = (nearCol.length > 12 ? nearCol : all).sort((a, c) => lum(...c) - lum(...a));
    const hi = pool[Math.floor(pool.length * 0.85)] || dom;
    const lo = pool[Math.floor(pool.length * 0.15)] || dom;

    // Outline colour: the darkest pixels of the ring, so an anti-aliased edge
    // pixel cannot decide the colour for the whole icon.
    const ringCols = [];
    for (let y = ly0; y <= ly1; y++) for (let x = lx0; x <= lx1; x++) {
      if (ring[y * w + x]) ringCols.push(px(rx + x, ry + y));
    }
    ringCols.sort((a, c) => lum(...a) - lum(...c));
    const oc = ringCols.length ? ringCols[Math.floor(ringCols.length * 0.25)] : [22, 40, 60];

    return {
      b: sb,
      strokePx,
      outline: rdp(traceOuter(mainFill.c), epsilon),
      inner: details.slice(0, 3).map((o) => rdp(traceOuter(o.c), epsilon)),
      parts: parts.map((o) => `${o.c.length / 2}px ${o.b.w}x${o.b.h}`),
      detailBoxes: details.map((o) => `${o.b.w}x${o.b.h}`),
      hi, lo, oc,
    };
  });
}, { src: dataUrl, epsilon: EPSILON });

await browser.close();
if (traced.error) { console.error(traced.error); process.exit(1); }

const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const lines = [];

for (let i = 0; i < traced.length; i++) {
  const t = traced[i];
  const name = NAMES[i];
  if (t.error) { lines.push(`${name}: ${t.error}`); continue; }
  const { b } = t;
  const deg = ROTATE[name] ?? 0;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const ccx = b.x0 + b.w / 2, ccy = b.y0 + b.h / 2;
  const rot = (x, y) => [ccx + (x - ccx) * cos - (y - ccy) * sin, ccy + (x - ccx) * sin + (y - ccy) * cos];

  // Stroke width in viewBox units, measured from the reference itself.
  const fit = VIEW - MARGIN * 2;
  const scale = Math.min(fit / b.w, fit / b.h);
  const sw = Math.max(0.7, Math.min(2.6, t.strokePx * scale));
  const shrink = 1 - (sw / 2) / (Math.max(b.w, b.h) * scale / 2);
  const s = scale * shrink;
  const cx = VIEW / 2, cy = VIEW / 2;

  const toPath = (p) => {
    const n = p.length / 2;
    const P = (k) => {
      const j = ((k % n) + n) % n;
      const [rx, ry] = rot(p[j * 2], p[j * 2 + 1]);
      return [(rx - ccx) * s + cx, (ry - ccy) * s + cy];
    };
    const mid = (a, c) => [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    const f = (v) => Math.round(v * 100) / 100;
    const m0 = mid(P(0), P(1));
    let d = `M${f(m0[0])} ${f(m0[1])}`;
    for (let k = 1; k <= n; k++) { const q = P(k), m = mid(q, P(k + 1)); d += `Q${f(q[0])} ${f(q[1])} ${f(m[0])} ${f(m[1])}`; }
    return d + 'Z';
  };

  const gid = `g${name.replace(/[^a-z]/g, '')}`;
  // Interior details are drawn WITHOUT the outline stroke. They are already
  // the outline colour, and a traced contour there is self-intersecting, so
  // stroking it balloons over the artwork it sits on.
  const inner = t.inner.map((p) => `    <path d="${toPath(p)}" fill="${hex(t.oc)}" stroke="none"/>`).join('\n');
  fs.writeFileSync(path.join('assets', 'threats', `${name}.svg`),
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img" aria-label="${name}">
  <!-- Silhouette traced 1:1 from the approved mockup by tools/trace-icons.mjs:
       the real pixel outline, simplified and smoothed. Not hand-drawn.
       Rotated ${deg}deg so the nose points NORTH (up). The renderer then
       rotates by the SOURCE heading: 0 N, 90 E, 180 S, 270 W. -->
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="${hex(t.hi)}"/>
      <stop offset="1" stop-color="${hex(t.lo)}"/>
    </linearGradient>
  </defs>
  <g stroke="${hex(t.oc)}" stroke-width="${Math.round(sw * 100) / 100}" stroke-linejoin="round" stroke-linecap="round">
    <path d="${toPath(t.outline)}" fill="url(#${gid})"/>
${inner}
  </g>
</svg>
`);
  lines.push(`${name.padEnd(16)} ${b.w}x${b.h}px  ${t.outline.length / 2} pts  rot ${String(deg).padStart(4)}deg  outline ${t.strokePx}px -> ${sw.toFixed(2)}u  ${hex(t.hi)}->${hex(t.lo)}  ink ${hex(t.oc)}  fill [${t.parts.join(', ')}]  detail [${t.detailBoxes.join(', ')}]`);
}
console.log(lines.join('\n'));
