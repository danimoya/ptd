/**
 * Every rule the authorization server enforces that is pure input-checking:
 * which redirect URIs may be registered, which grant types and client auth
 * methods exist, how a scope string is normalised, how an error or a code is
 * appended to a redirect URI, and whether a code row is still usable.
 *
 * Kept database-free so the rules are unit-testable without a server.
 */

export const SCOPES_SUPPORTED = ["ptd:member", "ptd:manager"] as const;
export const GRANT_TYPES_SUPPORTED = ["authorization_code", "refresh_token"] as const;
export const AUTH_METHODS_SUPPORTED = ["none", "client_secret_post", "client_secret_basic"] as const;
export const RESPONSE_TYPES_SUPPORTED = ["code"] as const;
export const CODE_CHALLENGE_METHODS_SUPPORTED = ["S256"] as const;

export const DEFAULT_SCOPE = "ptd:member";
export const MAX_REDIRECT_URIS = 10;

export type Scope = (typeof SCOPES_SUPPORTED)[number];
export type GrantType = (typeof GRANT_TYPES_SUPPORTED)[number];
export type AuthMethod = (typeof AUTH_METHODS_SUPPORTED)[number];

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string; description: string };

const ok = <T>(value: T): Checked<T> => ({ ok: true, value });
const bad = <T>(error: string, description: string): Checked<T> => ({ ok: false, error, description });

/** http is only tolerated on the loopback interface, for locally-run dev clients. */
export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

export function validateRedirectUri(raw: unknown): Checked<string> {
  if (typeof raw !== "string" || !raw.trim()) return bad("invalid_redirect_uri", "redirect_uris entries must be non-empty strings");
  const value = raw.trim();
  if (value.length > 500) return bad("invalid_redirect_uri", "redirect_uris entries must be at most 500 characters");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad("invalid_redirect_uri", `not an absolute URI: ${value}`);
  }
  if (url.hash) return bad("invalid_redirect_uri", "a redirect_uri may not contain a fragment");
  if (url.protocol === "https:") return ok(value);
  if (isLoopbackHttp(url)) return ok(value);
  return bad("invalid_redirect_uri", `redirect_uris must be https, or http on localhost / 127.0.0.1: ${value}`);
}

export function validateRedirectUris(raw: unknown): Checked<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) return bad("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  if (raw.length > MAX_REDIRECT_URIS) return bad("invalid_redirect_uri", `at most ${MAX_REDIRECT_URIS} redirect_uris`);
  const out: string[] = [];
  for (const entry of raw) {
    const checked = validateRedirectUri(entry);
    if (!checked.ok) return checked;
    if (!out.includes(checked.value)) out.push(checked.value);
  }
  return ok(out);
}

/** Registered URIs are matched by exact string, never by prefix. */
export function matchRedirectUri(registered: string[], supplied: string | undefined): Checked<string> {
  if (supplied === undefined || supplied === "") {
    // RFC 6749 §3.1.2.3 allows omission when exactly one URI is registered.
    if (registered.length === 1) return ok(registered[0]);
    return bad("invalid_request", "redirect_uri is required when the client registered more than one");
  }
  if (!registered.includes(supplied)) return bad("invalid_request", "redirect_uri does not match a registered redirect_uri for this client");
  return ok(supplied);
}

export function normalizeGrantTypes(raw: unknown): Checked<GrantType[]> {
  if (raw === undefined || raw === null) return ok([...GRANT_TYPES_SUPPORTED]);
  if (!Array.isArray(raw) || raw.length === 0) return bad("invalid_client_metadata", "grant_types must be a non-empty array");
  const out: GrantType[] = [];
  for (const g of raw) {
    if (typeof g !== "string" || !(GRANT_TYPES_SUPPORTED as readonly string[]).includes(g)) {
      return bad("invalid_client_metadata", `unsupported grant_type: ${String(g)} (supported: ${GRANT_TYPES_SUPPORTED.join(", ")})`);
    }
    if (!out.includes(g as GrantType)) out.push(g as GrantType);
  }
  if (!out.includes("authorization_code")) return bad("invalid_client_metadata", "grant_types must include authorization_code");
  return ok(out);
}

export function normalizeResponseTypes(raw: unknown): Checked<string[]> {
  if (raw === undefined || raw === null) return ok(["code"]);
  if (!Array.isArray(raw) || raw.length === 0) return bad("invalid_client_metadata", "response_types must be a non-empty array");
  for (const r of raw) {
    if (r !== "code") return bad("invalid_client_metadata", `unsupported response_type: ${String(r)} (only "code" is supported)`);
  }
  return ok(["code"]);
}

export function normalizeAuthMethod(raw: unknown): Checked<AuthMethod> {
  if (raw === undefined || raw === null || raw === "") return ok("none");
  if (typeof raw !== "string" || !(AUTH_METHODS_SUPPORTED as readonly string[]).includes(raw)) {
    return bad("invalid_client_metadata", `unsupported token_endpoint_auth_method: ${String(raw)} (supported: ${AUTH_METHODS_SUPPORTED.join(", ")})`);
  }
  return ok(raw as AuthMethod);
}

export function normalizeClientName(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null || raw === "") return ok("MCP client");
  if (typeof raw !== "string") return bad("invalid_client_metadata", "client_name must be a string");
  const value = raw.replace(/[\r\n\t]/g, " ").trim().slice(0, 255);
  if (!value) return bad("invalid_client_metadata", "client_name must not be blank");
  return ok(value);
}

/**
 * Scopes are informational: they are recorded on the grant and shown on the
 * consent screen, but the effective permission is always the membership role.
 */
export function normalizeScope(raw: unknown): Checked<string> {
  if (raw === undefined || raw === null || raw === "") return ok(DEFAULT_SCOPE);
  if (typeof raw !== "string") return bad("invalid_scope", "scope must be a space-delimited string");
  const parts = raw.split(/[\s+]+/).filter(Boolean);
  if (parts.length === 0) return ok(DEFAULT_SCOPE);
  const out: string[] = [];
  for (const p of parts) {
    if (!(SCOPES_SUPPORTED as readonly string[]).includes(p)) {
      return bad("invalid_scope", `unknown scope: ${p} (supported: ${SCOPES_SUPPORTED.join(", ")})`);
    }
    if (!out.includes(p)) out.push(p);
  }
  const joined = out.join(" ");
  return joined.length > 200 ? bad("invalid_scope", "scope is too long") : ok(joined);
}

/** RFC 8707: when the client names an audience it must be this server's MCP endpoint. */
export function sameResource(supplied: string, expected: string): boolean {
  const norm = (value: string) => {
    try {
      const u = new URL(value);
      const path = u.pathname.replace(/\/+$/, "");
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
    } catch {
      return value.trim().replace(/\/+$/, "");
    }
  };
  return norm(supplied) === norm(expected);
}

export function checkResource(raw: unknown, expected: string): Checked<string | null> {
  if (raw === undefined || raw === null || raw === "") return ok(null);
  if (typeof raw !== "string" || raw.length > 500) return bad("invalid_target", "resource must be a URI string");
  if (!sameResource(raw, expected)) return bad("invalid_target", `resource must be ${expected}`);
  return ok(raw);
}

/** Append query parameters to a redirect URI, preserving any it already carries. */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

export type CodeState = "valid" | "used" | "expired";

export function codeState(row: { expiresAt: Date | string; usedAt: Date | string | null }, now: Date = new Date()): CodeState {
  if (row.usedAt) return "used";
  const expires = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  return expires.getTime() <= now.getTime() ? "expired" : "valid";
}

/** `state` is echoed back verbatim; cap it so a hostile client cannot make us build a huge URL. */
export function normalizeState(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  return raw.slice(0, 512);
}
