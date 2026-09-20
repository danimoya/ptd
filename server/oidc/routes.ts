/**
 * The OIDC sign-in surface: four routes, registered from `registerAuthRoutes`.
 *
 *   GET  /api/auth/providers                 which buttons the door should show
 *   GET  /api/auth/oidc/:provider/start      → the provider, with state + PKCE
 *   GET  /api/auth/oidc/:provider/callback   ← the provider, then → /auth?oidc=…
 *   POST /api/auth/oidc/exchange             the code for the session token
 *
 * No token ever appears in a URL. The callback can only redirect (the browser
 * arrives by navigation, so there is nothing to answer with), and a JWT in a
 * redirect would be written to browser history, the proxy access log and any
 * Referer sent by the next page. So the callback hands over a two-minute,
 * single-use code and the SPA posts it back for the real thing.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { audit } from "../audit/log";
import { authLimiter } from "../rate-limit";
import { validate } from "../validation";
import { baseUrl } from "../discovery";
import { signPurposeJwt, signSessionJwt, PRE_AUTH_TTL_SECONDS } from "../auth/jwt";
import { configuredProviders, isOidcProvider, providerConfig, redirectUri, type OidcProvider } from "./providers";
import { consumeFlow, decodeState, encodeState, mintHandoff, redeemHandoff, safeRedirect, startFlow } from "./state";
import { exchangeCode, fetchProfile, OidcError, type FetchLike } from "./profile";
import { LinkError, resolveOidcLogin } from "./link";

function authPage(base: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${base}/auth?${query}`;
}

const exchangeSchema = z.object({ code: z.string().min(8).max(200) });

export interface OidcDeps {
  /** Injectable so tests drive a stub IdP without a network. */
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export function registerOidcRoutes(app: Express, deps: OidcDeps = {}) {
  const env = () => deps.env ?? process.env;
  const fetcher = () => deps.fetchImpl ?? fetch;

  app.get("/api/auth/providers", (req: Request, res: Response) => {
    res.json({ providers: configuredProviders(env()), passwordLogin: true });
  });

  app.get("/api/auth/oidc/:provider/start", authLimiter, (req: Request, res: Response) => {
    const provider = req.params.provider;
    if (!isOidcProvider(provider)) return res.status(404).json({ error: "unknown_provider" });
    const cfg = providerConfig(provider, env());
    // An unconfigured provider is not advertised, so reaching this is either a
    // stale bookmark or a probe. Both get the same flat answer.
    if (!cfg) return res.status(404).json({ error: "provider_not_configured", message: `${provider} sign-in is not configured on this deployment` });

    const base = baseUrl(req);
    const flow = startFlow(provider, cfg.pkce);
    const state = encodeState({
      nonce: flow.nonce,
      provider,
      redirectTo: safeRedirect(req.query.redirectTo),
      inviteToken: typeof req.query.inviteToken === "string" ? req.query.inviteToken.slice(0, 64) : undefined,
      issuedAt: Date.now(),
    });

    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", redirectUri(provider, base, env()));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", cfg.scope);
    url.searchParams.set("state", state);
    if (flow.challenge) {
      url.searchParams.set("code_challenge", flow.challenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    // Google will not re-prompt without it, which makes switching accounts
    // impossible on a shared machine.
    if (provider === "google") url.searchParams.set("prompt", "select_account");
    res.redirect(url.toString());
  });

  app.get("/api/auth/oidc/:provider/callback", async (req: Request, res: Response) => {
    const provider = req.params.provider;
    const base = baseUrl(req);
    const fail = (code: string, redirectTo = "/") =>
      res.redirect(authPage(base, { oidc_error: code, ...(redirectTo !== "/" ? { redirectTo } : {}) }));

    if (!isOidcProvider(provider)) return fail("unknown_provider");
    const cfg = providerConfig(provider, env());
    if (!cfg) return fail("provider_not_configured");

    const state = decodeState(String(req.query.state ?? ""));
    if (!state) return fail("bad_state");
    const flow = consumeFlow(state.nonce, provider);
    if (!flow) return fail("expired_state", state.redirectTo);

    if (typeof req.query.error === "string") {
      // The person pressed "cancel" at the provider, or it refused consent.
      return fail(req.query.error === "access_denied" ? "cancelled" : "provider_error", state.redirectTo);
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return fail("no_code", state.redirectTo);

    try {
      const accessToken = await exchangeCode(
        cfg,
        { code, redirectUri: redirectUri(provider, base, env()), verifier: flow.verifier },
        fetcher(),
      );
      const profile = await fetchProfile(cfg, accessToken, fetcher());
      const outcome = await resolveOidcLogin({ provider, profile, inviteToken: state.inviteToken });
      const user = outcome.user;

      if (user.isAgent) {
        // An agent seat authenticates with a bearer token, never interactively.
        return fail("agent_account", state.redirectTo);
      }

      if (outcome.created) audit(req, "oidc.signup", user.email, { provider, orgId: outcome.orgId });
      else if (outcome.linked) audit({ orgId: outcome.orgId, userId: user.id, label: `${user.displayName} <${user.email}>` }, "oidc.linked", user.email, { provider });

      if (user.totpEnabled) {
        const handoff = mintHandoff({
          kind: "mfa",
          preAuthToken: signPurposeJwt(user.id, "mfa"),
          email: user.email,
          provider,
        });
        audit({ orgId: outcome.orgId, userId: user.id, label: `${user.displayName} <${user.email}>` }, "auth.mfa_required", user.email, { provider, via: "oidc" });
        return res.redirect(authPage(base, { oidc: handoff, ...(state.redirectTo !== "/" ? { redirectTo: state.redirectTo } : {}) }));
      }

      audit({ orgId: outcome.orgId, userId: user.id, label: `${user.displayName} <${user.email}>` }, "oidc.login", user.email, {
        provider,
        created: outcome.created,
        linked: outcome.linked,
      });
      const handoff = mintHandoff({
        kind: "session",
        token: signSessionJwt(user.id),
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        orgId: outcome.orgId,
        created: outcome.created,
        linked: outcome.linked,
        provider,
      });
      res.redirect(authPage(base, { oidc: handoff, ...(state.redirectTo !== "/" ? { redirectTo: state.redirectTo } : {}) }));
    } catch (err) {
      if (err instanceof LinkError) return fail(err.code, state.redirectTo);
      if (err instanceof OidcError) return fail(err.code, state.redirectTo);
      console.error(`[oidc ${provider}] callback failed:`, err);
      fail("internal", state.redirectTo);
    }
  });

  /** Trade the one-time code for the session token, or for the 2FA challenge. */
  app.post("/api/auth/oidc/exchange", authLimiter, validate(exchangeSchema), async (req: Request, res: Response) => {
    const payload = redeemHandoff((req.body as z.infer<typeof exchangeSchema>).code);
    if (!payload) return res.status(400).json({ error: "invalid_code", message: "That sign-in has expired — start again." });

    if (payload.kind === "mfa") {
      return res.json({
        mfaRequired: true,
        preAuthToken: payload.preAuthToken,
        expiresInSeconds: PRE_AUTH_TTL_SECONDS,
        email: payload.email,
        provider: payload.provider,
      });
    }

    const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
    if (!user) return res.status(400).json({ error: "invalid_code" });
    const { passwordHash: _pw, totpSecretSealed: _s, recoveryCodesSealed: _r, ...safe } = user;
    res.json({
      token: payload.token,
      user: safe,
      orgId: payload.orgId,
      provider: payload.provider,
      created: payload.created,
      linked: payload.linked,
    });
  });
}

export { safeRedirect };
export type { OidcProvider };
