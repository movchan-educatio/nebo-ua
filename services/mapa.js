import{fetchJson}from'./http.js';import{normalizeMapa}from'./normalize.js';
const URL='https://check-ua-proxy.kykyyzka.workers.dev/mapa';
export async function fetchMapa(signal){const receivedAt=new Date(),data=await fetchJson(URL,{signal,timeout:12000});const ts=data?.ts?new Date(Number(data.ts)*1000):receivedAt;return{serverTime:ts,events:dedupe((Array.isArray(data?.objects)?data.objects:[]).map(x=>normalizeMapa(x,receivedAt)).filter(Boolean)),attack:data?.attack||null};}
function dedupe(items){return [...new Map(items.map(x=>[x.id,x])).values()];}
