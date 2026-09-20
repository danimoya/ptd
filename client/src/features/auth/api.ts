/**
 * The unauthenticated calls the door makes.
 *
 * Deliberately not routed through `lib/api.ts`: that helper attaches the stored
 * JWT and the org header, and every call here happens either before there is a
 * token or in the moments around minting one. The only exception is
 * `acceptInvitation`, which takes the freshly minted token as an argument rather
 * than reading it back out of localStorage — the caller has it in hand, and
 * reading it back is one more thing that can go stale.
 */

export interface InviteInfo {
  orgName: string;
  role: string;
  email: string;
  expired: boolean;
  accepted: boolean;
  expiresAt: string;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.message || data.error || `HTTP ${res.status}`));
  return data as T;
}

/**
 * What an `?invite=` token is for. Returns null for anything the server will not
 * vouch for, so the page can simply not mention an invitation rather than showing
 * an error for a link somebody mistyped.
 */
export async function lookupInvitation(token: string): Promise<InviteInfo | null> {
  try {
    const res = await fetch(`/api/invitations/${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    return (await res.json()) as InviteInfo;
  } catch {
    return null;
  }
}

export const acceptInvitation = (token: string, jwt: string) =>
  post<{ orgId: number; role: string }>("/api/invitations/accept", { token }, jwt);

export const forgotPassword = (email: string) =>
  post<{ ok: true; message: string; resetUrl?: string }>("/api/auth/forgot", { email });

export const resetPassword = (token: string, password: string) =>
  post<{ ok: true; token: string; user?: { email: string } }>("/api/auth/reset", { token, password });

export interface CredentialResult {
  token: string;
  user?: { email?: string };
}

/**
 * What a correct password gets when the account has 2FA on: no session, a
 * five-minute token, and a second step to take. It arrives as a 200 — the
 * password *was* right — so the caller must branch on the shape rather than on
 * the status code.
 */
export interface MfaChallenge {
  mfaRequired: true;
  preAuthToken: string;
  expiresInSeconds: number;
  email?: string;
  provider?: string;
}

export type SignInResult = CredentialResult | MfaChallenge;

export function isMfaChallenge(result: SignInResult | OidcExchange): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

export const signIn = (email: string, password: string) => post<SignInResult>("/api/auth/login", { email, password });

/** Step two: the pre-auth token plus either a live code or one recovery code. */
export const totpLogin = (input: { preAuthToken: string; code?: string; recoveryCode?: string }) =>
  post<{ token: string; user?: { email?: string }; usedRecoveryCode: boolean; recoveryCodesLeft: number }>(
    "/api/auth/totp/login",
    input,
  );

export interface ProviderSummary {
  provider: "google" | "github" | "microsoft";
  label: string;
  startUrl: string;
}

/**
 * Which sign-in providers this deployment has configured. An operator who set
 * none gets no buttons at all rather than three that lead to a 404, so the door
 * describes the deployment it is standing in.
 */
export async function getProviders(): Promise<ProviderSummary[]> {
  try {
    const res = await fetch("/api/auth/providers");
    if (!res.ok) return [];
    const body = (await res.json()) as { providers?: ProviderSummary[] };
    return Array.isArray(body.providers) ? body.providers : [];
  } catch {
    return [];
  }
}

/** Where the button points. `redirectTo` and an invitation survive the round trip. */
export function oidcStartUrl(provider: string, opts: { redirectTo?: string; inviteToken?: string } = {}): string {
  const params = new URLSearchParams();
  if (opts.redirectTo) params.set("redirectTo", opts.redirectTo);
  if (opts.inviteToken) params.set("inviteToken", opts.inviteToken);
  const query = params.toString();
  return `/api/auth/oidc/${provider}/start${query ? `?${query}` : ""}`;
}

export interface OidcSession {
  token: string;
  user?: { email?: string };
  orgId?: number | null;
  provider?: string;
  created?: boolean;
  linked?: boolean;
}

export type OidcExchange = OidcSession | MfaChallenge;

/**
 * Trade the one-time code the callback put in the URL for the session token. The
 * token itself is never in the URL — that is the whole point of the code — so
 * this POST is what actually signs the person in.
 */
export const exchangeOidc = (code: string) => post<OidcExchange>("/api/auth/oidc/exchange", { code });

/** What the callback says when it could not finish. Anything else is a bug worth showing raw. */
export const OIDC_ERRORS: Record<string, string> = {
  cancelled: "That sign-in was cancelled at the provider.",
  email_unverified:
    "The provider did not confirm that email address, so PTD will not attach it to an account. Verify the address with the provider, then try again.",
  no_email: "That account has no email address PTD can use. Add one at the provider, or sign in with a password.",
  agent_account: "That address belongs to an agent seat, which signs in with a token rather than interactively.",
  provider_not_configured: "That provider is not configured on this deployment.",
  unknown_provider: "That provider is not one PTD knows.",
  bad_state: "That sign-in could not be verified. Start again from this page.",
  expired_state: "That sign-in took too long, or the link was reused. Start again.",
  no_code: "The provider came back without an authorization code.",
  token_exchange_failed: "The provider refused the authorization code.",
  profile_failed: "The provider would not say who you are.",
  plan_limit: "That organization is at its plan's member limit.",
  provider_error: "The provider refused the sign-in.",
  internal: "Something went wrong on our side. The details are in the server log.",
};

export const signUp = (input: { email: string; password: string; displayName?: string; orgName?: string }) =>
  post<CredentialResult>("/api/auth/register", input);

/** Store what a signed-in session needs, the way `lib/auth.ts` expects to find it. */
export function keepSession(token: string, email?: string, orgId?: number) {
  localStorage.setItem("token", token);
  if (email) localStorage.setItem("userEmail", email);
  // An invited member's *own* organization is usually the older membership, so
  // without this the accepted org is not the one they land in.
  if (orgId !== undefined) localStorage.setItem("orgId", String(orgId));
}

/* ── The second-factor setup the door itself can run ─────────────────────
 * Reached as /auth?setup=2fa, which is where an organization that requires 2FA
 * sends a member who does not have it yet. These three calls need the session
 * token, so they go through `api()` rather than the unauthenticated `post()`
 * above; none of them touches an organization, which is the point — the caller
 * is being refused everywhere that does.
 */
export interface TotpEnrolment {
  secret: string;
  uri: string;
  qrSvg: string;
  digits: number;
  period: number;
  account: string;
}

/**
 * The session token, read at call time. Not `lib/api`'s helper: that one reports
 * `body.error` in preference to `body.message`, which would show a member
 * "bad_code" where the server wrote "That code is not right. Check the clock on
 * your phone and try the next one."
 */
function session(): string | null {
  try {
    return localStorage.getItem("token");
  } catch {
    return null;
  }
}

async function authed<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = session();
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.message || data.error || `HTTP ${res.status}`));
  return data as T;
}

export const beginTotpEnrolment = () => authed<TotpEnrolment>("/api/auth/totp/setup", { method: "POST" });

export const finishTotpEnrolment = (code: string) =>
  authed<{ enabled: true; recoveryCodes: string[] }>("/api/auth/totp/verify", { method: "POST", body: JSON.stringify({ code }) });

export interface AccountSecurity {
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  blocked: boolean;
  orgs: { orgId: number; name: string; role: string; requireTotp: boolean }[];
}

export const getAccountSecurity = () => authed<AccountSecurity>("/api/auth/security");
