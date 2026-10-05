// "ЗАРАЗ У ПОТОЦІ" summary: honest record counts + Ukrainian pluralization.
// No Node-only APIs – runs in browser and node:test.
import { accuracyTier, classifyThreat } from './threatClassify.js';

/** Ukrainian plural: 1 повідомлення, 2 повідомлення, 5 повідомлень. */
export function plural(n, one, few, many) {
  const x = Math.abs(Number(n)) || 0;
  const m10 = x % 10, m100 = x % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

const KIND_LABEL = {
  shahed: 'Шахед', uav: 'БПЛА', recon: 'розвідка', missile: 'ракета',
  ballistic: 'балістика', kab: 'КАБ', aviation: 'авіація', other: 'інше',
};

/**
 * Coordinate-level event records grouped by threat kind.
 * Only exact-tier (real coordinates) events are counted — area/report
 * precision records never become point markers, so they are excluded here.
 * Categories are disjoint: uav + missile + ballistic + kab + ... = exactTotal.
 * No double counting: the 2 KAB are inside exactTotal, not added on top.
 *
 * opts.onlyFresh (default true): skip stale events, mirroring the default
 * "Лише свіжі" renderer filter. opts.visible (Set of categories): count only
 * enabled categories, mirroring the layer toggles. With these, the numbers
 * match actually rendered markers instead of lying about hidden ones.
 */
export function flowStats(events, opts = {}) {
  const { onlyFresh = true, visible = null } = opts;
  const byKind = { shahed: 0, uav: 0, missile: 0, ballistic: 0, kab: 0, recon: 0, aviation: 0, other: 0 };
  let exactTotal = 0;
  let exactAll = 0;
  const received = Array.isArray(events) ? events.length : 0;
  for (const e of events || []) {
    if (accuracyTier(e) !== 'exact') continue;
    if (e.lat == null || e.lon == null) continue;
    exactAll++;
    if (onlyFresh && e.stale) continue;
    if (visible && !visible.has(e.category)) continue;
    exactTotal++;
    const k = classifyThreat(e);
    if (k in byKind) byKind[k]++;
    else byKind.other++;
  }
  return {
    uav: byKind.uav,
    shahed: byKind.shahed,
    missiles: byKind.missile + byKind.ballistic,
    kab: byKind.kab,
    exactTotal,
    byKind,
    received,
    suppressed: exactAll - exactTotal,
  };
}

/** Short label for a kind in cluster/summary contexts. */
export function kindShortLabel(kind) {
  return KIND_LABEL[kind] || KIND_LABEL.other;
}

/**
 * Compact summary HTML for the "ЗАРАЗ У ПОТОЦІ" strip.
 * Three disjoint columns (БПЛА / РАКЕТИ / КАБ) plus a sub-line with
 * coordinate events and raion polygons in alert. Numbers are event RECORDS
 * with real coordinates, labelled as повідомлення — never physical targets.
 */
export function flowSummaryHTML(stats, raionCount) {
  const s = { uav: 0, shahed: 0, missiles: 0, kab: 0, exactTotal: 0, suppressed: 0, ...(stats || {}) };
  const rc = Number(raionCount) || 0;
  const cell = (value, name) =>
    `<span class="flow-stat"><b>${value}</b><i>${name} ${plural(value, 'повідомлення', 'повідомлення', 'повідомлень')}</i></span>`;
  // Confirmed Shaheds get their own cell so they are never hidden inside generic БПЛА.
  const shahedCell = s.shahed > 0 ? cell(s.shahed, 'Шахед') : '';
  const suppressedNote = s.suppressed > 0
    ? ` · ${s.suppressed} ${plural(s.suppressed, 'застаріле', 'застарілі', 'застарілих')} приховано`
    : '';
  return `<div class="flow-cells">`
    + cell(s.uav, 'БПЛА')
    + shahedCell
    + cell(s.missiles, 'ракетних')
    + cell(s.kab, 'КАБ')
    + `</div>`
    + `<div class="flow-sub">${s.exactTotal} ${plural(s.exactTotal, 'точкова ціль', 'точкові цілі', 'точкових цілей')} · ${rc} ${plural(rc, 'район', 'райони', 'районів')} у тривозі${suppressedNote}</div>`;
}

/**
 * Semantic source health, derived from backend /v1/state health metadata.
 * Levels: LIVE (all listed sources current), DELAYED (data present but some
 * source older than normal), PARTIAL (a source really down, others work),
 * OFFLINE (no usable monitoring data at all).
 * A source that is 'offline' but carries the backend stale/delayed flag is
 * DELAYED, not DOWN: its data exists, it is just old. delayed != offline.
 */
const SOURCE_NAMES = {
  NEPTUN: 'NEPTUN · моніторинг',
  MAPA: 'MAPA · моніторинг',
  OFFICIAL: 'Офіційні тривоги',
};

export function sourceState(key, h) {
  const name = SOURCE_NAMES[key] || key;
  if (!h) return { key, name, state: 'DOWN', ageMs: null, detail: 'немає даних' };
  if (h.status === 'disabled') return { key, name, state: 'IDLE', ageMs: null, detail: 'не налаштовано' };
  if (h.status === 'online' && !h.delayed) {
    const ageMs = h.updatedAt ? Date.now() - new Date(h.updatedAt).getTime() : null;
    return { key, name, state: 'LIVE', ageMs, detail: h.error || null };
  }
  if (h.status === 'delayed' || h.delayed) {
    const ageMs = h.updatedAt ? Date.now() - new Date(h.updatedAt).getTime() : null;
    return { key, name, state: 'DELAYED', ageMs, detail: h.error || 'потік позначено застарілим' };
  }
  return { key, name, state: 'DOWN', ageMs: null, detail: h.error || 'джерело недоступне' };
}

export function overallStatus(health) {
  const per = {};
  for (const key of ['NEPTUN', 'MAPA', 'OFFICIAL']) {
    const s = sourceState(key, health?.[key]);
    if (s.state !== 'IDLE') per[key] = s;
  }
  const states = Object.values(per).map(s => s.state);
  let level = 'LIVE';
  if (!states.length || states.every(s => s === 'DOWN')) level = 'OFFLINE';
  else if (states.some(s => s === 'DOWN')) level = 'PARTIAL';
  else if (states.some(s => s === 'DELAYED')) level = 'DELAYED';
  return { level, per };
}
