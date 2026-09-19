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
import { auth } from "../auth";
import { heavyLimiter } from "../rate-limit";
import { handleAuthorize, handleClientInfo, handleDecision } from "./authorize";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata";
import { handleRegister } from "./register";
import { handleRevoke, handleToken } from "./token";

/** Public, unauthenticated, cacheable-by-nobody: the classic metadata CORS shape. */
function allowCors(res: Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function cors(req: Request, res: Response, next: NextFunction) {
  allowCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
}

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
  app.post("/oauth/register", cors, heavyLimiter, handleRegister);

  /* ── authorization endpoint + the SPA consent screen's own API ── */
  app.get("/oauth/authorize", handleAuthorize);
  app.get("/oauth/client-info", cors, handleClientInfo);
  app.post("/oauth/authorize/decision", auth, handleDecision);

  /* ── token + revocation (RFC 6749 §4.1.3 / §6, RFC 7009) ── */
  app.options("/oauth/token", cors);
  app.post("/oauth/token", cors, handleToken);
  app.options("/oauth/revoke", cors);
  app.post("/oauth/revoke", cors, handleRevoke);
}
