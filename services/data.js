import{fetchAlerts}from'./alerts.js';import{fetchThreats}from'./threats.js';import{fetchMapa}from'./mapa.js';import{fetchAggregated}from'./aggregator.js';import{DATA_MODE}from'./config.js';import{normalizeAlert,normalizeNeptun,isFresh}from'./normalize.js';import{correlate,fuse,detectDisagreement}from'./correlation.js';
export async function fetchAll(signal) {
  if (DATA_MODE === 'aggregator') {
    try { return await fetchAggregated(signal); }
    catch (e) { console.warn('Aggregator unavailable, falling back to direct fetch', e); }
  }
  const tasks = await Promise.allSettled([fetchAlerts(signal), fetchThreats(signal), fetchMapa(signal)]);
  if (tasks.every(r => r.status === 'rejected')) throw new Error('Усі джерела тимчасово недоступні');
  const checkedAt = new Date();
  const health = {
    NEPTUN: { ...healthItem(tasks[1], tasks[1].status === 'fulfilled' && tasks[1].value.stale, checkedAt),
      alertsStatus: tasks[0].status === 'fulfilled' ? 'online' : 'offline' },
    MAPA: healthItem(tasks[2], false, checkedAt),
  };
  const alerts = tasks[0].status === 'fulfilled' ? tasks[0].value.map(x => normalizeAlert(x, checkedAt)).filter(Boolean) : [];
  const neptun = tasks[1].status === 'fulfilled' ? tasks[1].value.threats.map(x => normalizeNeptun(x, checkedAt)).filter(Boolean) : [];
  const mapa = tasks[2].status === 'fulfilled' ? tasks[2].value.events : [];
  const events = [...neptun, ...mapa].map(e => ({ ...e, stale: e.stale || !isFresh(e) }));
  const fused = fuse(correlate(events));
  const receivedAt = health.NEPTUN.lastSuccessAt || health.MAPA.lastSuccessAt || null;
  return { alerts, events: fused, rawEvents: events, health, disagreement: detectDisagreement(events, health),
    receivedAt, directFallback: true, degraded: true };
}
function healthItem(result, delayed, checkedAt) {
  const ok = result.status === 'fulfilled';
  const lastSuccessAt = ok && !delayed ? checkedAt : null;
  return { status: ok ? 'online' : 'offline', checkedAt, updatedAt: lastSuccessAt, lastSuccessAt,
    ...(delayed ? { delayed: true } : {}),
    error: ok ? (delayed ? 'Джерело позначило потік як застарілий' : null) : result.reason?.message || 'Недоступно' };
}
export function getOfficialAlert(snapshot,region){return snapshot.alerts.filter(a=>a.region===region)}
export const POLL_MS=20000;
export function shouldPoll({hidden=false,autoRefresh=true,loading=false,lastStart=0,nowMs=Date.now(),intervalMs=POLL_MS}={}){
  if(hidden||!autoRefresh||loading)return false;
  return nowMs-lastStart>=intervalMs;
}export function getActiveThreats(snapshot,region){return snapshot.events.filter(e=>!region||e.region===region||e.derivedRegion===region)}export function getSourceHealth(snapshot){return snapshot.health}export function getRegionStatus(snapshot,region){return{official:getOfficialAlert(snapshot,region),monitoring:getActiveThreats(snapshot,region),updatedAt:snapshot.receivedAt}}export function getRecentChanges(timeline,region){return timeline.filter(x=>!region||x.region===region).slice(0,20)}
