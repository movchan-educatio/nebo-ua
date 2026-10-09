// Minimal but CORRECT SVG path bounding box: handles M/L/H/V/C/S/Q/T/A/Z in
// both absolute and relative forms. Needed because a naive number-pairing
// parser silently mis-reads relative commands (e.g. "l-4.7-5.5").
const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let m;
  while ((m = re.exec(d))) out.push(m[1] ? { cmd: m[1] } : { num: parseFloat(m[2]) });
  return out;
}

export function pathBBox(d) {
  const toks = tokenize(d);
  let i = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd = null;
  const minX = [], minY = [], maxX = [], maxY = [];
  const pt = (x, y) => { minX.push(x); maxX.push(x); minY.push(y); maxY.push(y); };
  const num = () => { const t = toks[i++]; return t && t.num !== undefined ? t.num : NaN; };
  const isCmd = (t) => t && t.cmd !== undefined;

  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++].cmd;
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (!(C in ARG_COUNT)) { i++; continue; }
    if (C === 'Z') { cx = sx; cy = sy; cmd = null; continue; }
    const n = ARG_COUNT[C];
    const a = [];
    for (let k = 0; k < n; k++) a.push(num());
    if (a.some((v) => !Number.isFinite(v))) break;

    if (C === 'M') {
      cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1];
      sx = cx; sy = cy; pt(cx, cy);
      cmd = rel ? 'l' : 'L';            // implicit lineto for extra pairs
    } else if (C === 'L') {
      cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1]; pt(cx, cy);
    } else if (C === 'H') {
      cx = rel ? cx + a[0] : a[0]; pt(cx, cy);
    } else if (C === 'V') {
      cy = rel ? cy + a[0] : a[0]; pt(cx, cy);
    } else if (C === 'C') {
      for (let k = 0; k < 6; k += 2) pt(rel ? cx + a[k] : a[k], rel ? cy + a[k + 1] : a[k + 1]);
      cx = rel ? cx + a[4] : a[4]; cy = rel ? cy + a[5] : a[5];
    } else if (C === 'S' || C === 'Q') {
      const step = C === 'S' ? 2 : 2;
      for (let k = 0; k < step; k += 2) pt(rel ? cx + a[k] : a[k], rel ? cy + a[k + 1] : a[k + 1]);
      cx = rel ? cx + a[step] : a[step]; cy = rel ? cy + a[step + 1] : a[step + 1];
    } else if (C === 'T') {
      pt(rel ? cx + a[0] : a[0], rel ? cy + a[1] : a[1]);
      cx = rel ? cx + a[0] : a[0]; cy = rel ? cy + a[1] : a[1];
    } else if (C === 'A') {
      // Approximate an elliptical arc by its endpoints: exact extents are not
      // needed here, only "does the artwork stay inside the viewBox".
      pt(rel ? cx + a[5] : a[5], rel ? cy + a[6] : a[6]);
      cx = rel ? cx + a[5] : a[5]; cy = rel ? cy + a[6] : a[6];
    }
  }
  if (!minX.length) return null;
  return { minX: Math.min(...minX), maxX: Math.max(...maxX), minY: Math.min(...minY), maxY: Math.max(...maxY) };
}

/** Union bbox of every path in an SVG fragment. */
export function svgBBox(svg, strokeWidth = 0) {
  const pad = strokeWidth / 2;
  let box = null;
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const b = pathBBox(m[1]);
    if (!b) continue;
    box = box ? {
      minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX),
      minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY),
    } : b;
  }
  if (!box) return null;
  return { minX: box.minX - pad, maxX: box.maxX + pad, minY: box.minY - pad, maxY: box.maxY + pad };
}