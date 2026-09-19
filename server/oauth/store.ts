/**
 * Persistence for the authorization server. The only interesting decision in
 * here: an issued access token is a real `ptd_` api_token minted through
 * mintToken, so /mcp and every REST route verify OAuth callers with the exact
 * same code path they use for hand-minted tokens. oauth_refresh_tokens is the
 * bookkeeping that lets a grant be rotated, listed and revoked.
 */
import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { db } from "../../db";
import {
  apiTokens, memberships, oauthClients, oauthCodes, oauthRefreshTokens, organizations,
  type OauthClient, type OauthCode, type OauthRefreshToken, type Role,
} from "../../db/schema";
import { mintToken } from "../tokens";
import { isRole } from "../types";
import {
  ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS,
  hashOpaque, hashSecret, newAuthorizationCode, newClientId, newClientSecret, newRefreshToken, verifySecret,
} from "./pkce";
import type { AuthMethod, GrantType } from "./validate";

/* ───────────────────────────────── clients ───────────────────────────────── */

export interface NewClient {
  clientName: string;
  redirectUris: string[];
  grantTypes: GrantType[];
  tokenEndpointAuthMethod: AuthMethod;
}

/** Registers a client. The secret (confidential clients only) is returned once. */
export async function createClient(meta: NewClient): Promise<{ client: OauthClient; clientSecret?: string }> {
  const clientId = newClientId();
  const clientSecret = meta.tokenEndpointAuthMethod === "none" ? undefined : newClientSecret();
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId,
      clientSecretHash: clientSecret ? await hashSecret(clientSecret) : null,
      clientName: meta.clientName,
      redirectUris: meta.redirectUris,
      grantTypes: meta.grantTypes,
      tokenEndpointAuthMethod: meta.tokenEndpointAuthMethod,
    })
    .returning();
  return { client, clientSecret };
}

export async function getClient(clientId: string | undefined): Promise<OauthClient | null> {
  if (!clientId || typeof clientId !== "string" || clientId.length > 64) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return row ?? null;
}

export async function listClients(): Promise<OauthClient[]> {
  return db.select().from(oauthClients).orderBy(desc(oauthClients.createdAt));
}

export async function deleteClient(clientId: string): Promise<boolean> {
  const rows = await db.delete(oauthClients).where(eq(oauthClients.clientId, clientId)).returning({ id: oauthClients.id });
  return rows.length > 0;
}

/** true when the client proved its identity (or is public and needs no proof). */
export async function authenticateClient(client: OauthClient, suppliedSecret: string | undefined): Promise<boolean> {
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (!client.clientSecretHash || !suppliedSecret) return false;
  return verifySecret(suppliedSecret, client.clientSecretHash);
}

/* ────────────────────────────── membership ──────────────────────────────── */

export async function membershipRole(userId: number, orgId: number): Promise<Role | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  return (isRole(row.role) ? row.role : "member") as Role;
}

export async function orgName(orgId: number): Promise<string | null> {
  const [row] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row?.name ?? null;
}

/* ─────────────────────────── authorization codes ─────────────────────────── */

export interface NewCode {
  clientId: string;
  userId: number;
  orgId: number;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
}

export async function createCode(meta: NewCode): Promise<{ code: string; expiresAt: Date }> {
  const code = newAuthorizationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.insert(oauthCodes).values({ ...meta, code, expiresAt });
  return { code, expiresAt };
}

export async function getCode(code: string): Promise<OauthCode | null> {
  if (typeof code !== "string" || !code || code.length > 128) return null;
  const [row] = await db.select().from(oauthCodes).where(eq(oauthCodes.code, code)).limit(1);
  return row ?? null;
}

/** Single-use claim: only the first caller gets `true`. */
export async function claimCode(id: number): Promise<boolean> {
  const rows = await db
    .update(oauthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(oauthCodes.id, id), isNull(oauthCodes.usedAt)))
    .returning({ id: oauthCodes.id });
  return rows.length > 0;
}

/**
 * A replayed code means the code leaked: revoke every token that code ever
 * produced (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.3.2), across all rotations.
 */
export async function revokeCodeLineage(codeId: number | null): Promise<{ refreshRevoked: number; accessRevoked: number }> {
  if (codeId === null) return { refreshRevoked: 0, accessRevoked: 0 };
  const rows = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.codeId, codeId));
  if (rows.length === 0) return { refreshRevoked: 0, accessRevoked: 0 };
  const now = new Date();
  const live = rows.filter((r) => !r.revokedAt);
  if (live.length > 0) {
    await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(inArray(oauthRefreshTokens.id, live.map((r) => r.id)));
  }
  const tokenIds = rows.map((r) => r.apiTokenId).filter((id): id is number => typeof id === "number");
  let accessRevoked = 0;
  if (tokenIds.length > 0) {
    const revoked = await db
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(inArray(apiTokens.id, tokenIds), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    accessRevoked = revoked.length;
  }
  return { refreshRevoked: live.length, accessRevoked };
}

/* ───────────────────────────────── grants ───────────────────────────────── */

export interface IssuedGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  apiTokenId: number;
  refreshId: number;
}

function tokenName(clientName: string): string {
  return `oauth:${clientName}`.slice(0, 80);
}

/** Mints the `ptd_` access token plus the refresh token that owns it. */
export async function issueGrant(opts: {
  userId: number; orgId: number; clientId: string; clientName: string; scope: string; codeId: number | null;
}): Promise<IssuedGrant> {
  const minted = await mintToken(opts.userId, opts.orgId, tokenName(opts.clientName), new Date(Date.now() + ACCESS_TTL_MS));
  const refreshToken = newRefreshToken();
  const [row] = await db
    .insert(oauthRefreshTokens)
    .values({
      tokenHash: hashOpaque(refreshToken),
      clientId: opts.clientId,
      userId: opts.userId,
      orgId: opts.orgId,
      apiTokenId: minted.id,
      codeId: opts.codeId,
      scope: opts.scope,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    })
    .returning();
  return { accessToken: minted.secret, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), apiTokenId: minted.id, refreshId: row.id };
}

export async function findRefresh(token: string): Promise<OauthRefreshToken | null> {
  if (typeof token !== "string" || !token) return null;
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hashOpaque(token))).limit(1);
  return row ?? null;
}

/** Rotation: the presented refresh token and its access token both die here. */
export async function retireRefresh(row: OauthRefreshToken): Promise<void> {
  const now = new Date();
  await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.id, row.id));
  if (row.apiTokenId !== null) {
    await db.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.id, row.apiTokenId), isNull(apiTokens.revokedAt)));
  }
}

/* ───────────────────────────── revocation ──────────────────────────────── */

/**
 * Revokes a refresh token (and the access token it owns). When the caller named
 * a client, the grant must belong to that client or nothing is touched.
 */
export async function revokeRefreshToken(token: string, expectedClientId?: string): Promise<{ revoked: boolean; clientId?: string }> {
  const row = await findRefresh(token);
  if (!row) return { revoked: false };
  if (expectedClientId && row.clientId !== expectedClientId) return { revoked: false };
  if (row.revokedAt) return { revoked: true, clientId: row.clientId };
  await retireRefresh(row);
  return { revoked: true, clientId: row.clientId };
}

/** Revokes an OAuth-issued `ptd_` access token; hand-minted tokens are left alone. */
export async function revokeAccessToken(accessToken: string, expectedClientId?: string): Promise<{ revoked: boolean; clientId?: string }> {
  const body = accessToken.startsWith("ptd_") ? accessToken.slice(4) : "";
  if (body.length !== 40) return { revoked: false };
  const [token] = await db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.prefix, body.slice(0, 8))).limit(1);
  if (!token) return { revoked: false };
  const [grant] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.apiTokenId, token.id)).limit(1);
  if (!grant) return { revoked: false };
  if (expectedClientId && grant.clientId !== expectedClientId) return { revoked: false };
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, token.id), isNull(apiTokens.revokedAt)));
  return { revoked: true, clientId: grant.clientId };
}

/* ──────────────────────── listing / admin surface ───────────────────────── */

export interface GrantRow {
  grantId: number;
  clientId: string;
  clientName: string | null;
  userId: number;
  orgId: number;
  scope: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  accessTokenId: number | null;
  accessTokenName: string | null;
  accessTokenExpiresAt: Date | null;
  accessTokenRevokedAt: Date | null;
  lastUsedAt: Date | null;
}

async function grantRows(where?: SQL): Promise<GrantRow[]> {
  const q = db
    .select({
      grantId: oauthRefreshTokens.id,
      clientId: oauthRefreshTokens.clientId,
      clientName: oauthClients.clientName,
      userId: oauthRefreshTokens.userId,
      orgId: oauthRefreshTokens.orgId,
      scope: oauthRefreshTokens.scope,
      createdAt: oauthRefreshTokens.createdAt,
      expiresAt: oauthRefreshTokens.expiresAt,
      revokedAt: oauthRefreshTokens.revokedAt,
      accessTokenId: oauthRefreshTokens.apiTokenId,
      accessTokenName: apiTokens.name,
      accessTokenExpiresAt: apiTokens.expiresAt,
      accessTokenRevokedAt: apiTokens.revokedAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(oauthRefreshTokens)
    .leftJoin(oauthClients, eq(oauthClients.clientId, oauthRefreshTokens.clientId))
    .leftJoin(apiTokens, eq(apiTokens.id, oauthRefreshTokens.apiTokenId))
    .orderBy(desc(oauthRefreshTokens.createdAt));
  const rows = where ? await q.where(where) : await q;
  return rows as GrantRow[];
}

export async function grantsForUser(userId: number, orgId: number): Promise<GrantRow[]> {
  return grantRows(and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.orgId, orgId)));
}

export async function grantsForOrg(orgId: number): Promise<GrantRow[]> {
  return grantRows(eq(oauthRefreshTokens.orgId, orgId));
}

export async function grantsForClient(clientId: string): Promise<GrantRow[]> {
  return grantRows(eq(oauthRefreshTokens.clientId, clientId));
}

/** Revokes one grant (refresh token + its access token) if it belongs to the caller. */
export async function revokeGrantById(grantId: number, scope: { userId?: number; orgId: number }): Promise<boolean> {
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, grantId)).limit(1);
  if (!row) return false;
  if (row.orgId !== scope.orgId) return false;
  if (scope.userId !== undefined && row.userId !== scope.userId) return false;
  await retireRefresh(row);
  return true;
}
