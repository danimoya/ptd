/**
 * Wiring for the OAuth 2.1 authorization server that lets Claude.ai and ChatGPT
 * connectors attach to PTD's MCP endpoint without anyone pasting a token:
 *
 *   1. POST /mcp with no token            → 401 + WWW-Authenticate (see server/mcp.ts)
 *   2. GET  /.well-known/oauth-protected-resource   → this resource, its auth server
 *   3. GET  /.well-known/oauth-authorization-server → endpoints, PKCE, grants
 *   4. POST /oauth/register               → the client registers itself (RFC 7591)
 *   5. GET  /oauth/authorize              → consent screen, user approves an org
 *   6. POST /oauth/token                  → code + verifier → ptd_ access token
 *   7. POST /mcp with that token          → tools, gated by the membership role
 *
 * The metadata and token endpoints answer CORS preflight because browser-based
 * MCP clients fetch them straight from the page; the consent screen is
 * same-origin and deliberately does not.
 */
import type { Express, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { auth } from "../auth";
import { heavyLimiter } from "../rate-limit";
import { corsHeaders } from "../discovery";
import { handleAuthorize, handleClientInfo, handleDecision } from "./authorize";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata";
import { handleRegister } from "./register";
import { handleRevoke, handleToken } from "./token";

/** Public, unauthenticated, cacheable-by-nobody: the classic metadata CORS shape. */
function cors(req: Request, res: Response, next: NextFunction) {
  corsHeaders(res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

/**
 * 60 a minute per IP on the two endpoints anyone can reach without a credential.
 *
 * `authLimiter`'s 20-per-15-minutes is right for a login form and wrong here: a
 * connector legitimately posts to /oauth/token on every refresh, and several people
 * behind one office NAT would trip it. 60/min still turns a code-guessing or
 * registration-spam loop into a pointless exercise, and the endpoints answer with
 * OAuth's own JSON error shape rather than express-rate-limit's default.
 */
const oauthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "temporarily_unavailable", error_description: "Too many requests. Try again in a minute." },
});

export function registerOAuthRoutes(app: Express) {
  /* ── discovery (RFC 9728 + RFC 8414) ── */
  const resourceMetadata = (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata(req));
  };
  // Both the bare document and the resource-path-suffixed form clients derive
  // from the MCP URL (…/oauth-protected-resource/mcp).
  app.options(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], cors);
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], cors, resourceMetadata);

  app.options("/.well-known/oauth-authorization-server", cors);
  app.get("/.well-known/oauth-authorization-server", cors, (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(authorizationServerMetadata(req));
  });

  /* ── dynamic client registration (RFC 7591) ── */
  app.options("/oauth/register", cors);
  // Both limiters: registration keeps its stricter 10/min, and the 60/min layer is
  // there so the two open endpoints answer the same way when someone hammers them.
  app.post("/oauth/register", cors, oauthLimiter, heavyLimiter, handleRegister);

  /* ── authorization endpoint + the SPA consent screen's own API ── */
  app.get("/oauth/authorize", handleAuthorize);
  app.get("/oauth/client-info", cors, handleClientInfo);
  app.post("/oauth/authorize/decision", auth, handleDecision);

  /* ── token + revocation (RFC 6749 §4.1.3 / §6, RFC 7009) ── */
  app.options("/oauth/token", cors);
  app.post("/oauth/token", cors, oauthLimiter, handleToken);
  app.options("/oauth/revoke", cors);
  app.post("/oauth/revoke", cors, oauthLimiter, handleRevoke);
}
