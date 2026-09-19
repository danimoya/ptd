import type { Role } from "../../../db/schema";

const API_BASE = "/api";

export function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("token");
  const orgId = localStorage.getItem("orgId");
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (orgId) h["X-Org-Id"] = orgId;
  return h;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** JSON fetch against /api with auth + org headers. Throws ApiError on non-2xx. */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...getAuthHeader(), ...(init.headers || {}) } });
  if (!res.ok) {
    let message = res.statusText;
    try { const body = await res.json(); message = body.error || body.message || message; } catch { /* keep statusText */ }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Me {
  user: { id: number; email: string; displayName: string; isAgent: boolean; createdAt: string };
  authType: "human" | "agent";
  orgs: { orgId: number; name: string; slug: string; plan: string; role: Role }[];
}

export interface OrgSummary { id: number; name: string; slug: string; plan: string; role: Role; createdAt: string }
export interface CurrentOrg extends Omit<OrgSummary, "createdAt"> { inviteCode?: string; createdAt: string }
export interface MemberRow { userId: number; role: Role; email: string; displayName: string; isAgent: boolean; joinedAt: string }

export const getMe = () => api<Me>("/auth/me");
export const getOrgs = () => api<OrgSummary[]>("/orgs");
export const createOrg = (name: string) => api<OrgSummary>("/orgs", { method: "POST", body: JSON.stringify({ name }) });
export const getCurrentOrg = () => api<CurrentOrg>("/orgs/current");
export const getMembers = () => api<MemberRow[]>("/orgs/current/members");
export const inviteMember = (email: string, role: "admin" | "manager" | "member") =>
  api("/orgs/current/invitations", { method: "POST", body: JSON.stringify({ email, role }) });
export const acceptInvitation = (token: string) => api<{ orgId: number; role: Role }>("/invitations/accept", { method: "POST", body: JSON.stringify({ token }) });
export const updateMemberRole = (userId: number, role: Role) => api(`/orgs/current/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
export const removeMember = (userId: number) => api(`/orgs/current/members/${userId}`, { method: "DELETE" });
export const getInviteCode = (regenerate = false) => api<{ inviteCode: string }>("/orgs/current/invite-code", { method: "POST", body: JSON.stringify({ regenerate }) });

export interface TokenRow { id: number; name: string; prefix: string; scopes: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }
export const getTokens = () => api<TokenRow[]>("/tokens");
export const createToken = (name: string, expiresInDays?: number) =>
  api<{ id: number; name: string; prefix: string; secret: string }>("/tokens", { method: "POST", body: JSON.stringify({ name, expiresInDays }) });
export const revokeToken = (id: number) => api(`/tokens/${id}`, { method: "DELETE" });
