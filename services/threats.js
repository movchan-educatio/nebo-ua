import { fetchJson } from './http.js';
const URL = 'https://check-ua-proxy.kykyyzka.workers.dev/threats';
const TYPES = new Set(['uav','recon','missile','ballistic','kab','mig31k','unknown']);
export async function fetchThreats(signal) {
  const data = await fetchJson(URL, { signal, timeout: 9000 });
  const serverTime = validDate(data.serverTime);
  const threats = Array.isArray(data.threats) ? data.threats : [];
  return {serverTime, stale:data.stale===true, threats: dedupe(threats.map(normalize).filter(Boolean))};
}
function normalize(t){
  if(!t || !t.id || !TYPES.has(t.type) || t.status === 'resolved') return null;
  const lat=Number(t.lat),lon=Number(t.lon),updatedAt=validDate(t.updatedAt);
  const hasPoint=Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=43&&lat<=53&&lon>=20&&lon<=42&&!t.areaOnly;
  return {...t,id:String(t.id),lat,lon,updatedAt,hasPoint,source:'NEPTUN',sourceUrl:'https://neptun.in.ua/'};
}
function dedupe(items){return [...new Map(items.map(x=>[x.id,x])).values()];}
function validDate(value){const d=new Date(value);return Number.isFinite(d.getTime())?d:null;}
