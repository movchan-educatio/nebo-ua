// Source fetching with timeout + retry. No framework APIs at import time.
async function fetchOnce(url, { timeoutMs = 8000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Некоректний JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function fetchWithRetry(url, opts = {}, attempts = 2) {
  const started = Date.now();
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await fetchOnce(url, opts);
      return { ok: true, data, latencyMs: Date.now() - started, error: null };
    } catch (e) {
      lastErr = e;
    }
    // Bounded backoff with jitter between attempts only: absorbs a transient
    // blip without hammering the upstream. Single attempt => no waiting.
    // Stays far below per-lane pipeline timeouts (19-25s).
    if (i < attempts - 1) await sleep(300 + Math.random() * 500);
  }
  return { ok: false, data: null, latencyMs: Date.now() - started, error: String(lastErr?.message || lastErr) };
}

function pickArray(data, keys) {
  for (const k of keys) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

// NEPTUN alerts: {oblasts:[...], raions:[...]} with {name,key,since,level,reasons[]}.
export async function fetchNeptunAlerts(env) {
  const r = await fetchWithRetry(env.NEPTUN_ALERTS_URL, { timeoutMs: 9000 });
  if (!r.ok) return { ...r, items: [] };
  const oblasts = pickArray(r.data, ['oblasts']);
  const raions = pickArray(r.data, ['raions']);
  const items = [...oblasts, ...raions]
    .filter(a => a && typeof a.name === 'string')
    .map(a => ({ ...a, source: 'NEPTUN', sourceUrl: 'https://neptun.in.ua/' }));
  return { ...r, items };
}

// NEPTUN threats: {threats:[...], serverTime, stale}.
export async function fetchNeptunThreats(env) {
  const r = await fetchWithRetry(env.NEPTUN_THREATS_URL, { timeoutMs: 9000 });
  if (!r.ok) return { ...r, items: [], stale: false };
  const items = Array.isArray(r.data?.threats) ? r.data.threats : [];
  return { ...r, items, stale: r.data?.stale === true };
}

// MAPA current: {objects:[...], ts, attack}.
export async function fetchMapa(env) {
  const r = await fetchWithRetry(env.MAPA_URL, { timeoutMs: 12000 });
  if (!r.ok) return { ...r, items: [] };
  const items = Array.isArray(r.data?.objects) ? r.data.objects : [];
  return { ...r, items };
}

// Official token API (generic shape):
//   GET {OFFICIAL_API_URL}  Authorization: Bearer {OFFICIAL_API_TOKEN}
//   -> [{oblast|region, district?, since, level?, reasons?[]}]
// Disabled (not an error) when URL or token is missing.
export async function fetchOfficial(env) {
  const url = env.OFFICIAL_API_URL;
  const token = env.OFFICIAL_API_TOKEN;
  if (!url || !token) return { ok: true, disabled: true, items: [], latencyMs: 0, error: null };
  const r = await fetchWithRetry(url, { timeoutMs: 9000, headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { ...r, items: [] };
  const items = Array.isArray(r.data) ? r.data : pickArray(r.data, ['alerts', 'states', 'items']);
  return { ...r, items };
}
