import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{describePlace,clearSelectedPlace}from'../services/locations.js';
import{pickTopThreat}from'../services/relevance.js';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const mem=()=>{const s={};return{getItem:k=>(k in s?s[k]:null),setItem:(k,v)=>{s[k]=String(v)},removeItem:k=>{delete s[k]}}};

test('describePlace builds title, sub and coverage levels',()=>{
  const d=describePlace({settlement:'Дмитрушки',raion:'Уманський район',oblast:'Черкаська область'});
  assert.equal(d.title,'Дмитрушки');
  assert.match(d.sub,/Уманський район/);assert.match(d.sub,/Черкаська область/);
  assert.deepEqual(d.levels.map(l=>l.key),['settlement','raion','oblast']);
});
test('describePlace handles oblast-only and empty place',()=>{
  const o=describePlace({oblast:'Черкаська область'});
  assert.equal(o.title,'Черкаська область');assert.deepEqual(o.levels.map(l=>l.key),['oblast']);
  const n=describePlace(null);
  assert.equal(n.title,'Місце не обрано');assert.deepEqual(n.levels,[]);
});
test('clearSelectedPlace removes stored place',()=>{
  const s=mem();s.setItem('nebo-location','{"settlement":"X"}');
  clearSelectedPlace(s);assert.equal(s.getItem('nebo-location'),null);
});
test('pickTopThreat prefers closing, then nearest, then latest',()=>{
  const a={id:'a',timestamp:new Date('2026-01-01T10:00:00Z')};
  const b={id:'b',timestamp:new Date('2026-01-01T11:00:00Z')};
  assert.equal(pickTopThreat([a,b],null).event.id,'b');
  const near={id:'n',timestamp:new Date('2026-01-01T09:00:00Z'),_distKm:3,_closing:false};
  const closing={id:'c',timestamp:new Date('2026-01-01T09:00:00Z'),_distKm:50,_closing:true,_etaMin:20};
  const r1=pickTopThreat([near,closing],{lat:49,lon:31});
  assert.equal(r1.event.id,'c');assert.equal(r1.reason,'closing');
  const r2=pickTopThreat([near,{...closing,_closing:false,_etaMin:null}],{lat:49,lon:31});
  assert.equal(r2.event.id,'n');assert.equal(r2.reason,'nearest');
});
test('pickTopThreat ignores stale events and empty input',()=>{
  assert.equal(pickTopThreat([],{lat:49,lon:31}),null);
  assert.equal(pickTopThreat([{id:'s',stale:true,timestamp:new Date()}],null),null);
});
test('UI uses Ukrainian monitoring wording, not Latin',()=>{
  const app=read('assets/js/app.js');
  assert.match(app,/МОНІТОРИНГОВЕ ПОВІДОМЛЕННЯ/);
  assert.match(app,/Моніторингові дані не скасовують офіційний сигнал/);
  assert.match(app,/Моніторингових даних:/);
  assert.match(app,/Моніторингові дані не замінюють офіційний статус/);
  assert.match(app,/До карти/);
});
