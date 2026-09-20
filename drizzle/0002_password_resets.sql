-- Password reset tokens.
--
-- The token is mailed; only a keyed SHA-256 of it is stored, so a stolen dump
-- cannot be replayed as a reset link. `token_hash` is UNIQUE because the digest
-- is deterministic: redemption looks the row up by value, exactly as
-- oauth_refresh_tokens does. `used_at` makes a link single-use; redeeming one
-- also stamps every other outstanding token for that user, so a forwarded older
-- link stops working the moment a new password is set.

CREATE TABLE password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(200) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets(user_id);
