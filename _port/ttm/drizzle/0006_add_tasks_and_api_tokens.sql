-- Tasks (per-project work items) — match "Cards" in Kanttban.
CREATE TABLE IF NOT EXISTS "tasks" (
    "id" serial PRIMARY KEY,
    "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "project_id" integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
    "title" varchar(255) NOT NULL,
    "external_ref" varchar(128),
    "archived" boolean NOT NULL DEFAULT false,
    "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tasks_project_idx" ON "tasks" ("project_id");
CREATE INDEX IF NOT EXISTS "tasks_workspace_idx" ON "tasks" ("workspace_id");
-- HeliosDB 3.14 does not support multi-column indexes; the (workspace_id,
-- external_ref) lookup falls back to a sequential scan but the workloads
-- here are small. Promote to a composite index on stacks running 3.27+.
CREATE INDEX IF NOT EXISTS "tasks_external_ref_idx" ON "tasks" ("external_ref");

-- Optional task attribution on time entries.
ALTER TABLE "time_entries"
    ADD COLUMN IF NOT EXISTS "task_id" integer REFERENCES "tasks"("id") ON DELETE SET NULL;

-- Bearer tokens for agent / API access (separate from short-lived JWT).
CREATE TABLE IF NOT EXISTS "api_tokens" (
    "id" serial PRIMARY KEY,
    "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "name" varchar(80) NOT NULL,
    "prefix" varchar(8) NOT NULL UNIQUE,
    "hash" varchar(200) NOT NULL,
    "scopes" varchar(64) NOT NULL DEFAULT 'read,write',
    "created_at" timestamp NOT NULL DEFAULT now(),
    "last_used_at" timestamp,
    "expires_at" timestamp,
    "revoked_at" timestamp
);

CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" ("user_id");
