/**
 * Copy-paste onboarding for agents. Every snippet embeds the real invite code and
 * the real origin the page is being served from, so what a user copies works
 * without editing — which is the whole point of showing them here rather than in docs.
 */

export interface SnippetContext {
  origin: string;
  inviteCode: string;
  /** A token the user pasted or just minted. Placeholder text when absent. */
  token?: string;
  agentName?: string;
}

export const TOKEN_PLACEHOLDER = "ptd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const tok = (ctx: SnippetContext) => ctx.token?.trim() || TOKEN_PLACEHOLDER;
const name = (ctx: SnippetContext) => ctx.agentName?.trim() || "My Agent";

/** Step 1: the agent registers itself and receives its own bearer token. */
export function registerCurl(ctx: SnippetContext): string {
  return [
    `curl -sX POST ${ctx.origin}/api/agent/register \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"name":"${name(ctx)}","inviteCode":"${ctx.inviteCode}"}'`,
  ].join("\n");
}

/** Step 2a: wire the MCP endpoint into Claude Code. */
export function claudeCodeSnippet(ctx: SnippetContext): string {
  return `claude mcp add --transport http ptd ${ctx.origin}/mcp \\\n  --header "Authorization: Bearer ${tok(ctx)}"`;
}

/** Step 2b: Claude Desktop — remote Streamable-HTTP server with an auth header. */
export function claudeDesktopConfig(ctx: SnippetContext): string {
  return JSON.stringify(
    {
      mcpServers: {
        ptd: {
          type: "http",
          url: `${ctx.origin}/mcp`,
          headers: { Authorization: `Bearer ${tok(ctx)}` },
        },
      },
    },
    null,
    2,
  );
}

/** Step 2c: Cursor uses the same key with `url` + `headers`. */
export function cursorConfig(ctx: SnippetContext): string {
  return JSON.stringify(
    {
      mcpServers: {
        ptd: {
          url: `${ctx.origin}/mcp`,
          headers: { Authorization: `Bearer ${tok(ctx)}` },
        },
      },
    },
    null,
    2,
  );
}

/** A plain JSON-RPC probe, the same request the "Test connection" button sends. */
export function toolsListCurl(ctx: SnippetContext): string {
  return [
    `curl -sX POST ${ctx.origin}/mcp \\`,
    `  -H 'Authorization: Bearer ${tok(ctx)}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Accept: application/json, text/event-stream' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  ].join("\n");
}

/** Where an agent should look first if it was given nothing but a URL. */
export function discoveryCurl(ctx: SnippetContext): string {
  return `curl -s ${ctx.origin}/.well-known/ai-agent.json`;
}

export interface Snippet { id: string; title: string; note: string; lang: "bash" | "json"; body: string }

export function buildSnippets(ctx: SnippetContext): Snippet[] {
  return [
    {
      id: "register",
      title: "1 · Agent self-registration",
      note: "The agent runs this once. It creates a member seat in this organization and returns a ptd_ token.",
      lang: "bash",
      body: registerCurl(ctx),
    },
    {
      id: "claude-code",
      title: "2 · Claude Code",
      note: "Adds PTD as a Streamable-HTTP MCP server for the current project.",
      lang: "bash",
      body: claudeCodeSnippet(ctx),
    },
    {
      id: "claude-desktop",
      title: "2 · Claude Desktop",
      note: "claude_desktop_config.json — merge into any existing mcpServers block.",
      lang: "json",
      body: claudeDesktopConfig(ctx),
    },
    {
      id: "cursor",
      title: "2 · Cursor",
      note: "~/.cursor/mcp.json, or .cursor/mcp.json inside a project.",
      lang: "json",
      body: cursorConfig(ctx),
    },
    {
      id: "tools-list",
      title: "3 · Verify",
      note: "Lists exactly the tools this token's role may call.",
      lang: "bash",
      body: toolsListCurl(ctx),
    },
    {
      id: "discovery",
      title: "Discovery",
      note: "Auth scheme, signup URL, MCP endpoint and every tool — no token needed.",
      lang: "bash",
      body: discoveryCurl(ctx),
    },
  ];
}
