import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Entry JS files that run in the browser. A single bad named import here
// kills the whole module (as happened with fetchRaionBorders) and leaves
// production with an empty map, while all Node unit tests still pass.
const ENTRIES = [
  'assets/js/app.js',
  'assets/js/map.js',
  'assets/js/enhancements.js',
  'assets/js/widget.js',
  'assets/js/scope.js',
];

function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const alias = t.split(/\s+as\s+/i).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
    }
  }
  return names;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare/external: skip
  return path.normalize(path.join(path.dirname(path.join(root, fromFile)), spec));
}

test('browser entry imports resolve to real files and real named exports', () => {
  const failures = [];
  for (const entry of ENTRIES) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[2];
      const target = resolveImport(entry, spec);
      if (!target) continue;
      const candidates = [target, target + '.js'];
      const found = candidates.find(c => fs.existsSync(c));
      if (!found) {
        failures.push(`${entry}: import target not found: ${spec}`);
        continue;
      }
      const targetSrc = fs.readFileSync(found, 'utf8');
      const exports = exportedNames(targetSrc);
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/i).pop().trim();
        if (!name) continue;
        if (!exports.has(name)) {
          failures.push(`${entry}: '${name}' is not exported by ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], 'All browser named imports must exist:\n' + failures.join('\n'));
});

test('app.js must not import fetchRaionBorders from raionShapesLocal (regression)', () => {
  const src = fs.readFileSync(path.join(root, 'assets/js/app.js'), 'utf8');
  assert.ok(
    !/import\s*\{[^}]*\bfetchRaionBorders\b[^}]*\}\s*from\s*['"][^'"]*raionShapesLocal\.js['"]/.test(src),
    'app.js must not import fetchRaionBorders from raionShapesLocal.js (it does not export it; this broke production)',
  );
});

test('raionShapesLocal resource URLs are base-independent (no hardcoded repo subpath)', () => {
  const src = fs.readFileSync(path.join(root, 'services/raionShapesLocal.js'), 'utf8');
  assert.ok(!src.includes("'/nebo-ua/'") && !src.includes('"/nebo-ua/"'), 'no hardcoded /nebo-ua/ base');
  assert.ok(src.includes('import.meta.url'), 'resource URLs must derive from import.meta.url');
  const regionsSrc = fs.readFileSync(path.join(root, 'services/regions.js'), 'utf8');
  assert.ok(!regionsSrc.includes("'/nebo-ua/'") && !regionsSrc.includes('"/nebo-ua/"'), 'no hardcoded /nebo-ua/ base in regions.js');
});
