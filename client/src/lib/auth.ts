// Client-side auth helpers — JWT expiry, sign-out, 401 interceptor.

interface JwtPayload {
  id: number;
  iat?: number;
  exp?: number;
}

function base64urlDecode(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  try {
    return atob(s);
  } catch {
    return "";
  }
}

/** Parse a JWT without verifying signature. Returns null on malformed tokens. */
export function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64urlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

/** true if the token is absent, malformed, or past its `exp`. */
export function isTokenExpired(): boolean {
  const token = localStorage.getItem("token");
  if (!token) return true;
  const payload = decodeJwt(token);
  if (!payload) return true;
  if (!payload.exp) return false;
  // exp is seconds since epoch
  return payload.exp * 1000 <= Date.now();
}

/** Seconds until expiry (negative if expired). */
export function secondsUntilExpiry(): number | null {
  const token = localStorage.getItem("token");
  if (!token) return null;
  const payload = decodeJwt(token);
  if (!payload?.exp) return null;
  return Math.floor((payload.exp * 1000 - Date.now()) / 1000);
}

/** Current signed-in email, decoded from the token metadata if we stored it. */
export function currentUserEmail(): string | null {
  return localStorage.getItem("userEmail");
}

/** Sign out: clear token, remember-me state, and workspace selection. */
export function signOut(redirect = true) {
  localStorage.removeItem("token");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("orgId");
  if (redirect) {
    window.location.href = "/auth";
  }
}

/** Requests whose 401 is an expected answer (e.g. testing a pasted agent token against /mcp). */
function isProbeRequest(input: RequestInfo | URL): boolean {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url, window.location.origin).pathname === "/mcp";
  } catch {
    return false;
  }
}

/**
 * Where a member is sent when their organization requires a second factor.
 *
 * The sign-in page, not the Org tab: /org is admin-only, and everything it reads
 * is refused by the very rule that sent them there. This page needs nothing but
 * the account surface, so it works for every role.
 */
export const SECURITY_SETUP_PATH = "/auth?setup=2fa";

/**
 * A 403 the app can act on rather than report: the organization requires 2FA and
 * this account does not have it. The session is perfectly valid — every
 * account-scoped call still works — so the token is *not* cleared; the person is
 * taken to the page that fixes it. Already being on that page is left alone —
 * anything else would reload it forever.
 */
async function isTotpRequired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body?.error === "totp_required";
  } catch {
    return false;
  }
}

/**
 * Global fetch wrapper: clears the token and redirects on 401, and steers a
 * `totp_required` 403 to the setup page.
 * Wrap `window.fetch` once at boot so every API call benefits.
 */
export function installAuthInterceptor() {
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await original(...args);
    if (res.status === 401 && !isProbeRequest(args[0])) {
      // Only clear + redirect when we actually had a token — otherwise the
      // /auth page itself would loop.
      if (localStorage.getItem("token")) {
        signOut(false);
        if (!window.location.pathname.startsWith("/auth")) {
          window.location.href = "/auth";
        }
      }
      return res;
    }
    const here = `${window.location.pathname}${window.location.search}`;
    if (localStorage.getItem("token") && here !== SECURITY_SETUP_PATH && (await isTotpRequired(res))) {
      window.location.href = SECURITY_SETUP_PATH;
    }
    return res;
  };
}
