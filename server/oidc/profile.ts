/**
 * Code → token → profile, per provider, over `fetch`.
 *
 * No OIDC library: the authorization-code exchange is one form POST and the
 * profile is one GET, and the three providers differ only in which field holds
 * the address. What a library would add here is a dependency in the sign-in path
 * — the one place where an unaudited transitive package is least welcome.
 *
 * The ID token is deliberately *not* trusted for identity. We read the profile
 * from the userinfo endpoint over TLS with the access token we just obtained, so
 * there is no JWKS to fetch, cache, rotate or mis-verify.
 */
import type { ProviderConfig } from "./providers";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OidcError extends Error {
  constructor(
    readonly code: "token_exchange_failed" | "profile_failed" | "email_unverified" | "no_email",
    message: string,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export interface OidcProfile {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

const UA = "ptd-oidc/1 (fetch)";

export async function exchangeCode(
  cfg: ProviderConfig,
  input: { code: string; redirectUri: string; verifier?: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  if (cfg.pkce && input.verifier) body.set("code_verifier", input.verifier);

  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // GitHub answers form-encoded unless asked for JSON; accept that shape too.
    parsed = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || typeof parsed.access_token !== "string" || !parsed.access_token) {
    const detail = typeof parsed.error_description === "string" ? parsed.error_description : typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new OidcError("token_exchange_failed", `${cfg.label} refused the authorization code: ${detail}`);
  }
  return parsed.access_token;
}

async function getJson(url: string, accessToken: string, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) throw new OidcError("profile_failed", `Profile request failed with HTTP ${res.status}`);
  return res.json();
}

export async function fetchProfile(cfg: ProviderConfig, accessToken: string, fetchImpl: FetchLike = fetch): Promise<OidcProfile> {
  const raw = (await getJson(cfg.userinfoUrl, accessToken, fetchImpl)) as Record<string, unknown>;

  if (cfg.provider === "google") {
    const subject = String(raw.sub ?? "");
    if (!subject) throw new OidcError("profile_failed", "Google returned no subject");
    return {
      subject,
      email: typeof raw.email === "string" ? raw.email.toLowerCase() : null,
      // Google sends a boolean; some tenants send the string "true".
      emailVerified: raw.email_verified === true || raw.email_verified === "true",
      displayName: typeof raw.name === "string" ? raw.name : null,
    };
  }

  if (cfg.provider === "microsoft") {
    const subject = String(raw.id ?? "");
    if (!subject) throw new OidcError("profile_failed", "Microsoft Graph returned no id");
    const mail = typeof raw.mail === "string" && raw.mail ? raw.mail : typeof raw.userPrincipalName === "string" ? raw.userPrincipalName : null;
    return {
      subject,
      email: mail ? mail.toLowerCase() : null,
      // Graph exposes no verification flag: a work, school or personal account's
      // address is the one the tenant or Microsoft itself already owns, so it is
      // treated as verified. Documented in docs/security.md.
      emailVerified: Boolean(mail),
      displayName: typeof raw.displayName === "string" ? raw.displayName : null,
    };
  }

  // GitHub: the id is the stable subject (the login can be renamed), and the
  // address comes from /user/emails, because a user who hides it in the profile
  // still has a primary verified one.
  const subject = raw.id !== undefined && raw.id !== null ? String(raw.id) : "";
  if (!subject) throw new OidcError("profile_failed", "GitHub returned no id");
  const displayName = typeof raw.name === "string" && raw.name ? raw.name : typeof raw.login === "string" ? raw.login : null;
  let email = typeof raw.email === "string" && raw.email ? raw.email.toLowerCase() : null;
  let verified = false;

  if (cfg.emailsUrl) {
    try {
      const list = (await getJson(cfg.emailsUrl, accessToken, fetchImpl)) as { email?: string; primary?: boolean; verified?: boolean }[];
      if (Array.isArray(list)) {
        const primary = list.find((e) => e.primary === true && e.verified === true) ?? list.find((e) => e.verified === true);
        if (primary?.email) {
          email = primary.email.toLowerCase();
          verified = true;
        }
      }
    } catch {
      // Scope refused or endpoint unreachable: fall through with what /user gave,
      // which then fails the verified-email check rather than trusting it.
    }
  }
  return { subject, email, emailVerified: verified, displayName };
}
