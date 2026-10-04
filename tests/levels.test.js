import test from'node:test';import assert from'node:assert/strict';import{threatLevel,raionLevel,LEVEL_LABEL}from'../services/levels.js';
test('closing contact is red',()=>{assert.equal(threatLevel({category:'uav',_closing:true}),'red')});
test('fresh ballistic is always red',()=>{assert.equal(threatLevel({category:'ballistic'}),'red')});
test('confirmed fresh missile or shahed is red',()=>{assert.equal(threatLevel({category:'missile',confirmed:true}),'red');assert.equal(threatLevel({category:'uav',kind:'shahed',confirmed:true}),'red')});
test('ordinary monitoring is yellow',()=>{assert.equal(threatLevel({category:'uav'}),'yellow');assert.equal(threatLevel({category:'kab',advisory:true}),'yellow');assert.equal(threatLevel({category:'missile'}),'yellow')});
test('stale is grey and never red',()=>{assert.equal(threatLevel({category:'ballistic',stale:true,_closing:true}),'grey')});
test('raion status maps to traffic-light level',()=>{assert.equal(raionLevel('alert'),'red');assert.equal(raionLevel('mon'),'yellow');assert.equal(raionLevel('calm'),'green')});
test('level labels exist',()=>{assert.equal(LEVEL_LABEL.red,'ЧЕРВОНИЙ');assert.equal(LEVEL_LABEL.yellow,'ЖОВТИЙ')});
