import { readFileSync } from "fs";
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL environment variable must be set");

let client: ReturnType<typeof postgres> | null = null;

/**
 * DATABASE_SSL=true turns TLS on. With DATABASE_SSL_CA pointing at the server
 * certificate the chain is verified (the bundled ptd-db image writes its
 * self-signed cert to the shared /tls volume); without it TLS is still used
 * but the certificate is not verified (rejectUnauthorized=false).
 */
function sslOptions(): false | "require" | Record<string, unknown> {
  if ((process.env.DATABASE_SSL ?? "false").toLowerCase() !== "true") return false;
  const ca = process.env.DATABASE_SSL_CA;
  if (ca) return { ca: readFileSync(ca), servername: process.env.DATABASE_SSL_SERVERNAME || "ptd-db" };
  return { rejectUnauthorized: false };
}

export const createPool = () => {
  if (client) return client;
  client = postgres(process.env.DATABASE_URL!, {
    ssl: sslOptions(),
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    debug: process.env.DB_DEBUG ? (_c, q) => console.log("[pg-sql]", q.slice(0, 400)) : undefined,
  });
  return client;
};
