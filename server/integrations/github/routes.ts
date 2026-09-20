import type { Express, Request, Response } from "express";
import { auth } from "../../auth";
import { requireRole, resolveOrg } from "../../orgs";
import type { OrgRequest } from "../../types";
import { mountRawBodyCapture, rawBodyOf } from "../shared/rawBody";
import { signState, verifyState, STATE_TTL_MS } from "../shared/state";
import {
  GITHUB_BASE_PATH,
  GITHUB_EVENTS,
  GITHUB_PERMISSIONS,
  githubAppEnv,
  githubSetupUrl,
  githubWebhookUrl,
  installUrl,
  integrationsTabUrl,
  isGithubAppConfigured,
  missingGithubEnv,
} from "./config";
import { readInstallation } from "./api";
import { handleGithubDelivery } from "./inbound";
import { getGithubForInstallation, saveGithubInstall, webhookSecretOf } from "./store";
import { GITHUB_DELIVERY_HEADER, GITHUB_EVENT_HEADER, GITHUB_SIGNATURE_HEADER, VERIFY_MESSAGES, verifyGithubRequest } from "./verify";

/**
 * HTTP surface of the GitHub adapter. `registerGithubRoutes(app)` is the only export
 * the rest of the server needs.
 *
 *   POST /api/integrations/github/install-url   ← admin with a JWT, returns the URL
 *   GET  /api/integrations/github/install       ← admin with a JWT, 302 to GitHub
 *   GET  /api/integrations/github/setup         ← GitHub's post-install redirect (state-signed)
 *   POST /api/integrations/github/webhook       ← GitHub (signed, unauthenticated)
 */

export const GITHUB_STATE_PURPOSE = "github-install-state";

export function registerGithubRoutes(app: Express): void {
  // Must run before Express's global body parsers — see ../shared/rawBody.
  const placement = mountRawBodyCapture(app, GITHUB_BASE_PATH, "githubRawBodyCapture");
  if (placement === "appended") {
    console.warn("[github] raw-body capture could not be placed before the body parsers; webhook signatures may not verify");
  }

  app.post(`${GITHUB_BASE_PATH}/install-url`, auth, resolveOrg, requireRole("admin"), (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const appEnv = githubAppEnv();
    if (!isGithubAppConfigured(appEnv)) {
      return res.status(503).json({
        error: "github_not_configured",
        message: `GitHub app not configured on this server (${missingGithubEnv(appEnv).join(" / ")})`,
      });
    }
    const state = signState(GITHUB_STATE_PURPOSE, { orgId: r.org.id, userId: r.user[0].id });
    res.json({
      url: installUrl({ slug: appEnv.slug, state }),
      slug: appEnv.slug,
      webhookUrl: githubWebhookUrl(req),
      // Both URLs are configured on the App itself, not by PTD — showing them is how an
      // admin checks the App was set up to point back here.
      setupUrl: githubSetupUrl(req),
      permissions: GITHUB_PERMISSIONS,
      events: [...GITHUB_EVENTS],
      expiresInSeconds: Math.round(STATE_TTL_MS / 1000),
    });
  });

  app.get(`${GITHUB_BASE_PATH}/install`, auth, resolveOrg, requireRole("admin"), (req: Request, res: Response) => {
    const r = req as OrgRequest;
    const appEnv = githubAppEnv();
    if (!isGithubAppConfigured(appEnv)) {
      return res.status(503).json({ error: "github_not_configured", message: "GitHub app not configured on this server" });
    }
    const state = signState(GITHUB_STATE_PURPOSE, { orgId: r.org.id, userId: r.user[0].id });
    res.redirect(302, installUrl({ slug: appEnv.slug, state }));
  });

  /**
   * GitHub's post-install redirect carries no PTD session (it is a fresh browser
   * navigation), so the signed `state` is what proves which organization asked for the
   * install — exactly as in the Slack OAuth callback.
   */
  app.get(`${GITHUB_BASE_PATH}/setup`, async (req: Request, res: Response) => {
    const installationId = Number(typeof req.query.installation_id === "string" ? req.query.installation_id : NaN);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!Number.isFinite(installationId) || installationId <= 0) {
      return res.redirect(302, integrationsTabUrl("error", "missing_installation_id"));
    }
    const checked = verifyState(GITHUB_STATE_PURPOSE, state);
    if (!checked.ok) return res.redirect(302, integrationsTabUrl("error", `state_${checked.reason}`));

    // A failed read is not fatal: the installation id is what PTD actually needs, and
    // the account is only there so the card can say what it was installed on.
    const info = await readInstallation(installationId).catch(() => ({ ok: false as const, error: "read_failed" }));
    try {
      await saveGithubInstall(checked.payload.orgId, checked.payload.userId, {
        installationId,
        account: info.ok ? info.info.account : null,
      });
    } catch (err) {
      console.error("[github] could not store the install:", err);
      return res.redirect(302, integrationsTabUrl("error", "store_failed"));
    }
    res.redirect(302, integrationsTabUrl("connected"));
  });

  app.post(`${GITHUB_BASE_PATH}/webhook`, async (req: Request, res: Response) => {
    const raw = rawBodyOf(req);
    if (raw === null) {
      console.error("[github] webhook arrived without a raw body — the capture layer is not in front of the parsers");
      return res.status(400).json({ error: "raw_body_unavailable" });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return res.status(400).json({ error: "not_json" });
    }

    // Read-only lookup before verification: it only tells us which secret to try.
    const installationId = Number((body.installation as { id?: unknown } | undefined)?.id ?? NaN);
    const row = Number.isFinite(installationId) ? await getGithubForInstallation(installationId).catch(() => null) : null;
    const verified = verifyGithubRequest({
      rawBody: raw,
      signature: req.header(GITHUB_SIGNATURE_HEADER),
      secrets: [githubAppEnv().webhookSecret, row ? webhookSecretOf(row.config) : undefined],
    });
    if (!verified.ok) {
      const status = verified.reason === "no_secret" ? 503 : 401;
      return res.status(status).json({ error: verified.reason, message: VERIFY_MESSAGES[verified.reason] });
    }

    const event = req.header(GITHUB_EVENT_HEADER) ?? "";
    const deliveryId = req.header(GITHUB_DELIVERY_HEADER) ?? null;
    try {
      const outcome = await handleGithubDelivery({ event, deliveryId, body });
      // 202 either way: GitHub only needs to know the delivery was accepted, and an
      // unmapped repository is not an error worth turning red in its deliveries list.
      res.status(202).json(outcome);
    } catch (err) {
      console.error(`[github] webhook ${event} failed:`, err);
      res.status(202).json({ handled: false, reason: "error" });
    }
  });
}
