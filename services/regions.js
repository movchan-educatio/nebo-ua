import { fetchJson } from './http.js';
// Use absolute path from GitHub Pages base (/nebo-ua/) to avoid relative fetch issues in ES modules
const GEOJSON_BASE = '/nebo-ua/';
export async function fetchRegions(){
  const geo=await fetchJson(`${GEOJSON_BASE}data/ukraine-regions.geojson`,{timeout:8000});
  if(geo?.type!=='FeatureCollection'||!Array.isArray(geo.features)) throw new Error('Некоректний GeoJSON');
  return geo;
}
export function regionName(feature){return feature?.properties?.region||feature?.properties?.name||feature?.properties?.NAME_1||feature?.properties?.oblast||feature?.properties?.name_uk||feature?.properties?.key||'Регіон';}
export function pointInFeature([lat,lon],feature){
  const polys=feature.geometry?.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry?.coordinates||[];
  return polys.some(poly=>insideRing([lon,lat],poly[0]||[]));
}
function insideRing([x,y],ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j];if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))inside=!inside}return inside}
