// Freshness and recovery logic for the radar, kept free of DOM and network so
// every rule in it can be tested directly.
//
// The central rule: a successful HTTP response proves the API is reachable,
// nothing more. It says nothing about whether the data behind it is current.
// A 200 carrying a snapshot from twenty minutes ago is a stale radar served by
// a healthy server, and the UI has to say so.

// How old the pipeline's own verification may be before we stop calling the
// data current. Three minutes is more than twice the cron period, so one missed
// run does not raise an alarm, but three do.
export const FRESH_WINDOW_MS = 180_000;

// How old the CONTENT may be before it is called out separately. Data can sit
// unchanged for a long time — a calm sky is a legitimate state — so this is a
// disclosure, not an alarm.
export const DATA_WINDOW_MS = 30 * 60_000;

// A timestamp further ahead than this is a clock skew or a broken server, not
// the future. Treating it as "checked just now" is how a stale radar gets to
// show LIVE.
export const FUTURE_TOLERANCE_MS = 60_000;

export const POLL_NORMAL_MS = 60_000;
export const POLL_HIDDEN_MS = 5 * 60_000;

export const STATUS = {
  LIVE: 'LIVE',
  DEGRADED: 'DEGRADED',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
  CHECKING: 'CHECKING',
};

// Recovery ladder: 15s, 30s, 60s, 120s, then never faster than 120s.
export const BACKOFF_STEPS_MS = [15_000, 30_000, 60_000, 120_000];

// Sources we report on individually. A source with an entry in the payload is
// the only thing that may be reported about it.
export const REPORTED_SOURCES = ['NEPTUN', 'MAPA'];

const parseUtc = (v) => {
  if (v == null) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// Splits a snapshot into the three things the UI must not confuse:
//   reach  — could we talk to the server at all
//   fresh  — did the server verify its upstream recently
//   current— did the CONTENT change recently (a separate, calmer question)
export function assess(snapshot, { now = Date.now(), reachable = true } = {}) {
  const pipeAt = parseUtc(snapshot?.pipelineCheckedAt);
  const dataAt = parseUtc(snapshot?.dataUpdatedAt);
  const pubAt = parseUtc(snapshot?.publishedAt);

  let pipeAgeMs = null;
  let pipeProblem = null;
  if (pipeAt === null) {
    pipeProblem = 'missing';
  } else if (pipeAt - now > FUTURE_TOLERANCE_MS) {
    pipeProblem = 'future';
    // A timestamp from the future is not a fresh check. Age is reported as the
    // distance so the number on screen cannot read as "just confirmed".
    pipeAgeMs = now - pipeAt;
  } else {
    pipeAgeMs = Math.max(0, now - pipeAt);
  }

  const stale = pipeProblem !== null || pipeAgeMs === null || pipeAgeMs > FRESH_WINDOW_MS;
  const dataAgeMs = dataAt === null ? null : Math.max(0, now - dataAt);

  const sources = {};
  for (const key of REPORTED_SOURCES) {
    const h = snapshot?.health?.[key];
    if (!h) continue;                       // absent: say nothing about it
    sources[key] = {
      status: h.status || 'unknown',
      error: h.error || null,
      delayed: !!h.delayed,
      ageMs: parseUtc(h.updatedAt) === null ? null : Math.max(0, now - parseUtc(h.updatedAt)),
    };
  }

  const sourceList = Object.values(sources);
  const sourceProblem = sourceList.some((s) =>
    (s.status && s.status !== 'online' && s.status !== 'disabled') || s.delayed || s.error);

  let status;
  if (!reachable) status = STATUS.OFFLINE;
  else if (!snapshot) status = STATUS.OFFLINE;
  else if (stale) status = STATUS.STALE;
  else if (sourceProblem) status = STATUS.DEGRADED;
  else status = STATUS.LIVE;

  return {
    status,
    reachable,
    hasSnapshot: !!snapshot,
    pipeAt, dataAt, pubAt,
    pipeAgeMs, dataAgeMs,
    dataStale: dataAgeMs !== null && dataAgeMs > DATA_WINDOW_MS,
    pipeProblem,
    sources,
    sourceProblem,
  };
}

// What the user is told. Kept apart from the status so the wording can be
// reviewed on its own: no message here may claim recovery or freshness the
// assessment does not support.
export function describe(a) {
  if (a.status === STATUS.OFFLINE) {
    return {
      tone: 'bad',
      title: 'Не вдалося отримати дані',
      detail: a.hasSnapshot
        ? 'Показано останній відомий стан. Спробуємо ще раз автоматично.'
        : 'Сервіс не відповідає. Перевірте з’єднання.',
    };
  }
  if (a.status === STATUS.STALE) {
    const why = a.pipeProblem === 'missing' ? 'час перевірки відсутній'
      : a.pipeProblem === 'future' ? 'час перевірки випереджає системний час'
        : 'остання перевірка давніша за 3 хвилини';
    return {
      tone: 'warn',
      title: 'Увага! Дані радара можуть бути застарілими',
      detail: why,
    };
  }
  if (a.status === STATUS.DEGRADED) {
    return {
      tone: 'warn',
      title: 'Дані актуальні, але джерело з помилкою',
      detail: Object.entries(a.sources)
        .filter(([, s]) => s.status !== 'online' || s.delayed || s.error)
        .map(([k, s]) => `${k}: ${s.delayed ? 'затримка' : (s.error || s.status)}`)
        .join(' · '),
    };
  }
  return { tone: 'ok', title: 'Актуальність даних підтверджена', detail: '' };
}

// Recovery ladder with jitter, so a crowd of clients that lost the backend at
// the same moment does not come back in the same second.
export function backoffMs(attempt, rand = Math.random) {
  const step = BACKOFF_STEPS_MS[Math.min(Math.max(0, attempt), BACKOFF_STEPS_MS.length - 1)];
  const jitter = Math.floor(rand() * 3000);
  return step + jitter;
}

// One validating gate in front of every request. Returns the snapshot or a
// named failure, so the caller never has to guess why a response was rejected.
export function validate(raw, { now = Date.now() } = {}) {
  let json;
  try { json = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { ok: false, reason: 'invalid-json' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'invalid-json' };
  if (json.v !== 1) return { ok: false, reason: 'unsupported-version', snapshot: json };
  if (!Array.isArray(json.events)) return { ok: false, reason: 'no-events', snapshot: json };
  if (!Array.isArray(json.alerts)) return { ok: false, reason: 'no-alerts', snapshot: json };
  // A payload with no usable verification time is answered, not usable: we
  // cannot tell how old it is, so it must not be presented as current.
  const pipeAt = parseUtc(json.pipelineCheckedAt);
  if (pipeAt === null) return { ok: false, reason: 'no-timestamp', snapshot: json };
  if (pipeAt - now > FUTURE_TOLERANCE_MS) return { ok: false, reason: 'future-timestamp', snapshot: json };
  return { ok: true, snapshot: json };
}

// Human age in Ukrainian, from an age in milliseconds — which is what every
// call site has, and what assess() already computed. Takes an age, not an
// instant: mixing the two up produced "20736 дн тому" for a fresh check.
export function formatAge(ageMs) {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return '—';
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 10) return 'щойно';
  if (s < 60) return `${s} с тому`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} хв тому`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} год тому`;
  return `${Math.floor(h / 24)} дн тому`;
}

export function formatClock(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Kyiv' });
}

// How long until the next scheduled poll.
//
// The attempt counter is an explicit argument rather than something read off
// the assessment: it counts consecutive failed REQUESTS, which is state the
// caller owns, not a property of the data. The jitter source is injectable so
// the schedule can be asserted exactly.
export function nextDelayMs({
  assessment = null, attempt = 0, checking = false, hidden = false,
  retryAfter = null, rand = Math.random,
} = {}) {
  if (checking) return 1000;                 // a request is in flight; do not stack
  // The server's Retry-After beats our ladder: it knows more than we do.
  if (retryAfter) return Math.max(1000, retryAfter);
  if (!assessment || assessment.status === STATUS.OFFLINE || assessment.status === STATUS.STALE) {
    return backoffMs(attempt, rand);
  }
  if (hidden) return POLL_HIDDEN_MS;
  return POLL_NORMAL_MS;
}