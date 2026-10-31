CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  external_id TEXT NOT NULL,
  login_customer_id TEXT,
  currency TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  credentials TEXT,
  token_expires_at TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redirect_uri TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  type TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  provider TEXT,
  account_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  detail TEXT,
  result TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);

CREATE TABLE IF NOT EXISTS metrics_cache (
  cache_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_entities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  daily_budget REAL,
  payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
