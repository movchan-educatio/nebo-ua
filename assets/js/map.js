import{regionName}from'../../services/regions.js';
import{territorialDanger,normOblast}from'../../services/districts.js';
import{classifyThreat,accuracyTier,freshnessScore,ageClass,shouldShowHeading}from'../../services/threatClassify.js';

// Module-relative URL of the threat icon sprite: resolves correctly from any
// page base path (/, /nebo-ua/, /dev/, widget/...) without hardcoding it.
const THREAT_SVG = new URL('../brand/threat-icons.svg', import.meta.url).href;

// ── Threat metadata ───────────────────────────────────────────────────────────
// 'shahed' is a distinct visual kind within the uav category.
// 'recon' is a distinct kind for reconnaissance UAVs.
const META={
  shahed:   {label:'ШАХЕД',   icon:'shahed',   color:'#ffb21c'},
  uav:      {label:'БПЛА',    icon:'uav',      color:'#f4a62a'},
  recon:    {label:'РОЗВІДКА',icon:'recon',    color:'#5bbcff'},
  missile:  {label:'РАКЕТА',  icon:'missile',  color:'#ff4d62'},
  ballistic:{label:'БАЛІСТИКА',icon:'ballistic',color:'#ff1744'},
  kab:      {label:'КАБ',     icon:'kab',      color:'#ff7a45'},
  aviation: {label:'АВІАЦІЯ', icon:'aircraft', color:'#9b7cff'},
  other:    {label:'Інше',    icon:'other',    color:'#c7d0da'},
};

// ── Territorial danger colors ──────────────────────────────────────────────────
// The oblast polygon is painted ONLY for oblast-level danger (official alert
// with district==null, or missile/ballistic monitor with district==null).
// Raion-level danger NEVER paints the oblast polygon — it is rendered as
// separate raion polygons (see setAlertShapes + drawAlertShapes in app.js).
const DANGER_STYLE = {
  // Oblast-level danger: missile, ballistic, oblast-wide official alert
  oblastCritical: { color:'#ff3344', weight:2.0, fillColor:'#cc0011', fillOpacity:0.38 },
  // Neutral: no oblast-level danger (even if some raion inside has danger)
  neutral:        { color:'#29485c', weight:0.8, fillColor:'#0d2635', fillOpacity:0.12 },
};

function iconFor(e){
  const kind=classifyThreat(e);
  const m=META[kind]||META.other;
  return{label:m.label,icon:m.icon,color:m.color,kind};
}

// ── Situation map (main map tab) ──────────────────────────────────────────────
export function createSituationMap(el,onSelect){
  const map=baseMap(el,[48.6,31.2],6);
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
  const clusters=L.markerClusterGroup({
    showCoverageOnHover:false,
    maxClusterRadius:80,
    disableClusteringAtZoom:11,
    spiderfyOnMaxZoom:true,
    iconCreateFunction:clusterIcon,
    clusterPane:'threatPane',
  });
  map.addLayer(clusters);
  let geo=null,fitted=false;

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

      // Click handler: show raion details if partial (raion-only alerts)
      const a=list[0]||null;
      const raionList = list.filter(x=>x.district).map(x=>x.district).filter(Boolean);
      const partial = !list.some(x=>!x.district) && raionList.length > 0;
      layer.on('click',()=>onSelect(a?{...a,raions:raionList,partial}:{official:true,category:'alert',region:n,status:'inactive',source:'Поточні офіційні дані'}));
    });
    if(!fitted&&regions.getBounds().isValid()){fitted=true;map.fitBounds(regions.getBounds(),{padding:[8,8]})}
  }

  function setEvents(events,visible){
    applyZoomClass();
    clusters.clearLayers();
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

      // ── Exact coordinate marker ───────────────────────────────────────────
      if(e.lat==null||e.lon==null)continue;
      const ac=ageClass(e,now);
      const fs=freshnessScore(e,now);
      const marker=L.marker([e.lat,e.lon],{
        icon:eventIcon(e,ac,fs),
        category:e.category,
        threatKind:classifyThreat(e),
        pane:'threatPane',
      }).on('click',()=>onSelect(e));
      clusters.addLayer(marker);

      // Uncertainty circle
      if(e.uncertaintyKm)L.circle([e.lat,e.lon],{radius:e.uncertaintyKm*1000,color:META[e.category]?.color||'#efb55b',weight:1,fillOpacity:.025,className:'uncertainty'}).addTo(uncertainties);

      // Trail
      if(!e.stale&&e.trail?.length>1){
        const pts=e.trail.map(p=>[p.lat,p.lon]);
        for(let i=0;i<pts.length-1;i++){
          L.polyline([pts[i],pts[i+1]],{color:META[e.category]?.color||'#efb55b',weight:2,opacity:0.18+(i/Math.max(1,pts.length-1))*0.62,dashArray:'3 7'}).addTo(trails);
        }
      }

      // Heading arrow – only when source has reliable position AND direction.
      if(Number.isFinite(e.heading)&&shouldShowHeading(e)){
        const rad=(90-Number(e.heading))*(Math.PI/180);
        const km10=Number(e.speed)/6;
        const cosLat=Math.cos(e.lat*Math.PI/180)||1;
        const dLat=(km10/111)*Math.sin(rad);
        const dLon=(km10/(111*Math.max(0.4,Math.abs(cosLat))))*Math.cos(rad);
        L.polyline([[e.lat,e.lon],[e.lat+dLat,e.lon+dLon]],{color:META[e.category]?.color||'#efb55b',weight:1.5,opacity:.55,dashArray:'5 5'}).addTo(trails);
      }
    }
  }

  function setWind(items){wind.clearLayers();for(const w of items||[]){if(!Number.isFinite(w.lat)||!Number.isFinite(w.lon)||!Number.isFinite(w.speedKmh)||!Number.isFinite(w.fromDeg))continue;const to=(w.fromDeg+180)%360;L.marker([w.lat,w.lon],{icon:windIcon(w,to),interactive:true}).bindTooltip(`${w.speedKmh} км/год`,{direction:'top',offset:[0,-18]}).addTo(wind)}}

  // Raion fill styles by danger level. Each item carries level:
  // 'alert'/'critical' -> red, 'high' -> orange, 'medium' -> dark amber.
  const RAION_FILL = {
    alert:    { color:'#ffa3ad', weight:2,   fillColor:'#c44150', fillOpacity:.38 },
    critical: { color:'#ff8090', weight:2,   fillColor:'#c44150', fillOpacity:.38 },
    high:     { color:'#ffaa33', weight:1.8, fillColor:'#cc5500', fillOpacity:.35 },
    medium:   { color:'#ffcc55', weight:1.4, fillColor:'#aa6600', fillOpacity:.25 },
  };
  function setAlertShapes(items,onPick){ashapes.clearLayers();for(const r of items||[]){const s=RAION_FILL[r.level]||RAION_FILL.alert;for(const poly of r.polys||[])L.polygon(poly,{color:s.color,weight:s.weight,fillColor:s.fillColor,fillOpacity:s.fillOpacity}).on('click',()=>onPick&&onPick(r)).addTo(ashapes)}}

  function setRaionShapes(items){
    shapes.clearLayers();
    for(const r of items||[]){
      // Only show alert raions prominently; calm raions get very subtle neutral border
      if(r.status==='alert'){
        const col='#ff5568';
        for(const ring of r.rings||[])L.polyline(ring,{color:col,weight:1.8,opacity:.9,interactive:false}).addTo(shapes);
      }else if(r.status==='mon'){
        const col='#efb55b';
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
    const layers={alerts:regions,area:areas,history:trails,uncertainty:uncertainties,monitoring:clusters,boundaries:regions,wind:wind,reports:reports,raions:dots,shapes:shapes};
    const l=layers[kind];
    if(!l)return;
    if(on&&!map.hasLayer(l))l.addTo(map);
    if(!on&&map.hasLayer(l))map.removeLayer(l);
  }
  function centerOnUser(){if(lastUser)map.setView([lastUser.lat,lastUser.lon],9)}
  function showHome(name){if(!geo)return;const f=name&&geo.features.find(x=>regionName(x)===name);const b=f?L.geoJSON(f).getBounds():regions.getBounds();if(b&&b.isValid())map.fitBounds(b,{padding:[12,12]})}
  return{map,setRegions,setEvents,setWind,setReports,setRaionDots,setRaionShapes,setAlertShapes,setUserPos,centerOnUser,showHome,toggle,meta:META};
}

// ── Radar range rings ────────────────────────────────────────────────────────
// Logical ring sets per selected maximum range (km). Pure and unit-tested.
const RANGE_PRESETS = [1, 3, 5, 10, 25, 100];
function rangeRings(rangeKm) {
  const r = Number(rangeKm);
  if (r === 1) return [0.25, 0.5, 1];
  if (r === 3) return [1, 2, 3];
  if (r === 5) return [1, 3, 5];
  if (r === 10) return [1, 3, 5, 10];
  if (r === 25) return [5, 10, 25];
  if (r === 100) return [25, 50, 100];
  if (Number.isFinite(r) && r > 0) {
    const steps = [0.25, 0.5, 1, 2, 3, 5, 10, 25, 50, 100, 200, 400, 800, 1500];
    const below = steps.filter(s => s < r).slice(-3);
    return [...below, r];
  }
  return [25, 50, 100];
}

// ── Radar map (radar tab) ─────────────────────────────────────────────────────
export function createRadarMap(el,onSelect){
  const map=baseMap(el,[49,31],6,{zoomControl:true});
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

  function render(events,center,opts={}){
    layer.clearLayers();rings.clearLayers();vectors.clearLayers();guard.clearLayers();
    if(!lastC||Math.abs(lastC[0]-center[0])>0.05||Math.abs(lastC[1]-center[1])>0.05){map.setView(center,6);lastC=center}
    for(const km of rangeRings(opts.range||100))L.circle(center,{radius:km*1000,color:'#66c7ff',weight:1,opacity:.18,fill:false,interactive:false}).addTo(rings);
    if(Number.isFinite(opts.guardKm)&&opts.guardKm>0)L.circle(center,{radius:opts.guardKm*1000,color:'#ff6f7d',weight:1.6,opacity:.6,dashArray:'8 8',fill:false,interactive:false}).addTo(guard);
    L.circleMarker(center,{radius:5,color:'#fff',fillColor:'#66c7ff',fillOpacity:1,weight:2}).addTo(rings);
    events.filter(e=>e.lat!=null&&e.lon!=null&&accuracyTier(e)==='exact').slice(0,300).forEach(e=>{
      L.marker([e.lat,e.lon],{icon:blipIcon(e),category:e.category,threatKind:classifyThreat(e),pane:'threatPane'}).on('click',()=>onSelect(e)).addTo(layer);
      if(Number.isFinite(e.heading)&&shouldShowHeading(e)){
        const h=Number(e.heading),s=Number(e.speed);
        const rad=(90-h)*(Math.PI/180),km10=s/6,cosLat=Math.cos(e.lat*Math.PI/180)||1;
        L.polyline([[e.lat,e.lon],[e.lat+(km10/111)*Math.sin(rad),e.lon+(km10/(111*Math.max(0.4,Math.abs(cosLat))))*Math.cos(rad)]],{color:META[e.category]?.color||'#efb55b',weight:1.2,opacity:.5,dashArray:'4 4',interactive:false}).addTo(vectors);
      }
    });
  }

  function renderUser(p){user.clearLayers();if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))return;L.marker([p.lat,p.lon],{icon:userIcon(),interactive:false,zIndexOffset:1000}).addTo(user)}
  function setSatellite(on){if(on){satellite.addTo(map);map.getContainer().classList.add('satellite-on')}else{if(map.hasLayer(satellite))map.removeLayer(satellite);map.getContainer().classList.remove('satellite-on')}}
  function setRadarRegions(g,alerts){borders.clearLayers();if(!g||!g.features)return;L.geoJSON(g,{style:{color:'#7fa8c9',weight:1.2,fillColor:'#0d2635',fillOpacity:.1}}).addTo(borders)}
  function setAlertFills(items){afills.clearLayers();for(const r of items||[]){for(const poly of r.polys||[])L.polygon(poly,{color:'#ff8f9a',weight:1.4,fillColor:'#c44150',fillOpacity:.3,interactive:false}).addTo(afills)}}
  function showPin(lat,lon,label){pin.clearLayers();if(!Number.isFinite(lat)||!Number.isFinite(lon))return;L.marker([lat,lon],{icon:pinIcon()}).bindTooltip(label||'Місце',{permanent:true,direction:'top',offset:[0,-16]}).addTo(pin);map.setView([lat,lon],9);lastC=[lat,lon]}
  return{map,render,renderUser,showPin,setSatellite,setAlertFills,setBorders:setRadarRegions};
}

// ── Base map factory ──────────────────────────────────────────────────────────
function baseMap(el,center,zoom,opts={}){
  const map=L.map(el,{zoomControl:opts.zoomControl!==false,minZoom:5,maxZoom:12,attributionControl:false,preferCanvas:true}).setView(center,zoom);
  if(map.zoomControl)map.zoomControl.setPosition('bottomright');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,crossOrigin:true,className:'nebo-tiles'}).addTo(map);
  return map;
}

// ── Icon factories ─────────────────────────────────────────────────────────────
function eventIcon(e,ac,fs){
  const m=iconFor(e);
  const heading=shouldShowHeading(e)?Number(e.heading):null;
  const opacity=Math.max(0.45,fs??1).toFixed(2);
  const cls=[
    'threat-marker',
    'cat-'+(e.category||'other'),
    'kind-'+m.kind,
    'age-'+(ac||'old'),
    e._distKm!=null&&e._distKm<25?'near':'',
    e._lvl==='red'?'lvl-red':'',
    e.isNew?'new':'',
    e.stale?'stale':'',
    e.advisory?'advisory':'',
    e.confirmed?'confirmed':'',
  ].filter(Boolean).join(' ');
  // Clean SVG-only marker: no circular background, no label clutter at overview zoom
  return L.divIcon({
    className:'',
    html:`<div class="${cls}" style="--c:${m.color};--heading:${heading??0}deg;opacity:${opacity}" data-directed="${heading!==null}" data-accuracy="${accuracyTier(e)}">
      <svg class="threat-svg"><use href="${THREAT_SVG}#${m.icon}"/></svg>
    </div>`,
    iconSize:[40,40],iconAnchor:[20,20],
  });
}

function blipIcon(e){
  const m=iconFor(e);
  const cls=['radar-blip','cat-'+(e.category||'other'),'kind-'+m.kind,e._distKm!=null&&e._distKm<25?'near':'',e._lvl==='red'?'lvl-red':''].filter(Boolean).join(' ');
  return L.divIcon({className:'',html:`<div class="${cls}" style="--c:${m.color}"><svg class="threat-svg"><use href="${THREAT_SVG}#${m.icon}"/></svg></div>`,iconSize:[36,36],iconAnchor:[18,18]});
}

function userIcon(){return L.divIcon({className:'',html:`<div class="user-pos-dot" title="Ваше положення"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function pinIcon(){return L.divIcon({className:'',html:`<div class="radar-pin" title="Знайдене місце"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function windIcon(w,to){const o=Math.min(0.85,0.3+w.speedKmh/80);return L.divIcon({className:'',html:`<div class="wind-arrow" style="--w:${to}deg;opacity:${o.toFixed(2)}"><svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg><b>${w.speedKmh}</b></div>`,iconSize:[44,44],iconAnchor:[22,22]})}
function raionDotIcon(st){return L.divIcon({className:'',html:'<div class="raion-dot st-'+(st||'calm')+'"></div>',iconSize:[14,14],iconAnchor:[7,7]})}
function reportIcon(){return L.divIcon({className:'',html:`<div class="user-report" title="Локальна мітка"><span>R</span></div>`,iconSize:[28,28],iconAnchor:[14,14]})}
function graticule(){const lines=[];for(let lon=20;lon<=42;lon+=2)lines.push([[43,lon],[53,lon]]);for(let lat=44;lat<=52;lat+=2)lines.push([[lat,20],[lat,42]]);return lines.map(l=>L.polyline(l,{color:'#66c7ff',weight:1,opacity:.16,interactive:false}))}

// ── Cluster icon with threat-type composition ─────────────────────────────────
// Pure composition: honest per-kind counts using real threat labels.
// Never renames a kind (generic UAV stays "БПЛА", never "ШАХЕД").
function clusterSummaryText(counts){
  const sorted=Object.entries(counts||{}).sort((a,b)=>b[1]-a[1]);
  const summaryParts=[];
  for(const [k,v] of sorted){
    summaryParts.push(`${v} ${META[k]?.label||k}`);
  }
  const summary=summaryParts.slice(0,2).join(' · ');
  const dom=sorted[0]?.[0]||'other';
  return{summary,summaryParts,dom};
}
// ── Small-group layout (2–4 targets, NO card) ──────────────────────────────────
// Transparent composition of individual silhouettes, each keeping its OWN
// kind icon and color (mixed groups stay readable). Footprint ≤ ~70px.
// Layouts: 2 = side by side, 3 = triangle, 4 = compact 2x2. No count text:
// the icons themselves show the quantity.
const GROUP_LAYOUTS = {
  2: { w: 64, h: 34, pts: [[17, 17], [47, 17]] },
  3: { w: 66, h: 56, pts: [[33, 15], [17, 41], [49, 41]] },
  4: { w: 70, h: 70, pts: [[19, 19], [51, 19], [19, 51], [51, 51]] },
};
function smallGroupHTML(items) {
  const list = (items || []).slice(0, 4);
  const lay = GROUP_LAYOUTS[list.length] || GROUP_LAYOUTS[4];
  const spans = list.map((it, i) => {
    const m = META[it.kind] || META.other;
    const [x, y] = lay.pts[i];
    return `<span class="tg-item" style="left:${x}px;top:${y}px;--c:${m.color}">`
      + `<svg class="tg-svg" viewBox="0 0 64 64"><use href="${THREAT_SVG}#${m.icon}"/></svg></span>`;
  }).join('');
  return { html: `<div class="threat-group g${list.length}" style="width:${lay.w}px;height:${lay.h}px">${spans}</div>`, w: lay.w, h: lay.h };
}
// ── Compact badge (5+ targets): round radar badge, dominant silhouette + ─────
// number. No big "8 БПЛА" text on the map; composition lives in title/aria
// and reveals itself on tap (zoom/spiderfy) or hover.
function clusterBadgeHTML(count, domKind, summaryText, titleText) {
  const m = META[domKind] || META.other;
  const title = titleText || `${count} повідомлень: ${summaryText || ''}`;
  return `<div class="threat-cluster is-badge" style="--c:${m.color}" title="${title}" aria-label="${title}">`
    + `<svg class="tg-badge-svg" viewBox="0 0 64 64"><use href="${THREAT_SVG}#${m.icon}"/></svg>`
    + `<b>${count}</b></div>`;
}
function clusterIcon(cluster){
  const children=cluster.getAllChildMarkers();
  const counts={};
  const items=[];
  for(const c of children){
    const k=c.options.threatKind||c.options.category||'other';
    counts[k]=(counts[k]||0)+1;
    items.push({kind:k});
  }
  const n=cluster.getChildCount();
  const{summaryParts}=clusterSummaryText(counts);
  const title=`${n} повідомлень: ${summaryParts.join(', ')}`;
  if(n<=4&&items.length){
    const g=smallGroupHTML(items);
    return L.divIcon({
      className:'',
      html:g.html.replace('class="threat-group', `title="${title}" aria-label="${title}" class="threat-group`),
      iconSize:[g.w,g.h],iconAnchor:[g.w/2,g.h/2],
    });
  }
  const{summary,dom}=clusterSummaryText(counts);
  void summary;
  return L.divIcon({
    className:'',
    html:clusterBadgeHTML(n,dom,summaryParts.slice(0,2).join(' · '),title),
    iconSize:[46,46],iconAnchor:[23,23],
  });
}

export{META,iconFor,clusterSummaryText,smallGroupHTML,clusterBadgeHTML,rangeRings,RANGE_PRESETS};
