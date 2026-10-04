import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{normRaion,normOblast,matchRaion,raionMatches,raionAlertActive,raionDirectory,oblastRaions}from'../services/districts.js';
const CHERKASY = raionDirectory('Черкаська область');
test('raion directory covers Cherkasy with Uman',()=>{assert.ok(CHERKASY.includes('Уманський'));assert.equal(CHERKASY.length,4)});
test('normRaion strips suffixes and case',()=>{assert.equal(normRaion('Уманський район'),'уманський');assert.equal(normRaion('Р-Н Звенигородський'),'звенигородський')});
test('old names map through aliases',()=>{const dnipro = raionDirectory('Дніпропетровська область');assert.equal(matchRaion(dnipro,'Новомосковський'),'Самарівський');const kharkiv = raionDirectory('Харківська область');assert.equal(matchRaion(kharkiv,'Красноградський'),'Берестинський')});
test('stem fallback matches short names',()=>{assert.equal(matchRaion(CHERKASY,'Звенигород'),'Звенигородський')});
test('oblastRaions groups alerts and monitoring by raion',()=>{
  const snap={alerts:[{region:'Черкаська область',district:'Уманський район',subtype:'Повітряна тривога',timestamp:new Date()}],events:[{region:'Черкаська область',district:'Уманський',category:'uav',subtype:'Шахед'},{region:'Черкаська область',district:null,category:'uav'}]};
  const view=oblastRaions(snap,'Черкаська область');
  assert.equal(view.rows.length,4);
  const uman=view.rows.find(r=>r.name==='Уманський');
  assert.equal(uman.status,'alert');assert.equal(uman.monCount,1);
  const calm=view.rows.find(r=>r.name==='Черкаський');
  assert.equal(calm.status,'calm');assert.equal(view.unassignedMon,1)});
test('oblast-wide alert marks every raion',()=>{
  const snap={alerts:[{region:'Черкаська область',district:null,subtype:'Тривога'}],events:[]};
  const view=oblastRaions(snap,'Черкаська область');
  assert.ok(view.rows.every(r=>r.status==='alert'));assert.equal(view.oblastWide,true)});
test('unknown raion from data still appears as stream row',()=>{
  const snap={alerts:[{region:'Черкаська область',district:'Невідомий',subtype:'Тривога'}],events:[]};
  const view=oblastRaions(snap,'Черкаська область');
  const extra=view.rows.find(r=>r.name==='Невідомий');
  assert.ok(extra&&extra.fromStream&&extra.status==='alert')});
test('raionAlertActive distinguishes my raion from neighbours',()=>{
  const a1={region:'Черкаська область',district:'Уманський район'};
  const a2={region:'Черкаська область',district:'Черкаський район'};
  const wide={region:'Черкаська область',district:null};
  assert.equal(raionAlertActive([a1],'Черкаська область','Уманський район').scope,'raion');
  assert.equal(raionAlertActive([a2],'Черкаська область','Уманський район').scope,'outside');
  // Oblast-wide alert returns 'oblast' scope for any specific raion check
  assert.equal(raionAlertActive([wide],'Черкаська область','Уманський район').scope,'oblast');
  assert.equal(raionAlertActive([a1],'Черкаська область',null).scope,'oblast');
  assert.equal(raionAlertActive([],'Черкаська область','Уманський район'),null);
  assert.ok(raionMatches('Самарівський','Новомосковський'));
});
test('no directory falls back to stream rows',()=>{
  const snap={alerts:[{region:'Севастополь',district:'Центр',subtype:'Тривога'}],events:[]};
  const view=oblastRaions(snap,'Севастополь');
  assert.equal(view.hasDirectory,false);assert.equal(view.rows.length,1)});
test('every geo oblast except special cities has a raion directory',()=>{
  const g=JSON.parse(fs.readFileSync(new URL('../data/ukraine-regions.geojson',import.meta.url),'utf8'));
  const skip=new Set(['м. київ','Севастополь','Автономна Республіка Крим']);
  for(const f of g.features){
    const name=f.properties.region||f.properties.key;
    if(skip.has(name))continue;
    assert.ok(raionDirectory(name),name);
  }});
