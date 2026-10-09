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

// Client identification (NOT evasion): automated clients SHOULD identify
// themselves. A missing User-Agent is a textbook bot signal for edge
// filters and can raise challenge rates without any request ever reaching
// key validation. This changes nothing about auth, frequency or retries.
export const UA_USER_AGENT = 'nebo-ua-check-proxy/1.0 (+https://nebo-ua.vercel.app)';

export const UA_ALERT_TYPES = ['AIR', 'ARTILLERY', 'URBAN_FIGHTS', 'CHEMICAL', 'NUCLEAR', 'INFO', 'CUSTOM', 'UNKNOWN'];
export const UA_TYPE_LABEL = {
  AIR: 'Повітряна тривога',
  ARTILLERY: 'Артилерійська загроза',
  URBAN_FIGHTS: 'Вуличні бої',
  CHEMICAL: 'Хімічна загроза',
  NUCLEAR: 'Ядерна загроза',
  INFO: 'Інформаційне повідомлення',
  CUSTOM: 'Особлива тривога',
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
async function uaFetch(env, path, { timeoutMs = 9000, signal } = {}) {
  const key = env.UKRAINEALARM_API_KEY;
  if (!key) throw new UAHttpError(0, 'UkraineAlarm key not configured');
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException('Timeout', 'AbortError')), timeoutMs);
  const started = Date.now();
  let status = null;
  try {
    const res = await fetch(uaBase(env) + path, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': UA_USER_AGENT,
        Authorization: authHeaderValue(key, env.UKRAINEALARM_AUTH_SCHEME),
      },
    });
    status = res.status;
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    // One row per actual HTTP attempt, including public history calls.
    // Do not log headers, query strings, response bodies or credentials.
    console.log(JSON.stringify({ upstream: 'UkraineAlarm', path: path.split('?')[0], status, durationMs: Date.now() - started }));
  }
}

function uaCheckStatus(res) {
  // Safe diagnostic headers only (names + non-sensitive values).
  // Never logged/stored: Authorization, Cookie, Set-Cookie, bodies.
  // Content type and ray ID are diagnostics, not proof of the origin of
  // the rejection or validity of the key. Only provider logs can confirm it.
  const safeHeader = (name) => {
    try {
      return res.headers?.get?.(name) || null;
    } catch {
      return null;
    }
  };
  const rayId = safeHeader('cf-ray');
  const contentType = safeHeader('content-type');
  const edgeMark = contentType && !/application\/json/i.test(contentType)
    ? `, edge content-type ${contentType.split(';')[0].trim()}`
    : '';
  const raySuffix = rayId ? ` (ray ${rayId})` : '';
  if (res.status === 429) {
    const h = res.headers?.get
      ? (res.headers.get('Retry-After') || res.headers.get('retry-after'))
      : null;
    throw new UAHttpError(429, 'UkraineAlarm: перевищено ліміт запитів', parseRetryAfterMs(h) ?? 60_000, rayId);
  }
  // Keep 401 and 403 distinct without guessing their root cause.
  if (res.status === 401) {
    throw new UAHttpError(401, `UkraineAlarm: запит не авторизовано (HTTP 401)${raySuffix}${edgeMark}. Причину має підтвердити постачальник API.`, null, rayId);
  }
  if (res.status === 403) {
    throw new UAHttpError(403, `UkraineAlarm: доступ заборонено (HTTP 403)${raySuffix}${edgeMark}. Причину має підтвердити постачальник API.`, null, rayId);
  }
  if (!res.ok) throw new UAHttpError(res.status, `UkraineAlarm: HTTP ${res.status}${raySuffix}${edgeMark}`, null, rayId);
  return { rayId, edgeMark };
}

export async function uaGet(env, path, opts) {
  const { res, text } = await uaFetch(env, path, opts);
  uaCheckStatus(res);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Некоректний JSON');
  }
}

// Raw variant for the version gate: also returns the untouched response
// text. The spec declares lastActionIndex int64, and observed values
// (≈6.4e17) exceed Number.MAX_SAFE_INTEGER — JSON.parse rounds them, so two
// different upstream versions could compare EQUAL and the gate would go
// blind. Exact decimal digits are compared as strings instead.
export async function uaGetRaw(env, path, opts) {
  const { res, text } = await uaFetch(env, path, opts);
  uaCheckStatus(res);
  try {
    return { data: JSON.parse(text), text };
  } catch {
    throw new Error('Некоректний JSON');
  }
}

export function exactActionIndex(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/"lastActionIndex"\s*:\s*(-?\d+)/);
  if (m) return m[1];
  const q = text.match(/"lastActionIndex"\s*:\s*"(-?\d+)"/);
  return q ? q[1] : null;
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
  // AlertLevelWithReason[] per the spec (alertLevel Red/Yellow + reason +
  // createdAt). Previously ignored — that hid real levels and reasons.
  const levels = Array.isArray(raw.activeAlertLevels)
    ? raw.activeAlertLevels.map(l => {
      if (!isObj(l)) return null;
      const createdAt = typeof l.createdAt === 'string' ? l.createdAt : null;
      return {
        level: l.alertLevel === 'Red' || l.alertLevel === 'Yellow' ? l.alertLevel : null,
        reason: typeof l.reason === 'string' && l.reason.trim() ? l.reason.trim().slice(0, 200) : null,
        createdAt: createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : null,
      };
    }).filter(Boolean)
    : [];
  return {
    regionId: typeof raw.regionId === 'string' ? raw.regionId : null,
    regionType: typeof raw.regionType === 'string' ? raw.regionType : null,
    type: UA_ALERT_TYPES.includes(type) ? type : 'UNKNOWN',
    // Source event time ONLY. Invalid/missing stays null (never faked).
    lastUpdate: lu && Number.isFinite(Date.parse(lu)) ? lu : null,
    levels,
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
  // Spec RegionAlarmsHistory: [{regionId, regionName, alarms:[RegionAlarmModel]}].
  // Unwrap .alarms[]; tolerate a flat RegionAlarmModel item defensively
  // (unknown server builds), never invent rows.
  const out = [];
  for (const raw of data) {
    if (!isObj(raw)) continue;
    const alarmRows = Array.isArray(raw.alarms) ? raw.alarms : [raw];
    for (const a of alarmRows) {
      if (!isObj(a)) continue;
      const sd = typeof a.startDate === 'string' ? a.startDate : null;
      const ed = typeof a.endDate === 'string' ? a.endDate : null;
      out.push({
        regionId: typeof a.regionId === 'string' ? a.regionId : (typeof raw.regionId === 'string' ? raw.regionId : null),
        regionName: typeof a.regionName === 'string' ? a.regionName : (typeof raw.regionName === 'string' ? raw.regionName : null),
        startDate: sd && Number.isFinite(Date.parse(sd)) ? sd : null,
        endDate: ed && Number.isFinite(Date.parse(ed)) ? ed : null,
        alertType: UA_ALERT_TYPES.includes(a.alertType) ? a.alertType : 'UNKNOWN',
        isContinue: a.isContinue === true,
      });
    }
  }
  return out;
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
    } else if (node.regionType) {
      // Community / CityOrVillage / CityDistrict / future types: resolve via
      // the full ancestor chain (nearest District + nearest State), so no
      // level can lose its oblast or fabricate one.
      let up = parent;
      while (up) {
        if (!entry.districtName && up.regionType === 'District') entry.districtName = up.regionName;
        if (!entry.oblastName && up.regionType === 'State') entry.oblastName = up.regionName;
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
    // Level from the documented activeAlertLevels (Red > Yellow), reasons
    // from the API with the type label as fallback. Start time = earliest
    // documented createdAt, falling back to lastUpdate, never to now.
    const levels = Array.isArray(a.levels) ? a.levels : [];
    const hasRed = levels.some(l => l.level === 'Red');
    const hasYellow = levels.some(l => l.level === 'Yellow');
    const apiReasons = levels.map(l => l.reason).filter(Boolean);
    const starts = levels.map(l => l.createdAt).filter(Boolean).sort();
    const since = starts[0] || a.lastUpdate || item.lastUpdate || null;
    const raw = {
      key: `ua:${item.regionId}:${a.type}`,
      name: item.regionName,
      oblast: null,
      since,
      level: hasRed || (!hasRed && !hasYellow) ? 'red' : 'yellow',
      reasons: apiReasons.length ? apiReasons : [label],
      uaType: a.type,
      uaRegionId: item.regionId,
      uaRegionType: typeOf,
    };
    if (typeOf === 'District' && idx?.oblastName) {
      raw.oblast = idx.oblastName;
    } else if (typeOf && typeOf !== 'State' && typeOf !== 'District') {
      // Community / CityOrVillage / CityDistrict / future levels: keep the
      // oblast for region matching and the local name in the district slot
      // (RAION precision, honest approximation — documented limitation).
      raw.oblast = idx?.oblastName || null;
    }
    out.push(raw);
  }
  return out;
}

// Version gate: full /alerts fetch only when the action index moved.
// Indices are compared as EXACT decimal strings (int64 can exceed
// Number.MAX_SAFE_INTEGER; numeric comparison could go blind).
// null (unknown) -> fetch once (fail-open a single validated call).
export function shouldFetchFull(storedIndex, remoteIndex) {
  if (remoteIndex == null) return true;
  if (storedIndex == null) return true;
  return String(storedIndex) !== String(remoteIndex);
}

// ── D1 ua_sync (key/value): lastActionIndex + 429 backoff ────────────────
export async function getUASync(db) {
  const out = { lastActionIndex: null, notBefore: 0 };
  try {
    if (!db || typeof db.prepare !== 'function') return out;
    const res = await db.prepare(`SELECT key, value FROM ua_sync`).all();
    for (const r of res?.results || []) {
      if (r?.key === 'lastActionIndex') {
        // Exact decimal string (int64 range) — never Number(), which would
        // round values above 2^53 and blind the version gate.
        out.lastActionIndex = typeof r.value === 'string' && /^-?\d+$/.test(r.value) ? r.value : null;
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

export async function refreshRegionsTree(env, maxAgeExceeded, opts) {
  const cached = await getRegionsTree(env);
  if (!maxAgeExceeded && cached.states.length && !cached.stale) {
    return { ...cached, refreshed: false };
  }
  const data = await uaGet(env, '/api/v3/regions', opts);
  const tree = parseRegions(data);
  const byId = buildRegionIndex(tree.states);
  const hash = hashRegionIndex(byId);
  let written = false;
  if (hash !== cached.hash || cached.stale) {
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
export async function fetchOfficialUkraineAlarm(env, opts = {}) {
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
    opts.signal?.throwIfAborted();
    if (Date.now() < sync.notBefore) {
      return fail('UkraineAlarm: пауза після 429 (поважаємо Retry-After)');
    }
    const { data: statusRaw, text: statusText } = await uaGetRaw(env, '/api/v3/alerts/status', opts);
    // Exact digits first (int64-safe); validated parse as fallback.
    const remoteIndex = exactActionIndex(statusText) ?? (() => {
      try {
        const v = parseStatusVersion(statusRaw);
        return v == null ? null : String(v);
      } catch {
        throw new Error('Некоректний JSON');
      }
    })();
    // The durable pipeline supplies the version stored atomically WITH its
    // official data. A fetched-but-unpublished version must never carry an
    // older snapshot. The legacy adapter contract remains for rollback.
    const storedIndex = Object.hasOwn(opts, 'publishedIndex') ? opts.publishedIndex : sync.lastActionIndex;
    if (!shouldFetchFull(storedIndex, remoteIndex)) {
      return {
        ok: true, disabled: false, items: [], carried: true,
        latencyMs: Date.now() - started, error: null,
        lastActionIndex: storedIndex,
      };
    }
    const alertsRaw = await uaGet(env, '/api/v3/alerts', opts);
    // Regions tree outage must not kill oblast-level officials (State items
    // need no tree) and must not fabricate parents: non-State items are
    // skipped until the tree is back.
    let byId = new Map();
    let statesOnly = false;
    try {
      const regions = await refreshRegionsTree(env, false, opts);
      byId = regions.byId || buildRegionIndex(regions.states || []);
    } catch {
      statesOnly = true;
    }
    const items = [];
    for (const parsed of parseAlerts(alertsRaw)) {
      if (statesOnly && parsed.regionType !== 'State') continue;
      items.push(...mapAlertRegion(parsed, byId));
    }
    opts.signal?.throwIfAborted();
    if (remoteIndex != null && !statesOnly && !Object.hasOwn(opts, 'publishedIndex')) {
      await setUASync(env.nebo_journal, { lastActionIndex: remoteIndex });
    }
    return {
      ok: true, disabled: false, items,
      latencyMs: Date.now() - started, error: null,
      lastActionIndex: statesOnly ? null : remoteIndex,
      ...(statesOnly ? { partial: true, delayed: true } : {}),
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
