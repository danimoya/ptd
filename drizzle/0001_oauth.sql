-- OAuth 2.1 authorization server (MCP remote-server auth, spec 2025-06-18).
-- Access tokens are ordinary ptd_ api_tokens: the resource server (/mcp) keeps
-- one verification path, and an OAuth grant is just "an api_token with a paper
-- trail". These three tables are that paper trail.

CREATE TABLE oauth_clients (
  id SERIAL PRIMARY KEY,
  client_id VARCHAR(64) NOT NULL UNIQUE,
  client_secret_hash VARCHAR(200),
  client_name VARCHAR(255) NOT NULL,
  redirect_uris JSONB NOT NULL DEFAULT '[]',
  grant_types JSONB NOT NULL DEFAULT '[]',
  token_endpoint_auth_method VARCHAR(32) NOT NULL DEFAULT 'none',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(128) NOT NULL UNIQUE,
  client_id VARCHAR(64) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  redirect_uri VARCHAR(500) NOT NULL,
  scope VARCHAR(200) NOT NULL DEFAULT '',
  code_challenge VARCHAR(128) NOT NULL,
  code_challenge_method VARCHAR(10) NOT NULL DEFAULT 'S256',
  resource VARCHAR(500),
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX oauth_codes_client_idx ON oauth_codes(client_id);
CREATE INDEX oauth_codes_user_idx ON oauth_codes(user_id);

CREATE TABLE oauth_refresh_tokens (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(200) NOT NULL UNIQUE,
  client_id VARCHAR(64) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_token_id INTEGER REFERENCES api_tokens(id) ON DELETE CASCADE,
  code_id INTEGER REFERENCES oauth_codes(id) ON DELETE SET NULL,
  scope VARCHAR(200) NOT NULL DEFAULT '',
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_user_idx ON oauth_refresh_tokens(user_id);
CREATE INDEX oauth_refresh_client_idx ON oauth_refresh_tokens(client_id);
CREATE INDEX oauth_refresh_code_idx ON oauth_refresh_tokens(code_id);
