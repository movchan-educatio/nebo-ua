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
 */
export function flowStats(events) {
  const byKind = { shahed: 0, uav: 0, missile: 0, ballistic: 0, kab: 0, recon: 0, aviation: 0, other: 0 };
  let exactTotal = 0;
  for (const e of events || []) {
    if (accuracyTier(e) !== 'exact') continue;
    if (e.lat == null || e.lon == null) continue;
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
  const s = { uav: 0, shahed: 0, missiles: 0, kab: 0, exactTotal: 0, ...(stats || {}) };
  const rc = Number(raionCount) || 0;
  const cell = (value, name) =>
    `<span class="flow-stat"><b>${value}</b><i>${name} ${plural(value, 'повідомлення', 'повідомлення', 'повідомлень')}</i></span>`;
  // Confirmed Shaheds get their own cell so they are never hidden inside generic БПЛА.
  const shahedCell = s.shahed > 0 ? cell(s.shahed, 'Шахед') : '';
  return `<div class="flow-cells">`
    + cell(s.uav, 'БПЛА')
    + shahedCell
    + cell(s.missiles, 'ракетних')
    + cell(s.kab, 'КАБ')
    + `</div>`
    + `<div class="flow-sub">${s.exactTotal} ${plural(s.exactTotal, 'координатна подія', 'координатні події', 'координатних подій')} · ${rc} ${plural(rc, 'район', 'райони', 'районів')} у тривозі</div>`;
}
