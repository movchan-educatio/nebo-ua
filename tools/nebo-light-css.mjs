// Converts the /nebo/ stylesheets from dark to light.
//
// Why a script and not a find-and-replace by eye: styles.css and dashboard.css
// hold 324 colour occurrences across 204 distinct values, and a missed one is
// a black rectangle on an otherwise light page that only shows up at a width
// nobody checked. Every change here is a named rule, and anything the map does
// not recognise is REPORTED rather than silently left behind.
//
// Scope safety: styles.css and dashboard.css are loaded by exactly one page,
// nebo/index.html. The radar and every document page load radar/radar.css only,
// so nothing in this file can reach them.
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['assets/css/styles.css', 'assets/css/dashboard.css'];

// ── The light palette: radar/radar.css :root, verbatim ───────────────────────
const PALETTE = `
:root {
  color-scheme: light;
  --bg: #F4F6F9;
  --bg2: #EEF2F7;
  --surface: #FFFFFF;
  --surface-2: #F8FAFC;
  --surface-3: #EEF2F7;
  --text: #14263D;
  --muted: #64748B;
  --faint: #94A3B8;
  --line: #E2E8F0;
  --line-soft: #EDF1F6;
  --cyan: #477FE0;
  --blue: #477FE0;
  --red: #EF3F36;
  --green: #16A36A;
  --success: #16A36A;
  --amber: #D98324;
  --orange: #F08B2F;
  --yellow: #EBAA19;
  --gold: #A8760A;
  --purple: #7C4DCC;
  --ink-on-accent: #FFFFFF;
}
`;

// ── RGB map, applied to every hex literal, alpha preserved ──────────────────
// Grouped by role. Dark-theme accents with alpha invert in meaning: a cyan glow
// at 40% over a light page is invisible, so those become a dark accent at the
// same alpha. Light tints invert too: #8df0bd reads as nothing on white.
const RGB = {
  // page / panel surfaces
  '02070b': 'F4F6F9', '050b12': 'F4F6F9', '05090d': 'F4F6F9', '081019': 'EEF2F7',
  '0b131b': 'FFFFFF', '08151f': 'FFFFFF', '08121a': 'FFFFFF', '080f15': 'F8FAFC',
  '080f14': 'F8FAFC', '0c1720': 'FFFFFF', '0b1723': 'FFFFFF', '060d14': 'F8FAFC',
  '0d1824': 'FFFFFF', '0d1826': 'FFFFFF', '0d1c28': 'F8FAFC', '0e1a23': 'FFFFFF',
  '0e1a24': 'FFFFFF', '0e1b29': 'F8FAFC', '0b1622': 'FFFFFF', '0b1b27': 'FFFFFF',
  '0d1a26': 'FFFFFF', '07131c': 'FFFFFF', '0a141d': 'FFFFFF', '0a1013': 'FFFFFF',
  // map and scope backdrops (the disc behind tiles)
  '0a2a18': 'EAF7F0', '061a0f': 'D6EEE0', '030c07': 'C2E4D2', '0d2635': 'CBD5E1',
  '16233a': '94A3B8', '1a3a4a': '94A3B8', '020805': 'EAF7F0',
  // text
  'e7f2f8': '14263D', 'e8f3fa': '14263D', '8ca4b3': '64748B', '5f7d8f': '94A3B8',
  '8fa4b5': '94A3B8', 'b8c5d1': '94A3B8', 'dceaf2': '14263D', 'dce8f2': '14263D',
  '9fd8f5': '14263D', '9fc9e8': '64748B', 'cfe0ec': '14263D', '9fb0bd': '64748B',
  '5b6b78': '94A3B8', '8fb0c2': '477FE0', '9fe8c6': '16A36A', 'bfe3fa': '14263D',
  '8fb0c9': '64748B', '9fe8c6': '0F7A4E', 'b9ffdc': '16A36A', '9dffcc': '0F7A4E',
  // accents
  '58c7ff': '477FE0', '38e1ff': '477FE0', '4da3ff': '477FE0', '66c7ff': '477FE0',
  '7db9ff': '477FE0', '7fa8c9': '64748B', '2f7ba8': '3B6BC4', '1d5a7e': '2A5499',
  '1d4e73': '2A5499', '3f7ea8': '3B6BC4', '1d6ca8': '2A5499', '3f8fd0': '3B6BC4',
  '4d7fa0': '3B6BC4', '2179ba': '33619E', '62c7ff': '477FE0', 'b06bff': '7C4DCC',
  '9b6cff': '7C4DCC',
  'ff536a': 'EF3F36', 'ff4d5e': 'EF3F36', 'ff2233': 'EF3F36', 'ff6f7d': 'EF3F36',
  'ff8f9a': 'C2261E', 'ff9ca5': 'C2261E', 'ff22331f': 'EF3F36',
  'ffaa32': 'EBAA19', 'ffaa27': 'EBAA19', 'ff9f43': 'F08B2F', 'ffd23d': 'EBAA19',
  'efb55b': 'D98324', 'f7b547': 'EBAA19', 'f3d6a6': '8A5300', 'ffd8db': '8F1D14',
  'f2905d': 'F08B2F',
  '42e8a4': '16A36A', '3dff9e': '16A36A', '8df0bd': '0F7A4E',
  'f3bd3d': 'A8760A',
  // state tints (dark-theme tinted panels -> light tinted panels)
  '0a1f16': 'E6F6EE', '372b19': 'FDF3E3', '3a171c': 'FDECEA', '18232d': 'EEF2F7',
  '2a1418': 'FDECEA', '2a1216': 'FDECEA',
  // white overlays: on a dark panel a white 5% lifts it; on a light one it
  // would be invisible, so these become a dark ink at the same weight.
  'ffffff08': '14263D08', 'ffffff0c': '14263D0C', 'ffffff0d': '14263D0D',
  'ffffff10': '14263D10', 'ffffff14': '14263D14', 'ffffff17': '14263D17',
  'ffffff2a': 'CBD5E1',
  // ambient washes
  '10283a': 'DDE7F2', '0f3127': 'E4ECF6',
  // diagnostics
  '8f8': '16A36A', '0f0': '16A36A',
  // leftovers found by the unmapped report on the first run
  '010409': '14263D',   // dialog backdrop: a dimmed page, not a hole
  '03080c': 'FFFFFF',   // deg / range-label chips over the scope
  '0d080a': 'FFF7F6',   // sky-hero alert wash
  '2a4a63': 'CBD5E1',   // map button border
  '231603': '231603',   // gold button label — deliberately dark on a gold fill
};

const hexToRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const rgbToHex = (r) => r.map((v) => v.toString(16).padStart(2, '0')).join('');

const unmapped = new Map();

// Rewrites #rgb/#rgba/#rrggbb/#rrggbbaa, preserving the alpha byte exactly.
function mapHex(src, file) {
  return src.replace(/#([0-9a-fA-F]{3,8})\b/g, (m, hex) => {
    let h = hex, alpha = '';
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    else if (h.length === 4) { h = h.slice(0, 3).split('').map((c) => c + c).join(''); alpha = h.slice(3, 4) + h.slice(3, 4); h = h.slice(0, 3); }
    else if (h.length === 8) { alpha = hex.slice(6, 8); h = hex.slice(0, 6); }
    if (h.length !== 6) return m;
    const key = h.toLowerCase();
    const target = RGB[key];
    if (!target) {
      // Only complain about colours that are actually dark. Light or neutral
      // literals are frequently deliberate: flag colours, gold gradients, UA.
      const [r, g, b] = hexToRgb(key);
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (l < 0.45 && key !== '000000') {
        if (!unmapped.has(key)) unmapped.set(key, new Set());
        unmapped.get(key).add(path.basename(file));
      }
      return m;
    }
    return '#' + target.toUpperCase() + alpha;
  });
}

function mapRgbFns(src, file) {
  return src.replace(/\brgba?\(([^)]+)\)/g, (m, inner) => {
    const parts = inner.split(',').map((s) => s.trim());
    if (parts.length < 3) return m;
    const key = parts.slice(0, 3).join(',').toLowerCase().replace(/\s+/g, '');
    const a = parts[3];
    const target = RGB[key];
    if (!target) return m;
    const rgb = hexToRgb(target.toLowerCase()).join(',');
    return a !== undefined ? `rgba(${rgb},${a})` : `rgb(${rgb})`;
  });
}

// ── Explicit rules, applied after the global map ────────────────────────────
// These exist because one source hex means two different things. #02070B is the
// page background in one rule and the backdrop behind map tiles in another; a
// global map cannot know which, so the map backdrop is corrected by hand.
const OVERRIDES = [
  // Map and scope backdrops: a hair darker than the page so the disc reads as
  // an instrument sitting on the surface, not as a hole in it.
  ['.leaflet-container{font:inherit;background:#F4F6F9}', '.leaflet-container{font:inherit;background:#E8EDF2}'],
  ['.map-wrap{background:#F4F6F9', '.map-wrap{background:#E8EDF2'],
  ['.radar-stage{background:#F4F6F9', '.radar-stage{background:#E8EDF2'],
];

// Declarations replaced whole, before any colour mapping.
const PRE = [
  // The raster fallback was darkened with an invert filter to fake the old
  // look. On a light page that produced a black map for anyone without WebGL.
  [
    /filter:grayscale\(\.85\) invert\(\.91\) hue-rotate\(180deg\) brightness\(\.52\) contrast\(1\.35\) saturate\(\.7\)/g,
    'filter:saturate(.72) brightness(1.02) contrast(1.02)',
  ],
  [
    /filter:grayscale\(\.95\) invert\(\.91\) hue-rotate\(180deg\) brightness\(\.52\) contrast\(1\.6\) saturate\(\.48\)/g,
    'filter:saturate(.72) brightness(1.02) contrast(1.04)',
  ],
  ['color-scheme:dark', 'color-scheme:light'],
  ['/* Небо.UA — LIVE tactical air-threat radar UI (reference rebuild).\n   Base #02070B; panels deep-navy translucent; cyan = nav/radar; gold = brand/active. */',
   '/* Небо.UA — LIVE air-threat radar UI. Light theme, sharing the radar\'s palette\n   (radar/radar.css :root) so /nebo/ and / read as one site. */'],
  ['/* НЕБО UA — premium dashboard theme (reference rebuild).\n   Dark tactical navy, glass panels, glow accents. Mobile-first responsive. */',
   '/* НЕБО UA — premium dashboard. Light theme on the radar\'s palette.\n   Mobile-first responsive. */'],
];

for (const f of FILES) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s;

  for (const [pat, to] of PRE) s = typeof pat === 'string' ? s.split(pat).join(to) : s.replace(pat, to);

  s = mapHex(s, f);
  s = mapRgbFns(s, f);
  for (const [from, to] of OVERRIDES) s = s.split(from).join(to);

  // Replace the token block only. The anchor is --bg, which appears in exactly
  // one :root per file; the others are layout overrides like
  // `:root{--header-h:48px}` that must survive untouched.
  //
  // The first version of this used a second pattern, /:root\{[\s\S]*?\n\}/,
  // to catch the multi-line block. It did not: a lazy match that crosses
  // newlines swallows every rule up to the next `\n}`, and it silently deleted
  // 27 rules including `.map-hud .hud-recent` and `.radar-right`. A single
  // :root-anchored pattern with `[^}]*` cannot cross a rule boundary.
  const tokenBlock = /:root\s*\{[^}]*--bg:[^}]*\}/;
  if (!tokenBlock.test(s)) {
    console.log(`  ${f}: WARNING no token block matched`);
  }
  s = s.replace(tokenBlock, PALETTE.trim());

  fs.writeFileSync(f, s, 'utf8');
  console.log(`${f}: ${before === s ? 'UNCHANGED' : 'rewritten'}`);
}

// ── Report on the FINAL content, not on the pre-replacement text ────────────
// The first version collected unmapped colours while mapping and printed them
// afterwards, so it named #173343 and #1B3A52 as leftovers when they were only
// ever inside the token block that was then replaced wholesale. A check that
// cries wolf gets ignored, so this re-scans what actually shipped.
const shipped = new Map();
for (const f of FILES) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
    if (h.length !== 6) continue;
    const key = h.toLowerCase();
    const [r, g, b] = hexToRgb(key);
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (l < 0.45 && key !== '000000' && key !== '231603') {
      if (!shipped.has(key)) shipped.set(key, new Set());
      shipped.get(key).add(path.basename(f));
    }
  }
}
console.log('\n=== dark hex still present in the shipped CSS ===');
if (!shipped.size) console.log('  (none) — every dark literal has a light rule');
for (const [hex, files] of [...shipped].sort()) {
  const [r, g, b] = hexToRgb(hex);
  console.log(`  #${hex.toUpperCase()}  rgb(${r},${g},${b})  in ${[...files].join(', ')}`);
}
