import { callAction, getAuthHeader } from "@/lib/api";

export const SECURITY_KEY = ["/api/auth/security"] as const;
export const ORG_SECURITY_KEY = ["action", "org.security"] as const;

export interface IdentityRow {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  createdAt: string;
}

export interface SecurityState {
  totpEnabled: boolean;
  setupStarted: boolean;
  recoveryCodesLeft: number;
  identities: IdentityRow[];
  providers: { provider: string; label: string; startUrl: string }[];
  orgs: { orgId: number; name: string; role: string; requireTotp: boolean }[];
  blocked: boolean;
}

export interface Enrolment {
  secret: string;
  uri: string;
  qrSvg: string;
  digits: number;
  period: number;
  account: string;
}

/**
 * Everything on this tab that concerns *your* account goes to `/api/auth/**`,
 * not through the action registry — on purpose. An organization that requires 2FA
 * refuses org-scoped calls from members who do not have it yet, and the page they
 * are sent to must keep working. The org-wide policy below is the only part that
 * is org-scoped, and it is only ever touched by an admin who already has 2FA.
 */
/**
 * Like `lib/api`'s helper, except that it prefers the server's `message` to its
 * `error` code. Every refusal on this tab is something a person has to act on —
 * "That code is not right", "Turn it on for your own account first" — and a bare
 * `bad_code` in a toast helps nobody.
 */
async function authed<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { ...getAuthHeader(), ...(init.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.message || data.error || `HTTP ${res.status}`));
  return data as T;
}

export const getSecurity = () => authed<SecurityState>("/auth/security");
export const startTotpSetup = () => authed<Enrolment>("/auth/totp/setup", { method: "POST" });
export const confirmTotp = (code: string) =>
  authed<{ enabled: true; recoveryCodes: string[]; shownOnce: true }>("/auth/totp/verify", { method: "POST", body: JSON.stringify({ code }) });
export const disableTotp = (code: string) => authed<{ enabled: false }>("/auth/totp/disable", { method: "POST", body: JSON.stringify({ code }) });
export const newRecoveryCodes = (code: string) =>
  authed<{ recoveryCodes: string[]; shownOnce: true }>("/auth/totp/recovery-codes", { method: "POST", body: JSON.stringify({ code }) });
export const unlinkIdentity = (id: number, confirm = false) =>
  authed<{ unlinked: number; provider?: string }>(`/auth/identities/${id}${confirm ? "?confirm=1" : ""}`, { method: "DELETE" });

export interface OrgSecurityPolicy {
  requireTotp: boolean;
  updatedAt: string | null;
  updatedBy: number | null;
}

export const getOrgSecurity = () => callAction<OrgSecurityPolicy>("org.security", {});
export const setOrgSecurity = (requireTotp: boolean) =>
  callAction<{ requireTotp: boolean; updatedAt: string; changed: boolean }>("org.set_security", { requireTotp });

/** `data:` rather than dangerouslySetInnerHTML: an <img> cannot run script. */
export const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
