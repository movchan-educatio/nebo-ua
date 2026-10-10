// Waits until production is actually serving this commit, not just something
// newer than an older baseline. The V5 sprite was already live before this
// deploy, so tools/await-deploy.mjs would pass instantly and prove nothing;
// these markers were introduced by the V5.2 layout fix and did not exist yet.
const SITE = process.argv[2] || 'https://nebo-ua.vercel.app';
const DEADLINE = Date.now() + Number(process.argv[3] || 10) * 60_000;

const MARKERS = [
  ['html has the map-state line', '/', 'id="rlMapState"'],
  ['html has the sheet backdrop', '/', 'id="rlSheetScrim"'],
  ['html groups radar + detail into one column', '/', 'class="rl-col-b"'],
  ['html has the detail header icon slot', '/', 'id="rlDetailIcon"'],
  // contourStatus lives in the script, not the stylesheet.
  ['script keys the scope on the contours', '/radar/radar.js', 'contourStatus'],
  ['script starts the contour loader idle', '/radar/radar.js', "contourStatus: 'idle'"],
  ['css makes the panel a flex column', '/radar/radar.css', '.rl-detail[hidden]'],
  ['css docks the panel actions', '/radar/radar.css', '.rl-detail-body .rl-btn-row'],
];

const get = async (p) => {
  const r = await fetch(SITE + p, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
  return { status: r.status, body: await r.text() };
};

let last = '';
for (;;) {
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    const bodies = { '/': (await get('/')).body };
    for (const p of new Set(MARKERS.map((m) => m[1]))) {
      if (p !== '/') bodies[p] = (await get(p)).body;
    }
    const missing = MARKERS.filter(([, path, needle]) => !bodies[path].includes(needle)).map(([label]) => label);
    const line = missing.length ? `waiting on ${missing.length}/${MARKERS.length}: ${missing[0]}` : 'all markers live';
    if (line !== last) { console.log(`${stamp}Z  ${line}`); last = line; }
    if (!missing.length) {
      console.log('\nLIVE: production serves the V5.2 layout fix.');
      process.exit(0);
    }
  } catch (e) {
    console.log(`${stamp}Z  error ${String(e).slice(0, 80)}`);
  }
  if (Date.now() > DEADLINE) { console.log('\nTIMEOUT: production is not serving this commit yet.'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 20000));
}