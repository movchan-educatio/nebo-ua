import{fetchJson}from'./http.js';import{normalizeMapa}from'./normalize.js';
const URL='https://mapa.ua/api/v1/current';
export async function fetchMapa(signal){const receivedAt=new Date(),data=await fetchJson(URL,{signal,timeout:12000});const ts=data?.ts?new Date(Number(data.ts)*1000):receivedAt;return{serverTime:ts,events:(Array.isArray(data?.objects)?data.objects:[]).map(x=>normalizeMapa(x,receivedAt)).filter(Boolean),attack:data?.attack||null};}
