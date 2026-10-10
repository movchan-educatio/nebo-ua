// Waits for the pushed commit to reach production and proves it, rather than
// assuming the deploy happened. Checks the served HTML AND the new sprite file.
const SITE = process.argv[2] || 'https://nebo-ua.vercel.app';
const DEADLINE = Date.now() + Number(process.argv[3] || 8) * 60_000;

const get = async (p) => {
  const r = await fetch(SITE + p, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
  return { status: r.status, body: r.headers.get('content-type')?.includes('svg') ? await r.text() : await r.text() };
};

let last = '';
for (;;) {
  const stamp = new Date().toISOString().slice(11, 19);
  try {
    const html = await get('/');
    const hasNew = html.body.includes('assets/threats/sprite.svg');
    const hasOld = html.body.includes('brand/threat-icons.svg');
    const sprite = await get('/assets/threats/sprite.svg');
    const spriteOk = sprite.status === 200 && sprite.body.includes('<symbol id="kab"');
    const line = `html=${hasNew ? 'V5' : hasOld ? 'V4' : '?'}  sprite=${sprite.status}${spriteOk ? ' ok' : ''} (${sprite.body.length}b)`;
    if (line !== last) { console.log(`${stamp}Z  ${line}`); last = line; }
    if (hasNew && spriteOk) { console.log('\nLIVE: the V5 sprite is being served.'); process.exit(0); }
  } catch (e) {
    console.log(`${stamp}Z  error ${String(e).slice(0, 80)}`);
  }
  if (Date.now() > DEADLINE) { console.log('\nTIMEOUT: production still not serving the V5 sprite.'); process.exit(2); }
  await new Promise((r) => setTimeout(r, 20000));
}
