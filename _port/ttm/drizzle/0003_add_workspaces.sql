CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" SERIAL PRIMARY KEY,
  "name" varchar(255) NOT NULL,
  "owner_id" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "memberships" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" varchar(20) NOT NULL DEFAULT 'member',
  "created_at" timestamp DEFAULT now() NOT NULL,
  UNIQUE ("workspace_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "memberships_user_id_idx" ON "memberships"("user_id");
CREATE INDEX IF NOT EXISTS "memberships_workspace_id_idx" ON "memberships"("workspace_id");

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "email" varchar(255) NOT NULL,
  "role" varchar(20) NOT NULL DEFAULT 'member',
  "token" varchar(64) NOT NULL UNIQUE,
  "invited_by" integer NOT NULL REFERENCES "users"("id"),
  "expires_at" timestamp NOT NULL,
  "accepted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations"("email");

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "workspace_id" integer REFERENCES "workspaces"("id") ON DELETE CASCADE;

ALTER TABLE "time_entries"
  ADD COLUMN IF NOT EXISTS "workspace_id" integer REFERENCES "workspaces"("id") ON DELETE CASCADE;

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "workspace_id" integer REFERENCES "workspaces"("id") ON DELETE CASCADE;

ALTER TABLE "entry_templates"
  ADD COLUMN IF NOT EXISTS "workspace_id" integer REFERENCES "workspaces"("id") ON DELETE CASCADE;

-- Backfill: create a personal workspace for each existing user and attach their data.
-- Rewritten from a DO $$ DECLARE ... FOR ... LOOP block into plain INSERT ... SELECT
-- statements per HeliosDB-Nano docs/compatibility/plpgsql.md. Ordering matters:
-- workspaces must exist before memberships reference them, and workspace_id columns
-- must be backfilled before any NOT NULL is enforced.

INSERT INTO "workspaces" ("name", "owner_id")
SELECT split_part("email", '@', 1) || '''s workspace', "id"
FROM "users"
WHERE "id" NOT IN (SELECT "owner_id" FROM "workspaces");

INSERT INTO "memberships" ("workspace_id", "user_id", "role")
SELECT w."id", w."owner_id", 'owner'
FROM "workspaces" w
WHERE NOT EXISTS (
  SELECT 1 FROM "memberships" m
  WHERE m."workspace_id" = w."id" AND m."user_id" = w."owner_id"
);

UPDATE "customers" SET "workspace_id" = (
  SELECT "id" FROM "workspaces" WHERE "owner_id" = "customers"."user_id" LIMIT 1
) WHERE "workspace_id" IS NULL AND "user_id" IS NOT NULL;

UPDATE "time_entries" SET "workspace_id" = (
  SELECT "id" FROM "workspaces" WHERE "owner_id" = "time_entries"."user_id" LIMIT 1
) WHERE "workspace_id" IS NULL AND "user_id" IS NOT NULL;

UPDATE "invoices" SET "workspace_id" = (
  SELECT "id" FROM "workspaces" WHERE "owner_id" = "invoices"."user_id" LIMIT 1
) WHERE "workspace_id" IS NULL AND "user_id" IS NOT NULL;

UPDATE "entry_templates" SET "workspace_id" = (
  SELECT "id" FROM "workspaces" WHERE "owner_id" = "entry_templates"."user_id" LIMIT 1
) WHERE "workspace_id" IS NULL AND "user_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "customers_workspace_id_idx" ON "customers"("workspace_id");
CREATE INDEX IF NOT EXISTS "time_entries_workspace_id_idx" ON "time_entries"("workspace_id");
CREATE INDEX IF NOT EXISTS "invoices_workspace_id_idx" ON "invoices"("workspace_id");
CREATE INDEX IF NOT EXISTS "entry_templates_workspace_id_idx" ON "entry_templates"("workspace_id");
