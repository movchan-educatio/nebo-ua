// Production observation: watch the aggregator for N minutes and report
// whether the pipeline actually advances (real updates, not just a 200 OK).
import https from 'node:https';

const STATE = 'https://check-ua-proxy.kykyyzka.workers.dev/v1/state';
const METRICS = 'https://check-ua-proxy.kykyyzka.workers.dev/v1/metrics';
const SITE = 'https://nebo-ua.vercel.app/';
const MINUTES = Number(process.argv[2] || 32);
const INTERVAL_S = Number(process.argv[3] || 120);

function get(url) {
  return new Promise((res) => {
    const req = https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (r) => {
      let b = ''; r.on('data', d => (b += d));
      r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.setTimeout(25000, () => { req.destroy(); res({ status: 0, body: '', error: 'timeout' }); });
    req.on('error', (e) => res({ status: 0, body: '', error: e.message }));
  });
}

const seenChecked = new Set();
const seenPublished = new Set();
const rows = [];
const t0 = Date.now();
console.log(`Observing ${MINUTES} min, poll every ${INTERVAL_S}s\n`);

while ((Date.now() - t0) / 60000 < MINUTES) {
  const [st, mt, site] = await Promise.all([get(STATE), get(METRICS), get(SITE)]);
  const now = new Date();
  let line = {
    at: now.toISOString(),
    state: st.status,
    site: site.status,
  };
  try {
    const j = JSON.parse(st.body);
    line.checkedAt = j.pipelineCheckedAt;
    line.publishedAt = j.publishedAt;
    line.dataUpdatedAt = j.dataUpdatedAt;
    line.events = (j.events || []).length;
    line.alerts = (j.alerts || []).length;
    line.health = Object.fromEntries(Object.entries(j.health || {}).map(([k, v]) => [k, v.status]));
    line.nOk = (j.health?.NEPTUN?.status === 'online' ? 1 : 0) + (j.health?.MAPA?.status === 'online' ? 1 : 0);
    if (line.checkedAt) seenChecked.add(line.checkedAt);
    if (line.publishedAt) seenPublished.add(line.publishedAt);
  } catch { line.parseError = true; }
  try {
    const m = JSON.parse(mt.body);
    line.lastOk = Object.fromEntries(Object.entries(m.sources || {}).map(([k, v]) => [k, v.lastOkAt]));
  } catch { /* metrics optional */ }

  const ageS = line.checkedAt ? Math.round((now - new Date(line.checkedAt)) / 1000) : null;
  const level = ageS == null ? 'OFFLINE' : ageS > 1800 ? 'OFFLINE' : ageS > 300 ? 'DELAYED' : 'LIVE';
  line.ageS = ageS;
  line.level = level;

  rows.push(line);
  console.log(
    `${line.at.slice(11, 19)}Z  state=${line.state} site=${line.site}  lvl=${level.padEnd(7)} age=${String(ageS).padStart(4)}s  ` +
    `checked=${(line.checkedAt || '-').slice(11, 19)} published=${(line.publishedAt || '-').slice(11, 19)} ` +
    `ev=${String(line.events ?? '-').padStart(3)} al=${String(line.alerts ?? '-').padStart(3)} mon=${line.nOk ?? '-'}`);
  await new Promise(r => setTimeout(r, INTERVAL_S * 1000));
}

console.log('\n===== SUMMARY =====');
console.log(`samples: ${rows.length}`);
console.log(`distinct pipelineCheckedAt values: ${seenChecked.size}  (a live pipeline changes this every cycle)`);
console.log(`distinct publishedAt values:      ${seenPublished.size}`);
console.log(`levels:`, rows.map(r => r.level).join(', '));
console.log(`site HTTP all 200: ${rows.every(r => r.site === 200)}`);
console.log(`state HTTP all 200: ${rows.every(r => r.state === 200)}`);
const gaps = rows.map(r => r.ageS).filter(a => a != null);
console.log(`age seconds: min=${Math.min(...gaps)} max=${Math.max(...gaps)} last=${gaps[gaps.length - 1]}`);
console.log(`\nVERDICT: ${seenChecked.size >= Math.floor(rows.length / 2) ? 'PIPELINE IS ADVANCING' : 'PIPELINE NOT ADVANCING'}`);