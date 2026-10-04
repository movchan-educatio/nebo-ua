import test from'node:test';import assert from'node:assert/strict';import{selectGuardTargets,selectProximityAlerts}from'../services/guard.js';import{speak,voiceSupported}from'../services/voice.js';
test('guard selects only targets inside radius, ETA first',()=>{const events=[{id:'far',_distKm:80,_closing:false,_etaMin:null},{id:'near',_distKm:12,_closing:false,_etaMin:null},{id:'hot',_distKm:20,_closing:true,_etaMin:6},{id:'nocoords',_distKm:null}];const r=selectGuardTargets(events,30);assert.deepEqual(r.map(x=>x.e.id),['hot','near'])});
test('guard needs positive radius and user position context',()=>{assert.deepEqual(selectGuardTargets([{id:'a',_distKm:5}],0),[]);assert.deepEqual(selectGuardTargets([{id:'a',_distKm:5}],-3),[])});
test('proximity alerts only inside 10km and throttle repeats',()=>{
  const evs=[{id:'a',_distKm:8},{id:'b',_distKm:40},{id:'c',_distKm:5,stale:true}];
  const seen=new Map();
  const r1=selectProximityAlerts(evs,seen,1000);
  assert.deepEqual(r1.fresh.map(h=>h.id),['a']);
  seen.set('a',1000);
  assert.deepEqual(selectProximityAlerts(evs,seen,2000).fresh,[]);
  assert.deepEqual(selectProximityAlerts(evs,seen,200000).fresh.map(h=>h.id),['a']);
});test('voice never throws without browser speech',()=>{assert.equal(typeof voiceSupported(),'boolean');assert.equal(speak('тест'),false)});
