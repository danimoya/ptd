/**
 * A stub identity provider: the three endpoints PTD actually calls, and the two
 * checks that make the test meaningful (the authorization code is redeemed once,
 * and the PKCE verifier has to hash to the challenge that was sent).
 *
 * It exists because the alternative is mocking `fetch`, which would prove that
 * our mock matches our code rather than that our code speaks the protocol. This
 * runs a real HTTP server, so the redirect, the form-encoded token POST and the
 * bearer-authenticated profile fetch are all exercised for real.
 *
 * Pointed at with `OIDC_<PROVIDER>_BASE_URL`, which exists for exactly this.
 */
import { createHash, randomBytes } from "crypto";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * A `fetch`-shaped client over `node:http`.
 *
 * `tests/setup.ts` replaces the global `fetch` with a vi.fn() for the whole
 * suite, so the real one is not available to a test that wants to talk to this
 * stub over a socket. Everything in server/oidc takes its fetch as a parameter
 * for exactly this reason, and this is what the tests pass in. It implements only
 * what those callers use: a method, headers, a string body, `redirect: "manual"`,
 * and the `ok` / `status` / `headers.get` / `text()` / `json()` surface.
 */
export type MinimalResponse = Pick<Response, "ok" | "status" | "text" | "json"> & { headers: { get(name: string): string | null } };

export function nodeFetch(input: string | URL, init: RequestInit = {}): Promise<MinimalResponse> {
  const url = typeof input === "string" ? new URL(input) : input;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: (init.method ?? "GET").toUpperCase(),
        headers: (init.headers as Record<string, string>) ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            headers: { get: (name: string) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
            text: async () => body,
            json: async () => JSON.parse(body),
          } as MinimalResponse),
        );
      },
    );
    req.on("error", reject);
    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}

export interface StubProfile {
  /** Google/Microsoft `sub`/`id`, GitHub numeric id. */
  subject: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
}

export interface StubIdp {
  url: string;
  close: () => Promise<void>;
  /** What the last /token call carried, so a test can assert PKCE was sent. */
  lastTokenBody: () => Record<string, string> | null;
  authorizeCalls: () => { params: Record<string, string> }[];
  setProfile: (profile: StubProfile) => void;
  /** Serve a 500 from /token, to exercise the failure path. */
  breakToken: (broken: boolean) => void;
}

type Flavour = "google" | "github" | "microsoft";

export async function startStubIdp(opts: { flavour: Flavour; profile: StubProfile }): Promise<StubIdp> {
  let profile = opts.profile;
  let broken = false;
  let lastTokenBody: Record<string, string> | null = null;
  const authorizeCalls: { params: Record<string, string> }[] = [];
  const codes = new Map<string, { challenge: string | null; used: boolean }>();
  const tokens = new Set<string>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/authorize") {
      const params = Object.fromEntries(url.searchParams.entries());
      authorizeCalls.push({ params });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { challenge: params.code_challenge ?? null, used: false });
      const back = new URL(params.redirect_uri);
      back.searchParams.set("code", code);
      if (params.state) back.searchParams.set("state", params.state);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname === "/token" && req.method === "POST") {
      const raw = await new Promise<string>((resolve) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => resolve(body));
      });
      const form = Object.fromEntries(new URLSearchParams(raw));
      lastTokenBody = form;
      if (broken) return json(500, { error: "server_error", error_description: "stub is sulking" });
      const entry = codes.get(form.code ?? "");
      if (!entry || entry.used) return json(400, { error: "invalid_grant", error_description: "unknown or reused code" });
      entry.used = true;
      if (entry.challenge) {
        const verifier = form.code_verifier ?? "";
        const digest = createHash("sha256").update(verifier).digest("base64url");
        if (digest !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
      }
      const access = randomBytes(12).toString("hex");
      tokens.add(access);
      return json(200, { access_token: access, token_type: "bearer", scope: form.scope ?? "" });
    }

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (url.pathname === "/userinfo") {
      if (!tokens.has(bearer)) return json(401, { error: "invalid_token" });
      if (opts.flavour === "google") {
        return json(200, { sub: profile.subject, email: profile.email ?? undefined, email_verified: profile.emailVerified ?? false, name: profile.name ?? undefined });
      }
      if (opts.flavour === "microsoft") {
        return json(200, { id: profile.subject, mail: profile.email ?? null, userPrincipalName: profile.email ?? undefined, displayName: profile.name ?? undefined });
      }
      // GitHub hides the address here unless the user made it public.
      return json(200, { id: Number(profile.subject) || profile.subject, login: profile.name ?? "octocat", name: profile.name ?? null, email: null });
    }

    if (url.pathname === "/user/emails") {
      if (!tokens.has(bearer)) return json(401, { error: "invalid_token" });
      if (!profile.email) return json(200, []);
      return json(200, [{ email: profile.email, primary: true, verified: profile.emailVerified ?? false }]);
    }

    json(404, { error: "not_found", path: url.pathname });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => (server as Server).close(() => resolve())),
    lastTokenBody: () => lastTokenBody,
    authorizeCalls: () => authorizeCalls,
    setProfile: (next) => {
      profile = next;
    },
    breakToken: (value) => {
      broken = value;
    },
  };
}
