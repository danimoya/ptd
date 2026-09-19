/**
 * The authorization endpoint and the decision it hands to the consent page.
 *
 * GET /oauth/authorize validates everything that can be checked without a user
 * and then sends the browser to the SPA consent screen with the same query. The
 * screen signs the person in (or uses their existing session), lets them choose
 * the organization, shows the role they hold and the tools it unlocks, and posts
 * back to /oauth/authorize/decision — the only place an authorization code is
 * ever created, and only for an organization the caller is actually a member of.
 */
import type { Request, Response } from "express";
import { z } from "zod";
import { baseUrl } from "../discovery";
import type { AuthenticatedRequest } from "../types";
import { actionsFor } from "../actions";
import { resourceUri } from "./metadata";
import { isValidChallenge } from "./pkce";
import { createCode, getClient, membershipRole, orgName } from "./store";
import {
  CODE_CHALLENGE_METHODS_SUPPORTED, checkResource, matchRedirectUri, normalizeScope, normalizeState, redirectWith,
} from "./validate";

export const CONSENT_PATH = "/oauth/consent";

/** The authorize query, as strings, however the client spelled it. */
export interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

const str = (v: unknown): string | undefined => {
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" && v !== "" ? v : undefined;
};

export function readQuery(q: Record<string, unknown>): AuthorizeQuery {
  return {
    response_type: str(q.response_type),
    client_id: str(q.client_id),
    redirect_uri: str(q.redirect_uri),
    scope: str(q.scope),
    state: str(q.state),
    code_challenge: str(q.code_challenge),
    code_challenge_method: str(q.code_challenge_method),
    resource: str(q.resource),
  };
}

/** An error we may not redirect: the client or its redirect_uri is untrustworthy. */
function refuse(res: Response, status: number, error: string, description: string) {
  res.status(status);
  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
      `<body style="font:16px/1.6 ui-serif,Georgia,serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem">` +
      `<h1 style="font-size:1.4rem">Authorization request refused</h1>` +
      `<p><code>${escapeHtml(error)}</code></p><p>${escapeHtml(description)}</p>` +
      `<p style="color:#666;font-size:.9rem">Nothing was approved and no token was issued.</p></body>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Validates the request. Returns either a consent redirect, a redirect carrying
 * an OAuth error back to the client, or a refusal we must render ourselves.
 */
export async function handleAuthorize(req: Request, res: Response) {
  const q = readQuery(req.query as Record<string, unknown>);

  const client = await getClient(q.client_id);
  if (!client) return refuse(res, 400, "invalid_client", "Unknown client_id. Register the client at /oauth/register first.");

  const redirect = matchRedirectUri(client.redirectUris ?? [], q.redirect_uri);
  if (!redirect.ok) return refuse(res, 400, redirect.error, redirect.description);
  const redirectUri = redirect.value;
  const state = normalizeState(q.state);

  // From here the client's redirect_uri is trusted, so errors go back to it.
  const back = (error: string, description: string) =>
    res.redirect(302, redirectWith(redirectUri, { error, error_description: description, state }));

  if (q.response_type !== "code") {
    return back("unsupported_response_type", 'response_type must be "code" (authorization code with PKCE)');
  }
  if (!q.code_challenge_method || !CODE_CHALLENGE_METHODS_SUPPORTED.includes(q.code_challenge_method as "S256")) {
    return back("invalid_request", "code_challenge_method=S256 is mandatory");
  }
  if (!isValidChallenge(q.code_challenge)) {
    return back("invalid_request", "code_challenge must be 43–128 unreserved characters (base64url of the SHA-256 verifier)");
  }
  const scope = normalizeScope(q.scope);
  if (!scope.ok) return back(scope.error, scope.description);

  const resource = checkResource(q.resource, resourceUri(baseUrl(req)));
  if (!resource.ok) return back(resource.error, resource.description);

  const consent = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: redirectUri,
    scope: scope.value,
    code_challenge: q.code_challenge,
    code_challenge_method: "S256",
  });
  if (state) consent.set("state", state);
  if (resource.value) consent.set("resource", resource.value);
  res.redirect(302, `${CONSENT_PATH}?${consent.toString()}`);
}

/** Public, non-secret facts about a client, so the consent page can name it. */
export async function handleClientInfo(req: Request, res: Response) {
  const clientId = str((req.query as Record<string, unknown>).client_id);
  const client = await getClient(clientId);
  if (!client) return res.status(404).json({ error: "invalid_client", error_description: "Unknown client_id" });
  res.json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    confidential: client.clientSecretHash !== null,
    registered_at: client.createdAt,
  });
}

const decisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().max(500).optional(),
  response_type: z.string().max(40).optional(),
  scope: z.string().max(200).optional(),
  state: z.string().max(512).optional(),
  code_challenge: z.string().max(128).optional(),
  code_challenge_method: z.string().max(10).optional(),
  resource: z.string().max(500).optional(),
  orgId: z.number().int().positive(),
});

/**
 * POST /oauth/authorize/decision — behind `auth`, so the grant is always tied to
 * a real signed-in identity. Answers with the URL the page should navigate to;
 * the page never builds a callback URL itself.
 */
export async function handleDecision(req: Request, res: Response) {
  const parsed = decisionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", error_description: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
  }
  const body = parsed.data;
  const user = (req as AuthenticatedRequest).user[0];

  const client = await getClient(body.client_id);
  if (!client) return res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id" });

  const redirect = matchRedirectUri(client.redirectUris ?? [], body.redirect_uri);
  if (!redirect.ok) return res.status(400).json({ error: redirect.error, error_description: redirect.description });
  const redirectUri = redirect.value;
  const state = normalizeState(body.state);

  if (body.decision === "deny") {
    return res.json({
      decision: "deny",
      redirect: redirectWith(redirectUri, { error: "access_denied", error_description: "The user declined the authorization request", state }),
    });
  }

  if (body.response_type && body.response_type !== "code") {
    return res.status(400).json({ error: "unsupported_response_type", error_description: 'response_type must be "code"' });
  }
  if (body.code_challenge_method !== "S256" || !isValidChallenge(body.code_challenge)) {
    return res.status(400).json({ error: "invalid_request", error_description: "A valid S256 code_challenge is mandatory" });
  }
  const scope = normalizeScope(body.scope);
  if (!scope.ok) return res.status(400).json({ error: scope.error, error_description: scope.description });

  const resource = checkResource(body.resource, resourceUri(baseUrl(req)));
  if (!resource.ok) return res.status(400).json({ error: resource.error, error_description: resource.description });

  const role = await membershipRole(user.id, body.orgId);
  if (!role) return res.status(403).json({ error: "access_denied", error_description: "You are not a member of that organization" });

  const { code, expiresAt } = await createCode({
    clientId: client.clientId,
    userId: user.id,
    orgId: body.orgId,
    redirectUri,
    scope: scope.value,
    codeChallenge: body.code_challenge!,
    codeChallengeMethod: "S256",
    resource: resource.value,
  });

  res.json({
    decision: "approve",
    redirect: redirectWith(redirectUri, { code, state }),
    expires_at: expiresAt,
    granted: {
      orgId: body.orgId,
      org: await orgName(body.orgId),
      role,
      scope: scope.value,
      client_name: client.clientName,
      tools: actionsFor(role).map((a) => a.name),
    },
  });
}
