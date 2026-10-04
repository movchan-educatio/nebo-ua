import test from'node:test';import assert from'node:assert/strict';import{fetchAggregated} from'../services/aggregator.js';
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch});
const serverSnapshot=()=>({
  v:1,serverTime:'2026-10-04T12:00:00Z',receivedAt:'2026-10-04T12:00:05Z',
  health:{
    OFFICIAL:{status:'disabled',updatedAt:null,error:null},
    NEPTUN:{status:'online',updatedAt:'2026-10-04T12:00:05Z',error:null},
    MAPA:{status:'online',updatedAt:'2026-10-04T12:00:05Z',error:null},
  },
  alerts:[{id:'official:x',source:'NEPTUN / офіційні канали',official:true,category:'alert',region:'Черкаська область',district:null,eventTime:'2026-10-04T11:50:00Z',receivedAt:'2026-10-04T12:00:05Z',latencyMs:605000}],
  events:[{id:'neptun:a',source:'NEPTUN',official:false,category:'uav',lat:49,lon:31,eventTime:'2026-10-04T11:59:00Z',receivedAt:'2026-10-04T12:00:05Z',latencyMs:65000,confidence:'high',stale:false,trail:[]}],
  disagreement:{active:false,reason:''},
});
test('aggregator snapshot adapts to the app shape with dates kept',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify(serverSnapshot()),{status:200});
  const s=await fetchAggregated();
  assert.ok(s.receivedAt instanceof Date);
  assert.equal(s.alerts[0].source,'NEPTUN / офіційні канали');
  assert.ok(s.alerts[0].timestamp instanceof Date);
  assert.equal(s.events[0].latencyMs,65000);
  assert.equal(s.events[0].confidence,'high');
  assert.equal(s.health.OFFICIAL.status,'disabled');
});
test('aggregator rejects malformed snapshots',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({v:1}),{status:200});
  await assert.rejects(fetchAggregated(),/агрегатора/);
});
