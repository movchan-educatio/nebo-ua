import test from'node:test';import assert from'node:assert/strict';import{advertising,adsAllowed}from'../services/ads.js';
test('advertising is disabled in public release',()=>{assert.equal(advertising.adsEnabled,false);assert.equal(adsAllowed(),false)});
test('ad-free user always suppresses ads',()=>assert.equal(adsAllowed({adsEnabled:true,provider:'future',user:{isAdFree:true}}),false));
