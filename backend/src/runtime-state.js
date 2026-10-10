// D1 commits the complete cycle atomically. KV remains a budgeted fallback
// checkpoint; its eventual consistency cannot serialize competing writers.
import { GZIP_TRIGGER_BYTES } from './slim.js';
export async function loadRuntime(db) {
  const res = await db.prepare('SELECT bundle FROM pipeline_state WHERE id=1').all();
  const raw = res?.results?.[0]?.bundle;
  if (!raw) return null;
  const bundle = JSON.parse(raw.startsWith('gzip:') ? await unpack(raw.slice(5)) : raw);
  if (!bundle?.snapshot || !bundle?.prev || !Number.isFinite(bundle.startedAt)) {
    throw new Error('Invalid pipeline state');
  }
  return bundle;
}

export async function commitRuntime(db, bundle) {
  let value = JSON.stringify(bundle);
  // D1 has a 2,000,000-byte row limit. Compressing 750 KB on every commit AND
  // every load is what actually killed the cron: it sat comfortably under the
  // old 500 KB trigger in tests, then real attack volumes crossed it and the
  // gzip cost alone blew the 10 ms CPU budget. Slimming (src/slim.js) keeps the
  // common case uncompressed; compression is now only the last resort before
  // the row limit, where it belongs.
  if (new TextEncoder().encode(value).length > GZIP_TRIGGER_BYTES) value = 'gzip:' + await pack(value);
  if (new TextEncoder().encode(value).length > 1_950_000) throw new Error('Snapshot exceeds D1 row limit');
  const result = await db.prepare(`
    INSERT INTO pipeline_state (id, started_at, bundle) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, bundle=excluded.bundle
    WHERE excluded.started_at > pipeline_state.started_at
  `).bind(bundle.startedAt, value).run();
  return result?.meta?.changes === 1;
}

async function pack(text) {
  const compressed = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

async function unpack(encoded) {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// No fresh D1 checks may be attached to an older KV checkpoint. That would
// make a failed/throttled publication appear current to its consumers.
export function runtimeResponse(bundle, nowMs, storage = 'd1') {
  return {
    ...bundle.snapshot,
    responseAt: new Date(nowMs).toISOString(),
    storage,
    ...(storage === 'kv-fallback' ? { degraded: true } : {}),
  };
}
