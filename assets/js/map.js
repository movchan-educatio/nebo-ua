import{regionName}from'../../services/regions.js';
import{territorialDanger,normOblast}from'../../services/districts.js';
import{classifyThreat,accuracyTier,ageClass,shouldShowHeading}from'../../services/threatClassify.js';
import{attachBasemap,NEBO_ATTRIBUTION}from'./basemap.js';
import{planMove}from'../../services/tracks.js';

// Module-relative URL of the threat icon sprite: resolves correctly from any
// page base path (/, /nebo-ua/, /dev/, widget/...) without hardcoding it.
const THREAT_SVG = new URL('../brand/threat-icons.svg', import.meta.url).href;

// External-file <use href="file.svg#id"> is flaky in some browsers once the
// element is re-created inside transformed/filtered containers (Chrome simply
// paints nothing). Inline the sprite symbols once into the document and use
// internal references — bulletproof and still a single source of truth.
let spriteInlined = false;
const symbolMarkup = new Map(); // id -> { viewBox, inner }  (inline fallback)
const spriteReady = [];        // callbacks fired after symbols are parsed
function onSpriteReady(fn) { if (spriteInlined) fn(); else spriteReady.push(fn); }
function ensureSpriteInline() {
  if (spriteInlined || typeof document === 'undefined') return;
  spriteInlined = true;
  try {
    fetch(THREAT_SVG).then(r => r.text()).then(txt => {
      // 1) Parse symbols so markers can inline the paths directly.
      for (const m of txt.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
        symbolMarkup.set(m[1], { viewBox: m[2], inner: m[3] });
      }
      // 2) Also keep a hidden sprite holder (1×1 off-screen, never 0×0).
      const wrap = document.createElement('div');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:0;overflow:visible';
      wrap.innerHTML = txt;
      document.body.appendChild(wrap);
      for (const fn of spriteReady.splice(0)) { try { fn(); } catch { /* ignore */ } }
    }).catch(() => { /* keep the <use> fallback */ });
  } catch { /* ignore */ }
}
// Marker HTML glyph: inline paths when parsed, <use> until then.
function glyphSvg(icon, size) {
  const sym = symbolMarkup.get(icon);
  if (sym) {
    return `<svg class="threat-svg" viewBox="${sym.viewBox}" style="width:${size}px;height:${size}px">${sym.inner}</svg>`;
  }
  return `<svg class="threat-svg" style="width:${size}px;height:${size}px"><use href="#${icon}" xlink:href="#${icon}"/></svg>`;
}
ensureSpriteInline();

// ── Threat metadata ───────────────────────────────────────────────────────────
// 'shahed' is a distinct visual kind within the uav category.
// 'recon' is a distinct kind for reconnaissance UAVs.
// Palette: Небо.UA threat color system (single source; radar/list use it too).
const META={
  shahed:   {label:'ШАХЕД',   icon:'shahed',   color:'#FF7B4D'},
  uav:      {label:'БПЛА',    icon:'uav',      color:'#FFC43D'},
  fpv:      {label:'FPV-ДРОН',icon:'fpv',      color:'#FF9F43'},
  recon:    {label:'РОЗВІДКА',icon:'recon',    color:'#62C7FF'},
  missile:  {label:'РАКЕТА',  icon:'missile',  color:'#FF4D67'},
  ballistic:{label:'БАЛІСТИКА',icon:'ballistic',color:'#FF2F3E'},
  kab:      {label:'КАБ',     icon:'kab',      color:'#FF806B'},
  aviation: {label:'АВІАЦІЯ', icon:'aircraft', color:'#9B6CFF'},
  explosion:{label:'ЗМІ: ВИБУХИ',icon:'explosion',color:'#FF6A00'},
  other:    {label:'Інше',    icon:'other',    color:'#B8C5D1'},
};

// ── V2 reference styling: expressive fills (washed mosaic forbidden —
// oblast fills stay restrained, danger reads instantly).
const DANGER_STYLE = {
  // SOLID, opaque territory colours (reference): the fill carries the status
  // fully, a thin light outline separates neighbours. No glow, no neon.
  oblastCritical: { color:'#FFFFFF', weight:1.0, opacity:0.55, fillColor:'#C62839', fillOpacity:0.95 },
  oblastElevated: { color:'#FFFFFF', weight:1.0, opacity:0.55, fillColor:'#D9A441', fillOpacity:0.95 },
  // The neutral style is the fill for every oblast with no alert, so it is the
  // surface the basemap has to be seen through. It used to be a near-black navy
  // at 0.9: on a dark map that blended into the tiles, but the moment the tiles
  // became light the same opacity turned them into an opaque grey slab that hid
  // the map entirely. Opacity is tuned for the backdrop, so both changed
  // together. Alert fills stay at 0.95 — those are meant to dominate.
  neutral:        { color:'#64748B', weight:0.8, opacity:0.75, fillColor:'#CBD5E1', fillOpacity:0.22 },
};

// ── Unified threat visual registry ──────────────────────────────────────────
// Single source of truth for Map, Radar, List, Recent Events and Popup
// visuals (TZ §29). Never copy SVG paths elsewhere: resolve the kind
// once via classifyThreat, then read icon/color/size from here.
const THREAT_SIZE = {
  shahed: 26, uav: 24, fpv: 24, recon: 23, missile: 24, ballistic: 26,
  kab: 24, aviation: 25, explosion: 24, other: 22,
};
// Radar-ineligible kinds are event reports, not flying targets.
const RADAR_EXCLUDED = new Set(['explosion']);
export function getThreatVisual(input) {
  const kind = typeof input === 'string' ? input : classifyThreat(input);
  const m = META[kind] || META.other;
  const realKind = META[kind] ? kind : 'other';
  return {
    kind: realKind, icon: m.icon, color: m.color, label: m.label,
    size: THREAT_SIZE[realKind] || 24, cssClass: 'kind-' + realKind,
    radarEligible: !RADAR_EXCLUDED.has(realKind),
    mapEligible: true,
  };
}

// A position that is not "exact" may still be REAL: the source gave
// coordinates AND its own ±km. Such events must not vanish from the map —
// they are plotted with a dashed uncertainty ring instead. Nothing is
// invented: no coordinates, no radius beyond what the source stated.
function plotworthy(e){
  if(!e||e.areaOnly)return false;
  if(!Number.isFinite(Number(e.lat))||!Number.isFinite(Number(e.lon)))return false;
  if(accuracyTier(e)==='exact')return true;
  const pq=String(e.positionQuality||'');
  if(['area','raion','district','region'].includes(pq))return false;
  const unc=Number(e.uncertaintyKm);
  return Number.isFinite(unc)&&unc>0;
}

function iconFor(e){
  const v = getThreatVisual(e);
  return { label: v.label, icon: v.icon, color: v.color, kind: v.kind };
}

// Explicit Ukraine bounds: never rely on data-derived bounds that may be
// inflated (stray points / projection rounding) and pull neighbouring
// countries into frame. Covers Zakarpattia (W) to Luhansk (E), Crimea (S).
export const UKRAINE_BOUNDS = [[44.2, 22.0], [52.5, 40.4]];

// ── Situation map (main map tab) ──────────────────────────────────────────────
export function createSituationMap(el,onSelect){
  const map=baseMap(el,[48.6,31.2],6,{zoomControl:false});
  const satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,crossOrigin:true,className:'sat-tiles'});
  const regions=L.geoJSON(null).addTo(map);
  const areas=L.layerGroup().addTo(map);       // area-precision overlays
  const reported=L.layerGroup().addTo(map);    // report-precision dim markers
  const trails=L.layerGroup().addTo(map);
  const uncertainties=L.layerGroup().addTo(map);
  const wind=L.layerGroup();
  const reports=L.layerGroup().addTo(map);
  const user=L.layerGroup().addTo(map);
  const dots=L.layerGroup().addTo(map);
  const shapes=L.layerGroup().addTo(map);
  const ashapes=L.layerGroup().addTo(map);
  // Dedicated threat pane: targets render ABOVE polygon fills / oblast /
  // raion borders (overlayPane z400, markerPane z600) but BELOW Leaflet
  // popups (popupPane z700) and tooltips (tooltipPane z650). HUD and
  // navigation are DOM above the map container.
  if(!map.getPane('threatPane')) map.createPane('threatPane');
  map.getPane('threatPane').style.zIndex=625;
  // Oblast name pane: above polygon fills, below target markers.
  if(!map.getPane('labelPane')) map.createPane('labelPane');
  map.getPane('labelPane').style.zIndex=610;
  map.getPane('labelPane').style.pointerEvents='none';
  const labels=L.layerGroup().addTo(map);
  const labelEntries=[];
  // Greedy declutter: sort by oblast area (largest first), place a label only
  // if its screen rect does not collide with an already placed one. Collided
  // labels are hidden (not removed) and reappear when zoom gives them room.
  function declutterLabels(){
    if(!labelEntries.length) return;
    try{
      const placed=[];
      const nameH=16;
      for(const e of [...labelEntries].sort((a,b)=>b.area-a.area)){
        const el=e.marker.getElement();
        if(!el) continue;
        const nameEl=el.querySelector('.oblast-name')||el;
        const w=(e.name.length*6.6)+10, h=nameH;
        const pt=map.latLngToContainerPoint(e.marker.getLatLng());
        const rect={x1:pt.x-w/2,y1:pt.y-h/2,x2:pt.x+w/2,y2:pt.y+h/2};
        const hit=placed.some(p=>!(rect.x2<p.x1||rect.x1>p.x2||rect.y2<p.y1||rect.y1>p.y2));
        if(hit){ nameEl.classList.add('label-hidden'); }
        else { nameEl.classList.remove('label-hidden'); placed.push(rect); }
      }
    }catch(err){}
  }
  // One marker per REAL trackId. Reference look: NO number bubbles — real
  // threat icons only, decluttered by priority (ballistic > missile > shahed
  // > kab > aviation > uav > recon). Overlap is resolved by screen distance;
  // hidden icons reappear on zoom. Counts stay truthful in the side panel.
  const targets=L.layerGroup();
  // When the sprite finishes parsing, re-render markers so they switch from
  // the <use> fallback to inlined paths (guaranteed painting).
  onSpriteReady(() => {
    try {
      for (const [tid, m] of markerByTrack) {
        const e = currentByTrack.get(tid);
        if (!e) continue;
        m.setIcon(eventIcon(e, ageClass(e, Date.now())));
        m.options._sig = null;
      }
    } catch { /* ignore */ }
  });
  const PRIORITY={ballistic:1,missile:2,shahed:3,kab:4,aviation:5,uav:6,recon:7,fpv:8,explosion:9,other:10};
  function targetCap(){ const z=map.getZoom(); return z<=5?16:z===6?24:z<=8?40:Infinity; }
  function targetMinDist(){ const z=map.getZoom(); return z<=6?26:z<=8?20:14; }
  function declutterTargets(){
    try{
      const cap=targetCap(), minD=targetMinDist();
      const items=[];
      for(const [tid,m] of markerByTrack){
        const el=glyphEl(m); if(!el) continue;
        const e=currentByTrack.get(tid)||{};
        const k=m.options.threatKind||'other';
        items.push({el, tid, pr:PRIORITY[k]||10, pt:map.latLngToContainerPoint(m.getLatLng())});
      }
      items.sort((a,b)=>a.pr-b.pr);
      const placed=[];
      for(const it of items){
        const el=it.el.closest('.threat-marker')||it.el;
        const tooClose=placed.some(p=>Math.hypot(p.x-it.pt.x,p.y-it.pt.y)<minD);
        if(placed.length>=cap||tooClose){ el.classList.add('target-hidden'); }
        else { el.classList.remove('target-hidden'); placed.push({x:it.pt.x,y:it.pt.y}); }
      }
    }catch(err){}
  }
  map.addLayer(targets);
  let geo=null,fitted=false;
  function fitUkraine(){
    try{
      map.invalidateSize(false);
      map.fitBounds(UKRAINE_BOUNDS,ukraineFitOptions());
      fitted=true;
      setTimeout(()=>{ try{ declutterLabels(); }catch(e){} }, 60);
    }catch(e){}
  }
  function refitOnResize(){
    try{ map.invalidateSize(false); fitUkraine(); }catch(e){}
  }
  // Persistent marker objects per stable trackId: the SAME L.marker instance
  // survives snapshots; only its position/icon refresh. setLatLng + the CSS
  // transform transition gives the short UI glide between two CONFIRMED
  // positions — never extrapolation.
  const markerByTrack=new Map(),currentByTrack=new Map();

  // Zoom-dependent label visibility class on map container
  function applyZoomClass(){
    const z=map.getZoom();
    const c=map.getContainer();
    if(!c)return;
    c.className=c.className.replace(/\bmap-zoom-\d+\b/g,'').trim();
    c.classList.add('map-zoom-'+z);
  }
  map.on('zoomend',applyZoomClass);
  map.on('viewreset',applyZoomClass);
  map.on('load',applyZoomClass);
  setTimeout(applyZoomClass,0);
  map.on('zoomend',()=>{ try{ declutterLabels(); declutterTargets(); }catch(e){} });
  map.on('moveend',()=>{ try{ declutterLabels(); declutterTargets(); }catch(e){} });
  // Keep Ukraine fully visible when the container or window resizes.
  window.addEventListener('resize',()=>{ try{ refitOnResize(); }catch(e){} });

  function setRegions(g,alerts,events){
    geo=g;
    // Oblast polygon is painted ONLY for oblast-level danger (official alert
    // with district==null, or missile/ballistic monitor with district==null).
    // Raion-level danger NEVER paints the oblast polygon — it is rendered as
    // separate raion polygons (setAlertShapes + drawAlertShapes in app.js).
    let dangerOblasts=[];
    try{ dangerOblasts=(territorialDanger(alerts,events).oblasts||[]).map(normOblast); }catch(e){}

    regions.clearLayers();
    regions.addData(g);
    regions.eachLayer(layer=>{
      const n=regionName(layer.feature),key=layer.feature.properties?.key;
      const list=alerts.filter(x=>x.key===key||x.region===n);

      const style = dangerOblasts.includes(normOblast(n))
        ? DANGER_STYLE.oblastCritical
        : DANGER_STYLE.neutral;

      layer.setStyle(style);

      // Oblast names render via the dedicated label layer (see fitUkraine).

      // Click handlers intentionally absent: territories are informational
      // only (the operator asked for no click-through on raions/oblasts).
      layer.options.interactive = false;
    });
    if(!fitted) fitUkraine();
    // Oblast name labels: dedicated div-marker layer (guaranteed visible,
    // above fills, below target markers via pane order + CSS z-index).
    try{
      labels.clearLayers();
      labelEntries.length = 0;
      regions.eachLayer(layer=>{
        const n=regionName(layer.feature);
        if(!n) return;
        const b=layer.getBounds && layer.getBounds();
        if(!b || !b.isValid()) return;
        const c=b.getCenter();
        const mk=L.marker([c.lat,c.lng],{
          icon:L.divIcon({className:'',html:`<span class="oblast-name">${n}</span>`,iconSize:[0,0],iconAnchor:[0,0]}),
          interactive:false, keyboard:false, pane:'labelPane',
        }).addTo(labels);
        // Area proxy for priority (larger oblasts win the declutter).
        let w=0,h=0; try{ const s=b.getNorthEast(), t=b.getSouthWest(); w=Math.abs(s.lng-t.lng); h=Math.abs(s.lat-t.lat); }catch(e){}
        labelEntries.push({ marker:mk, name:n, area:w*h });
      });
      declutterLabels();
    }catch(e){}
  }

  // ── Movement animation along CONFIRMED positions (turns included) ────────
  // When a track's trail has ≥2 confirmed fixes, the marker glides through
  // those fixes in order instead of cutting straight to the newest one, so a
  // real direction change reads as an animated turn. Only confirmed points
  // are used — nothing is extrapolated.
  const animByTrack=new Map();
  function cancelAnim(tid){
    const a=animByTrack.get(tid);
    if(a){ try{ cancelAnimationFrame(a.raf); }catch(err){} animByTrack.delete(tid); }
  }
  function setGlyphHeading(marker,deg){
    try{
      const el=marker.getElement();
      const svg=el&&el.querySelector('.threat-svg');
      if(svg){
        svg.style.transition='transform .9s ease-out';
        svg.style.transform='rotate('+(deg||0)+'deg)';
      }
    }catch(err){}
  }
  function lerp(a,b,t){ return a+(b-a)*t; }
  function bearingDeg(a,b){
    const dLat=b.lat-a.lat, dLon=(b.lon-a.lon)*Math.cos((a.lat*Math.PI)/180);
    let d=Math.atan2(dLon,dLat)*180/Math.PI;
    if(!Number.isFinite(d)) d=0;
    return (d+360)%360;
  }
  function animateThrough(marker,tid,pts){
    cancelAnim(tid);
    if(!Array.isArray(pts)||pts.length<2){ return false; }
    // Segment lengths → proportional timing (longer legs take longer).
    const legs=[]; let total=0;
    for(let i=0;i<pts.length-1;i++){
      const d=Math.hypot(pts[i+1].lat-pts[i].lat,(pts[i+1].lon-pts[i].lon)*Math.cos((pts[i].lat*Math.PI)/180));
      legs.push(d); total+=d;
    }
    if(total<=1e-9){ return false; }
    const DUR=1600; // total glide time for the confirmed path
    const start=performance.now();
    try{ const el=marker.getElement(); if(el) el.style.transitionDuration='0ms'; }catch(err){}
    const step=(now)=>{
      const t=Math.min(1,(now-start)/DUR);
      const target=total*t;
      let acc=0, lat=pts[0].lat, lon=pts[0].lon, seg=0;
      for(let i=0;i<legs.length;i++){
        if(acc+legs[i]>=target||i===legs.length-1){
          const f=legs[i]>0?Math.min(1,(target-acc)/legs[i]):1;
          lat=lerp(pts[i].lat,pts[i+1].lat,f);
          lon=lerp(pts[i].lon,pts[i+1].lon,f);
          seg=i;
          break;
        }
        acc+=legs[i];
      }
      marker.setLatLng([lat,lon]);
      setGlyphHeading(marker,bearingDeg(pts[seg],pts[seg+1]||pts[seg]));
      if(t<1){
        const raf=requestAnimationFrame(step);
        animByTrack.set(tid,{raf});
      }else{
        animByTrack.delete(tid);
        try{ const el=marker.getElement(); if(el) el.style.transitionDuration=''; }catch(err){}
      }
    };
    const raf=requestAnimationFrame(step);
    animByTrack.set(tid,{raf});
    return true;
  }
  // trailByTrack: filled by setEvents from the trail list (confirmed fixes).
  const trailByTrack=new Map();

  // Single-track marker upsert shared by full sync and live updates:
  // same L.marker object glides via planMove, DOM persists when visuals
  // are unchanged. Returns the marker, or null for non-point events.
  function upsertMarker(e,now){
    if(!e||!plotworthy(e))return null;
    const ac=ageClass(e,now);
    const tid=e.trackId||e.id;
    const prevEv=currentByTrack.get(tid)||null;
    currentByTrack.set(tid,e);
    let marker=markerByTrack.get(tid);
    const kindNow=classifyThreat(e);
    // Orientation: source course first; otherwise the bearing between the
    // last two CONFIRMED trail fixes (real observed movement, not a guess).
    let headingNow=shouldShowHeading(e)?Number(e.heading):null;
    if(headingNow==null){
      const tp=trailByTrack.get(tid);
      if(Array.isArray(tp)&&tp.length>=2){
        const b=tp[tp.length-1], a=tp[tp.length-2];
        const dLat=b.lat-a.lat, dLon=(b.lon-a.lon)*Math.cos((a.lat*Math.PI)/180);
        const d=Math.atan2(dLon,dLat)*180/Math.PI;
        if(Number.isFinite(d)) headingNow=(d+360)%360;
      }
    }
    const sig=[kindNow,headingNow??'x',ac,e._lvl||''].join('|');    if(marker){
      // Confirmed-point glide only: planMove gates same-track, both
      // confirmed, newer timestamp; duration scales with distance.
      const plan=planMove(prevEv,e);
      // Turn-aware animation: with ≥2 confirmed trail fixes for this track,
      // glide through them in order (real turns animate). Otherwise fall
      // back to the straight confirmed-point glide.
      const trailPts=trailByTrack.get(tid);
      const animated=plan.animate && trailPts && trailPts.length>=2 && animateThrough(marker,tid,trailPts);
      if(!animated){
        if(plan.animate){
          try{
            const el=marker.getElement();
            if(el)el.style.transitionDuration=Math.min(1800,Math.max(600,plan.durationMs))+'ms';
          }catch(err){}
          marker.setLatLng([e.lat,e.lon]);
        }else if(marker.getLatLng().lat!==e.lat||marker.getLatLng().lng!==e.lon){
          try{const el=marker.getElement();if(el)el.style.transitionDuration='';}catch(err){}
          marker.setLatLng([e.lat,e.lon]);
        }
      }
      // Updates never replay the .new pulse ring: it renders once, on add.
      // Skip setIcon entirely when nothing visual changed, so the SAME DOM
      // node (and its CSS glide transition) survives background refreshes.
      if(marker.options._sig!==sig){
        marker.setIcon(eventIcon({ ...e, isNew: false, _headingOverride: headingNow },ac));
        marker.options._sig=sig;
      }
      marker.options.category=e.category;
      marker.options.threatKind=kindNow;
    }else{
      marker=L.marker([e.lat,e.lon],{
        icon:eventIcon({ ...e, _headingOverride: headingNow },ac),
        category:e.category,
        threatKind:classifyThreat(e),
        pane:'threatPane',
      }).on('click',()=>onSelect(currentByTrack.get(tid)||e));
      marker.options._sig=sig;
      markerByTrack.set(tid,marker);
      targets.addLayer(marker);
      if(tid===selectedTrack){const g=glyphEl(marker);if(g)g.classList.add('selected');}
    }
    return marker;
  }
  // Live single-track update (WS upsert): moves/refreshes one marker,
  // never rebuilds the layer. Returns true when a marker was touched.
  function updateTrack(e){
    return !!upsertMarker(e,Date.now());
  }
  function removeTrack(tid){
    const m=markerByTrack.get(tid);
    if(m){try{targets.removeLayer(m);}catch(e){}markerByTrack.delete(tid);}
    currentByTrack.delete(tid);
    if(selectedTrack===tid)setSelectedTrack(null);
  }

  // Reference-style trail: a solid coloured path along CONFIRMED positions
  // with chevron arrowheads placed along it showing the direction of travel.
  // Nothing is drawn beyond the last confirmed fix — no forecast.
  function arrowSizeDeg(){
    try{ const z=map.getZoom(); return Math.max(0.005, 0.022/Math.pow(2,Math.max(0,z-6))); }
    catch(e){ return 0.012; }
  }
  function drawTrail(points,color,weightMul){
    if(!Array.isArray(points)||points.length<2)return;
    const w=2.8*(weightMul||1);
    const n=points.length-1;
    for(let i=0;i<n;i++){
      const a=points[i], b=points[i+1];
      const f=(i+1)/n;                       // newer segment = more visible
      L.polyline([[a.lat,a.lon],[b.lat,b.lon]],{
        color,weight:w,opacity:(0.35+0.5*f).toFixed(2),lineCap:'round',interactive:false,
      }).addTo(trails);
      // Chevron («>») at the segment midpoint, pointing along the movement.
      const dLat=b.lat-a.lat, dLon=(b.lon-a.lon)*Math.cos((a.lat*Math.PI)/180);
      const len=Math.hypot(dLat,dLon);
      if(len<1e-6) continue;
      const uLat=dLat/len, uLon=dLon/len;
      const k=Math.cos(((a.lat+b.lat)/2*Math.PI)/180)||1;
      const pLat=-uLon*k, pLon=uLat/k;
      const size=arrowSizeDeg();
      const midLat=(a.lat+b.lat)/2, midLon=(a.lon+b.lon)/2;
      const tip=[midLat+uLat*size*0.9, midLon+uLon*size*0.9];
      const left=[midLat-uLat*size*0.5+pLat*size*0.75, midLon-uLon*size*0.5+pLon*size*0.75];
      const right=[midLat-uLat*size*0.5-pLat*size*0.75, midLon-uLon*size*0.5-pLon*size*0.75];
      L.polyline([left,tip,right],{color,weight:w*0.9,opacity:(0.5+0.45*f).toFixed(2),lineCap:'round',lineJoin:'round',interactive:false}).addTo(trails);
    }
    // Final arrowhead at the newest confirmed position.
    const a=points[points.length-2], b=points[points.length-1];
    const dLat=b.lat-a.lat, dLon=b.lon-a.lon;
    const len=Math.hypot(dLat,dLon);
    if(len>1e-6){
      const uLat=dLat/len, uLon=dLon/len;
      const k=Math.cos((b.lat*Math.PI)/180)||1;
      const pLat=-uLon*k, pLon=uLat/k;
      const size=arrowSizeDeg();
      const tip=[b.lat+uLat*size, b.lon+uLon*size];
      const l=[b.lat+pLat*size*0.6, b.lon+pLon*size*0.6];
      const r=[b.lat-pLat*size*0.6, b.lon-pLon*size*0.6];
      L.polygon([tip,l,r],{color,weight:0,fillColor:color,fillOpacity:.95,interactive:false}).addTo(trails);
    }
  }

  function setEvents(events,visible,selTrail,trailList){
    applyZoomClass();
    const seenTracks=new Set();
    areas.clearLayers();
    reported.clearLayers();
    trails.clearLayers();
    uncertainties.clearLayers();
    // Trails FIRST: fill trailByTrack (animation needs it this cycle) but do
    // NOT draw yet — drawing is filtered to tracks whose marker is actually
    // visible after declutter, so no orphan dashed segments float on the map.
    const pendingTrails = [];
    trailByTrack.clear();
    if(Array.isArray(trailList)){
      const PRIORITY_TRAIL=new Set(['shahed','missile','ballistic','kab','aviation']);
      let trailBudget=14;
      for(const tr of trailList){
        if(!tr||!Array.isArray(tr.points)||tr.points.length<2)continue;
        const kind=(()=>{ try{ return classifyThreat(tr); }catch(e){ return 'other'; } })();
        const maxPts=PRIORITY_TRAIL.has(kind)?6:4;
        const pts=tr.points.slice(-maxPts).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
        if(pts.length<2) continue;
        trailByTrack.set(tr.trackId,pts);
        if(trailBudget<=0) continue;
        trailBudget--;
        if(selTrail&&tr.trackId===selTrail.trackId)continue;
        pendingTrails.push({ tr, pts, kind, mul: PRIORITY_TRAIL.has(kind)?1:0.72 });
      }
    }
    const now=Date.now();
    for(const e of events){
      if(!visible.has(e.category))continue;
      const tier=accuracyTier(e);

      // ── Area-only / Imprecise: dashed region outline ONLY ────────────────
      if((tier==='area'||tier==='report')&&!plotworthy(e)){
        if(e.areaOnly&&geo){
          const f=geo.features.find(x=>regionName(x)===e.region);
          if(f)L.geoJSON(f,{style:{color:META[classifyThreat(e)]?.color||'#efb55b',dashArray:'6 7',weight:1.4,fillOpacity:.06}}).addTo(areas);
        }
        // FOR AREA/REPORT THREATS: SKIP ADDING POINT MARKERS ENTIRELY
        continue;
      }

      // ── Coordinate marker: persistent object per stable track ────────────
      const m=upsertMarker(e,now);
      if(m)seenTracks.add(e.trackId||e.id);

      // Approximate but real positions show the source's own uncertainty as a
      // dashed ring — the glyph never pretends to be a precise point.
      if(tier!=='exact'){
        const unc=Number(e.uncertaintyKm);
        if(Number.isFinite(unc)&&unc>0){
          L.circle([+e.lat,+e.lon],{radius:unc*1000,color:META[classifyThreat(e)]?.color||'#efb55b',weight:1.1,opacity:.5,dashArray:'4 6',fill:false,interactive:false}).addTo(uncertainties);
        }
      }

      // NOTE: no forward heading line and no full-route polyline here.
      // Direction is shown ONLY by rotating the glyph itself (orientation,
      // never position). Trails render exclusively from confirmed past
      // positions via the trail lists below — nothing is drawn ahead of
      // the marker, so no line can be read as a forecast or landing point.
    }
    // Prune markers whose tracks left the snapshot (backend drops them only
    // after repeated misses, so absence here means genuinely gone).
    for(const [tid,m] of markerByTrack){
      if(!seenTracks.has(tid)){try{targets.removeLayer(m);}catch(e){}markerByTrack.delete(tid);currentByTrack.delete(tid);}
    }
    declutterTargets();
    // Draw trails only for tracks whose marker survived declutter — a trail
    // without a visible target would read as a stale, orphaned line.
    for(const pt of pendingTrails){
      const mk=markerByTrack.get(pt.tr.trackId);
      const g=mk&&glyphEl(mk);
      if(!g||g.classList.contains('target-hidden')) continue;
      drawTrail(pt.pts, META[pt.kind]?.color||'#efb55b', pt.mul);
    }
    // Selected-track trail: last confirmed positions only (source trail for
    // MAPA, accumulated history otherwise), thin and muted. Older segments
    // fade out; the newest segment near the target is most visible. Never
    // global, never a forecast.
    if(selTrail&&Array.isArray(selTrail.points)&&selTrail.points.length>1){
      drawTrail(selTrail.points.slice(-8), META[selTrail.category]?.color||'#efb55b', 1.15);
    }
  }

  function setWind(items){wind.clearLayers();for(const w of items||[]){if(!Number.isFinite(w.lat)||!Number.isFinite(w.lon)||!Number.isFinite(w.speedKmh)||!Number.isFinite(w.fromDeg))continue;const to=(w.fromDeg+180)%360;L.marker([w.lat,w.lon],{icon:windIcon(w,to),interactive:true}).bindTooltip(`${w.speedKmh} км/год`,{direction:'top',offset:[0,-18]}).addTo(wind)}}

  // Raion fills: SOLID opaque colours with thin light outlines (reference),
  // so each raion/community reads as its own crisp territory. 'calm' is an
  // invisible-but-clickable polygon so every raion responds to a tap.
  const RAION_FILL = {
    alert:    { color:'#FFFFFF', weight:0.9, opacity:0.5, fillColor:'#C62839', fillOpacity:.95 },
    critical: { color:'#FFFFFF', weight:1.0, opacity:0.55, fillColor:'#B01F30', fillOpacity:.96 },
    high:     { color:'#FFFFFF', weight:0.9, opacity:0.5, fillColor:'#D9A441', fillOpacity:.95 },
    medium:   { color:'#FFFFFF', weight:0.8, opacity:0.4, fillColor:'#A87C22', fillOpacity:.92 },
    calm:     { color:'#64748B', weight:0.6, opacity:0.28, fillColor:'#000000', fillOpacity:0 },
  };
  function setAlertShapes(items){
    ashapes.clearLayers();
    for(const r of items||[]){const s=RAION_FILL[r.level]||RAION_FILL.alert;for(const poly of r.polys||[])L.polygon(poly,{color:s.color,weight:s.weight,opacity:s.opacity,fillColor:s.fillColor,fillOpacity:s.fillOpacity,interactive:false}).addTo(ashapes)}
  }

  function setRaionShapes(items){
    shapes.clearLayers();
    for(const r of items||[]){
      // Only show alert raions prominently; calm raions get very subtle neutral border
      if(r.status==='alert'){
        const col='#FF536A';
        for(const ring of r.rings||[])L.polyline(ring,{color:col,weight:1.8,opacity:.9,interactive:false}).addTo(shapes);
      }else if(r.status==='mon'){
        const col='#FFAA27';
        for(const ring of r.rings||[])L.polyline(ring,{color:col,weight:1.2,opacity:.6,interactive:false}).addTo(shapes);
      }else{
        // Calm raions: extremely subtle, only visible at high zoom
        for(const ring of r.rings||[])L.polyline(ring,{color:'#94A3B8',weight:.6,opacity:.15,interactive:false}).addTo(shapes);
      }
    }
  }

  function setRaionDots(items){
    dots.clearLayers();
    for(const r of items||[]){
      if(!Number.isFinite(r.lat)||!Number.isFinite(r.lon))continue;
      const _m=L.marker([r.lat,r.lon],{icon:raionDotIcon(r.status),interactive:false});
      // NON-PERMANENT TOOLTIP: shows on hover/click, does not clutter overview map permanently
      if(r.status==='alert')_m.bindTooltip(r.name||'Район',{permanent:false,direction:'top',offset:[0,-12],className:'raion-tip'});
      _m.addTo(dots);
    }
  }

  function setReports(items,onReport){reports.clearLayers();for(const r of items||[]){if(!Number.isFinite(r.lat)||!Number.isFinite(r.lon))continue;L.marker([r.lat,r.lon],{icon:reportIcon()}).on('click',()=>onReport&&onReport(r)).addTo(reports)}}

  let lastUser=null;
  function setUserPos(p){
    lastUser=(p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon))?p:null;
    user.clearLayers();
    if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))return;
    if(Number.isFinite(p.acc))L.circle([p.lat,p.lon],{radius:Math.max(30,p.acc),color:'#477FE0',weight:1,opacity:.5,fillOpacity:.08,interactive:false}).addTo(user);
    L.marker([p.lat,p.lon],{icon:userIcon(),interactive:false,zIndexOffset:1000}).addTo(user);
  }

  function toggle(kind,on){
    if(kind==='satellite'){if(on){satellite.addTo(map);map.getContainer().classList.add('satellite-on')}else{if(map.hasLayer(satellite))map.removeLayer(satellite);map.getContainer().classList.remove('satellite-on')}return}
    const layers={alerts:regions,area:areas,history:trails,uncertainty:uncertainties,monitoring:targets,boundaries:regions,wind:wind,reports:reports,raions:dots,shapes:shapes};
    const l=layers[kind];
    if(!l)return;
    if(on&&!map.hasLayer(l))l.addTo(map);
    if(!on&&map.hasLayer(l))map.removeLayer(l);
  }
  function centerOnUser(){if(lastUser)map.setView([lastUser.lat,lastUser.lon],9)}
  function showHome(name){if(!geo)return;const f=name&&geo.features.find(x=>regionName(x)===name);const b=f?L.geoJSON(f).getBounds():regions.getBounds();if(b&&b.isValid())map.fitBounds(b,{padding:[12,12]})}
  let selectedTrack=null;
  function glyphEl(m){try{const el=m.getElement();if(!el)return null;return el.classList.contains('threat-marker')?el:el.querySelector('.threat-marker');}catch(e){return null;}}
  function setSelectedTrack(tid){
    selectedTrack=tid||null;
    for(const [id,m] of markerByTrack){
      const g=glyphEl(m);
      if(g)g.classList.toggle('selected',id===selectedTrack);
    }
  }
  return{map,setRegions,setEvents,updateTrack,removeTrack,setWind,setReports,setRaionDots,setRaionShapes,setAlertShapes,setUserPos,centerOnUser,showHome,setSelectedTrack,toggle,meta:META,fitUkraine,refitOnResize};
}

// ── Radar range rings ────────────────────────────────────────────────────────
// Beautiful divisions per selected maximum range (km). Pure and unit-tested.
const RANGE_PRESETS = [1, 3, 5, 10, 25, 100];
function rangeRings(rangeKm) {
  const r = Number(rangeKm);
  if (r === 1) return [0.2, 0.4, 0.6, 0.8, 1];
  if (r === 3) return [0.6, 1.2, 1.8, 2.4, 3];
  if (r === 5) return [1, 2, 3, 4, 5];
  if (r === 10) return [2, 4, 6, 8, 10];
  if (r === 25) return [5, 10, 15, 20, 25];
  if (r === 100) return [20, 40, 60, 80, 100];
  if (Number.isFinite(r) && r > 0) {
    const steps = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50, 100, 200, 400, 800, 1500];
    const below = steps.filter(s => s < r).slice(-3);
    return [...below, r];
  }
  return [20, 40, 60, 100];
}

// ── Radar map (radar tab) ─────────────────────────────────────────────────────
export function createRadarMap(el,onSelect){
  const map=baseMap(el,[49,31],6,{zoomControl:false});
  if(!map.getPane('threatPane')) map.createPane('threatPane');
  map.getPane('threatPane').style.zIndex=625;
  const satellite=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18,crossOrigin:true,className:'sat-tiles'});
  const layer=L.layerGroup().addTo(map);
  const rings=L.layerGroup().addTo(map);
  const vectors=L.layerGroup().addTo(map);
  const guard=L.layerGroup().addTo(map);
  const user=L.layerGroup().addTo(map);
  const pin=L.layerGroup().addTo(map);
  const afills=L.layerGroup().addTo(map);
  const grid=L.layerGroup().addTo(map);
  const borders=L.layerGroup().addTo(map);
  graticule().forEach(l=>l.addTo(grid));
  let lastC=null;
  // Root cause of "Cannot read properties of undefined (reading 'x')":
  // renderAll() runs on every data load, including while #radarMap is hidden
  // (0px). Adding Path layers to a Canvas-rendered map with no size leaves
  // _pxBounds undefined and L.Canvas._draw crashes. Defer Leaflet mutations
  // until the container is visible; the scope canvas (pure math) updates
  // regardless via scopeUI.update in app.js.
  let pending=null;
  const visible=()=>{ try{ return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0; }catch(e){ return false; } };

  function render(events,center,opts={}){
    if(!visible()){ pending=Object.assign({},pending,{events,center,opts}); return; }
    pending=null;
    layer.clearLayers();rings.clearLayers();vectors.clearLayers();guard.clearLayers();
    if(!lastC||Math.abs(lastC[0]-center[0])>0.05||Math.abs(lastC[1]-center[1])>0.05){map.setView(center,6);lastC=center}
    for(const km of rangeRings(opts.range||100))L.circle(center,{radius:km*1000,color:'#477FE0',weight:1,opacity:.18,fill:false,interactive:false}).addTo(rings);
    if(Number.isFinite(opts.guardKm)&&opts.guardKm>0)L.circle(center,{radius:opts.guardKm*1000,color:'#EF3F36',weight:1.6,opacity:.6,dashArray:'8 8',fill:false,interactive:false}).addTo(guard);
    L.circleMarker(center,{radius:5,color:'#fff',fillColor:'#477FE0',fillOpacity:1,weight:2}).addTo(rings);
    events.filter(e=>plotworthy(e)).slice(0,300).forEach(e=>{
      L.marker([e.lat,e.lon],{icon:blipIcon(e),category:e.category,threatKind:classifyThreat(e),pane:'threatPane'}).on('click',()=>onSelect(e)).addTo(layer);
      const tier=accuracyTier(e);
      const unc=Number(e.uncertaintyKm);
      if(tier!=='exact'&&Number.isFinite(unc)&&unc>0){
        L.circle([+e.lat,+e.lon],{radius:unc*1000,color:META[classifyThreat(e)]?.color||'#efb55b',weight:1.1,opacity:.5,dashArray:'4 6',fill:false,interactive:false}).addTo(vectors);
      }
      // NOTE: no forward heading projection here either — the rotated glyph
      // alone shows direction. Nothing is drawn ahead of any marker.
    });
  }

  function renderUser(p){user.clearLayers();if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))return;L.marker([p.lat,p.lon],{icon:userIcon(),interactive:false,zIndexOffset:1000}).addTo(user)}
  function setSatellite(on){if(on){satellite.addTo(map);map.getContainer().classList.add('satellite-on')}else{if(map.hasLayer(satellite))map.removeLayer(satellite);map.getContainer().classList.remove('satellite-on')}}
  function setRadarRegions(g,alerts){
    if(!visible()){ pending=Object.assign({},pending,{geo:g}); return; }
    borders.clearLayers();if(!g||!g.features)return;L.geoJSON(g,{style:{color:'#64748B',weight:1.2,fillColor:'#CBD5E1',fillOpacity:.1}}).addTo(borders)}
  function setAlertFills(items){applyAlertFills(items);}
  function applyAlertFills(items){
    if(!visible()){ pending=Object.assign({},pending,{fills:items}); return; }
    afills.clearLayers();for(const r of items||[]){for(const poly of r.polys||[])L.polygon(poly,{color:'#ff8f9a',weight:1.4,fillColor:'#c44150',fillOpacity:.3,interactive:false}).addTo(afills)}}
  function flush(){
    if(!visible()) return false;
    try{ map.invalidateSize(true); }catch(e){}
    const p=pending; pending=null;
    if(p){
      if(p.geo!==undefined) setRadarRegions(p.geo);
      if(p.fills!==undefined) applyAlertFills(p.fills);
      if(p.events!==undefined) render(p.events,p.center,p.opts||{});
    }
    return true;
  }
  function showPin(lat,lon,label){pin.clearLayers();if(!Number.isFinite(lat)||!Number.isFinite(lon))return;L.marker([lat,lon],{icon:pinIcon()}).bindTooltip(label||'Місце',{permanent:true,direction:'top',offset:[0,-16]}).addTo(pin);map.setView([lat,lon],9);lastC=[lat,lon]}
  return{map,render,renderUser,showPin,setSatellite,setAlertFills,setBorders:setRadarRegions,flush};
}

// ── Base map factory ──────────────────────────────────────────────────────────
// Basemap: OpenFreeMap vector style (OpenMapTiles schema, OSM geodata),
// rendered inside Leaflet via MapLibre. Engine stays Leaflet — every
// operational overlay (oblast/raion polygons, markers, trails,
// GPS/Home) remains a Leaflet layer above the basemap pane.
function baseMap(el,center,zoom,opts={}){
  const map=L.map(el,{zoomControl:opts.zoomControl!==false,minZoom:5,maxZoom:12,attributionControl:false,preferCanvas:true}).setView(center,zoom);
  if(map.zoomControl)map.zoomControl.setPosition('bottomright');
  // Async: vector first, OSM-raster fallback keeps the app alive offline.
  try{attachBasemap(map)?.catch?.(()=>{});}catch(e){}
  map.attributionControl?.setPrefix?.(false);
  return map;
}

// Responsive Ukraine fit: desktop keeps room for the right rail (~320px),
// mobile keeps room for the bottom nav + HUD. Prevents Crimea / Zakarpattia /
// Donbas cut-off (TZ §23).
export function ukraineFitOptions(){
  try{
    const w = window.innerWidth;
    if(w >= 1100) return { paddingTopLeft:[18,18], paddingBottomRight:[26,26] };
    if(w >= 720) return { paddingTopLeft:[20,90], paddingBottomRight:[30,60] };
    return { paddingTopLeft:[12,70], paddingBottomRight:[12,110] };
  }catch(e){ return { padding:[16,16] }; }
}

// ── Icon factories ─────────────────────────────────────────────────────────────
function eventIcon(e,ac){
  const m=iconFor(e);
  // Orientation: explicit override (trail-derived bearing) wins, then the
  // source course.
  const heading=(e._headingOverride!=null&&Number.isFinite(e._headingOverride))
    ? Number(e._headingOverride)
    : (shouldShowHeading(e)?Number(e.heading):null);
  const cls=[
    'threat-marker',
    'cat-'+(e.category||'other'),
    'kind-'+m.kind,
    'age-'+(ac||'old'),
    e.stale?'stale':'',
    e.advisory?'advisory':'',
  ].filter(Boolean).join(' ');
  // Clean SVG-only marker: no circular background, no label clutter at overview zoom.
  // Source-reported group size (count>1 from the source itself) renders as a
  // compact ×N badge on that track's own marker — never merged from proximity.
  const srcCount=Number(e.count);
  const countBadge=Number.isFinite(srcCount)&&srcCount>1?`<span class="mk-count">×${Math.min(99,Math.floor(srcCount))}</span>`:'';
  return L.divIcon({
    className:'',
    html:`<div class="${cls}" style="--c:${m.color};--heading:${heading??0}deg;opacity:1" data-directed="${heading!==null}" data-accuracy="${accuracyTier(e)}">
      ${glyphSvg(m.icon, 32)}${countBadge}
    </div>`,
    iconSize:[40,40],iconAnchor:[20,20],
  });
}

function blipIcon(e){
  const m=iconFor(e);
  const cls=['radar-blip','cat-'+(e.category||'other'),'kind-'+m.kind].filter(Boolean).join(' ');
  return L.divIcon({className:'',html:`<div class="${cls}" style="--c:${m.color}"><svg class="threat-svg"><use href="${THREAT_SVG}#${m.icon}"/></svg></div>`,iconSize:[36,36],iconAnchor:[18,18]});
}

function userIcon(){return L.divIcon({className:'',html:`<div class="user-pos-dot" title="Ваше положення"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function pinIcon(){return L.divIcon({className:'',html:`<div class="radar-pin" title="Знайдене місце"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function windIcon(w,to){const o=Math.min(0.85,0.3+w.speedKmh/80);return L.divIcon({className:'',html:`<div class="wind-arrow" style="--w:${to}deg;opacity:${o.toFixed(2)}"><svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg><b>${w.speedKmh}</b></div>`,iconSize:[44,44],iconAnchor:[22,22]})}
function raionDotIcon(st){return L.divIcon({className:'',html:'<div class="raion-dot st-'+(st||'calm')+'"></div>',iconSize:[14,14],iconAnchor:[7,7]})}
function reportIcon(){return L.divIcon({className:'',html:`<div class="user-report" title="Локальна мітка"><span>R</span></div>`,iconSize:[28,28],iconAnchor:[14,14]})}
function graticule(){const lines=[];for(let lon=20;lon<=42;lon+=2)lines.push([[43,lon],[53,lon]]);for(let lat=44;lat<=52;lat+=2)lines.push([[lat,20],[lat,42]]);return lines.map(l=>L.polyline(l,{color:'#477FE0',weight:1,opacity:.16,interactive:false}))}

export{META,iconFor,THREAT_SIZE,NEBO_ATTRIBUTION,rangeRings,RANGE_PRESETS};
