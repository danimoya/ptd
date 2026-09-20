import type { Express, Request, Response } from "express";
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { apiTokens, users, type User } from "../db/schema";
import { auth } from "./auth";
import { resolveOrg } from "./orgs";
import { validate } from "./validation";
import type { OrgRequest } from "./types";
import { audit } from "./audit/log";

const scrypt = promisify(scryptCb);
export const TOKEN_PREFIX = "ptd_";

export interface MintedToken { id: number; prefix: string; secret: string; name: string }

async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(secret, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function verifySecret(supplied: string, stored: string): Promise<boolean> {
  const [hashedHex, salt] = stored.split(".");
  if (!hashedHex || !salt) return false;
  const expected = Buffer.from(hashedHex, "hex");
  const actual = (await scrypt(supplied, salt, 64)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function mintToken(userId: number, orgId: number, name: string, expiresAt?: Date | null): Promise<MintedToken> {
  const prefix = randomBytes(4).toString("hex");
  const body = randomBytes(16).toString("hex");
  const [created] = await db
    .insert(apiTokens)
    .values({ userId, orgId, name, prefix, hash: await hashSecret(body), expiresAt: expiresAt ?? null })
    .returning();
  return { id: created.id, prefix, secret: `${TOKEN_PREFIX}${prefix}${body}`, name: created.name };
}

const lastUsedCache = new Map<string, number>();
async function touchLastUsed(prefix: string) {
  const now = Date.now();
  if (now - (lastUsedCache.get(prefix) ?? 0) < 60_000) return;
  lastUsedCache.set(prefix, now);
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.prefix, prefix));
}

/** Verify `Authorization: Bearer ptd_…`. Returns null on any failure; never throws. */
export async function verifyApiToken(authHeader: string | undefined): Promise<{ user: User; orgId: number } | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const supplied = m[1].trim();
  if (!supplied.startsWith(TOKEN_PREFIX)) return null;
  const body = supplied.slice(TOKEN_PREFIX.length);
  if (body.length !== 40) return null;
  const prefix = body.slice(0, 8);
  const secret = body.slice(8);
  const [row] = await db.select().from(apiTokens).where(eq(apiTokens.prefix, prefix)).limit(1);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  if (!(await verifySecret(secret, row.hash))) return null;
  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user) return null;
  touchLastUsed(prefix).catch(() => {});
  return { user, orgId: row.orgId };
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

export function registerTokenRoutes(app: Express) {
  app.get("/api/tokens", auth, resolveOrg, async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const rows = await db
      .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, scopes: apiTokens.scopes,
        createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, r.user[0].id), eq(apiTokens.orgId, r.org.id)))
      .orderBy(apiTokens.createdAt);
    res.json(rows);
  });

  app.post("/api/tokens", auth, resolveOrg, validate(createSchema), async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const { name, expiresInDays } = req.body as z.infer<typeof createSchema>;
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
    const minted = await mintToken(r.user[0].id, r.org.id, name, expiresAt);
    // The prefix, never the secret: it is the handle an admin reads back in the
    // log and in the token list, and it is not a credential on its own.
    audit(req, "token.minted", minted.prefix, { name, expiresAt: expiresAt?.toISOString() ?? null });
    res.status(201).json({ ...minted, auth_header_example: `Authorization: Bearer ${minted.secret}` });
  });

  app.post("/api/tokens/rotate", auth, resolveOrg, async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const revoked = await db.update(apiTokens).set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.userId, r.user[0].id), eq(apiTokens.orgId, r.org.id), isNull(apiTokens.revokedAt)))
      .returning({ prefix: apiTokens.prefix });
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : "rotated";
    const minted = await mintToken(r.user[0].id, r.org.id, name);
    audit(req, "token.rotated", minted.prefix, { revoked: revoked.map((t) => t.prefix), name });
    res.status(201).json({ ...minted, auth_header_example: `Authorization: Bearer ${minted.secret}` });
  });

  app.delete("/api/tokens/:id", auth, resolveOrg, async (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad token id" });
    const rows = await db.update(apiTokens).set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, r.user[0].id))).returning({ id: apiTokens.id, prefix: apiTokens.prefix });
    if (rows.length === 0) return res.status(404).json({ error: "Token not found" });
    audit(req, "token.revoked", rows[0].prefix, { tokenId: id });
    res.json({ revoked: id });
  });
}
