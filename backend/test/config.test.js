import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBindings } from '../src/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8');

function tomlBindings() {
  const names = new Set();
  for (const m of toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"\s*$/gm)) names.add(m[1]);
  return names;
}
function tomlVars() {
  const names = new Set();
  const varsSection = toml.split('[vars]')[1]?.split('[')[0] || '';
  for (const m of varsSection.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm)) names.add(m[1]);
  return names;
}
function codeEnvNames() {
  const names = new Set();
  const srcDir = path.join(root, 'src');
  for (const f of fs.readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of src.matchAll(/env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  }
  return names;
}
// Secrets live in the dashboard, not in wrangler.toml.
const SECRET_ALLOWLIST = new Set(['OFFICIAL_API_TOKEN', 'VAPID_PRIVATE_KEY', 'UKRAINEALARM_API_KEY']);

test('every env.* used in src exists as a binding, var, or known secret', () => {
  const available = new Set([...tomlBindings(), ...tomlVars(), ...SECRET_ALLOWLIST]);
  const missing = [...codeEnvNames()].filter(n => !available.has(n));
  assert.deepEqual(missing, [], `missing env names: ${missing.join(', ')}`);
});

test('D1 binding used by code matches wrangler.toml', () => {
  assert.ok(tomlBindings().has('nebo_journal'));
  const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  assert.match(indexSrc, /env\.nebo_journal/);
  assert.doesNotMatch(indexSrc, /env\.JOURNAL\b/);
});

test('KV binding used by code matches wrangler.toml', () => {
  assert.ok(tomlBindings().has('NEBO_STATE'));
  const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  assert.match(indexSrc, /env\.NEBO_STATE/);
  assert.doesNotMatch(indexSrc, /env\.STATE\b/);
});

test('checkBindings reports missing bindings by name', () => {
  assert.deepEqual(checkBindings({}), ['NEBO_STATE (KV)', 'nebo_journal (D1)']);
  const fakeDb = { prepare: () => ({}) };
  const fakeKv = { get: async () => null, put: async () => {} };
  assert.deepEqual(checkBindings({ NEBO_STATE: fakeKv, nebo_journal: fakeDb }), []);
  assert.deepEqual(checkBindings({ NEBO_STATE: fakeKv }), ['nebo_journal (D1)']);
});
