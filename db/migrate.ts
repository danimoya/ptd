// Applies drizzle/*.sql in filename order, once each, tracked in _migrations.
// Statements are executed one at a time (simple `;` split — no dollar-quoting
// in our migrations) so the same files work on HeliosDB-Nano and Postgres.
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [path.resolve(here, "../drizzle"), path.resolve(here, "drizzle"), path.resolve(process.cwd(), "drizzle")];
const dir = candidates.find((d) => { try { readdirSync(d); return true; } catch { return false; } });
if (!dir) throw new Error("drizzle/ directory not found");
const migrationsDir: string = dir;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

function splitStatements(text: string): string[] {
  return text
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
}

async function main() {
  await sql.unsafe(
    "CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT now())"
  );
  const applied = new Set((await sql.unsafe("SELECT name FROM _migrations")).map((r: any) => r.name as string));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const statements = splitStatements(readFileSync(path.join(migrationsDir, file), "utf8"));
    console.log(`[migrate] applying ${file} (${statements.length} statements)`);
    for (const stmt of statements) await sql.unsafe(stmt);
    await sql.unsafe("INSERT INTO _migrations (name) VALUES ($1)", [file]);
  }
  console.log(`[migrate] up to date (${files.length} files)`);
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch((err) => { console.error("[migrate] failed:", err); process.exit(1); });
