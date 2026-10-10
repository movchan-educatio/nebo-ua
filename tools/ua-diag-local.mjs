// LOCAL verification of the UkraineAlarm diagnostics.
//
// Runs the REAL adapter code against the REAL API, using a deliberately
// invalid key, and prints the telemetry it emits. This proves the diagnostic
// path works end to end and classifies real responses correctly — without
// touching the production secret and without changing the auth scheme.
//
//   node tools/ua-diag-local.mjs
import { fetchOfficialUkraineAlarm, describeKey, keyFingerprint, classifyUaResponse, UA_FP_PEPPER } from '../backend/src/ukrainealarm.js';

const lines = [];
const real = console.log;
console.log = (...a) => { lines.push(a.map(String).join(' ')); };

const DUMMY = 'sk-local-verification-invalid-key-0000';
const env = {
  UKRAINEALARM_API_KEY: DUMMY,
  UKRAINEALARM_AUTH_SCHEME: '',
  UKRAINEALARM_API_URL: 'https://api.ukrainealarm.com',
};

const result = await fetchOfficialUkraineAlarm(env);
console.log = real;

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const rows = lines.map(parse).filter(Boolean);

console.log('LOCAL VERIFICATION — real adapter, real API, deliberately invalid key\n');
console.log('credential report');
const cfg = rows.find((r) => r.event === 'auth-config');
console.log('  ' + JSON.stringify(cfg));
console.log('');
console.log('per-endpoint telemetry');
for (const r of rows.filter((x) => x.endpoint)) {
  console.log(`  ${String(r.endpoint).padEnd(8)} status=${String(r.status).padEnd(5)} class=${String(r.class).padEnd(13)} ${String(r.durationMs).padStart(5)}ms  scheme=${r.scheme}  keyFp=${r.keyFp}`);
}
console.log('');
console.log('cycle outcome');
const failed = rows.find((r) => r.event === 'cycle-failed');
console.log('  ' + JSON.stringify(failed));
console.log('  ok=' + result.ok + '  items=' + result.items.length + '  (no false all-clear: ok must be false)');
console.log('');

// Proof the secret cannot have leaked into any emitted line.
const joined = lines.join('\n');
console.log('leak check');
console.log('  key present in any log line :', joined.includes(DUMMY));
console.log('  "Authorization" in output   :', joined.includes('Authorization'));
console.log('  lines emitted               :', lines.length);

// Both endpoints must carry the SAME scheme + fingerprint: that is the
// runtime proof they are configured identically.
const eps = rows.filter((x) => x.endpoint);
const consistent = eps.length > 0 && eps.every((e) => e.scheme === eps[0].scheme && e.keyFp === eps[0].keyFp);
console.log('  endpoints share one auth id :', consistent);

console.log('\nfingerprint reproducibility');
const fp = await keyFingerprint(DUMMY, UA_FP_PEPPER);
console.log('  local fingerprint           :', fp);
console.log('  matches the Worker log value:', eps.every((e) => e.keyFp === fp));

console.log('\nclassification of the responses actually observed');
for (const e of eps) console.log(`  ${e.endpoint}: ${e.status} -> ${e.class}`);
console.log(`  (a 403 with an HTML body would classify as 'edge_blocked', not 'forbidden': ${classifyUaResponse(403, 'text/html')})`);

if (result.ok !== false) { console.error('\nFAIL: a rejected key must never report ok=true'); process.exit(1); }
if (joined.includes(DUMMY)) { console.error('\nFAIL: the key leaked into a log line'); process.exit(1); }
if (!consistent) { console.error('\nFAIL: endpoints disagree on auth configuration'); process.exit(1); }
console.log('\nAll local checks passed.');
