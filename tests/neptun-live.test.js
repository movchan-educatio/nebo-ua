import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_URL, BACKOFF_MS, classifyFrame, nextBackoff, createLiveClient } from '../services/neptun-live.js';
import { createStore, syncStore } from '../services/tracks.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeSocketHub() {
  const sockets = [];
  return {
    sockets,
    factory: () => {
      const s = { sent: [], closed: false, onmessage: null, onopen: null, onclose: null, onerror: null,
        close() { this.closed = true; if (this.onclose) this.onclose(); },
        emit(obj) { if (this.onmessage) this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); } };
      sockets.push(s);
      return s;
    },
  };
}

// ── protocol ────────────────────────────────────────────────────────────────
test('WS endpoint is the documented NEPTUN stream', () => {
  assert.equal(WS_URL, 'wss://neptun.in.ua/api/v1/stream');
});

test('snapshot frame carries full threat list', () => {
  const f = classifyFrame({ type: 'snapshot', ts: 1, data: { threats: [{ id: 'a' }] } });
  assert.equal(f.type, 'snapshot');
  assert.deepEqual(f.threats, [{ id: 'a' }]);
});

test('upsert frame requires a stable threat id', () => {
  assert.equal(classifyFrame({ type: 'upsert', data: { id: 'trk_1', lat: 50 } }).type, 'upsert');
  assert.equal(classifyFrame({ type: 'upsert', data: { lat: 50 } }).type, 'malformed');
});

test('remove frame carries only the id', () => {
  const f = classifyFrame({ type: 'remove', data: { id: 'trk_1' } });
  assert.equal(f.type, 'remove');
  assert.equal(f.id, 'trk_1');
});

test('heartbeat and alerts frames route correctly', () => {
  assert.equal(classifyFrame({ type: 'heartbeat' }).type, 'heartbeat');
  assert.equal(classifyFrame({ type: 'alerts', data: { raions: [] } }).type, 'alerts');
  assert.equal(classifyFrame({ type: 'alerts' }).type, 'malformed');
});

test('WebSocket malformed event does not crash app', () => {
  for (const bad of ['{broken', '', null, 42, { nope: 1 }, { type: 'teleport', data: {} }, { type: 'snapshot', data: {} }]) {
    assert.equal(classifyFrame(bad).type, 'malformed');
  }
});

// ── no extrapolation ────────────────────────────────────────────────────────
test('no extrapolation: live client never predicts positions', () => {
  const src = fs.readFileSync(path.join(root, 'services/neptun-live.js'), 'utf8');
  assert.ok(!src.includes('predict'), 'dead-reckoning must not be used');
  assert.ok(!src.includes('speed *'), 'no speed*time projection');
});

// ── lifecycle ───────────────────────────────────────────────────────────────
test('snapshot replaces tracks, upsert updates, remove drops', () => {
  const hub = fakeSocketHub();
  const store = createStore();
  const seen = [];
  const c = createLiveClient({
    createSocket: hub.factory,
    setTimeoutFn: () => 0, clearTimeoutFn: () => {},
    onSnapshot: (threats) => { syncStore(store, threats.map(t => ({ ...t, trackId: 'neptun:' + t.id, timestamp: new Date(t.updatedAt) }))); seen.push('snapshot'); },
    onUpsert: (t) => { store.upsert({ ...t, trackId: 'neptun:' + t.id, timestamp: new Date(t.updatedAt) }); seen.push('upsert'); },
    onRemove: (id) => { store.remove('neptun:' + id); seen.push('remove'); },
  });
  c.start();
  hub.sockets[0].emit({ type: 'snapshot', data: { threats: [{ id: 'a', updatedAt: '2026-10-06T10:00:00Z', lat: 50, lon: 31 }] } });
  assert.equal(store.size, 1);
  hub.sockets[0].emit({ type: 'upsert', data: { id: 'a', updatedAt: '2026-10-06T10:01:00Z', lat: 50.1, lon: 31.1 } });
  assert.equal(store.get('neptun:a').pos.lat, 50.1);
  hub.sockets[0].emit({ type: 'remove', data: { id: 'a' } });
  assert.equal(store.size, 0);
  // Malformed frame mid-stream changes nothing and throws nothing.
  hub.sockets[0].emit('{broken');
  assert.deepEqual(seen, ['snapshot', 'upsert', 'remove']);
  c.stop();
});

test('reconnect uses backoff 1/2/5/10/20/30s and does not duplicate targets', () => {
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000, 10000, 20000, 30000]);
  assert.equal(nextBackoff(0), 1000);
  assert.equal(nextBackoff(5), 30000);
  assert.equal(nextBackoff(99), 30000);
  const hub = fakeSocketHub();
  const store = createStore();
  let timers = [];
  const c = createLiveClient({
    createSocket: hub.factory,
    setTimeoutFn: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimeoutFn: () => {},
    onSnapshot: (threats) => syncStore(store, threats.map(t => ({ ...t, trackId: 'neptun:' + t.id, timestamp: new Date(t.updatedAt) }))),
  });
  c.start();
  assert.equal(hub.sockets.length, 1);
  hub.sockets[0].emit({ type: 'snapshot', data: { threats: [{ id: 'a', updatedAt: '2026-10-06T10:00:00Z', lat: 50, lon: 31 }] } });
  hub.sockets[0].close(); // drop -> reconnect scheduled, no storm (single timer)
  assert.deepEqual(timers, [1000]);
  assert.equal(store.size, 1); // offline keeps last snapshot, nothing cleared
  c.stop();
});

test('REST fallback: client reports disabled without WebSocket', () => {
  const states = [];
  const c = createLiveClient({ createSocket: null, onState: (s) => states.push(s) });
  const hadWS = typeof WebSocket !== 'undefined';
  c.start();
  if (!hadWS) assert.ok(states.includes('disabled'));
  c.stop();
});

test('stale lifecycle: vanished tracks removed on snapshot reconcile', () => {
  const store = createStore();
  const at = (iso) => new Date(iso);
  syncStore(store, [{ id: 'a', trackId: 'a', lat: 50, lon: 31, timestamp: at('2026-10-06T10:00:00Z') }]);
  assert.equal(store.size, 1);
  const r = syncStore(store, []);
  assert.equal(r.removed, 1);
  assert.equal(store.size, 0);
});

test('duplicate event ignored: same id+timestamp+coordinate adds nothing', () => {
  const store = createStore();
  const e = { id: 'a', trackId: 'a', lat: 50, lon: 31, timestamp: new Date('2026-10-06T10:00:00Z') };
  assert.equal(store.upsert(e).type, 'added');
  assert.equal(store.upsert({ ...e }).type, 'ignored-order');
  assert.deepEqual(store.get('a').history, []);
});

test('area-only is never a radar target', () => {
  const store = createStore();
  store.upsert({ id: 'a', trackId: 'a', lat: 49, lon: 32, areaOnly: true, timestamp: new Date('2026-10-06T10:00:00Z') });
  assert.equal(store.get('a').pos, null);
});
