PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  slot         TEXT PRIMARY KEY,
  email        TEXT UNIQUE,
  name         TEXT,
  status       TEXT DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot    TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  agent_type   TEXT NOT NULL,
  name         TEXT,
  model        TEXT,
  is_default   INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'active',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(user_slot, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_slot);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(agent_type);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key     TEXT UNIQUE NOT NULL,
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  agent_db_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  agent_id        TEXT NOT NULL,
  status          TEXT DEFAULT 'active',
  is_main         INTEGER DEFAULT 0,
  message_count   INTEGER DEFAULT 0,
  total_tokens    INTEGER DEFAULT 0,
  total_cost_krw  REAL DEFAULT 0,
  file_path       TEXT,
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_slot);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_db_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at DESC);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slot       TEXT NOT NULL REFERENCES users(slot) ON DELETE CASCADE,
  date            TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cache_read      INTEGER DEFAULT 0,
  cache_write     INTEGER DEFAULT 0,
  message_count   INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  cost_krw        REAL DEFAULT 0,
  fx_rate         REAL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_slot, date, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_date ON api_usage_daily(date);
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON api_usage_daily(user_slot, date);

CREATE TABLE IF NOT EXISTS fx_rates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  currency     TEXT NOT NULL,
  to_currency  TEXT NOT NULL DEFAULT 'KRW',
  rate         REAL NOT NULL,
  fetched_at   INTEGER NOT NULL,
  source       TEXT
);
CREATE INDEX IF NOT EXISTS idx_fx_currency_time ON fx_rates(currency, fetched_at DESC);
