CREATE TABLE IF NOT EXISTS pipeline_state (
  id INTEGER PRIMARY KEY CHECK (id=1),
  started_at INTEGER NOT NULL,
  bundle TEXT NOT NULL
);
