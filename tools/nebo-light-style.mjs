// Builds a local light basemap style for Небо.UA, mirroring what
// assets/data/nebo-dark.json does for the dark one: fork the official
// OpenFreeMap style, then retune it for an operational instrument.
//
// This is a script rather than a hand-edited blob so the fork can be
// regenerated when OpenFreeMap publishes a new positron, and so every change is
// visible as a rule here instead of hiding inside 25 KB of JSON.
//
// Design rule: the map's job is to say WHERE something is. The threat layer's
// job is to say WHAT it is. So the basemap keeps geography — water, boundaries,
// major roads — and drops everything that is only interesting when the map is
// the subject. Labels stay legible but recede, because a saturated red track
// must not have to compete with a map that is trying to look interesting.
import fs from 'node:fs';
import path from 'node:path';

const SOURCE = 'https://tiles.openfreemap.org/styles/positron';
const OUT = path.join('assets', 'data', 'nebo-light.json');

// map.js creates the only Leaflet map that uses this basemap, at
// minZoom 5 / maxZoom 12. Anything above 12 can never render, so it is dead
// weight in the file and dead weight in the GPU every frame.
export const MAX_ZOOM = 12;

// Detail that exists to orient a walker, not a threat radar.
const DROP_BY_ID = new Set([
  'highway-shield-us-interstate', // United States only
  'road_shield_us',
  'landcover_ice_shelf', // polar, and Ukraine has none
  'landcover_glacier',
]);

// Label colours keyed to place rank, not to upstream's palette. Upstream picks
// colours for a general-purpose map; here every label is deliberately quieter
// than the chrome around it, so nothing on the basemap competes with a threat
// marker. The white halo positron already sets is what keeps them readable.
//
// The darkest value here sits around 0.31 luminance. Upstream's city label is
// near-black, which on this page reads as a heading rather than as a place name
// — and a black label is exactly what a red threat marker must not have to
// compete with.
const MUTED_LABEL = {
  water_name_point_label: '#8FA3C4',
  water_name_line_label: '#8FA3C4',
  waterway_line_label: '#9AA6B4',
  'highway-name-path': '#83888D',
  'highway-name-minor': '#7A7F84',
  'highway-name-major': '#6E7378',
  airport: '#6B7075',
  label_other: '#8A8F93',
  label_village: '#83888D',
  label_town: '#767C80',
  label_state: '#6E7378',
  label_city: '#5C6165',
  label_city_capital: '#4A5054',
  label_country_3: '#9AA0A5',
  label_country_2: '#9AA0A5',
  label_country_1: '#9AA0A5',
};

export async function fetchUpstream() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`positron fetch failed: HTTP ${res.status}`);
  return res.json();
}

// Drops layers by rule and returns what it removed, so the caller can report
// the reduction rather than assert it.
export function retune(style, { maxZoom = MAX_ZOOM } = {}) {
  const dropped = [];
  const kept = [];

  for (const layer of style.layers || []) {
    if (DROP_BY_ID.has(layer.id)) { dropped.push([layer.id, 'irrelevant to this map']); continue; }
    // Layers that only exist above the map's own maximum zoom can never draw.
    if (typeof layer.minzoom === 'number' && layer.minzoom > maxZoom) {
      dropped.push([layer.id, `starts at z${layer.minzoom}, map stops at z${maxZoom}`]);
      continue;
    }
    if (layer.type === 'symbol') {
      const colour = MUTED_LABEL[layer.id];
      if (colour) {
        layer.paint = { ...layer.paint, 'text-color': colour };
        // Upstream keeps a white halo on light; without it a muted label on a
        // muted road becomes unreadable. Kept deliberately.
        if (layer.paint['text-halo-color'] === undefined) layer.paint['text-halo-color'] = '#FFFFFF';
      }
    }
    kept.push(layer);
  }

  // positron declares Natural Earth shaded relief but no layer references it.
  // Shipping an unused source makes every consumer believe it depends on it.
  const usedSources = new Set(kept.map((l) => l.source).filter(Boolean));
  const removedSources = [];
  for (const name of Object.keys(style.sources || {})) {
    if (!usedSources.has(name)) { removedSources.push(name); delete style.sources[name]; }
  }

  style.layers = kept;
  style.name = 'Nebo.UA premium light (OpenFreeMap / OpenMapTiles)';
  style.metadata = {
    ...(style.metadata || {}),
    'openfreemap:base-style': 'https://tiles.openfreemap.org/styles/positron',
    'openfreemap:schema': 'OpenMapTiles',
    'nebo:note':
      'Fork of the official OpenFreeMap positron style, retuned for Небо.UA: neutral light ' +
      'background, muted labels, and detail layers above the map max zoom removed, so the red ' +
      'threat layer is the only saturated thing on screen. Tiles, glyphs and sprites still served ' +
      'by OpenFreeMap; geodata by OpenStreetMap.',
    'nebo:max-zoom': String(maxZoom),
  };
  return { dropped, removedSources, keptCount: kept.length };
}

export async function build({ write = true } = {}) {
  const style = await fetchUpstream();
  const before = (style.layers || []).length;
  const report = retune(style);
  const json = JSON.stringify(style);
  if (write) fs.writeFileSync(OUT, json, 'utf8');
  return { before, ...report, bytes: json.length, out: OUT };
}

if (process.argv[1] && process.argv[1].endsWith('nebo-light-style.mjs')) {
  const r = await build();
  console.log(`wrote ${r.out}  ${(r.bytes / 1024).toFixed(1)} KB`);
  console.log(`layers ${r.before} -> ${r.keptCount}`);
  if (r.removedSources.length) console.log('unused sources removed:', r.removedSources.join(', '));
  console.log('--- dropped ---');
  for (const [id, why] of r.dropped) console.log(`  ${id.padEnd(32)} ${why}`);
}
