CREATE TABLE IF NOT EXISTS "projects" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" integer NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "customer_id" integer REFERENCES "customers"("id") ON DELETE SET NULL,
  "user_id" integer REFERENCES "users"("id"),
  "name" varchar(255) NOT NULL,
  "color" varchar(16),
  "archived" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "projects_workspace_id_idx" ON "projects"("workspace_id");
CREATE INDEX IF NOT EXISTS "projects_customer_id_idx" ON "projects"("customer_id");

ALTER TABLE "time_entries"
  ADD COLUMN IF NOT EXISTS "project_id" integer REFERENCES "projects"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "time_entries_project_id_idx" ON "time_entries"("project_id");

ALTER TABLE "entry_templates"
  ADD COLUMN IF NOT EXISTS "project_id" integer REFERENCES "projects"("id") ON DELETE SET NULL;
