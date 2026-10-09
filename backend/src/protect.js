// False all-clear protection (pure logic, no I/O).
//
// Rules:
// - State is only updated from SUCCESSFUL source cycles. A failed fetch
//   never closes anything (outage must not look like an all-clear).
// - Missing items gain misses; alerts close after ALERT_MISS_LIMIT misses,
//   threats go stale after 1 miss and drop after THREAT_MISS_LIMIT.
// - Dropped items are reported as ended (for the journal), never silently lost.
//
// prev: { alerts: [{... alertRecord, misses}], threats: [...] } | null
// fresh: { alerts: [...], threats: [...] } freshly normalized records
export function protectAlerts(prevAlerts, freshAlerts, missLimit = 3, successfulSources = null) {
  const prev = new Map((prevAlerts || []).map(a => [a.id, a]));
  const seen = new Set();
  const active = [];
  const ended = [];
  for (const a of freshAlerts || []) {
    seen.add(a.id);
    active.push({ ...a, misses: 0 });
  }
  for (const [id, p] of prev) {
    if (seen.has(id)) continue;
    if (successfulSources && !successfulSources.has(sourceKey(p))) {
      active.push({ ...p, stale: true });
      continue;
    }
    const misses = (p.misses || 0) + 1;
    if (misses >= missLimit) {
      ended.push({ ...p, misses });
    } else {
      active.push({ ...p, misses, stale: true });
    }
  }
  return { active, ended };
}

export function protectThreats(prevThreats, freshThreats, missLimit = 3, successfulSources = null) {
  const prev = new Map((prevThreats || []).map(e => [e.id, e]));
  const seen = new Set();
  const active = [];
  const ended = [];
  for (const e of freshThreats || []) {
    seen.add(e.id);
    active.push({ ...e, misses: 0 });
  }
  for (const [id, p] of prev) {
    if (seen.has(id)) continue;
    if (successfulSources && !successfulSources.has(sourceKey(p))) {
      active.push({ ...p, stale: true });
      continue;
    }
    const misses = (p.misses || 0) + 1;
    if (misses >= missLimit) {
      ended.push({ ...p, misses });
    } else {
      active.push({ ...p, misses, stale: true });
    }
  }
  return { active, ended };
}

function sourceKey(record) {
  return String(record.source || '').startsWith('NEPTUN') ? 'NEPTUN' : record.source;
}
