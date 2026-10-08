import{regionName}from'../../services/regions.js';
import{territorialDanger,normOblast}from'../../services/districts.js';
import{classifyThreat,accuracyTier,ageClass,shouldShowHeading}from'../../services/threatClassify.js';
import{attachBasemap,NEBO_ATTRIBUTION}from'./basemap.js';
import{planMove}from'../../services/tracks.js';

// Module-relative URL of the threat icon sprite: resolves correctly from any
// page base path (/, /nebo-ua/, /dev/, widget/...) without hardcoding it.
const THREAT_SVG = new URL('../brand/threat-icons.svg', import.meta.url).href;

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
  // Reference look: FLAT soft fills, no neon, no colored glow. Borders are
  // thin and neutral so only the fill carries the status.
  oblastCritical: { color:'#00000000', weight:0, fillColor:'#B7253A', fillOpacity:0.40 },
  oblastElevated: { color:'#00000000', weight:0, fillColor:'#C07A16', fillOpacity:0.32 },
  neutral:        { color:'#00000000', weight:0, fillColor:'#22344A', fillOpacity:0.40 },
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

      // Click handler: show raion details if partial (raion-only alerts)
      const a=list[0]||null;
      const raionList = list.filter(x=>x.district).map(x=>x.district).filter(Boolean);
      const partial = !list.some(x=>!x.district) && raionList.length > 0;
      layer.on('click',()=>onSelect(a?{...a,raions:raionList,partial}:{official:true,category:'alert',region:n,status:'inactive',source:'Поточні офіційні дані'}));
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

  // Single-track marker upsert shared by full sync and live updates:
  // same L.marker object glides via planMove, DOM persists when visuals
  // are unchanged. Returns the marker, or null for non-point events.
  function upsertMarker(e,now){
    if(!e||accuracyTier(e)!=='exact'||e.lat==null||e.lon==null)return null;
    const ac=ageClass(e,now);
    const tid=e.trackId||e.id;
    const prevEv=currentByTrack.get(tid)||null;
    currentByTrack.set(tid,e);
    let marker=markerByTrack.get(tid);
    const kindNow=classifyThreat(e);
    const headingNow=shouldShowHeading(e)?Number(e.heading):null;
    const sig=[kindNow,headingNow??'x',ac,e._lvl||''].join('|');
    if(marker){
      // Confirmed-point glide only: planMove gates same-track, both
      // confirmed, newer timestamp; duration scales with distance.
      const plan=planMove(prevEv,e);
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
      // Updates never replay the .new pulse ring: it renders once, on add.
      // Skip setIcon entirely when nothing visual changed, so the SAME DOM
      // node (and its CSS glide transition) survives background refreshes.
      if(marker.options._sig!==sig){
        marker.setIcon(eventIcon({ ...e, isNew: false },ac));
        marker.options._sig=sig;
      }
      marker.options.category=e.category;
      marker.options.threatKind=kindNow;
    }else{
      marker=L.marker([e.lat,e.lon],{
        icon:eventIcon(e,ac),
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

  function setEvents(events,visible,selTrail,trailList){
    applyZoomClass();
    const seenTracks=new Set();
    areas.clearLayers();
    reported.clearLayers();
    trails.clearLayers();
    uncertainties.clearLayers();
    const now=Date.now();
    for(const e of events){
      if(!visible.has(e.category))continue;
      const tier=accuracyTier(e);

      // ── Area-only / Imprecise: dashed region outline ONLY ────────────────
      if(tier==='area'||tier==='report'){
        if(e.areaOnly&&geo){
          const f=geo.features.find(x=>regionName(x)===e.region);
          if(f)L.geoJSON(f,{style:{color:META[classifyThreat(e)]?.color||'#efb55b',dashArray:'6 7',weight:1.4,fillOpacity:.06}}).addTo(areas);
        }
        // FOR AREA/REPORT THREATS: SKIP ADDING POINT MARKERS ENTIRELY
        continue;
      }

      // ── Exact coordinate marker: persistent object per stable track ──────
      const m=upsertMarker(e,now);
      if(m)seenTracks.add(e.trackId||e.id);

      // Uncertainty is shown as a number in the popup, never as a circle:
      // no accuracy/uncertainty rings around targets on the main map.

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
    // Background trails for every fresh track with ≥2 confirmed positions
    // (MAPA source trail or session history). Thin, muted, behind markers.
    // Selected track keeps its stronger emphasis below.
    if(Array.isArray(trailList)){
      for(const tr of trailList){
        if(!tr||!Array.isArray(tr.points)||tr.points.length<2)continue;
        if(selTrail&&tr.trackId===selTrail.trackId)continue;
        const col=META[tr.category]?.color||'#efb55b';
        const pts=tr.points.slice(-8);
        for(let i=0;i<pts.length-1;i++){
          const f=(i+1)/(pts.length-1);
          L.polyline([[pts[i].lat,pts[i].lon],[pts[i+1].lat,pts[i+1].lon]],{color:col,weight:1.2,opacity:(0.10+0.22*f).toFixed(2),dashArray:'1 4',interactive:false}).addTo(trails);
        }
        pts.forEach((p,i)=>{
          if(i===pts.length-1)return;
          L.circleMarker([p.lat,p.lon],{radius:1.6,color:col,weight:1,opacity:.3,fillOpacity:.25,interactive:false}).addTo(trails);
        });
      }
    }
    // Selected-track trail: last confirmed positions only (source trail for
    // MAPA, accumulated history otherwise), thin and muted. Older segments
    // fade out; the newest segment near the target is most visible. Never
    // global, never a forecast.
    if(selTrail&&Array.isArray(selTrail.points)&&selTrail.points.length>1){
      const col=META[selTrail.category]?.color||'#efb55b';
      const pts=selTrail.points.slice(-8);
      for(let i=0;i<pts.length-1;i++){
        const f=(i+1)/(pts.length-1);
        L.polyline([[pts[i].lat,pts[i].lon],[pts[i+1].lat,pts[i+1].lon]],{color:col,weight:i===pts.length-2?2:1.2,opacity:(0.12+0.38*f).toFixed(2),dashArray:'2 5',interactive:false}).addTo(trails);
      }
      pts.forEach((p,i)=>{
        if(i===pts.length-1)return;
        const f=(i+1)/pts.length;
        L.circleMarker([p.lat,p.lon],{radius:2,color:col,weight:1,opacity:(0.2+0.3*f).toFixed(2),fillOpacity:(0.15+0.25*f).toFixed(2),interactive:false}).addTo(trails);
      });
    }
  }

  function setWind(items){wind.clearLayers();for(const w of items||[]){if(!Number.isFinite(w.lat)||!Number.isFinite(w.lon)||!Number.isFinite(w.speedKmh)||!Number.isFinite(w.fromDeg))continue;const to=(w.fromDeg+180)%360;L.marker([w.lat,w.lon],{icon:windIcon(w,to),interactive:true}).bindTooltip(`${w.speedKmh} км/год`,{direction:'top',offset:[0,-18]}).addTo(wind)}}

  // Raion fills: flat soft fills, no glowing borders (reference look).
  const RAION_FILL = {
    alert:    { color:'#00000000', weight:0, fillColor:'#B7253A', fillOpacity:.36 },
    critical: { color:'#00000000', weight:0, fillColor:'#C22B3E', fillOpacity:.40 },
    high:     { color:'#00000000', weight:0, fillColor:'#C07A16', fillOpacity:.30 },
    medium:   { color:'#00000000', weight:0, fillColor:'#8E6316', fillOpacity:.24 },
  };
  function setAlertShapes(items,onPick){ashapes.clearLayers();for(const r of items||[]){const s=RAION_FILL[r.level]||RAION_FILL.alert;for(const poly of r.polys||[])L.polygon(poly,{color:s.color,weight:s.weight,fillColor:s.fillColor,fillOpacity:s.fillOpacity}).on('click',()=>onPick&&onPick(r)).addTo(ashapes)}}

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
        for(const ring of r.rings||[])L.polyline(ring,{color:'#1a3a4a',weight:.6,opacity:.15,interactive:false}).addTo(shapes);
      }
    }
  }

  function setRaionDots(items,onPick){
    dots.clearLayers();
    for(const r of items||[]){
      if(!Number.isFinite(r.lat)||!Number.isFinite(r.lon))continue;
      const _m=L.marker([r.lat,r.lon],{icon:raionDotIcon(r.status)}).on('click',()=>onPick&&onPick(r));
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
    if(Number.isFinite(p.acc))L.circle([p.lat,p.lon],{radius:Math.max(30,p.acc),color:'#66c7ff',weight:1,opacity:.5,fillOpacity:.08,interactive:false}).addTo(user);
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
    for(const km of rangeRings(opts.range||100))L.circle(center,{radius:km*1000,color:'#66c7ff',weight:1,opacity:.18,fill:false,interactive:false}).addTo(rings);
    if(Number.isFinite(opts.guardKm)&&opts.guardKm>0)L.circle(center,{radius:opts.guardKm*1000,color:'#ff6f7d',weight:1.6,opacity:.6,dashArray:'8 8',fill:false,interactive:false}).addTo(guard);
    L.circleMarker(center,{radius:5,color:'#fff',fillColor:'#66c7ff',fillOpacity:1,weight:2}).addTo(rings);
    events.filter(e=>e.lat!=null&&e.lon!=null&&accuracyTier(e)==='exact').slice(0,300).forEach(e=>{
      L.marker([e.lat,e.lon],{icon:blipIcon(e),category:e.category,threatKind:classifyThreat(e),pane:'threatPane'}).on('click',()=>onSelect(e)).addTo(layer);
      // NOTE: no forward heading projection here either — the rotated glyph
      // alone shows direction. Nothing is drawn ahead of any marker.
    });
  }

  function renderUser(p){user.clearLayers();if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))return;L.marker([p.lat,p.lon],{icon:userIcon(),interactive:false,zIndexOffset:1000}).addTo(user)}
  function setSatellite(on){if(on){satellite.addTo(map);map.getContainer().classList.add('satellite-on')}else{if(map.hasLayer(satellite))map.removeLayer(satellite);map.getContainer().classList.remove('satellite-on')}}
  function setRadarRegions(g,alerts){
    if(!visible()){ pending=Object.assign({},pending,{geo:g}); return; }
    borders.clearLayers();if(!g||!g.features)return;L.geoJSON(g,{style:{color:'#7fa8c9',weight:1.2,fillColor:'#0d2635',fillOpacity:.1}}).addTo(borders)}
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
  const heading=shouldShowHeading(e)?Number(e.heading):null;
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
      <svg class="threat-svg"><use href="${THREAT_SVG}#${m.icon}"/></svg>${countBadge}
      <span class="mk-label">${m.label}</span>
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
function graticule(){const lines=[];for(let lon=20;lon<=42;lon+=2)lines.push([[43,lon],[53,lon]]);for(let lat=44;lat<=52;lat+=2)lines.push([[lat,20],[lat,42]]);return lines.map(l=>L.polyline(l,{color:'#66c7ff',weight:1,opacity:.16,interactive:false}))}

export{META,iconFor,THREAT_SIZE,NEBO_ATTRIBUTION,rangeRings,RANGE_PRESETS};
