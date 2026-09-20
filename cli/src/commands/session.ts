import { callAction, request } from "../api.ts";
import { clearCredentials, configMode, configPath, DEFAULT_BASE_URL, readFileConfigOnly, stripTrailingSlash, writeConfig } from "../config.ts";
import { bold, dim, green, yellow } from "../color.ts";
import { CliError, UsageError } from "../errors.ts";
import { ask, askSecret } from "../prompt.ts";
import { json, keyValue, table } from "../table.ts";
import type { Ctx } from "../context.ts";
import { stringFlag } from "../args.ts";

interface Whoami {
  userId?: number;
  email?: string;
  displayName?: string;
  role?: string;
  authType?: string;
  org?: { id?: number; name?: string; slug?: string } | null;
}

export async function login(ctx: Ctx): Promise<void> {
  const stored = readFileConfigOnly();
  const baseUrl = stripTrailingSlash(stringFlag(ctx.flags, "url") ?? ctx.client.baseUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL);
  if (!/^https?:\/\//.test(baseUrl)) throw new UsageError(`--url must be an http(s) URL, got "${baseUrl}"`, "login");

  let token = stringFlag(ctx.flags, "token");
  if (token === undefined) {
    const email = stringFlag(ctx.flags, "email") ?? (await ask(`Email for ${baseUrl}: `));
    if (!email) throw new CliError("No email given.");
    const password = await askSecret("Password: ");
    if (!password) throw new CliError("No password given.");
    const answer = (await request({ baseUrl, fetchImpl: ctx.client.fetchImpl }, "/api/auth/login", {
      method: "POST",
      body: { email, password },
      anonymous: true,
    })) as { token?: string };
    if (!answer?.token) throw new CliError("The server accepted the login but returned no token.");
    token = answer.token;
  } else if (!token.startsWith("ptd_")) {
    ctx.print(yellow("Note: agent tokens start with ptd_ — storing this value anyway."));
  }

  // The token decides the organization for `ptd_…`; for a JWT the server picks the
  // oldest membership. Either way whoami reports the truth, so store what it says.
  const probeClient = { baseUrl, token, fetchImpl: ctx.client.fetchImpl };
  const me = (await callAction(probeClient, "whoami")) as Whoami;
  const orgId = me?.org?.id;
  const path = writeConfig({ baseUrl, token, orgId }, process.env);

  if (ctx.raw) return ctx.print(json({ baseUrl, orgId, configPath: path, whoami: me }));
  ctx.print(green(`Logged in to ${baseUrl}`));
  ctx.print(describeIdentity(me));
  ctx.print(dim(`Credential stored in ${path} (mode 0600).`));
}

export async function logout(ctx: Ctx): Promise<void> {
  const { path, hadToken } = clearCredentials();
  if (ctx.raw) return ctx.print(json({ loggedOut: hadToken, configPath: path }));
  ctx.print(hadToken ? green(`Credential removed from ${path}.`) : dim("No stored credential to remove."));
}

export async function whoami(ctx: Ctx): Promise<void> {
  const me = (await callAction(ctx.client, "whoami")) as Whoami;
  if (ctx.raw) return ctx.print(json(me));
  ctx.print(describeIdentity(me));
  ctx.print(dim(`server    ${ctx.client.baseUrl}`));
  const mode = configMode();
  if (mode !== null && (mode & 0o077) !== 0) {
    ctx.print(yellow(`Warning: ${configPath()} is mode ${mode.toString(8)} — it holds a bearer token. chmod 600 it.`));
  }
}

function describeIdentity(me: Whoami): string {
  return keyValue({
    user: `${me.displayName ?? "?"} <${me.email ?? "?"}>`,
    userId: me.userId,
    org: me.org?.name ? `${me.org.name} (id ${me.org.id})` : me.org?.id,
    role: me.role,
    authType: me.authType === "agent" ? `${me.authType} — time entries are recorded as agent work` : me.authType,
  });
}

interface OrgRow {
  id: number;
  name: string;
  slug?: string;
  plan?: string;
  role?: string;
}

export async function orgs(ctx: Ctx): Promise<void> {
  const rows = (await request(ctx.client, "/api/orgs", { noOrg: true })) as OrgRow[];
  if (ctx.raw) return ctx.print(json(rows));
  if (!Array.isArray(rows) || rows.length === 0) return ctx.print(dim("No organizations for this credential."));
  const current = ctx.client.orgId;
  ctx.print(
    table(
      rows.map((o) => ({ "": o.id === current ? "*" : "", id: o.id, name: o.name, role: o.role ?? "", plan: o.plan ?? "", slug: o.slug ?? "" })),
      [{ key: "", header: "" }, { key: "id", numeric: true }, "name", "role", "plan", "slug"],
    ),
  );
  if (current !== undefined) ctx.print(dim(`\n* current organization — change it with \`ptd use <orgId>\`.`));
}

export async function use(ctx: Ctx): Promise<void> {
  const raw = ctx.args[0];
  if (!raw) throw new UsageError("Name the organization id — see `ptd orgs`.", "use");
  if (!/^\d+$/.test(raw)) throw new UsageError(`"${raw}" is not an organization id (a positive integer).`, "use");
  const orgId = Number(raw);
  const rows = (await request(ctx.client, "/api/orgs", { noOrg: true })) as OrgRow[];
  const match = Array.isArray(rows) ? rows.find((o) => o.id === orgId) : undefined;
  if (!match) throw new CliError(`This credential is not a member of organization ${orgId}. Run \`ptd orgs\` to see the options.`);

  const stored = readFileConfigOnly();
  writeConfig({ baseUrl: stored.baseUrl ?? ctx.client.baseUrl, token: stored.token, orgId }, process.env);
  if (ctx.raw) return ctx.print(json({ orgId, name: match.name, role: match.role }));
  ctx.print(green(`Now acting in ${bold(match.name)} (id ${orgId}) as ${match.role ?? "member"}.`));
}
