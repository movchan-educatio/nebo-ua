// UkraineAlarm API v3 adapter (official air-alert source).
//
// Documented surface (UkraineAlarm-javascript, API version 3.0):
//   GET /api/v3/alerts/status          -> { lastActionIndex } (cheap version gate)
//   GET /api/v3/alerts                 -> AlertRegionModel[] (active alarms)
//   GET /api/v3/alerts/regionHistory?regionId= -> RegionAlarmsHistory[] (last 25)
//   GET /api/v3/alerts/{regionId}      -> AlertRegionModel[] (single region)
//   GET /api/v3/regions                -> { states: RegionViewModel[] } (tree)
//   POST/PATCH/DELETE /api/v3/webhook  -> subscription (NOT used: WebHookModel
//     carries no auth/secret field, so no trustworthy inbound verification
//     exists — opening an unauthenticated webhook endpoint would be unsafe).
// Auth: API key in the `Authorization` HTTP header, optional "Token " prefix
// (swagger-codegen default: raw key). Scheme is configurable via
// UKRAINEALARM_AUTH_SCHEME; the key itself lives ONLY in the Worker secret
// UKRAINEALARM_API_KEY and is never logged, never sent to browsers.
//
// Budget rules (Cloudflare Free + unknown upstream rate limits):
//   - /alerts/status every cycle (tiny), full /alerts ONLY when
//     lastActionIndex changed (persisted in D1 ua_sync, written on change).
//   - Regions tree cached in KV `v1:ua-regions` (TTL 7d), refreshed at most
//     once per 24h and rewritten only when its hash changes (<=1 write/day).
//   - 429 honors Retry-After via D1 `notBefore` (cap 15 min). Failures never
//     fake success: no checkedAt/health movement without a real 2xx.
//   - Time semantics: eventTime comes ONLY from source lastUpdate/startDate
//     (missing/invalid -> null, never `now`). Verification time is assigned
//     by the pipeline (receivedAt/health.updatedAt), never by this module.
export const UA_DEFAULT_BASE = 'https://api.ukrainealarm.com';
export const UA_REGIONS_KV_KEY = 'v1:ua-regions';
export const UA_REGIONS_TTL_S = 7 * 24 * 3600;
export const UA_REGIONS_MAX_AGE_MS = 24 * 3600_000;
export const UA_BACKOFF_CAP_MS = 15 * 60_000;

export const UA_ALERT_TYPES = ['AIR', 'ARTILLERY', 'URBAN_FIGHTS', 'CHEMICAL', 'NUCLEAR', 'INFO', 'UNKNOWN'];
export const UA_TYPE_LABEL = {
  AIR: 'Повітряна тривога',
  ARTILLERY: 'Артилерійська загроза',
  URBAN_FIGHTS: 'Вуличні бої',
  CHEMICAL: 'Хімічна загроза',
  NUCLEAR: 'Ядерна загроза',
  INFO: 'Інформаційне повідомлення',
  UNKNOWN: 'Тривога',
};
// Only AIR is an air-raid alarm. Other documented types are real official
// danger signals, but presenting them AS air-raid would fabricate meaning,
// so they keep their honest subtype label (never converted to coordinates).
export function isAirRaid(type) {
  return type === 'AIR';
}

export function authHeaderValue(key, scheme) {
  const s = (scheme || '').trim();
  return s ? `${s} ${key}` : key;
}

export class UAHttpError extends Error {
  constructor(status, message, retryAfterMs = null, rayId = null) {
    super(message);
    this.name = 'UAHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    // Cloudflare ray ID of the upstream edge response (diagnostic only,
    // never secret). Lets support locate a rejected request in their logs.
    this.rayId = rayId;
  }
}

function parseRetryAfterMs(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, UA_BACKOFF_CAP_MS);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, Math.min(t - Date.now(), UA_BACKOFF_CAP_MS));
  return null;
}

export function uaBase(env) {
  const u = (env.UKRAINEALARM_API_URL || UA_DEFAULT_BASE).trim().replace(/\/+$/, '');
  return u || UA_DEFAULT_BASE;
}

// Single choke point for all upstream calls. Throws UAHttpError on HTTP
// errors (with .status / .retryAfterMs) or Error('Некоректний JSON').
export async function uaGet(env, path, { timeoutMs = 9000 } = {}) {
  const key = env.UKRAINEALARM_API_KEY;
  if (!key) throw new UAHttpError(0, 'UkraineAlarm key not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
  try {
    const res = await fetch(uaBase(env) + path, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authHeaderValue(key, env.UKRAINEALARM_AUTH_SCHEME),
      },
    });
    // Safe diagnostic headers only (names + non-sensitive values).
    // Never logged/stored: Authorization, Cookie, Set-Cookie, bodies.
    const rayId = (() => {
      try {
        return res.headers?.get?.('cf-ray') || null;
      } catch {
        return null;
      }
    })();
    const raySuffix = rayId ? ` (ray ${rayId})` : '';
    if (res.status === 429) {
      const h = res.headers?.get
        ? (res.headers.get('Retry-After') || res.headers.get('retry-after'))
        : null;
      throw new UAHttpError(429, 'UkraineAlarm: перевищено ліміт запитів', parseRetryAfterMs(h) ?? 60_000, rayId);
    }
    // 401 vs 403 are deliberately distinct: 401 means the key itself was
    // rejected; 403 from this edge has been observed intermittently for
    // valid keys (bot-mitigation sampling), so conflating them would
    // misdirect the investigation. No retries, no scheme guessing here.
    if (res.status === 401) {
      throw new UAHttpError(401, `UkraineAlarm: ключ відхилено (HTTP 401)${raySuffix}. Перевірте секрет UKRAINEALARM_API_KEY.`, null, rayId);
    }
    if (res.status === 403) {
      throw new UAHttpError(403, `UkraineAlarm: доступ відхилено edge-сервером (HTTP 403)${raySuffix}. Схоже на WAF/фільтр, а не на невалідний ключ.`, null, rayId);
    }
    if (!res.ok) throw new UAHttpError(res.status, `UkraineAlarm: HTTP ${res.status}${raySuffix}`, null, rayId);
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

// ── Runtime validation (documented shapes only) ──────────────────────────
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function parseStatusVersion(data) {
  if (!isObj(data)) throw new Error('Некоректний JSON');
  const i = data.lastActionIndex;
  if (i == null) return null; // unknown version -> caller fetches full once
  if (typeof i !== 'number' || !Number.isFinite(i)) throw new Error('Некоректний JSON');
  return i;
}

function parseAlertItem(raw) {
  if (!isObj(raw)) return null;
  const type = typeof raw.type === 'string' ? raw.type : 'UNKNOWN';
  const lu = typeof raw.lastUpdate === 'string' ? raw.lastUpdate : null;
  return {
    regionId: typeof raw.regionId === 'string' ? raw.regionId : null,
    regionType: typeof raw.regionType === 'string' ? raw.regionType : null,
    type: UA_ALERT_TYPES.includes(type) ? type : 'UNKNOWN',
    // Source event time ONLY. Invalid/missing stays null (never faked).
    lastUpdate: lu && Number.isFinite(Date.parse(lu)) ? lu : null,
  };
}

export function parseAlertRegion(raw) {
  if (!isObj(raw) || typeof raw.regionId !== 'string' || !raw.regionId) return null;
  const alerts = Array.isArray(raw.activeAlerts)
    ? raw.activeAlerts.map(parseAlertItem).filter(Boolean)
    : [];
  return {
    regionId: raw.regionId,
    regionType: typeof raw.regionType === 'string' ? raw.regionType : null,
    regionName: typeof raw.regionName === 'string' ? raw.regionName : null,
    lastUpdate: typeof raw.lastUpdate === 'string' ? raw.lastUpdate : null,
    activeAlerts: alerts,
  };
}

export function parseAlerts(data) {
  if (!Array.isArray(data)) throw new Error('Некоректний JSON');
  return data.map(parseAlertRegion).filter(Boolean);
}

function parseRegionNode(raw) {
  if (!isObj(raw) || typeof raw.regionId !== 'string' || !raw.regionId) return null;
  const kids = Array.isArray(raw.regionChildIds)
    ? raw.regionChildIds.map(parseRegionNode).filter(Boolean)
    : [];
  return {
    regionId: raw.regionId,
    regionName: typeof raw.regionName === 'string' ? raw.regionName : null,
    regionType: typeof raw.regionType === 'string' ? raw.regionType : null,
    regionChildIds: kids,
  };
}

export function parseRegions(data) {
  if (!isObj(data) || !Array.isArray(data.states)) throw new Error('Некоректний JSON');
  return { states: data.states.map(parseRegionNode).filter(Boolean) };
}

export function parseHistory(data) {
  if (!Array.isArray(data)) throw new Error('Некоректний JSON');
  return data.map(raw => {
    if (!isObj(raw)) return null;
    const sd = typeof raw.startDate === 'string' ? raw.startDate : null;
    const ed = typeof raw.endDate === 'string' ? raw.endDate : null;
    return {
      regionId: typeof raw.regionId === 'string' ? raw.regionId : null,
      regionName: typeof raw.regionName === 'string' ? raw.regionName : null,
      startDate: sd && Number.isFinite(Date.parse(sd)) ? sd : null,
      endDate: ed && Number.isFinite(Date.parse(ed)) ? ed : null,
      alertType: UA_ALERT_TYPES.includes(raw.alertType) ? raw.alertType : 'UNKNOWN',
      isContinue: raw.isContinue === true,
    };
  }).filter(Boolean);
}

// ── Regions index: regionId -> { oblast, district } via tree parents ─────
export function buildRegionIndex(states) {
  const byId = new Map();
  const walk = (node, parent) => {
    const entry = {
      regionId: node.regionId,
      regionName: node.regionName,
      regionType: node.regionType,
      parentId: parent?.regionId || null,
      oblastName: null,
      districtName: null,
    };
    if (node.regionType === 'State') entry.oblastName = node.regionName;
    else if (node.regionType === 'District') {
      entry.oblastName = parent?.regionType === 'State' ? parent.regionName : null;
      entry.districtName = node.regionName;
    } else if (node.regionType === 'Community') {
      const district = parent?.regionType === 'District' ? parent : null;
      entry.districtName = district?.regionName || null;
      entry.oblastName = district ? null : null; // resolved below via grandparent walk
      // grandparent state lookup
      let up = parent;
      while (up) {
        if (up.regionType === 'State') { entry.oblastName = up.regionName; break; }
        up = up.__parent || null;
      }
    }
    node.__parent = parent || null;
    byId.set(node.regionId, entry);
    for (const kid of node.regionChildIds || []) walk(kid, node);
  };
  for (const s of states || []) walk(s, null);
  // cleanup helper refs
  const clean = (nodes) => {
    for (const n of nodes || []) {
      delete n.__parent;
      clean(n.regionChildIds);
    }
  };
  clean(states);
  return byId;
}

export function hashRegionIndex(byId) {
  const rows = [...byId.values()]
    .map(e => [e.regionId, e.regionType, e.regionName, e.parentId].map(v => v ?? '').join('|'))
    .sort();
  return rows.join('\n');
}

// Map one AlertRegionModel to normalizeAlert-compatible raw inputs
// (one record per active alert; stable id `ua:{regionId}:{type}`).
// Regions with zero activeAlerts produce nothing (no alarm = no record).
export function mapAlertRegion(item, byId) {
  if (!item || !item.regionId || !item.regionName || !item.activeAlerts?.length) return [];
  const idx = byId?.get(item.regionId);
  const typeOf = idx?.regionType || item.regionType;
  const out = [];
  for (const a of item.activeAlerts) {
    const label = UA_TYPE_LABEL[a.type] || UA_TYPE_LABEL.UNKNOWN;
    const since = a.lastUpdate || item.lastUpdate || null;
    const raw = {
      key: `ua:${item.regionId}:${a.type}`,
      name: item.regionName,
      oblast: null,
      since,
      level: 'red',
      reasons: [label],
      uaType: a.type,
      uaRegionId: item.regionId,
      uaRegionType: typeOf,
    };
    if (typeOf === 'District' && idx?.oblastName) {
      raw.oblast = idx.oblastName;
    } else if (typeOf === 'Community') {
      // Community granularity exceeds the alert schema: keep the oblast for
      // region matching and the community name in the district slot (RAION
      // precision, honest approximation — documented limitation).
      raw.oblast = idx?.oblastName || null;
    }
    out.push(raw);
  }
  return out;
}

// Version gate: full /alerts fetch only when the action index moved.
// null (unknown) -> fetch once (fail-open a single validated call).
export function shouldFetchFull(storedIndex, remoteIndex) {
  if (remoteIndex == null) return true;
  if (storedIndex == null) return true;
  return remoteIndex !== storedIndex;
}

// ── D1 ua_sync (key/value): lastActionIndex + 429 backoff ────────────────
export async function getUASync(db) {
  const out = { lastActionIndex: null, notBefore: 0 };
  try {
    if (!db || typeof db.prepare !== 'function') return out;
    const res = await db.prepare(`SELECT key, value FROM ua_sync`).all();
    for (const r of res?.results || []) {
      if (r?.key === 'lastActionIndex') {
        const n = Number(r.value);
        out.lastActionIndex = Number.isFinite(n) ? n : null;
      } else if (r?.key === 'notBefore') {
        const n = Number(r.value);
        out.notBefore = Number.isFinite(n) ? n : 0;
      }
    }
  } catch { /* sync state is best effort */ }
  return out;
}

export async function setUASync(db, patch) {
  try {
    if (!db || typeof db.prepare !== 'function') return;
    const stmt = db.prepare(
      `INSERT INTO ua_sync (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    );
    const batch = Object.entries(patch).map(([k, v]) => stmt.bind(k, String(v)));
    await db.batch(batch);
  } catch { /* best effort */ }
}

// ── Regions tree cache (KV, hash-gated, <=1 write/day) ───────────────────
export async function getRegionsTree(env) {
  const empty = { states: [], hash: null, fromCache: false };
  try {
    const kv = env.NEBO_STATE;
    if (!kv || typeof kv.get !== 'function') return empty;
    const raw = await kv.get(UA_REGIONS_KV_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.states)) return empty;
    const age = Date.now() - (Number(p.fetchedAt) || 0);
    return { states: p.states, hash: p.hash || null, fromCache: true, stale: age > UA_REGIONS_MAX_AGE_MS, fetchedAt: p.fetchedAt };
  } catch {
    return empty;
  }
}

export async function refreshRegionsTree(env, maxAgeExceeded) {
  const cached = await getRegionsTree(env);
  if (!maxAgeExceeded && cached.states.length && !cached.stale) {
    return { ...cached, refreshed: false };
  }
  const data = await uaGet(env, '/api/v3/regions');
  const tree = parseRegions(data);
  const byId = buildRegionIndex(tree.states);
  const hash = hashRegionIndex(byId);
  let written = false;
  if (hash !== cached.hash) {
    try {
      await env.NEBO_STATE.put(
        UA_REGIONS_KV_KEY,
        JSON.stringify({ v: 1, states: tree.states, hash, fetchedAt: Date.now() }),
        { expirationTtl: UA_REGIONS_TTL_S },
      );
      written = true;
    } catch { /* cache write failure must not break the pipeline */ }
  }
  return { states: tree.states, hash, fromCache: false, refreshed: true, written, byId };
}

// ── Full official-source cycle for runPipeline ───────────────────────────
// Returns fetchOfficial-compatible { ok, disabled, items, latencyMs, error }.
// items are normalizeAlert-shaped raw inputs (normalization stays in the
// pipeline). Version-unchanged cycles return { carried:true, items:[] } —
// the pipeline then re-affirms previous OFFICIAL records (version equality
// IS verification of the set; no new timestamps are fabricated).
// Never throws for upstream problems (honest { ok:false }).
export async function fetchOfficialUkraineAlarm(env) {
  const started = Date.now();
  if (!env.UKRAINEALARM_API_KEY) {
    return { ok: true, disabled: true, items: [], latencyMs: 0, error: null };
  }
  const fail = (error) => ({
    ok: false, disabled: false, items: [],
    latencyMs: Date.now() - started, error,
  });
  try {
    const sync = await getUASync(env.nebo_journal);
    if (Date.now() < sync.notBefore) {
      return fail('UkraineAlarm: пауза після 429 (поважаємо Retry-After)');
    }
    const statusRaw = await uaGet(env, '/api/v3/alerts/status');
    const remoteIndex = parseStatusVersion(statusRaw);
    if (!shouldFetchFull(sync.lastActionIndex, remoteIndex)) {
      return {
        ok: true, disabled: false, items: [], carried: true,
        latencyMs: Date.now() - started, error: null,
        lastActionIndex: sync.lastActionIndex,
      };
    }
    const alertsRaw = await uaGet(env, '/api/v3/alerts');
    // Regions tree outage must not kill oblast-level officials (State items
    // need no tree) and must not fabricate parents: non-State items are
    // skipped until the tree is back.
    let byId = new Map();
    let statesOnly = false;
    try {
      const regions = await refreshRegionsTree(env, false);
      byId = regions.byId || buildRegionIndex(regions.states || []);
    } catch {
      statesOnly = true;
    }
    const items = [];
    for (const parsed of parseAlerts(alertsRaw)) {
      if (statesOnly && parsed.regionType !== 'State') continue;
      items.push(...mapAlertRegion(parsed, byId));
    }
    if (remoteIndex != null) await setUASync(env.nebo_journal, { lastActionIndex: remoteIndex });
    return {
      ok: true, disabled: false, items,
      latencyMs: Date.now() - started, error: null,
      lastActionIndex: remoteIndex,
    };
  } catch (e) {
    if (e instanceof UAHttpError && e.status === 429) {
      await setUASync(env.nebo_journal, { notBefore: Date.now() + (e.retryAfterMs ?? 60_000) });
    }
    return fail(String(e?.message || e));
  }
}

// Validated region-history passthrough (for the optional worker route).
// No KV writes, no persistence — pure read-through.
export async function fetchRegionHistory(env, regionId) {
  if (typeof regionId !== 'string' || !regionId || regionId.length > 64
    || !/^[A-Za-z0-9 _\-.А-Яа-яІіЇїЄєҐґ]+$/u.test(regionId)) {
    throw new Error('Некоректний regionId');
  }
  const data = await uaGet(env, `/api/v3/alerts/regionHistory?regionId=${encodeURIComponent(regionId)}`);
  return parseHistory(data);
}
