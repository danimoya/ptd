/**
 * The four unauthenticated calls the door makes.
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

export const signIn = (email: string, password: string) => post<CredentialResult>("/api/auth/login", { email, password });

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
