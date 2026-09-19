/**
 * Token and revocation endpoints (RFC 6749 §4.1.3 / §6, RFC 7009).
 *
 * Both grants end in the same place: `issueGrant`, which mints an ordinary
 * `ptd_` api_token as the access token. Refresh rotates — the presented refresh
 * token and the access token it owned are revoked before the new pair is handed
 * out — and a replayed authorization code takes down every token that code ever
 * produced, because a replay means the code leaked.
 */
import type { Request, Response } from "express";
import { verifyPkce, safeEqual } from "./pkce";
import {
  authenticateClient, claimCode, findRefresh, getClient, getCode, issueGrant, membershipRole,
  retireRefresh, revokeAccessToken, revokeCodeLineage, revokeRefreshToken,
} from "./store";
import { codeState } from "./validate";
import type { OauthClient } from "../../db/schema";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function fail(res: Response, status: number, error: string, description?: string) {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

export interface ClientAuth {
  clientId?: string;
  clientSecret?: string;
  via: "basic" | "post" | "none";
}

/** client_secret_basic, client_secret_post, or a public client naming itself in the body. */
export function parseClientAuth(header: string | undefined, body: Record<string, unknown>): ClientAuth {
  const basic = typeof header === "string" ? header.match(/^Basic\s+(.+)$/i) : null;
  if (basic) {
    const decoded = Buffer.from(basic[1].trim(), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      // RFC 6749 §2.3.1: both halves are form-urlencoded.
      const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
      return { clientId: dec(decoded.slice(0, idx)), clientSecret: dec(decoded.slice(idx + 1)), via: "basic" };
    }
  }
  return { clientId: str(body.client_id), clientSecret: str(body.client_secret), via: str(body.client_secret) ? "post" : "none" };
}

/** Authenticates the client, or explains why it could not be. */
async function requireClient(res: Response, auth: ClientAuth, expectedClientId?: string): Promise<OauthClient | null> {
  if (!auth.clientId) {
    fail(res, 401, "invalid_client", "client_id is required (client_secret_basic, client_secret_post, or client_id in the body)");
    return null;
  }
  if (expectedClientId && !safeEqual(auth.clientId, expectedClientId)) {
    fail(res, 400, "invalid_grant", "client_id does not match the client this grant was issued to");
    return null;
  }
  const client = await getClient(auth.clientId);
  if (!client) {
    fail(res, 401, "invalid_client", "Unknown client_id");
    return null;
  }
  if (!(await authenticateClient(client, auth.clientSecret))) {
    if (auth.via === "basic") res.setHeader("WWW-Authenticate", 'Basic realm="ptd"');
    fail(res, 401, "invalid_client", "Client authentication failed");
    return null;
  }
  return client;
}

export async function handleToken(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = str(body.grant_type);
  if (!grantType) return fail(res, 400, "invalid_request", "grant_type is required");
  if (grantType === "authorization_code") return authorizationCodeGrant(req, res, body);
  if (grantType === "refresh_token") return refreshTokenGrant(req, res, body);
  return fail(res, 400, "unsupported_grant_type", `grant_type must be authorization_code or refresh_token (got ${grantType})`);
}

async function authorizationCodeGrant(req: Request, res: Response, body: Record<string, unknown>) {
  const code = str(body.code);
  const verifier = str(body.code_verifier);
  if (!code) return fail(res, 400, "invalid_request", "code is required");
  if (!verifier) return fail(res, 400, "invalid_request", "code_verifier is required (PKCE is mandatory)");

  const auth = parseClientAuth(req.header("Authorization"), body);
  const client = await requireClient(res, auth);
  if (!client) return;

  const row = await getCode(code);
  if (!row) return fail(res, 400, "invalid_grant", "Unknown or already discarded authorization code");
  if (!safeEqual(row.clientId, client.clientId)) {
    return fail(res, 400, "invalid_grant", "This authorization code was issued to a different client");
  }

  const state = codeState(row);
  if (state === "used") {
    const revoked = await revokeCodeLineage(row.id);
    return fail(
      res, 400, "invalid_grant",
      `Authorization code already used — every token issued from it has been revoked (${revoked.accessRevoked} access, ${revoked.refreshRevoked} refresh)`
    );
  }
  if (state === "expired") return fail(res, 400, "invalid_grant", "Authorization code has expired (they live 10 minutes)");

  const suppliedRedirect = str(body.redirect_uri);
  if (suppliedRedirect === undefined) return fail(res, 400, "invalid_request", "redirect_uri is required");
  if (!safeEqual(suppliedRedirect, row.redirectUri)) {
    return fail(res, 400, "invalid_grant", "redirect_uri does not match the one the code was issued for");
  }
  if (!verifyPkce(verifier, row.codeChallenge, row.codeChallengeMethod)) {
    return fail(res, 400, "invalid_grant", "code_verifier does not match the code_challenge");
  }
  if (!(await claimCode(row.id))) {
    return fail(res, 400, "invalid_grant", "Authorization code has just been redeemed by another request");
  }
  const role = await membershipRole(row.userId, row.orgId);
  if (!role) return fail(res, 400, "invalid_grant", "The approving user is no longer a member of that organization");

  const grant = await issueGrant({
    userId: row.userId, orgId: row.orgId, clientId: client.clientId,
    clientName: client.clientName, scope: row.scope, codeId: row.id,
  });
  res.json({
    access_token: grant.accessToken,
    token_type: "Bearer",
    expires_in: grant.expiresIn,
    refresh_token: grant.refreshToken,
    scope: row.scope,
  });
}

async function refreshTokenGrant(req: Request, res: Response, body: Record<string, unknown>) {
  const token = str(body.refresh_token);
  if (!token) return fail(res, 400, "invalid_request", "refresh_token is required");

  const row = await findRefresh(token);
  if (!row) return fail(res, 400, "invalid_grant", "Unknown refresh token");

  const auth = parseClientAuth(req.header("Authorization"), body);
  // A public client may omit client_id on refresh; when it sends one it must match.
  const client = await requireClient(res, { ...auth, clientId: auth.clientId ?? row.clientId }, row.clientId);
  if (!client) return;

  if (row.revokedAt) {
    const revoked = await revokeCodeLineage(row.codeId);
    return fail(
      res, 400, "invalid_grant",
      `Refresh token has already been rotated or revoked — the whole grant has been revoked (${revoked.accessRevoked} access, ${revoked.refreshRevoked} refresh)`
    );
  }
  if (new Date(row.expiresAt).getTime() <= Date.now()) {
    return fail(res, 400, "invalid_grant", "Refresh token has expired (they live 30 days) — start a new authorization");
  }
  const role = await membershipRole(row.userId, row.orgId);
  if (!role) return fail(res, 400, "invalid_grant", "The approving user is no longer a member of that organization");

  await retireRefresh(row);
  const grant = await issueGrant({
    userId: row.userId, orgId: row.orgId, clientId: row.clientId,
    clientName: client.clientName, scope: row.scope, codeId: row.codeId,
  });
  res.json({
    access_token: grant.accessToken,
    token_type: "Bearer",
    expires_in: grant.expiresIn,
    refresh_token: grant.refreshToken,
    scope: row.scope,
  });
}

/**
 * RFC 7009. The token itself is the proof of possession, so a public client can
 * revoke without authenticating; an unknown token is still a 200, so this cannot
 * be used to probe which tokens exist.
 */
export async function handleRevoke(req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  const body = (req.body ?? {}) as Record<string, unknown>;
  const token = str(body.token);
  if (!token) return fail(res, 400, "invalid_request", "token is required");

  const auth = parseClientAuth(req.header("Authorization"), body);
  const hint = str(body.token_type_hint);
  const order: ("refresh_token" | "access_token")[] =
    hint === "access_token" ? ["access_token", "refresh_token"] : ["refresh_token", "access_token"];

  for (const kind of order) {
    const result =
      kind === "refresh_token"
        ? await revokeRefreshToken(token, auth.clientId)
        : await revokeAccessToken(token, auth.clientId);
    if (result.revoked) return res.status(200).json({ revoked: true, token_type: kind });
  }
  // Unknown, already-revoked, or someone else's token: indistinguishable on purpose.
  res.status(200).json({ revoked: false });
}
