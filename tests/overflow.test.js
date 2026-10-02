import test from'node:test';import assert from'node:assert/strict';import{measureViewportBounds,unexpectedOverflow}from'./overflow-helper.js';
const el=rect=>({getBoundingClientRect:()=>rect});
test('overflow helper checks every UI edge against viewport',()=>{const good=el({left:0,right:320,top:0,bottom:568}),bad=el({left:-1,right:320,top:0,bottom:568}),result=measureViewportBounds([good,bad],{width:320,height:568});assert.equal(result[0].inBounds,true);assert.equal(unexpectedOverflow(result).length,1)});
