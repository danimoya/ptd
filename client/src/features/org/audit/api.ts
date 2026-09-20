import { callAction } from "@/lib/api";

export interface AuditEventRow {
  id: number;
  at: string;
  kind: string;
  target: string | null;
  actor: string;
  actorUserId: number | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
}

export interface AuditPage {
  total: number;
  limit: number;
  offset: number;
  kinds: { kind: string; count: number }[];
  events: AuditEventRow[];
}

export interface AuditFilters {
  from?: string;
  to?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export const AUDIT_KEY = (f: AuditFilters) => ["action", "audit.list", f] as const;

/** A date input gives `YYYY-MM-DD`; the action wants an instant. */
export function dayStart(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function dayEnd(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const listAudit = (filters: AuditFilters) => callAction<AuditPage>("audit.list", { ...filters });
export const exportAudit = (range: { from?: string; to?: string; kind?: string }) =>
  callAction<{ filename: string; rows: number; csv: string }>("audit.export", { ...range });

/**
 * Hand the CSV to the browser as a file. A data: URL would work for small logs
 * and then quietly break on a long one, so this goes through a blob and revokes
 * the URL on the next tick.
 */
export function downloadText(filename: string, body: string, mime = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Plain-language labels. An unknown kind is shown verbatim rather than hidden. */
export const KIND_LABELS: Record<string, string> = {
  "auth.login": "signed in",
  "auth.login_failed": "sign-in refused",
  "auth.register": "account created",
  "auth.password_reset_requested": "asked for a reset link",
  "auth.password_reset": "password reset",
  "auth.mfa_required": "second factor asked for",
  "auth.mfa_success": "second factor accepted",
  "auth.mfa_failed": "second factor refused",
  "auth.recovery_code_used": "recovery code used",
  "totp.enabled": "2FA turned on",
  "totp.disabled": "2FA turned off",
  "totp.recovery_regenerated": "recovery codes replaced",
  "oidc.login": "signed in with a provider",
  "oidc.signup": "account created via a provider",
  "oidc.linked": "provider linked",
  "oidc.unlinked": "provider unlinked",
  "org.created": "organization created",
  "org.deleted": "organization deleted",
  "org.exported": "data exported",
  "org.security_changed": "security policy changed",
  "org.set_security": "security policy changed",
  "org.export": "export link minted",
  "member.role_changed": "role changed",
  "member.removed": "member removed",
  "member.joined": "member joined",
  "invite.created": "invitation sent",
  "invite.code_regenerated": "invite code regenerated",
  "token.minted": "token minted",
  "token.revoked": "token revoked",
  "token.rotated": "tokens rotated",
  "agent.registered": "agent seat opened",
  "identity.unlink": "provider unlinked",
  "audit.export": "audit log exported",
};

export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** Which of the three registers a row belongs to, for its colour. */
export function kindTone(kind: string): "alarm" | "credential" | "plain" {
  if (kind.endsWith("_failed") || kind === "org.deleted" || kind === "totp.disabled" || kind === "member.removed") return "alarm";
  if (kind.startsWith("token.") || kind.startsWith("totp.") || kind.startsWith("oidc.") || kind.startsWith("identity.") || kind.startsWith("auth.")) return "credential";
  return "plain";
}
