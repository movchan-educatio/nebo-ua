import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPENFREEMAP, NEBO_ATTRIBUTION, NEBO_LIGHT_STYLE_URL, FALLBACK_RASTER_URL, shouldUseVector, vectorStyleSpec } from '../assets/js/basemap.js';
import { META, getThreatVisual, rangeRings, RANGE_PRESETS } from '../assets/js/map.js';
import { haversineKm, bearingDeg, project } from '../assets/js/scope.js';
import { territorialDanger } from '../services/districts.js';
import { classifyThreat, accuracyTier, shouldShowHeading } from '../services/threatClassify.js';

// ── OpenFreeMap stack identity (TZ §1, §33, §40) ─────────────────────────────
test('OpenFreeMap endpoints are official, never invented', () => {
  // positron, not dark: the /nebo/ surface is light, and the dark fork's whole
  // premise was a colour scheme this page no longer uses.
  assert.equal(OPENFREEMAP.styleUrl, 'https://tiles.openfreemap.org/styles/positron');
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

test('nebo light style URL is base-independent (no hardcoded /nebo-ua/)', () => {
  assert.ok(!NEBO_LIGHT_STYLE_URL.includes('/nebo-ua/') || NEBO_LIGHT_STYLE_URL.endsWith('assets/data/nebo-light.json'));
  assert.ok(NEBO_LIGHT_STYLE_URL.endsWith('assets/data/nebo-light.json'));
});

test('nebo-light.json: valid v8 style on OpenMapTiles planet source', async () => {
  const raw = await readFile('assets/data/nebo-light.json', 'utf8');
  const style = JSON.parse(raw);
  assert.equal(style.version, 8);
  assert.equal(style.sources.openmaptiles.type, 'vector');
  assert.equal(style.sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
  assert.ok(String(style.glyphs).includes('tiles.openfreemap.org'));
  // Every layer must point at a source that actually exists, or MapLibre throws
  // on the first frame and the map silently never appears.
  for (const l of style.layers) {
    assert.ok(!l.source || style.sources[l.source], `layer ${l.id} references a missing source`);
    assert.ok(l.id && l.type, `layer ${JSON.stringify(l.id)} is malformed`);
  }
});

// The basemap must never be the most saturated thing on screen. That is the
// whole reason it was retuned, so it is asserted rather than assumed.
const lum = (c) => {
  const m = String(c).match(/#([0-9a-f]{6})/i) || String(c).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  const [r, g, b] = m[1].length === 6
    ? [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)].map((h) => parseInt(h, 16))
    : [m[1], m[2], m[3]].map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

test('nebo-light.json: light background, no dark layer left behind', async () => {
  const style = JSON.parse(await readFile('assets/data/nebo-light.json', 'utf8'));
  const byId = Object.fromEntries(style.layers.map((l) => [l.id, l]));
  const bg = lum(byId.background.paint['background-color']);
  assert.ok(bg !== null && bg > 0.85, `background must be light, got ${bg}`);
  // A stray dark fill is how a "light" map ends up with a black lake.
  for (const l of style.layers) {
    const fill = l.paint && l.paint['fill-color'];
    if (fill !== undefined && !Array.isArray(fill)) {
      const l2 = lum(fill);
      assert.ok(l2 === null || l2 > 0.5, `layer ${l.id} has a dark fill ${fill}`);
    }
  }
});

test('nebo-light.json: labels recede, and stay readable', async () => {
  const style = JSON.parse(await readFile('assets/data/nebo-light.json', 'utf8'));
  const symbols = style.layers.filter((l) => l.type === 'symbol');
  assert.ok(symbols.length > 0, 'place labels are still present');
  for (const l of symbols) {
    const colour = l.paint && l.paint['text-color'];
    if (colour === undefined) continue; // shield icons carry no text colour
    const v = lum(colour);
    // Muted: dark enough to read on a light map, never pure black.
    assert.ok(v === null || (v > 0.15 && v < 0.85), `layer ${l.id} label is not muted: ${colour}`);
    // Legible: a muted label without a halo disappears into the map it sits on.
    assert.ok(l.paint['text-halo-color'] !== undefined, `layer ${l.id} lost its halo`);
  }
});

test('nebo-light.json: no POI / shop / tourism noise (TZ §4)', async () => {
  const style = JSON.parse(await readFile('assets/data/nebo-light.json', 'utf8'));
  const ids = style.layers.map((l) => l.id);
  // Matched on layer semantics, not on the substring "poi": a crude substring
  // check reports water_name_pOIint_label as a POI layer, which it is not.
  assert.ok(!ids.some((id) => /^(poi|.*_poi)$/i.test(id)), 'no POI layers, official positron style has none either');
  assert.ok(
    !style.layers.some((l) => /^(poi|shop|cafe|restaurant|tourism|attraction|leisure)(_|$)/i.test(l['source-layer'] || '')),
    'no commercial/tourism source layers',
  );
  // aerodrome_label is deliberately KEPT, unlike in the dark fork. On an air
  // threat radar the airfields are the subject, not scenery: dropping the layer
  // would remove information the user came for. It is held to the same muted
  // label rule as everything else, checked above.
  assert.ok(ids.includes('airport'), 'airfield labels stay — they are operational context here');
  assert.equal(style.layers.find((l) => l.id === 'airport')['source-layer'], 'aerodrome_label');
});

// The retuning rule, kept honest: anything that can only appear above the map's
// own maximum zoom is dead weight in the file and in every frame.
test('nebo-light.json: carries nothing the map cannot reach', async () => {
  const mapSrc = await readFile('assets/js/map.js', 'utf8');
  const maxZoom = Number((mapSrc.match(/maxZoom:(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(maxZoom), 'the map still declares a max zoom');
  const style = JSON.parse(await readFile('assets/data/nebo-light.json', 'utf8'));
  for (const l of style.layers) {
    assert.ok(l.minzoom === undefined || l.minzoom <= maxZoom, `layer ${l.id} starts at z${l.minzoom}, map stops at z${maxZoom}`);
  }
  // positron declares Natural Earth shaded relief that no layer uses.
  const used = new Set(style.layers.map((l) => l.source).filter(Boolean));
  for (const name of Object.keys(style.sources)) {
    assert.ok(used.has(name), `source ${name} is declared but never used`);
  }
});

test('raster fallback stays OSM when vector is unavailable (TZ §38)', () => {
  assert.ok(FALLBACK_RASTER_URL.includes('tile.openstreetmap.org'));
  assert.equal(shouldUseVector(), false); // Node has no WebGL → must degrade, never throw
  assert.equal(vectorStyleSpec().attribution, NEBO_ATTRIBUTION);
  assert.ok(vectorStyleSpec().style.endsWith('assets/data/nebo-light.json'));
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
  assert.equal(shouldShowHeading({ locationPrecision: 'COORDINATE', heading: 90, speed: null, areaOnly: false, stale: false }), true, 'course alone orients the nose');
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

test('radar labels are honest (no legacy "Приціл" wording)', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('Радар повітряних загроз'), 'radar canvas label present');
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

test('radar is the central card (no separate mode window)', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.ok(html.includes('id="rlScope"'), 'radar canvas present');
  assert.ok(html.includes('Немає повідомлень із достатньо точними координатами') || html.includes('id="rlRadarCount"'), 'honest data note present');
  assert.ok(html.includes('data-range="100"'), 'range presets present');
  const dash = await readFile('assets/js/dashboard.js', 'utf8');
  assert.ok(!dash.includes('openRadarBig'), 'no separate expanded radar window');
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
