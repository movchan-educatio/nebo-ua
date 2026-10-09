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
  shahed: 'Шахед', uav: 'БПЛА', fpv: 'FPV-дрон', recon: 'розвідка', missile: 'ракета',
  ballistic: 'балістика', kab: 'КАБ', aviation: 'авіація', explosion: 'вибухи (ЗМІ)', other: 'інше',
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
  const byKind = { shahed: 0, uav: 0, fpv: 0, missile: 0, ballistic: 0, kab: 0, recon: 0, aviation: 0, explosion: 0, other: 0 };
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
 * Compact summary HTML for the "ЗАРАЗ У ПОТОЦІ" HUD.
 * Radar-style cells: [icon] N БПЛА · [icon] N РАКЕТ · [icon] N КАБ
 * (+ separate ШАХЕД cell only for confirmed Shaheds, never hidden inside
 * generic БПЛА). Sub-line: rendered point targets + raions in alert.
 * Technical "stale hidden" counts are NOT shown to regular users.
 */
const THREAT_SPRITE = '/assets/brand/threat-icons.svg';
// HUD icon colors mirror the shared threat palette (assets/js/map.js META).
const KIND_COLOR = { uav: '#FFC43D', shahed: '#FF7B4D', missile: '#FF4D67', kab: '#FF806B', fpv: '#FF9F43', explosion: '#FF6A00' };
export function flowSummaryHTML(stats, raionCount) {
  const s = { uav: 0, shahed: 0, missiles: 0, kab: 0, exactTotal: 0, suppressed: 0, ...(stats || {}) };
  const rc = Number(raionCount) || 0;
  const cell = (value, icon, name, color) =>
    `<span class="flow-stat" style="--c:${color}"><svg class="flow-ico" aria-hidden="true"><use href="${THREAT_SPRITE}#${icon}"/></svg><b>${value}</b><i>${name}</i></span>`;
  const shahedCell = s.shahed > 0
    ? cell(s.shahed, 'shahed', plural(s.shahed, 'ШАХЕД', 'ШАХЕДИ', 'ШАХЕДІВ'), KIND_COLOR.shahed)
    : '';
  return `<div class="flow-cells">`
    + cell(s.uav, 'uav', 'БПЛА', KIND_COLOR.uav)
    + shahedCell
    + cell(s.missiles, 'missile', plural(s.missiles, 'РАКЕТА', 'РАКЕТИ', 'РАКЕТ'), KIND_COLOR.missile)
    + cell(s.kab, 'kab', plural(s.kab, 'КАБ', 'КАБи', 'КАБів'), KIND_COLOR.kab)
    + `</div>`
    + `<div class="flow-sub">${s.exactTotal} ${plural(s.exactTotal, 'точкова ціль', 'точкові цілі', 'точкових цілей')} · ${rc} ${plural(rc, 'район', 'райони', 'районів')} у тривозі</div>`
    + `<div class="flow-compact"><b>ЗАРАЗ У ПОТОЦІ</b>${s.exactTotal} ${plural(s.exactTotal, 'ціль', 'цілі', 'цілей')} · ${rc} ${plural(rc, 'район', 'райони', 'районів')}</div>`;
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
