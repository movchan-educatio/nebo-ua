// OpenFreeMap / OpenMapTiles / OpenStreetMap basemap for Небо.UA.
//
// Light by design: a threat radar is an instrument, and an instrument does not
// compete with its own chrome. The basemap says where something is; the red
// threat layer says what it is. So geography stays — water, boundaries, major
// roads — labels recede, and detail that only exists to orient a walker rather
// than a radar is dropped entirely (see tools/nebo-light-style.mjs).
//
// Map engine stays Leaflet: all oblast/raion polygons, markers, clusters,
// trails, GPS/Home and popups remain Leaflet layers. Only the visual
// background switches from OSM raster tiles to the OpenFreeMap vector style
// (OpenMapTiles schema, OSM geodata) rendered through MapLibre GL inside a
// Leaflet layer (@maplibre/maplibre-gl-leaflet).
//
// If WebGL / CDN / tiles are unavailable, we fall back to OSM raster so the
// operational UI stays alive (see TZ §38). Threat data is NEVER baked into
// the basemap — it lives in separate Leaflet panes above it.

export const OPENFREEMAP = {
  styleUrl: 'https://tiles.openfreemap.org/styles/positron',
  tilesUrl: 'https://tiles.openfreemap.org/planet',
  siteUrl: 'https://openfreemap.org/',
  schemaUrl: 'https://www.openmaptiles.org/',
  dataUrl: 'https://www.openstreetmap.org/copyright',
  maplibreVersion: '5.7.3',
  bindingVersion: '0.1.4',
};

export const NEBO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' +
  ' · © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>' +
  ' · <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a>';

// Local premium-light fork of the official OpenFreeMap positron style.
// Module-relative so it works from /, /nebo-ua/, /dev/, widget/...
// Regenerate with: node tools/nebo-light-style.mjs
export const NEBO_LIGHT_STYLE_URL = new URL('../data/nebo-light.json', import.meta.url).href;

export const FALLBACK_RASTER_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function shouldUseVector() {
  try {
    if (typeof WebGLRenderingContext === 'undefined') return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return false;
    if (typeof navigator !== 'undefined' && /MSIE|Trident\//.test(navigator.userAgent || '')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// Pure helper (unit-tested): style object the map layer should use.
export function vectorStyleSpec() {
  return { style: NEBO_LIGHT_STYLE_URL, attribution: NEBO_ATTRIBUTION };
}

// Attach the basemap to a Leaflet map instance.
// Returns a promise resolving to 'vector' | 'raster' | 'raster-fallback'.
//
// Loading uses UMD <script> builds (maplibre-gl, then the Leaflet binding),
// NOT ESM imports: the binding's ESM build pulls its own second copy of
// Leaflet, which replaces/augments window.L and breaks the vendored
// markercluster plugin (L.DistanceGrid is not a constructor). UMD keeps a
// single window.L for every overlay layer.
export async function attachBasemap(map) {
  const raster = () =>
    window.L.tileLayer(FALLBACK_RASTER_URL, {
      maxZoom: 19,
      crossOrigin: true,
      className: 'nebo-raster-tiles',
      attribution: NEBO_ATTRIBUTION,
    }).addTo(map);

  if (!shouldUseVector()) {
    raster();
    map.getContainer()?.classList.add('basemap-raster');
    return 'raster';
  }
  try {
    ensureMaplibreCss();
    await loadVectorLibs();
    const L = window.L;
    if (typeof L.maplibreGL !== 'function') throw new Error('maplibre-gl-leaflet factory not found');
    if (typeof L.DistanceGrid !== 'function') throw new Error('Leaflet instance mismatch (markercluster)');
    const layer = L.maplibreGL({ style: NEBO_LIGHT_STYLE_URL, attribution: NEBO_ATTRIBUTION });
    layer.addTo(map);
    map.getContainer()?.classList.add('basemap-vector');
    // If the vector style/tiles fail after attach, keep the app alive with raster.
    const fallbackOnce = () => {
      try {
        if (map.hasLayer(layer)) map.removeLayer(layer);
      } catch (e) {}
      raster();
      map.getContainer()?.classList.add('basemap-raster');
      map.getContainer()?.classList.add('basemap-degraded');
      showBasemapNotice(map, true);
    };
    layer.on('layererror', fallbackOnce);
    layer.on('tileerror', fallbackOnce);
    return 'vector';
  } catch (e) {
    // One retry: CDN cold-resolution of transitive deps can fail transiently.
    try {
      await new Promise((r) => setTimeout(r, 1500));
      ensureMaplibreCss();
      await loadVectorLibs();
      const L = window.L;
      if (typeof L.maplibreGL !== 'function') throw new Error('maplibre-gl-leaflet factory not found (retry)');
      const layer = L.maplibreGL({ style: NEBO_LIGHT_STYLE_URL, attribution: NEBO_ATTRIBUTION });
      layer.addTo(map);
      map.getContainer()?.classList.add('basemap-vector');
      return 'vector';
    } catch (e2) {
      console.warn('[basemap] vector unavailable, using OSM raster fallback', e2);
      raster();
      map.getContainer()?.classList.add('basemap-raster');
      showBasemapNotice(map, false);
      return 'raster-fallback';
    }
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    try {
      const id = 'nebo-lib-' + src.replace(/[^a-z0-9]+/gi, '-').slice(-60);
      const existing = document.getElementById(id);
      if (existing) {
        if (existing.dataset.loaded === '1') return resolve();
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('script failed: ' + src)), { once: true });
        return;
      }
      const el = document.createElement('script');
      el.id = id;
      el.src = src;
      el.async = false;
      el.onload = () => { el.dataset.loaded = '1'; resolve(); };
      el.onerror = () => reject(new Error('script failed: ' + src));
      document.head.appendChild(el);
    } catch (e) {
      reject(e);
    }
  });
}

let libsPromise = null;
function loadVectorLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      await loadScript(`https://cdn.jsdelivr.net/npm/maplibre-gl@${OPENFREEMAP.maplibreVersion}/dist/maplibre-gl.js`);
      await loadScript(`https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@${OPENFREEMAP.bindingVersion}/leaflet-maplibre-gl.js`);
    })().catch((e) => { libsPromise = null; throw e; });
  }
  return libsPromise;
}

function ensureMaplibreCss() {
  try {
    const id = 'maplibre-gl-css';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://cdn.jsdelivr.net/npm/maplibre-gl@${OPENFREEMAP.maplibreVersion}/dist/maplibre-gl.css`;
    document.head.appendChild(link);
  } catch (e) {}
}

function showBasemapNotice(map, degraded) {
  try {
    const c = map.getContainer();
    if (!c || c.querySelector('.basemap-notice')) return;
    const el = document.createElement('div');
    el.className = 'basemap-notice';
    el.textContent = degraded
      ? 'Картографічна підкладка тимчасово недоступна — оперативні дані актуальні'
      : 'Картографічна підкладка (OpenFreeMap) завантажується…';
    c.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  } catch (e) {}
}
