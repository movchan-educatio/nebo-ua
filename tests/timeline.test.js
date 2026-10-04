import test from'node:test';
import assert from'node:assert/strict';
import{appendTimeline}from'../services/timeline.js';

test('timeline groups repeated changes from the same source',()=>{
  const first=appendTimeline([],{at:new Date('2026-10-04T10:00:00Z'),text:'Нове повідомлення: БПЛА',source:'MAPA'});
  const second=appendTimeline(first,{at:new Date('2026-10-04T10:00:20Z'),text:'Нове повідомлення: БПЛА',source:'MAPA'});
  assert.equal(second.length,1);
  assert.equal(second[0].count,2);
});

test('timeline keeps different sources and old changes separate',()=>{
  let items=appendTimeline([],{at:new Date('2026-10-04T10:00:00Z'),text:'Нове повідомлення: БПЛА',source:'MAPA'});
  items=appendTimeline(items,{at:new Date('2026-10-04T10:00:10Z'),text:'Нове повідомлення: БПЛА',source:'NEPTUN'});
  items=appendTimeline(items,{at:new Date('2026-10-04T10:02:00Z'),text:'Нове повідомлення: БПЛА',source:'NEPTUN'});
  assert.equal(items.length,3);
});
