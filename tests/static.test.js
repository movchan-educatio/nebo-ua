import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('PWA metadata and relative paths',()=>{const m=JSON.parse(read('manifest.webmanifest'));assert.equal(m.name,'НЕБО UA');assert.equal(m.display,'standalone');assert.equal(m.start_url,'./');assert.match(read('assets/js/app.js'),/serviceWorker\.register\('\.\/service-worker\.js'\)/)});
test('production source has no fake threat arrays',()=>{const all=['assets/js/app.js','services/threats.js'].map(read).join('\n');assert.doesNotMatch(all,/const\s+(drones|missiles)\s*=\s*\[/i)});
test('service worker does not cache API',()=>assert.match(read('service-worker.js'),/includes\('\/api\/'\).*return/));
test('required safety copy exists',()=>{const h=read('index.html');assert.match(h,/не замінює офіційні системи/);assert.match(h,/monitoring відображаються окремо/)})
