import{regionName}from'../../services/regions.js';
import{classifyThreat,accuracyTier,freshnessScore,ageClass,shouldShowHeading}from'../../services/threatClassify.js';

// ── Threat metadata ───────────────────────────────────────────────────────────
// 'shahed' is a distinct visual kind within the uav category.
const META={
  shahed:   {label:'ШАХЕД',   icon:'shahed',   color:'#f5c04a'},
  uav:      {label:'БПЛА',    icon:'uav',      color:'#efb55b'},
  recon:    {label:'РОЗВІДКА',icon:'uav',      color:'#9d91ff'},
  missile:  {label:'РАКЕТА',  icon:'missile',  color:'#ff6f7d'},
  ballistic:{label:'БАЛІСТИКА',icon:'ballistic',color:'#ff5568'},
  kab:      {label:'КАБ',     icon:'kab',      color:'#f2905d'},
  aviation: {label:'АВІАЦІЯ', icon:'aircraft', color:'#7db9ff'},
  other:    {label:'Інше',    icon:'other',    color:'#a6b3bc'},
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
  const clusters=L.markerClusterGroup({
    showCoverageOnHover:false,
    maxClusterRadius:64,
    spiderfyOnMaxZoom:true,
    iconCreateFunction:clusterIcon,
  });
  map.addLayer(clusters);
  let geo=null,fitted=false;

  // Zoom-dependent label visibility
  function applyZoomClass(){
    const z=map.getZoom();
    const c=map.getContainer();
    c.className=c.className.replace(/\bmap-zoom-\d+\b/g,'');
    c.classList.add('map-zoom-'+z);
  }
  map.on('zoomend',applyZoomClass);
  // defer until container is in DOM
  setTimeout(applyZoomClass,0);

  function setRegions(g,alerts){
    geo=g;
    regions.clearLayers();
    regions.addData(g);
    regions.eachLayer(layer=>{
      const n=regionName(layer.feature),key=layer.feature.properties?.key;
      const list=alerts.filter(x=>x.key===key||x.region===n);
      const wide=list.some(x=>!x.district),a=list[0];
      layer.setStyle({color:wide?'#ff7e89':list.length?'#efb55b':'#29485c',weight:list.length?1.6:.8,fillColor:wide?'#c44150':'#0d2635',fillOpacity:wide?.34:.12});
      layer.on('click',()=>onSelect(a?{...a,raions:list.map(x=>x.district).filter(Boolean),partial:!wide}:{official:true,category:'alert',region:n,status:'inactive',source:'Поточні офіційні дані'}));
    });
    if(!fitted&&regions.getBounds().isValid()){fitted=true;map.fitBounds(regions.getBounds(),{padding:[8,8]})}
  }

  function setEvents(events,visible){
    clusters.clearLayers();
    areas.clearLayers();
    reported.clearLayers();
    trails.clearLayers();
    uncertainties.clearLayers();
    const now=Date.now();
    for(const e of events){
      if(!visible.has(e.category))continue;
      const tier=accuracyTier(e);

      // ── Area-only: dashed region outline ─────────────────────────────────
      if(tier==='area'||tier==='report'){
        if(e.areaOnly&&geo){
          const f=geo.features.find(x=>regionName(x)===e.region);
          if(f)L.geoJSON(f,{style:{color:META[classifyThreat(e)]?.color||'#efb55b',dashArray:'6 7',weight:1.4,fillOpacity:.06}}).addTo(areas);
        }
        // For area/report threats with known region but no exact point,
        // skip adding a fake point marker entirely.
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
      // shouldShowHeading() checks COORDINATE precision, !areaOnly, !stale.
      // Additional inline guard: heading must be finite (Number.isFinite(e.heading)).
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

  function setAlertShapes(items,onPick){ashapes.clearLayers();for(const r of items||[]){for(const poly of r.polys||[])L.polygon(poly,{color:'#ffa3ad',weight:2,fillColor:'#c44150',fillOpacity:.38}).on('click',()=>onPick&&onPick(r)).addTo(ashapes)}}

  function setRaionShapes(items){shapes.clearLayers();for(const r of items||[]){const col=r.status==='alert'?'#ff5568':r.status==='mon'?'#efb55b':'#3d5a74';for(const ring of r.rings||[])L.polyline(ring,{color:col,weight:r.status==='alert'?1.8:1.1,opacity:r.status==='calm'?.45:.85,interactive:false}).addTo(shapes)}}

  function setRaionDots(items,onPick){dots.clearLayers();for(const r of items||[]){if(!Number.isFinite(r.lat)||!Number.isFinite(r.lon))continue;const _m=L.marker([r.lat,r.lon],{icon:raionDotIcon(r.status)}).on('click',()=>onPick&&onPick(r));if(r.status==='alert')_m.bindTooltip(r.name||'Район',{permanent:true,direction:'top',offset:[0,-12],className:'raion-tip'});_m.addTo(dots)}}

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

// ── Radar map (radar tab) ─────────────────────────────────────────────────────
export function createRadarMap(el,onSelect){
  const map=baseMap(el,[49,31],6,{zoomControl:true});
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
    [25,50,100,200].forEach(km=>L.circle(center,{radius:km*1000,color:'#66c7ff',weight:1,opacity:.18,fill:false,interactive:false}).addTo(rings));
    if(Number.isFinite(opts.guardKm)&&opts.guardKm>0)L.circle(center,{radius:opts.guardKm*1000,color:'#ff6f7d',weight:1.6,opacity:.6,dashArray:'8 8',fill:false,interactive:false}).addTo(guard);
    L.circleMarker(center,{radius:5,color:'#fff',fillColor:'#66c7ff',fillOpacity:1,weight:2}).addTo(rings);
    events.filter(e=>e.lat!=null&&e.lon!=null&&accuracyTier(e)==='exact').slice(0,300).forEach(e=>{
      L.marker([e.lat,e.lon],{icon:blipIcon(e),category:e.category,threatKind:classifyThreat(e)}).on('click',()=>onSelect(e)).addTo(layer);
      // Heading vector only when source has reliable position AND direction (Number.isFinite(e.heading))
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
  return L.divIcon({
    className:'',
    html:`<div class="${cls}" style="--c:${m.color};--heading:${heading??0}deg;opacity:${opacity}" data-directed="${heading!==null}" data-accuracy="${accuracyTier(e)}">
      <svg><use href="./assets/brand/threat-icons.svg#${m.icon}"/></svg>
      <div class="pulse"></div>
      <b class="mk-label">${m.label}</b>
    </div>`,
    iconSize:[36,44],iconAnchor:[18,22],
  });
}

function blipIcon(e){
  const m=iconFor(e);
  const cls=['radar-blip','cat-'+(e.category||'other'),'kind-'+m.kind,e._distKm!=null&&e._distKm<25?'near':'',e._lvl==='red'?'lvl-red':''].filter(Boolean).join(' ');
  return L.divIcon({className:'',html:`<div class="${cls}" style="--c:${m.color}"><i></i><svg><use href="./assets/brand/threat-icons.svg#${m.icon}"/></svg><b class="mk-label">${m.label}</b></div>`,iconSize:[40,54],iconAnchor:[20,27]});
}

function userIcon(){return L.divIcon({className:'',html:`<div class="user-pos-dot" title="Ваше положення"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function pinIcon(){return L.divIcon({className:'',html:`<div class="radar-pin" title="Знайдене місце"></div>`,iconSize:[16,16],iconAnchor:[8,8]})}
function windIcon(w,to){const o=Math.min(0.85,0.3+w.speedKmh/80);return L.divIcon({className:'',html:`<div class="wind-arrow" style="--w:${to}deg;opacity:${o.toFixed(2)}"><svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg><b>${w.speedKmh}</b></div>`,iconSize:[44,44],iconAnchor:[22,22]})}
function raionDotIcon(st){return L.divIcon({className:'',html:'<div class="raion-dot st-'+(st||'calm')+'"></div>',iconSize:[14,14],iconAnchor:[7,7]})}
function reportIcon(){return L.divIcon({className:'',html:`<div class="user-report" title="Локальна мітка"><span>R</span></div>`,iconSize:[28,28],iconAnchor:[14,14]})}
function graticule(){const lines=[];for(let lon=20;lon<=42;lon+=2)lines.push([[43,lon],[53,lon]]);for(let lat=44;lat<=52;lat+=2)lines.push([[lat,20],[lat,42]]);return lines.map(l=>L.polyline(l,{color:'#66c7ff',weight:1,opacity:.16,interactive:false}))}

// ── Cluster icon with threat-type composition ─────────────────────────────────
function clusterIcon(cluster){
  const children=cluster.getAllChildMarkers();
  // Count by threatKind (set on marker options) for composition summary
  const counts={};
  for(const c of children){
    const k=c.options.threatKind||c.options.category||'other';
    counts[k]=(counts[k]||0)+1;
  }
  const n=cluster.getChildCount();
  const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,2);
  const summary=sorted.map(([k,v])=>`${v} ${META[k]?.label||k}`).join(' · ');
  const dom=sorted[0]?.[0]||'other';
  const m=META[dom]||META.other;
  const title=`${n} повідомлень: ${summary}`;
  return L.divIcon({
    className:'',
    html:`<div class="threat-cluster" style="--c:${m.color}" title="${title}" aria-label="${title}">
      <svg><use href="./assets/brand/threat-icons.svg#${m.icon}"/></svg>
      <b>${n}</b>
      <small class="cluster-summary">${summary}</small>
    </div>`,
    iconSize:[60,50],iconAnchor:[30,25],
  });
}

export{META,iconFor};
