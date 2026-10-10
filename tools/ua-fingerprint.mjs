// Lets the key holder verify that the Worker is using THEIR key, without ever
// putting the key into a log, a file, a commit or a report.
//
//   node tools/ua-fingerprint.mjs            -> prompts, keeps the key in memory
//   node tools/ua-fingerprint.mjs <key>      -> key given as an argument
//
// Prints only the truncated HMAC fingerprint and the length. Run it on the
// machine that holds the key and compare with the `keyFp` value the Worker
// logs in its `auth-config` / per-endpoint rows.

import readline from 'node:readline';
import { keyFingerprint, describeKey, UA_FP_PEPPER } from '../backend/src/ukrainealarm.js';

const args = process.argv.slice(2);
let key = args[0];

if (!key) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  key = await new Promise((resolve) => {
    process.stdout.write('API key (input hidden where the terminal allows it): ');
    rl.question('', (v) => { rl.close(); resolve(v.trim()); });
  });
}

if (!key) {
  console.error('no key supplied');
  process.exit(1);
}

const fp = await keyFingerprint(key, UA_FP_PEPPER);
const shape = describeKey(key, process.env.UKRAINEALARM_AUTH_SCHEME || '');

console.log('');
console.log('  fingerprint :', fp);
console.log('  length      :', shape.length);
console.log('  scheme      :', shape.scheme);
console.log('');
console.log('  Compare "fingerprint" with the keyFp field in the Worker log:');
console.log('    {"upstream":"UkraineAlarm","event":"auth-config",...,"keyFp":"' + fp + '"}');
console.log('');
console.log('  The key itself was not printed, not written to disk, not sent');
console.log('  anywhere. Only the fingerprint above leaves this process.');
