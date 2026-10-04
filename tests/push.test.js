import test from'node:test';import assert from'node:assert/strict';
import{urlBase64ToUint8Array,buildSubscribeBody,pushSupported}from'../services/push.js';
test('base64url decodes to bytes with padding fixed',()=>{
  assert.deepEqual([...urlBase64ToUint8Array('AQID')],[1,2,3]);
  assert.deepEqual([...urlBase64ToUint8Array('AQ')], [1]);
  assert.deepEqual([...urlBase64ToUint8Array('__8')], [255,255]);
});
test('buildSubscribeBody keeps shape for the backend',()=>{
  const body=buildSubscribeBody({subscription:{endpoint:'https://x',keys:{p256dh:'a',auth:'b'}},places:[{oblast:'O'}],categories:{uav:false},quiet:{enabled:true}});
  assert.equal(body.subscription.endpoint,'https://x');
  assert.deepEqual(body.places,[{oblast:'O'}]);
  assert.equal(body.categories.uav,false);
  assert.equal(body.quiet.enabled,true);
});
test('push is unsupported without browser globals',()=>{
  assert.equal(pushSupported(),false);
});
