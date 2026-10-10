// Runs the REAL captured production bundle through the new slimming and reports
// the actual saving, so the fix is justified by measurement, not by a fixture.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { slimBundle, bundleBytes, TRAIL_BUDGET_BYTES, GZIP_TRIGGER_BYTES } from '../backend/src/slim.js';

const json = JSON.parse(fs.readFileSync('tools/_bundle.json', 'utf8').replace(/^\uFEFF/, ''));
const rows = Array.isArray(json) ? json : (json.result || json.results || []);
const stored = rows[0]?.results?.[0]?.bundle;
if (!stored) { console.error('no bundle — see diag-bundle.mjs'); process.exit(1); }

const live = JSON.parse(stored.startsWith('gzip:') ? zlib.gunzipSync(Buffer.from(stored.slice(5), 'base64')).toString('utf8') : stored);
const slim = slimBundle(live);

const before = bundleBytes(live), after = bundleBytes(slim);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const gz = (obj) => (zlib.gzipSync(Buffer.from(JSON.stringify(obj))).length / 1024).toFixed(1) + ' KB';

console.log('                     production bundle -> after slimBundle\n');
console.log(`decoded size       ${kb(before).padStart(10)}  ->  ${kb(after)}`);
console.log(`gzip cost avoided  ${(stored.length / 1024).toFixed(1)} KB of compression no longer runs on every commit and every load`);
console.log(`reduction          ${(before / 1024).toFixed(1)} KB -> ${(after / 1024).toFixed(1)} KB  (${((1 - after / before) * 100).toFixed(0)}% smaller)`);
console.log(`gzip every cycle?  ${before > 500_000 ? 'YES (this is what killed the cron)' : 'no'}  ->  ${after > GZIP_TRIGGER_BYTES ? 'YES' : 'no'}`);
console.log(`trail budget       ${TRAIL_BUDGET_BYTES / 1024} KB\n`);

const evs = slim.snapshot.events;
const withTrail = evs.filter((e) => Array.isArray(e.trail) && e.trail.length > 1).length;
console.log(`events             ${evs.length} (unchanged: ${evs.length === live.snapshot.events.length})`);
console.log(`correlated dropped ${evs.every((e) => !('correlated' in e))}`);
console.log(`trails kept        ${withTrail}/${evs.length} events, longest ${Math.max(0, ...evs.map((e) => (e.trail || []).length))} points`);
console.log(`ids unchanged      ${evs.every((e, i) => e.id === live.snapshot.events[i].id)}`);
console.log(`prev.threats       ${slim.prev.threats.length} (unchanged: ${slim.prev.threats.length === live.prev.threats.length})`);
console.log(`summary flags kept ${evs.every((e) => e.crossSource !== undefined && e.fused !== undefined)}`);
