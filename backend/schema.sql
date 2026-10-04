-- nebo-ua journal + source checks (D1)
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'alert' | 'threat'
  source TEXT NOT NULL,           -- OFFICIAL | NEPTUN | MAPA
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
