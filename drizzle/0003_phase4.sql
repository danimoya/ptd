-- Phase 4: contractor billing + certified invoices, approvals, verified agent usage,
-- hosted-grade accounts, workflow depth, and durable state for multi-replica operation.

ALTER TABLE streams ADD COLUMN budget_mode VARCHAR(10) NOT NULL DEFAULT 'alert';
ALTER TABLE streams ADD COLUMN hourly_rate REAL;
ALTER TABLE customers ADD COLUMN hourly_rate REAL;
ALTER TABLE customers ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'USD';

ALTER TABLE memberships ADD COLUMN billable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE memberships ADD COLUMN hourly_rate REAL;
ALTER TABLE memberships ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE memberships ADD COLUMN billing_name TEXT;
ALTER TABLE memberships ADD COLUMN billing_address TEXT;
ALTER TABLE memberships ADD COLUMN tax_id VARCHAR(64);
ALTER TABLE memberships ADD COLUMN require_approval BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE time_entries ADD COLUMN approval_status VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE time_entries ADD COLUMN approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE time_entries ADD COLUMN approved_at TIMESTAMP;
ALTER TABLE time_entries ADD COLUMN locked_invoice_id INTEGER;
ALTER TABLE time_entries ADD COLUMN verified_tokens INTEGER;
ALTER TABLE time_entries ADD COLUMN verified_cost_usd REAL;
ALTER TABLE time_entries ADD COLUMN verified_source VARCHAR(20);
ALTER TABLE time_entries ADD COLUMN verified_at TIMESTAMP;

ALTER TABLE invoices ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'customer';
ALTER TABLE invoices ADD COLUMN member_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN reference VARCHAR(40);
ALTER TABLE invoices ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE invoices ADD COLUMN rate REAL;
ALTER TABLE invoices ADD COLUMN total_minutes INTEGER;
ALTER TABLE invoices ADD COLUMN amount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN snapshot JSONB;
ALTER TABLE invoices ADD COLUMN content_hash VARCHAR(128);
ALTER TABLE invoices ADD COLUMN signature TEXT;
ALTER TABLE invoices ADD COLUMN signing_key_id INTEGER;
ALTER TABLE invoices ADD COLUMN verify_token VARCHAR(64);
ALTER TABLE invoices ADD COLUMN issued_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN voided_at TIMESTAMP;
CREATE INDEX invoices_verify_token_idx ON invoices(verify_token);

CREATE TABLE signing_keys (
  id SERIAL PRIMARY KEY,
  algorithm VARCHAR(16) NOT NULL DEFAULT 'ed25519',
  public_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  retired_at TIMESTAMP
);

ALTER TABLE users ADD COLUMN totp_secret_sealed TEXT;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN recovery_codes_sealed TEXT;

CREATE TABLE user_identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX user_identities_lookup_idx ON user_identities(provider, subject);

CREATE TABLE audit_events (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  kind VARCHAR(48) NOT NULL,
  target VARCHAR(120),
  meta JSONB,
  ip VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_idx ON audit_events(org_id);

CREATE TABLE link_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX link_codes_code_idx ON link_codes(provider, code);

ALTER TABLE chat_identities ADD COLUMN org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;

CREATE TABLE ai_usage (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  provider VARCHAR(20) NOT NULL,
  model VARCHAR(80) NOT NULL,
  action VARCHAR(64) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_org_idx ON ai_usage(org_id);

CREATE TABLE import_runs (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(20) NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  warnings JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE usage_reconciliations (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  reported_tokens INTEGER NOT NULL DEFAULT 0,
  provider_tokens INTEGER NOT NULL DEFAULT 0,
  reported_cost_usd REAL NOT NULL DEFAULT 0,
  provider_cost_usd REAL NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL,
  detail JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE task_comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  via VARCHAR(16) NOT NULL DEFAULT 'web',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX task_comments_task_idx ON task_comments(task_id);

CREATE TABLE task_attachments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename VARCHAR(255) NOT NULL,
  mime VARCHAR(120) NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_task_idx ON task_attachments(task_id);

CREATE TABLE task_recurrences (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule VARCHAR(120) NOT NULL,
  next_run_at TIMESTAMP NOT NULL,
  last_run_at TIMESTAMP,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE custom_fields (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  key VARCHAR(40) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  options JSONB,
  position INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX custom_fields_org_idx ON custom_fields(org_id);

CREATE TABLE task_custom_values (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value JSONB
);
CREATE INDEX task_custom_values_task_idx ON task_custom_values(task_id);
