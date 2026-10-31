-- MySQL 8.x schema for the post-SQLite phase. Keep column names identical to schema.sql.
-- Credentials stay AES-256-GCM encrypted at the application layer, so TEXT is correct here.

CREATE TABLE accounts (
  id VARCHAR(48) PRIMARY KEY,
  provider VARCHAR(16) NOT NULL,
  label VARCHAR(255) NOT NULL,
  external_id VARCHAR(128) NOT NULL,
  login_customer_id VARCHAR(64) NULL,
  currency VARCHAR(8) NULL,
  timezone VARCHAR(64) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'connected',
  credentials TEXT NULL,
  token_expires_at DATETIME(3) NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uniq_provider_external (provider, external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE oauth_states (
  state VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  redirect_uri VARCHAR(512) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE approvals (
  id VARCHAR(48) PRIMARY KEY,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  type VARCHAR(24) NOT NULL,
  risk VARCHAR(8) NOT NULL,
  status VARCHAR(16) NOT NULL,
  account_id VARCHAR(48) NOT NULL,
  provider VARCHAR(16) NOT NULL,
  summary TEXT NOT NULL,
  payload JSON NOT NULL,
  result JSON NULL,
  decided_at DATETIME(3) NULL,
  decided_by VARCHAR(64) NULL,
  note TEXT NULL,
  KEY idx_approvals_status (status, created_at),
  KEY idx_approvals_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
  id VARCHAR(48) PRIMARY KEY,
  created_at DATETIME(3) NOT NULL,
  actor VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  provider VARCHAR(16) NULL,
  account_id VARCHAR(48) NULL,
  entity_type VARCHAR(16) NULL,
  entity_id VARCHAR(128) NULL,
  detail JSON NULL,
  result VARCHAR(16) NOT NULL DEFAULT 'info',
  KEY idx_audit_created (created_at),
  KEY idx_audit_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE metrics_cache (
  cache_key VARCHAR(255) PRIMARY KEY,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_cache_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settings (
  `key` VARCHAR(64) PRIMARY KEY,
  value JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE mock_entities (
  id VARCHAR(48) PRIMARY KEY,
  account_id VARCHAR(48) NOT NULL,
  provider VARCHAR(16) NOT NULL,
  type VARCHAR(16) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL,
  daily_budget DECIMAL(12, 2) NULL,
  payload JSON NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  KEY idx_mock_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
