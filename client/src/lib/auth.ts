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

/**
 * Global fetch wrapper: clears the token and redirects on 401.
 * Wrap `window.fetch` once at boot so every API call benefits.
 */
export function installAuthInterceptor() {
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await original(...args);
    if (res.status === 401) {
      // Only clear + redirect when we actually had a token — otherwise the
      // /auth page itself would loop.
      if (localStorage.getItem("token")) {
        signOut(false);
        if (!window.location.pathname.startsWith("/auth")) {
          window.location.href = "/auth";
        }
      }
    }
    return res;
  };
}
