
ALTER TABLE "customers" 
ADD COLUMN "weekly_goal_hours" integer,
ADD COLUMN "billing_address" text,
ADD COLUMN "billing_email" varchar(255);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" SERIAL PRIMARY KEY,
  "customer_id" integer REFERENCES "customers"("id"),
  "user_id" integer REFERENCES "users"("id"),
  "month" integer NOT NULL,
  "year" integer NOT NULL,
  "status" varchar(50) NOT NULL DEFAULT 'draft',
  "total_amount" integer,
  "pdf_url" varchar(255),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
