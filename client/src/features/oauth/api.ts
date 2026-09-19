// Client half of the OAuth consent screen: reading the authorize query the
// server handed us, and the four calls the screen makes. The parsing and
// body-building are pure so they can be tested without a browser.

export interface ConsentParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

export interface ClientInfo {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  confidential: boolean;
  registered_at: string;
}

export interface DecisionResult {
  decision: "approve" | "deny";
  redirect: string;
  granted?: { orgId: number; org: string | null; role: string; scope: string; client_name: string; tools: string[] };
}

export interface ActionRow {
  name: string;
  title: string;
  description: string;
  surface: string;
  requiredRole: string;
}

export function readConsentParams(search: URLSearchParams): ConsentParams {
  const get = (k: string) => (search.get(k) ?? "").trim();
  return {
    responseType: get("response_type") || "code",
    clientId: get("client_id"),
    redirectUri: get("redirect_uri"),
    scope: get("scope"),
    state: get("state"),
    codeChallenge: get("code_challenge"),
    codeChallengeMethod: get("code_challenge_method") || "S256",
    resource: get("resource"),
  };
}

/** Everything the server requires before it will mint a code. Empty list = usable request. */
export function missingConsentParams(p: ConsentParams): string[] {
  const missing: string[] = [];
  if (!p.clientId) missing.push("client_id");
  if (!p.redirectUri) missing.push("redirect_uri");
  if (!p.codeChallenge) missing.push("code_challenge");
  if (p.responseType !== "code") missing.push("response_type=code");
  if (p.codeChallengeMethod !== "S256") missing.push("code_challenge_method=S256");
  return missing;
}

export function decisionBody(p: ConsentParams, orgId: number, decision: "approve" | "deny") {
  const body: Record<string, unknown> = {
    decision,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: p.responseType,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    orgId,
  };
  if (p.scope) body.scope = p.scope;
  if (p.state) body.state = p.state;
  if (p.resource) body.resource = p.resource;
  return body;
}

/** Host the user will be sent back to — the one thing worth showing them verbatim. */
export function callbackHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function scopeList(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/** Tool names grouped by surface, for the "what this grants" list. */
export function toolsBySurface(actions: ActionRow[]): { surface: string; names: string[] }[] {
  const order = ["overview", "plan", "track", "org"];
  const groups = new Map<string, string[]>();
  for (const a of actions) {
    const list = groups.get(a.surface) ?? [];
    list.push(a.name);
    groups.set(a.surface, list);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([surface, names]) => ({ surface, names: names.sort() }));
}

async function jsonOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error_description || body?.error || body?.message || `HTTP ${res.status}`);
  return body;
}

export async function fetchClientInfo(clientId: string): Promise<ClientInfo> {
  return jsonOrThrow(await fetch(`/oauth/client-info?client_id=${encodeURIComponent(clientId)}`));
}

export async function login(email: string, password: string): Promise<{ token: string; user: { email: string } }> {
  return jsonOrThrow(
    await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
}

export interface MeOrgs {
  user: { id: number; email: string; displayName: string };
  orgs: { orgId: number; name: string; slug: string; plan: string; role: string }[];
}

export async function fetchMe(token: string): Promise<MeOrgs> {
  return jsonOrThrow(await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } }));
}

export async function fetchActions(token: string, orgId: number): Promise<ActionRow[]> {
  return jsonOrThrow(await fetch("/api/actions", { headers: { Authorization: `Bearer ${token}`, "X-Org-Id": String(orgId) } }));
}

export async function postDecision(token: string, p: ConsentParams, orgId: number, decision: "approve" | "deny"): Promise<DecisionResult> {
  return jsonOrThrow(
    await fetch("/oauth/authorize/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(decisionBody(p, orgId, decision)),
    })
  );
}
