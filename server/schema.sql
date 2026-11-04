-- Reference schema; production DDL is applied through the owning Drizzle migration.
CREATE TABLE demo_ai_control (
  id INTEGER PRIMARY KEY,
  quota_day TEXT NOT NULL DEFAULT '',
  admissions INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT,
  state TEXT NOT NULL DEFAULT 'idle',
  call_id TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  close_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
