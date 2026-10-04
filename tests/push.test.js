import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{urlBase64ToUint8Array,buildSubscribeBody,pushSupported,getVapidKey,sendPushTest}from'../services/push.js';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const originalFetch=globalThis.fetch;
test.afterEach(()=>{globalThis.fetch=originalFetch});
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
test('push sync helpers live at module scope and always receive notifier',()=>{
  const src=read('assets/js/enhancements.js');
  assert.match(src,/^function collectPushSync\(notifier\)/m);
  assert.match(src,/^function queuePushSync\(notifier\)/m);
  const calls=[...src.matchAll(/(collectPushSync|queuePushSync)\(([^)]*)\)/g)];
  assert.ok(calls.length>=4);
  for(const c of calls)assert.equal(c[2].trim(),'notifier',c[0]);
});
test('getVapidKey distinguishes dead backend from missing key',async()=>{
  globalThis.fetch=async()=>new Response('nope',{status:404});
  await assert.rejects(getVapidKey(),e=>e.code==='backend');
  globalThis.fetch=async()=>new Response(JSON.stringify({publicKey:null}),{status:200});
  await assert.rejects(getVapidKey(),e=>e.code==='vapid');
  globalThis.fetch=async()=>new Response(JSON.stringify({publicKey:'BKey123'}),{status:200});
  assert.equal(await getVapidKey(),'BKey123');
});
test('sendPushTest surfaces failed delivery instead of lying',async()=>{
  const fakeSub={endpoint:'https://push.example/sub',toJSON:()=>({endpoint:'https://push.example/sub'})};
  const winDesc=Object.getOwnPropertyDescriptor(globalThis,'window');
  const navDesc=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  globalThis.window={PushManager:function(){},Notification:function(){}};
  Object.defineProperty(globalThis,'navigator',{value:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>fakeSub}})}},configurable:true,writable:true});
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,status:500}),{status:200});
  try{
    await assert.rejects(sendPushTest(),e=>e.code==='backend');
  }finally{
    if(winDesc)Object.defineProperty(globalThis,'window',winDesc);else delete globalThis.window;
    if(navDesc)Object.defineProperty(globalThis,'navigator',navDesc);
  }
});
