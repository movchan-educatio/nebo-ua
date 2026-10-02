import test from 'node:test';import assert from 'node:assert/strict';import {fetchJson} from '../services/http.js';import {fetchThreats} from '../services/threats.js';
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch});
test('HTTP errors are surfaced without malformed parsing',async()=>{globalThis.fetch=async()=>new Response('fail',{status:500});await assert.rejects(fetchJson('https://example.invalid'),/HTTP 500/)});
test('malformed JSON is rejected',async()=>{globalThis.fetch=async()=>new Response('{bad',{status:200});await assert.rejects(fetchJson('https://example.invalid'),/Некоректний JSON/)});
test('threat adapter removes invalid coordinates and duplicates',async()=>{globalThis.fetch=async()=>new Response(JSON.stringify({serverTime:'2026-10-02T20:00:00Z',threats:[{id:'a',type:'uav',lat:50,lon:30,status:'active',updatedAt:'2026-10-02T20:00:00Z'},{id:'a',type:'uav',lat:50,lon:30,status:'active',updatedAt:'2026-10-02T20:00:00Z'},{id:'b',type:'uav',lat:99,lon:30,status:'active'}]}),{status:200});const r=await fetchThreats();assert.equal(r.threats.length,2);assert.equal(r.threats.find(x=>x.id==='b').hasPoint,false)});
