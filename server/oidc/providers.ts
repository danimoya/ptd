/**
 * The three identity providers PTD can sign a person in with, and what each one
 * needs that the others do not.
 *
 * A provider exists only if its client id and secret are configured; everything
 * else — the button on the sign-in page, the start route, the callback — follows
 * from that one fact, so an operator who configures nothing ships a PTD with
 * password sign-in and no dead buttons.
 *
 * `OIDC_<PROVIDER>_BASE_URL` redirects every endpoint at one origin. It exists so
 * the test suite can stand up a stub IdP; no deployment should set it.
 */
export const OIDC_PROVIDERS = ["google", "github", "microsoft"] as const;
export type OidcProvider = (typeof OIDC_PROVIDERS)[number];

export function isOidcProvider(value: unknown): value is OidcProvider {
  return typeof value === "string" && (OIDC_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  provider: OidcProvider;
  label: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** GitHub only: the addresses endpoint, since /user may hide the address. */
  emailsUrl?: string;
  scope: string;
  /** GitHub's OAuth app endpoints ignore PKCE, so it is not sent there. */
  pkce: boolean;
  /** Microsoft wants the tenant in the path; `common` means "any account". */
  tenant?: string;
}

const LABELS: Record<OidcProvider, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

function envKey(provider: OidcProvider, suffix: string): string {
  return `OIDC_${provider.toUpperCase()}_${suffix}`;
}

function stubEndpoints(base: string, provider: OidcProvider): Pick<ProviderConfig, "authorizeUrl" | "tokenUrl" | "userinfoUrl" | "emailsUrl"> {
  const root = base.replace(/\/+$/, "");
  return {
    authorizeUrl: `${root}/authorize`,
    tokenUrl: `${root}/token`,
    userinfoUrl: `${root}/userinfo`,
    ...(provider === "github" ? { emailsUrl: `${root}/user/emails` } : {}),
  };
}

function liveEndpoints(provider: OidcProvider, tenant: string): Pick<ProviderConfig, "authorizeUrl" | "tokenUrl" | "userinfoUrl" | "emailsUrl"> {
  switch (provider) {
    case "google":
      return {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      };
    case "github":
      return {
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userinfoUrl: "https://api.github.com/user",
        emailsUrl: "https://api.github.com/user/emails",
      };
    case "microsoft":
      return {
        authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        userinfoUrl: "https://graph.microsoft.com/v1.0/me",
      };
  }
}

const SCOPES: Record<OidcProvider, string> = {
  google: "openid email profile",
  github: "read:user user:email",
  microsoft: "openid email profile User.Read",
};

export function providerConfig(provider: OidcProvider, env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  const clientId = env[envKey(provider, "CLIENT_ID")]?.trim();
  const clientSecret = env[envKey(provider, "CLIENT_SECRET")]?.trim();
  if (!clientId || !clientSecret) return null;
  const tenant = (provider === "microsoft" ? env.OIDC_MICROSOFT_TENANT?.trim() : undefined) || "common";
  const base = env[envKey(provider, "BASE_URL")]?.trim();
  return {
    provider,
    label: LABELS[provider],
    clientId,
    clientSecret,
    scope: env[envKey(provider, "SCOPE")]?.trim() || SCOPES[provider],
    pkce: provider !== "github",
    tenant: provider === "microsoft" ? tenant : undefined,
    ...(base ? stubEndpoints(base, provider) : liveEndpoints(provider, tenant)),
  };
}

export interface ProviderSummary {
  provider: OidcProvider;
  label: string;
  startUrl: string;
}

/** What the sign-in page asks for: the configured providers, in a fixed order. */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ProviderSummary[] {
  return OIDC_PROVIDERS.filter((p) => providerConfig(p, env) !== null).map((provider) => ({
    provider,
    label: LABELS[provider],
    startUrl: `/api/auth/oidc/${provider}/start`,
  }));
}

/** The redirect URI registered with the provider. Overridable per provider. */
export function redirectUri(provider: OidcProvider, base: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[envKey(provider, "REDIRECT_URI")]?.trim();
  if (override) return override;
  return `${base.replace(/\/+$/, "")}/api/auth/oidc/${provider}/callback`;
}
