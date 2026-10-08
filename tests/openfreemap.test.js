import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPENFREEMAP, NEBO_ATTRIBUTION, NEBO_DARK_STYLE_URL, FALLBACK_RASTER_URL, shouldUseVector, vectorStyleSpec } from '../assets/js/basemap.js';
import { META, getThreatVisual, rangeRings, RANGE_PRESETS } from '../assets/js/map.js';
import { haversineKm, bearingDeg, project } from '../assets/js/scope.js';
import { territorialDanger } from '../services/districts.js';
import { classifyThreat, accuracyTier, shouldShowHeading } from '../services/threatClassify.js';

// ── OpenFreeMap stack identity (TZ §1, §33, §40) ─────────────────────────────
test('OpenFreeMap endpoints are official, never invented', () => {
  assert.equal(OPENFREEMAP.styleUrl, 'https://tiles.openfreemap.org/styles/dark');
  assert.equal(OPENFREEMAP.tilesUrl, 'https://tiles.openfreemap.org/planet');
  assert.equal(OPENFREEMAP.siteUrl, 'https://openfreemap.org/');
  assert.equal(OPENFREEMAP.schemaUrl, 'https://www.openmaptiles.org/');
  assert.ok(OPENFREEMAP.dataUrl.includes('openstreetmap.org/copyright'));
});

test('attribution keeps OpenFreeMap + OpenMapTiles + OpenStreetMap', () => {
  assert.ok(NEBO_ATTRIBUTION.includes('OpenStreetMap'));
  assert.ok(NEBO_ATTRIBUTION.includes('OpenMapTiles'));
  assert.ok(NEBO_ATTRIBUTION.includes('OpenFreeMap'));
});

test('nebo dark style URL is base-independent (no hardcoded /nebo-ua/)', () => {
  assert.ok(!NEBO_DARK_STYLE_URL.includes('/nebo-ua/') || NEBO_DARK_STYLE_URL.endsWith('assets/data/nebo-dark.json'));
  assert.ok(NEBO_DARK_STYLE_URL.endsWith('assets/data/nebo-dark.json'));
});

test('nebo-dark.json: valid v8 style on OpenMapTiles planet source', async () => {
  const raw = await readFile('assets/data/nebo-dark.json', 'utf8');
  const style = JSON.parse(raw);
  assert.equal(style.version, 8);
  assert.equal(style.sources.openmaptiles.type, 'vector');
  assert.equal(style.sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
  assert.ok(String(style.glyphs).includes('tiles.openfreemap.org'));
});

test('nebo-dark.json: ultra-dark background + muted palette (TZ §3)', async () => {
  const style = JSON.parse(await readFile('assets/data/nebo-dark.json', 'utf8'));
  const byId = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  assert.equal(byId.background.paint['background-color'], '#02070B');
  assert.equal(byId.water.paint['fill-color'], '#02080D');
  const country = byId.boundary_country.paint['line-color'];
  assert.equal(country, '#233440');
  // No light/white basemap layer may compete with operational data.
  for (const l of style.layers) {
    const paints = JSON.stringify(l.paint || {});
    assert.ok(!paints.includes('#ffffff') && !paints.includes('#fff'), `layer ${l.id} must not be white`);
  }
});

test('nebo-dark.json: no POI / shop / tourism noise (TZ §4)', async () => {
  const style = JSON.parse(await readFile('assets/data/nebo-dark.json', 'utf8'));
  const ids = style.layers.map((l) => l.id).join(' ');
  assert.ok(!ids.includes('poi'), 'no poi layers, official dark style has none either');
  assert.ok(!/shop|cafe|restaurant|tourism|aerodrome/i.test(ids), 'no commercial/tourism layers');
});

test('raster fallback stays OSM when vector is unavailable (TZ §38)', () => {
  assert.ok(FALLBACK_RASTER_URL.includes('tile.openstreetmap.org'));
  assert.equal(shouldUseVector(), false); // Node has no WebGL → must degrade, never throw
  assert.equal(vectorStyleSpec().attribution, NEBO_ATTRIBUTION);
});

// ── Unified threat visuals (TZ §29) ─────────────────────────────────────────
test('getThreatVisual: single registry for map/radar/list/cluster/popup', () => {
  for (const kind of ['shahed', 'uav', 'fpv', 'recon', 'missile', 'ballistic', 'kab', 'aviation', 'explosion', 'other']) {
    const v = getThreatVisual(kind);
    assert.equal(v.kind, kind);
    assert.equal(v.icon, META[kind].icon);
    assert.equal(v.color, META[kind].color);
    assert.ok(Number.isFinite(v.size) && v.size >= 20 && v.size <= 40);
  }
});

test('generic UAV is never a Shahed (TZ §20)', () => {
  const uav = getThreatVisual({ category: 'uav', kind: 'uav', subtype: 'БпЛА' });
  const sh = getThreatVisual({ category: 'uav', kind: 'shahed', subtype: 'Shahed-136' });
  assert.equal(uav.kind, 'uav');
  assert.equal(sh.kind, 'shahed');
  assert.notEqual(uav.icon, sh.icon);
  assert.equal(classifyThreat({ category: 'uav', sourceType: 'uav', subtype: 'БпЛА' }), 'uav');
});

// ── Radar ranges + math (TZ §28, §31) ───────────────────────────────────────
test('radar ranges are exactly 1/3/5/10/25/100', () => {
  assert.deepEqual(RANGE_PRESETS, [1, 3, 5, 10, 25, 100]);
  assert.deepEqual(rangeRings(10), [2, 4, 6, 8, 10]);
  assert.deepEqual(rangeRings(100), [20, 40, 60, 80, 100]);
});

test('haversine: Kyiv–Lviv ≈ 460–480 km', () => {
  const d = haversineKm(50.45, 30.52, 49.84, 24.02);
  assert.ok(d > 450 && d < 490, `got ${d}`);
});

test('bearing: north=0, east=90, south=180, west=270', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0) - 0) < 0.5);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg(0, 0, -1, 0) - 180) < 0.5);
  assert.ok(Math.abs(bearingDeg(0, 0, 0, -1) - 270) < 0.5);
});

test('project: 5 km target at range 10 sits at ~50% radius', () => {
  const size = 400;
  const c = [49, 31];
  // ~5 km north of center
  const p = project(c[0] + 5 / 110.57, c[1], c, 10, size);
  assert.ok(p.inside);
  assert.ok(Math.abs(p.distKm - 5) < 0.3, `got ${p.distKm}`);
  const rPx = Math.hypot(p.x - size / 2, p.y - size / 2);
  const fullR = size / 2 - 8;
  const frac = rPx / fullR;
  assert.ok(frac > 0.42 && frac < 0.58, `got ${frac}`);
});

test('project: target beyond range is not drawn inside', () => {
  const p = project(49, 31 + 1, [49, 31], 10, 400); // ~70+ km east
  assert.equal(p.inside, false);
});

// ── Raion scope: district never paints oblast (TZ §7, §8) ───────────────────
test('district alert paints only its raion, never the oblast', () => {
  const alerts = [{ region: 'Черкаська область', district: 'Уманський район', level: 'yellow' }];
  const { oblasts, fills } = territorialDanger(alerts, []);
  assert.deepEqual(oblasts, []);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].district, 'Уманський район');
});

test('unknown district without polygon data: no oblast fallback invented', () => {
  const alerts = [{ region: 'Черкаська область', district: 'Невідомий район', level: 'yellow' }];
  const { oblasts } = territorialDanger(alerts, []);
  assert.deepEqual(oblasts, []);
});

// ── Reference look: every track keeps its icon, overlaps decluttered ────────
test('UI markers: real icons, priority declutter instead of bubbles', async () => {
  const src = await readFile('assets/js/map.js', 'utf8');
  assert.ok(!src.includes('markerClusterGroup'), 'no cluster bubble factory');
  assert.ok(src.includes('declutterTargets'), 'priority declutter present');
  assert.ok(src.includes('markerByTrack'), 'markers persist per stable trackId');
});

test('source count badge comes only from explicit source count', async () => {
  const src = await readFile('assets/js/map.js', 'utf8');
  assert.ok(src.includes('mk-count'), 'count badge hook exists');
});

// ── Real data only (TZ §20–§22) ─────────────────────────────────────────────
test('no coordinates → report tier (never a fake marker)', () => {
  assert.equal(accuracyTier({ areaOnly: true }), 'area');
  assert.equal(accuracyTier({}), 'report');
});

test('no heading → no invented direction', () => {
  assert.equal(shouldShowHeading({ locationPrecision: 'COORDINATE', heading: null, speed: 100, areaOnly: false, stale: false }), false);
  assert.equal(shouldShowHeading({ locationPrecision: 'COORDINATE', heading: 90, speed: 100, areaOnly: false, stale: false }), true);
});

test('basemap uses single-Leaflet UMD scripts, never a second ESM Leaflet', async () => {
  const src = await readFile('assets/js/basemap.js', 'utf8');
  assert.ok(src.includes('leaflet-maplibre-gl.js'), 'UMD binding build');
  assert.ok(src.includes('maplibre-gl.js'), 'UMD maplibre build');
  assert.ok(!src.includes('/+esm'), 'no +esm ESM imports (they duplicate Leaflet and break markercluster)');
  assert.ok(src.includes('DistanceGrid'), 'guards the single window.L instance markercluster extended');
});

test('radar map defers Canvas work until visible (no _pxBounds crash)', async () => {
  const src = await readFile('assets/js/map.js', 'utf8');
  assert.ok(src.includes('clientWidth'), 'visibility guard on radar Leaflet mutations');
  assert.ok(src.includes('flush'), 'deferred radar layers replay on first open');
});

test('Map→Radar first click replays deferred layers (flush + scope restart)', async () => {
  const src = await readFile('assets/js/app.js', 'utf8');
  assert.ok(src.includes('radarUI.flush'), 'showView replays radar layers after layout settles');
  assert.ok(src.includes('applyRadarMode()'), 'scope loop restarts on every radar open');
});

test('debug overlay requires explicit opt-in (?debug / localStorage), never by default', async () => {
  const src = await readFile('assets/js/app.js', 'utf8');
  const body = src.slice(src.indexOf('function setupDebug()'), src.indexOf('function setupDebug()') + 600);
  assert.ok(body.includes("localStorage.getItem('debug')"), 'localStorage.debug opt-in');
  assert.ok(body.includes('debug') && body.includes('location.search'), '?debug=1 opt-in');
  assert.ok(!body.includes("hostname==='localhost'"), 'localhost alone must not enable the overlay');
});

test('scope renders the shared SVG silhouettes, rings follow selected range', async () => {
  const src = await readFile('assets/js/scope.js', 'utf8');
  assert.ok(src.includes('getThreatVisual'), 'same icon registry as the map');
  assert.ok(src.includes('threat-icons.svg'), 'same sprite file as the map');
  assert.ok(src.includes('drawImage'), 'silhouettes drawn on the scope, not dots');
  assert.ok(src.includes('rangeRings(S.range)'), 'rings scale with the selected range');
});

test('radar mode labels are Радар/Карта (no "Приціл")', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('>Радар<'), 'Радар label present');
  assert.ok(!html.includes('Приціл'), 'legacy Приціл label gone');
});

test('HUD copy is radar-style, no logbook wording or debug counts', async () => {
  const src = await readFile('services/summary.js', 'utf8');
  const body = src.slice(src.indexOf('export function flowSummaryHTML'));
  assert.ok(body.includes('РАКЕТ'), 'short РАКЕТ copy');
  assert.ok(!body.includes('повідомлення'), 'no "повідомлення" logbook wording');
  assert.ok(!body.includes('приховано'), 'no stale-hidden debug counts');
  assert.ok(body.includes('flow-compact'), 'mobile gets a 2-row compact line');
});

test('radar is a compact panel plus an expanded mode, both honest about data', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('id="scopeMini"'), 'compact radar canvas present');
  assert.ok(html.includes('id="radarNote"') || html.includes('підтвердженими координатами'), 'honest data-limitation note present');
  assert.ok(html.includes('data-range="100"'), 'range presets present');
  const dash = await readFile('assets/js/dashboard.js', 'utf8');
  assert.ok(dash.includes('scopeBig') || dash.includes('openRadarBig'), 'expanded radar mode exists');
  assert.ok(dash.includes('areaOnly'), 'area-only records never plotted as targets');
});

test('Map↔Radar share viewport: radar stores center, map restores it', async () => {
  const src = await readFile('assets/js/app.js', 'utf8');
  assert.ok(src.includes('state._radarCenter=center'), 'radar center stored per render');
  assert.ok(src.includes('state._mapView='), 'map viewport stored when leaving');
  assert.ok(src.includes('setView([sv.lat,sv.lon],sv.zoom'), 'exact viewport restored on return');
});

test('mobile HUD collapses to two rows via flow-compact', async () => {
  const css = await readFile('assets/css/styles.css', 'utf8');
  assert.ok(css.includes('.flow-compact'), 'compact line styled');
});

console.log('openfreemap checks passed');
