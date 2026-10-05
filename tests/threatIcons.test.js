import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyThreat } from '../services/threatClassify.js';
import { META } from '../assets/js/map.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'assets/brand/threat-icons.svg'), 'utf8');

const REQUIRED = ['shahed', 'uav', 'recon', 'missile', 'ballistic', 'kab', 'aircraft', 'other'];

// All symbols with their viewBox + inner markup.
function symbols() {
  const out = new Map();
  for (const m of svg.matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"\s*>([\s\S]*?)<\/symbol>/g)) {
    out.set(m[1], { viewBox: m[2], body: m[3] });
  }
  return out;
}

// Bounding box over path coordinates + circle extents.
function bboxOf(body) {
  const xs = [], ys = [];
  for (const m of body.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"/g)) {
    const cx = Number(m[1]), cy = Number(m[2]), r = Number(m[3]);
    xs.push(cx - r, cx + r); ys.push(cy - r, cy + r);
  }
  for (const m of body.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"(?![^>]*r=)/g)) {
    xs.push(Number(m[1])); ys.push(Number(m[2]));
  }
  for (const m of body.matchAll(/d="([^"]+)"/g)) {
    const nums = m[1].match(/-?\d+(\.\d+)?/g) || [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(Number(nums[i])); ys.push(Number(nums[i + 1]));
    }
  }
  if (!xs.length) return null;
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

test('all 8 threat symbols exist with uniform viewBox 0 0 64 64', () => {
  const syms = symbols();
  for (const id of REQUIRED) {
    assert.ok(syms.has(id), `missing symbol #${id}`);
    assert.equal(syms.get(id).viewBox, '0 0 64 64', `#${id} must use viewBox 0 0 64 64`);
  }
  assert.equal(syms.size, REQUIRED.length, 'no extra/unexpected symbols');
});

test('no emoji or unicode pictographs in the icon file', () => {
  // eslint-disable-next-line no-misleading-character-class
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(svg), 'icons must be pure SVG paths, not emoji');
  assert.ok(!svg.includes('<text'), 'no text glyphs as icons');
  assert.ok(!/hotlink/.test(svg), 'no hotlinking');
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/)/.test(svg), 'no external references (except xmlns)');
});

test('elongated silhouettes are nose-up: nose near top, tail near bottom', () => {
  const syms = symbols();
  for (const id of ['shahed', 'recon', 'missile', 'ballistic', 'kab', 'aircraft']) {
    const box = bboxOf(syms.get(id).body);
    assert.ok(box, `#${id} has drawable geometry`);
    assert.ok(box.minY < 18, `#${id} nose must reach the top (minY=${box.minY})`);
    assert.ok(box.maxY > 44, `#${id} tail must reach the bottom (maxY=${box.maxY})`);
    const cx = (box.minX + box.maxX) / 2;
    assert.ok(Math.abs(cx - 32) < 7, `#${id} must be horizontally centered (cx=${cx.toFixed(1)})`);
  }
});

test('symmetric marks (uav/other) are centered, not offset', () => {
  const syms = symbols();
  for (const id of ['uav', 'other']) {
    const box = bboxOf(syms.get(id).body);
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    assert.ok(Math.abs(cx - 32) < 7 && Math.abs(cy - 32) < 9, `#${id} centered (c=${cx.toFixed(1)},${cy.toFixed(1)})`);
  }
});

test('ballistic is visibly heavier than cruise missile (distinct silhouettes)', () => {
  const syms = symbols();
  const w = (id) => { const b = bboxOf(syms.get(id).body); return b.maxX - b.minX; };
  assert.ok(w('ballistic') > w('missile'), `ballistic wider than missile (${w('ballistic').toFixed(1)} > ${w('missile').toFixed(1)})`);
});

test('kab is a fat bomb body, not a slender missile', () => {
  const syms = symbols();
  const b = bboxOf(syms.get('kab').body);
  const w = b.maxX - b.minX;
  assert.ok(w > 30, `kab UMPK band must span wide (width=${w.toFixed(1)})`);
});

// ── API kind -> SVG mapping (pipeline: normalize -> classifyThreat -> icon) ──
test('mapping: explicit Shahed/Geran -> #shahed', () => {
  for (const t of ['БПЛА Shahed-136', 'Шахед', 'Герань-2', 'Geran', 'камикадзе']) {
    const kind = classifyThreat({ kind: null, subtype: t, sourceType: 'uav', category: 'uav' });
    assert.equal(kind, 'shahed', t);
    assert.equal(META[kind].icon, 'shahed');
  }
});

test('mapping: generic БпЛА/дрон -> #uav, NEVER #shahed', () => {
  for (const t of ['БпЛА', 'БпЛА курсом на Конотоп', 'Дрон', '3 групи дронів з Сумщини курсом на Короп', 'Реактивний БпЛА на Іванків']) {
    const kind = classifyThreat({ kind: null, subtype: t, sourceType: 'uav', category: 'uav' });
    assert.equal(kind, 'uav', t);
    assert.equal(META[kind].icon, 'uav');
  }
});

test('mapping: recon/missile/ballistic/kab/aviation/unknown -> own icon', () => {
  const cases = [
    [{ kind: null, subtype: 'Орлан-10 розвідка', sourceType: 'x', category: 'recon' }, 'recon'],
    [{ kind: null, subtype: 'Крилата ракета Х-101', sourceType: 'x', category: 'missile' }, 'missile'],
    [{ kind: null, subtype: 'Іскандер-М', sourceType: 'x', category: 'ballistic' }, 'ballistic'],
    [{ kind: null, subtype: 'Пуск КАБ', sourceType: 'bomb', category: 'kab' }, 'kab'],
    [{ kind: null, subtype: 'Су-34', sourceType: 'x', category: 'aviation' }, 'aviation'],
    [{ kind: null, subtype: '???', sourceType: 'unknown', category: 'other' }, 'other'],
  ];
  const syms = symbols();
  for (const [ev, want] of cases) {
    const kind = classifyThreat(ev);
    assert.equal(kind, want, ev.subtype);
    assert.ok(syms.has(META[kind].icon), `icon #${META[kind].icon} exists for kind ${kind}`);
  }
});

// ── No geometric wrappers around single markers ──────────────────────────────
test('event/blip marker HTML is a bare SVG (no circle/triangle/diamond/label wrappers)', () => {
  const src = fs.readFileSync(path.join(root, 'assets/js/map.js'), 'utf8');
  const eventHtml = src.slice(src.indexOf('function eventIcon'), src.indexOf('function blipIcon'));
  const blipHtml = src.slice(src.indexOf('function blipIcon'), src.indexOf('function userIcon'));
  for (const [name, html] of [['eventIcon', eventHtml], ['blipIcon', blipHtml]]) {
    assert.ok(!html.includes('mk-label'), `${name}: no text label wrapper`);
    assert.ok(!html.includes('pulse'), `${name}: no pulse ring wrapper`);
    assert.ok(html.includes('class="threat-svg"'), `${name}: renders the threat SVG`);
  }
});

test('unknown threat is a diamond with a path-drawn question mark (no text element)', () => {
  const syms = symbols();
  const body = syms.get('other').body;
  assert.ok(!body.includes('<text'), 'no text glyphs');
  for (const m of body.matchAll(/<circle[^>]*r="([\d.]+)"/g)) {
    assert.ok(Number(m[1]) <= 3, 'only the question-mark dot, no ring mark');
  }
  const paths = [...body.matchAll(/<path[^>]*d="([^"]+)"/g)].map(m => m[1]);
  assert.ok(paths.length >= 2, 'diamond outline + question-mark paths');
  const box = bboxOf(body);
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  assert.ok(w > 20 && h > 20 && Math.abs(w - h) < 12, `diamond proportions (${w.toFixed(1)}x${h.toFixed(1)})`);
});

test('reference palette: UAV yellow, Shahed orange, recon cyan, aviation violet, KAB coral, unknown neutral', () => {
  assert.equal(META.uav.color.toLowerCase(), '#ffc43d');
  assert.equal(META.recon.color.toLowerCase(), '#62c7ff');
  assert.equal(META.missile.color.toLowerCase(), '#ff4d67');
  assert.equal(META.kab.color.toLowerCase(), '#ff806b');
  assert.equal(META.aviation.color.toLowerCase(), '#9b6cff');
  assert.equal(META.other.color.toLowerCase(), '#b8c5d1');
});

test('marker CSS: transparent container, per-kind sizes, directed rotation on the SVG', () => {
  const css = fs.readFileSync(path.join(root, 'assets/css/styles.css'), 'utf8');
  assert.ok(css.includes('.threat-marker svg.threat-svg'), 'threat SVG sizing rule exists');
  for (const kind of ['shahed', 'uav', 'recon', 'missile', 'ballistic', 'kab', 'aviation', 'other']) {
    assert.ok(css.includes(`.threat-marker.kind-${kind} svg.threat-svg`), `per-kind size for ${kind}`);
  }
  assert.ok(css.includes('[data-directed="true"]'), 'directed markers rotate only with real heading');
  assert.ok(css.includes('transform-box: fill-box'), 'rotation is centered on the silhouette');
});

console.log('All threat icon tests passed!');
