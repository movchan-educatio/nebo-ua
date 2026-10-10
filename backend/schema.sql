-- nebo-ua journal + source checks (D1)
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'alert' | 'threat'
  source TEXT NOT NULL,           -- NEPTUN | MAPA; OFFICIAL rows are historical only
  category TEXT,
  region TEXT,
  district TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ended_at TEXT,                 -- set only when closed by protection rules
  status TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'stale' | 'ended'
);
CREATE INDEX IF NOT EXISTS idx_journal_status ON journal(status);
CREATE INDEX IF NOT EXISTS idx_journal_last_seen ON journal(last_seen);

CREATE TABLE IF NOT EXISTS checks (
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL,           -- 1 | 0
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_source_ts ON checks(source, ts);

-- One atomic current snapshot, including source versions and grace counters.
-- Used when SYNC_STATE_STORE=d1. KV remains the fallback checkpoint.
CREATE TABLE IF NOT EXISTS pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  started_at INTEGER NOT NULL,
  bundle TEXT NOT NULL
);

-- Web Push subscriptions. No accounts: the endpoint IS the identity.
-- places: JSON [{oblast, raion?, hromada?, settlement?}] (several allowed).
-- categories: JSON {officialStart, officialEnd, uav, missile, ballistic, kab, aviation}.
-- quiet: JSON {enabled, start "HH:MM", end "HH:MM"}.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  places TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '{}',
  quiet TEXT NOT NULL DEFAULT '{}',
  oblast_norm TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_seen TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subs_oblast ON push_subscriptions(oblast_norm);

CREATE TABLE IF NOT EXISTS push_log (
  ts TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  event_id TEXT,
  category TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_log_ts ON push_log(ts);
