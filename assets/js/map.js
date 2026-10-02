import { regionName } from '../../services/regions.js';
const META={uav:['🛸','БПЛА'],recon:['◉','Розвідувальний БПЛА'],missile:['➤','Ракетна загроза'],ballistic:['◆','Балістична загроза'],kab:['⬢','КАБ'],mig31k:['△','Авіаційна загроза'],unknown:['•','Інше']};
export function createMap(el){
  const map=L.map(el,{zoomControl:false,minZoom:5,maxZoom:12}).setView([48.6,31.2],6);
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19,crossOrigin:true}).addTo(map);
  const polygons=L.geoJSON(null).addTo(map),groups={};
  Object.keys(META).forEach(k=>groups[k]=L.layerGroup().addTo(map));
  function setRegions(geo,alerts){const active=new Set(alerts.map(a=>a.key));polygons.clearLayers();polygons.addData(geo);polygons.eachLayer(layer=>{const f=layer.feature,n=regionName(f),key=f.properties?.key,isActive=active.has(key)||alerts.some(a=>a.name===n||a.oblast===n);layer.setStyle({color:isActive?'#ff6472':'#456173',weight:isActive?2:1,fillColor:isActive?'#d9364a':'#163044',fillOpacity:isActive?.42:.22});const a=alerts.find(x=>x.key===key||x.name===n||x.oblast===n);layer.bindPopup(`<div class="popup-title">${escape(n)}</div><p>${a?'🔴 Повітряна тривога':'Активний сигнал повітряної тривоги не зафіксований у поточних даних.'}</p>${a?`<div class="popup-meta">Початок: ${fmt(a.since)}<br>Джерело: <a href="${a.sourceUrl}" target="_blank" rel="noopener">${a.source}</a></div>`:''}`)});map.fitBounds(polygons.getBounds(),{padding:[10,10]})}
  function setThreats(items,visible){Object.values(groups).forEach(g=>g.clearLayers());items.filter(t=>t.hasPoint&&visible.has(t.type)).slice(0,500).forEach(t=>{const [icon,label]=META[t.type]||META.unknown;const marker=L.marker([t.lat,t.lon],{icon:L.divIcon({className:'',html:`<div class="marker">${icon}</div>`,iconSize:[28,28],iconAnchor:[14,14]})});marker.bindPopup(`<div class="popup-title">${icon} ${escape(t.title||label)}</div><div class="popup-meta">Регіон: ${escape(t.region||'не вказано')}<br>${t.district?`Район: ${escape(t.district)}<br>`:''}${Number.isFinite(t.heading)?`За даними джерела: напрямок ${Math.round(t.heading)}°<br>`:''}Час: ${fmt(t.updatedAt)}<br>Статус: Моніторингова інформація<br>Джерело: <a href="${t.sourceUrl}" target="_blank" rel="noopener">${t.source}</a></div>`);marker.addTo(groups[t.type])})}
  function toggle(type,on){if(on&&!map.hasLayer(groups[type]))groups[type].addTo(map);if(!on&&map.hasLayer(groups[type]))map.removeLayer(groups[type])}
  return {map,setRegions,setThreats,toggle,meta:META};
}
const escape=s=>String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt=d=>d?new Intl.DateTimeFormat('uk-UA',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}).format(new Date(d)):'не вказано';
