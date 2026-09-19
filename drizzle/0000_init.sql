CREATE TABLE organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  plan VARCHAR(20) NOT NULL DEFAULT 'self_hosted',
  invite_code VARCHAR(32),
  stripe_customer_id VARCHAR(64),
  stripe_subscription_id VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  is_agent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  invited_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE INDEX memberships_org_idx ON memberships(org_id);

CREATE TABLE invitations (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  token VARCHAR(64) NOT NULL UNIQUE,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  prefix VARCHAR(8) NOT NULL UNIQUE,
  hash VARCHAR(200) NOT NULL,
  scopes VARCHAR(64) NOT NULL DEFAULT 'read,write',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP
);

CREATE TABLE apps (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  urls JSONB NOT NULL DEFAULT '[]',
  repo VARCHAR(255),
  stack JSONB NOT NULL DEFAULT '[]',
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX apps_org_idx ON apps(org_id);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  weekly_goal_hours INTEGER,
  billing_address TEXT,
  billing_email VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE streams (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(16),
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  archived BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  agent_budget_usd REAL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX streams_org_idx ON streams(org_id);

CREATE TABLE stream_apps (
  id SERIAL PRIMARY KEY,
  stream_id INTEGER NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'backlog',
  stream_id INTEGER REFERENCES streams(id) ON DELETE SET NULL,
  app_id INTEGER REFERENCES apps(id) ON DELETE SET NULL,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  start_date TIMESTAMP,
  due_date TIMESTAMP,
  estimated_duration INTEGER,
  dependencies JSONB NOT NULL DEFAULT '[]',
  external_key VARCHAR(128),
  urgency INTEGER NOT NULL DEFAULT 5,
  impact INTEGER NOT NULL DEFAULT 5,
  effort INTEGER NOT NULL DEFAULT 5,
  priority_score INTEGER NOT NULL DEFAULT 5,
  priority_source VARCHAR(10) NOT NULL DEFAULT 'formula',
  priority_note TEXT,
  tags JSONB NOT NULL DEFAULT '[]',
  completed BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX tasks_org_idx ON tasks(org_id);
CREATE INDEX tasks_stream_idx ON tasks(stream_id);
CREATE INDEX tasks_status_idx ON tasks(status);

CREATE TABLE task_events (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  kind VARCHAR(32) NOT NULL,
  changes JSONB,
  note TEXT,
  via VARCHAR(16) NOT NULL DEFAULT 'web',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events(task_id);

CREATE TABLE time_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  stream_id INTEGER REFERENCES streams(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  check_in TIMESTAMP NOT NULL,
  check_out TIMESTAMP,
  is_break BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  entry_source VARCHAR(10) NOT NULL DEFAULT 'human',
  agent_label VARCHAR(80),
  tokens_used INTEGER,
  api_cost_usd REAL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_user_idx ON time_entries(user_id);
CREATE INDEX time_entries_org_idx ON time_entries(org_id);
CREATE INDEX time_entries_task_idx ON time_entries(task_id);

CREATE TABLE entry_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  stream_id INTEGER REFERENCES streams(id) ON DELETE SET NULL,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(32),
  notes TEXT,
  is_break BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  total_amount INTEGER,
  pdf_url VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE org_integrations (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE chat_identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  external_id VARCHAR(128) NOT NULL,
  linked_at TIMESTAMP NOT NULL DEFAULT now()
);
