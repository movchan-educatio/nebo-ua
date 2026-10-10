// Pulls the live pipeline_state bundle, gunzips it and reports what is inside
// and how big each part is. Read-only diagnostics.
//
// Fetch it first (wrangler's own quoting is easier to get right in the shell):
//   wrangler.cmd d1 execute nebo-journal --remote --json \
//     --command "SELECT bundle FROM pipeline_state WHERE id=1;" > tools/_bundle.json
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = 'tools/_bundle.json';
if (!fs.existsSync(file)) {
  console.error(`missing ${file} — see the comment at the top of this file`);
  process.exit(1);
}
// PowerShell writes a BOM; strip it before parsing.
const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const rows = Array.isArray(json) ? json : (json.result || json.results || []);
const bundleStr = rows[0]?.results?.[0]?.bundle;
if (!bundleStr) { console.error('no bundle in response'); process.exit(1); }
const gz = bundleStr.startsWith('gzip:');
const text = gz ? zlib.gunzipSync(Buffer.from(bundleStr.slice(5), 'base64')).toString('utf8') : bundleStr;
const b = JSON.parse(text);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
const part = (name, v) => `${name.padEnd(26)} ${Array.isArray(v) ? String(v.length).padStart(5) : '-'} items  ${kb(JSON.stringify(v ?? null))}`;

console.log(`stored bundle   : ${kb(bundleStr)} (${gz ? 'gzip' : 'plain'})`);
console.log(`decoded bundle  : ${kb(text)}`);
console.log(`gzip threshold  : 500.0 KB  -> ${Buffer.byteLength(text) > 500_000 ? 'ABOVE, so it is packed every cycle' : 'below, stored plain'}`);
console.log(`D1 row limit    : 1.9 MB   -> headroom ${kb('x'.repeat(0)) || (1.9 * 1024 * 1024 / 1024 - Buffer.byteLength(bundleStr) / 1024).toFixed(0)} KB`);
console.log('');
console.log(part('prev.alerts', b.prev?.alerts));
console.log(part('prev.threats', b.prev?.threats));
console.log(part('snapshot.alerts', b.snapshot?.alerts));
console.log(part('snapshot.events', b.snapshot?.events));
console.log(part('officialItems', b.officialItems));
console.log(part('fpAlerts', b.fpAlerts));
console.log(part('fpThreats', b.fpThreats));
console.log('');
console.log(`dataUpdatedAt   : ${b.snapshot?.dataUpdatedAt}`);
console.log(`pipelineCheckedAt: ${b.snapshot?.pipelineCheckedAt}`);
console.log(`writtenAt       : ${b.writtenAt}`);

// Where the bytes actually are.
const sizes = Object.entries(b).map(([k, v]) => [k, Buffer.byteLength(JSON.stringify(v ?? null))]).sort((a, c) => c[1] - a[1]);
console.log('\ntop-level fields by size:');
for (const [k, n] of sizes.slice(0, 8)) console.log(`  ${k.padEnd(22)} ${(n / 1024).toFixed(1)} KB  ${((n / Buffer.byteLength(text)) * 100).toFixed(1)}%`);

if (b.prev?.threats?.length) {
  const bySource = {};
  for (const t of b.prev.threats) bySource[t.source] = (bySource[t.source] || 0) + 1;
  console.log('\nprev.threats by source:', JSON.stringify(bySource));
  const stale = b.prev.threats.filter((t) => t.stale).length;
  console.log(`prev.threats stale: ${stale}/${b.prev.threats.length}`);
  const ages = b.prev.threats.map((t) => (Date.now() - Date.parse(t.eventTime || t.timestamp || 0)) / 60000)
    .filter(Number.isFinite).sort((a, c) => a - c);
  if (ages.length) console.log(`eventTime age min/med/max (min): ${ages[0].toFixed(0)} / ${ages[ages.length >> 1].toFixed(0)} / ${ages.at(-1).toFixed(0)}`);
}

// Where the bytes inside the big arrays actually are.
function fieldBreakdown(label, arr) {
  if (!arr?.length) return;
  const totals = new Map();
  for (const item of arr) {
    for (const [k, v] of Object.entries(item)) {
      totals.set(k, (totals.get(k) || 0) + Buffer.byteLength(JSON.stringify(v ?? null)));
    }
  }
  const total = [...totals.values()].reduce((a, c) => a + c, 0);
  console.log(`\n${label}: ${arr.length} items, ${(total / 1024).toFixed(1)} KB total, ${(total / arr.length / 1024).toFixed(2)} KB each`);
  for (const [k, n] of [...totals.entries()].sort((a, c) => c[1] - a[1]).slice(0, 12)) {
    console.log(`  ${k.padEnd(20)} ${(n / 1024).toFixed(1).padStart(7)} KB  ${((n / total) * 100).toFixed(1).padStart(5)}%`);
  }
}
fieldBreakdown('snapshot.events', b.snapshot?.events);
fieldBreakdown('snapshot.alerts', b.snapshot?.alerts);
fieldBreakdown('prev.threats', b.prev?.threats);
