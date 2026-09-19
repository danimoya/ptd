CREATE TABLE IF NOT EXISTS "entry_templates" (
  "id" SERIAL PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "customer_id" integer REFERENCES "customers"("id") ON DELETE SET NULL,
  "name" varchar(100) NOT NULL,
  "notes" text,
  "is_break" boolean NOT NULL DEFAULT false,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "entry_templates_user_id_idx" ON "entry_templates"("user_id");
