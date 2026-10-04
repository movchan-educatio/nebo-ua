import test from'node:test';import assert from'node:assert/strict';import{project,sweepBoost,fmtAzimuth}from'../assets/js/scope.js';
test('project centers the reference point',()=>{
  const p=project(49,31,[49,31],200,400);
  assert.equal(Math.round(p.x),200);assert.equal(Math.round(p.y),200);
  assert.equal(p.distKm,0);assert.equal(p.inside,true)});
test('project places east point right and inside',()=>{
  const p=project(49,32,[49,31],200,400);
  assert.ok(p.x>200&&p.distKm>50&&p.distKm<100&&p.inside===true);
  assert.ok(p.bearing>80&&p.bearing<100)});
test('project flags out-of-range',()=>{
  const p=project(52,38,[49,31],200,400);
  assert.equal(p.inside,false)});
test('sweepBoost peaks on the beam and fades',()=>{
  assert.ok(Math.abs(sweepBoost(0,10)-(1-10/30))<1e-9);
  assert.equal(sweepBoost(0,180),0);
  assert.ok(Math.abs(sweepBoost(350,10)-(1-20/30))<1e-9)});
test('fmtAzimuth pads and localizes',()=>{
  assert.equal(fmtAzimuth(5,3.24),'А 005° · 3,2 км');
  assert.equal(fmtAzimuth(180,150),'А 180° · 150 км')});
