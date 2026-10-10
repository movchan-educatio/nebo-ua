// Characterise the place data that is present but not reaching the UI.
const res = await fetch('https://check-ua-proxy.kykyyzka.workers.dev/v1/state');
const j = await res.json();
const events = j.events || [];
const has = (e, k) => e[k] !== undefined && e[k] !== null && String(e[k]).trim() !== '';
const without = events.filter((e) => !has(e, 'region') && !has(e, 'settlement') && !has(e, 'district'));

console.log(`events: ${events.length} | with a place: ${events.length - without.length} | without: ${without.length}`);

const src = {};
for (const e of without) src[e.source] = (src[e.source] || 0) + 1;
console.log('unknown-place rows by source:', src);

console.log('\n--- destination field shapes (the place is hiding here) ---');
const shapes = {};
for (const e of without) {
  const d = e.destination || '';
  const key = /^[a-z_]+(\([a-z]+\))?$/.test(d) ? 'slug(name)' : d ? 'other' : '(empty)';
  shapes[key] = (shapes[key] || 0) + 1;
}
console.log(shapes);

const paren = without.filter((e) => /^[a-z_]+\(([a-z]+)\)$/.test(e.destination || ''));
console.log(`\nrows matching slug(oblast): ${paren.length} of ${without.length}`);
console.log('distinct oblast slugs:', [...new Set(paren.map((e) => /\(([a-z]+)\)$/.exec(e.destination)[1]))].sort().join(', '));

console.log('\n--- how many have SOME place signal at all ---');
const signals = {
  'destination has (oblast)': paren.length,
  'rawExplanation names a place': without.filter((e) => /[А-Яа-яІіЇїЄєҐґ]/.test(e.rawExplanation || '')).length,
  'subtype names a place': without.filter((e) => /[А-Яа-яІіЇїЄєҐґ]/.test(e.subtype || '')).length,
  'has coordinates': without.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)).length,
};
console.log(signals);

console.log('\n--- sample destinations ---');
console.log([...new Set(without.map((e) => e.destination).filter(Boolean))].slice(0, 12).join('\n'));

console.log('\n--- rawExplanation samples ---');
console.log([...new Set(without.map((e) => e.rawExplanation).filter(Boolean))].slice(0, 10).join('\n'));

// Does the repo already know how to resolve a settlement to an oblast?
console.log('\n--- nearby known-places for contrast ---');
const known = events.filter((e) => has(e, 'region') || has(e, 'settlement')).slice(0, 4);
for (const e of known) console.log(`  ${e.region || '-'} / ${e.settlement || '-'} / dest=${e.destination || '-'}`);
