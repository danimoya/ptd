import { describe, expect, it } from "vitest";
import {
  buildSnippets, claudeCodeSnippet, claudeDesktopConfig, cursorConfig,
  discoveryCurl, registerCurl, toolsListCurl, TOKEN_PLACEHOLDER,
} from "../../client/src/features/org/snippets";

const CTX = { origin: "https://ptd.example.com", inviteCode: "f9d9e8013717f6c0", token: "ptd_abcdef0123456789abcdef0123456789abcdef01", agentName: "Nightly Triage Bot" };

describe("registerCurl", () => {
  it("posts to this deployment's signup URL with this org's real invite code", () => {
    const s = registerCurl(CTX);
    expect(s).toContain("https://ptd.example.com/api/agent/register");
    expect(s).toContain('"inviteCode":"f9d9e8013717f6c0"');
    expect(s).toContain('"name":"Nightly Triage Bot"');
    expect(s).not.toContain("<");
  });

  it("falls back to a usable placeholder name", () => {
    expect(registerCurl({ ...CTX, agentName: "" })).toContain('"name":"My Agent"');
    expect(registerCurl({ origin: "http://x", inviteCode: "c" })).toContain('"name":"My Agent"');
  });

  it("never leaks a token into the signup snippet — it has not been minted yet", () => {
    expect(registerCurl(CTX)).not.toContain(CTX.token);
  });
});

describe("claudeCodeSnippet", () => {
  it("is a runnable `claude mcp add` with the http transport and a bearer header", () => {
    const s = claudeCodeSnippet(CTX);
    expect(s).toContain("claude mcp add --transport http ptd https://ptd.example.com/mcp");
    expect(s).toContain(`--header "Authorization: Bearer ${CTX.token}"`);
  });

  it("shows a placeholder token until the user pastes one", () => {
    expect(claudeCodeSnippet({ ...CTX, token: undefined })).toContain(TOKEN_PLACEHOLDER);
    expect(claudeCodeSnippet({ ...CTX, token: "   " })).toContain(TOKEN_PLACEHOLDER);
  });
});

describe("Claude Desktop config", () => {
  it("is valid JSON describing a remote Streamable-HTTP server with an auth header", () => {
    const parsed = JSON.parse(claudeDesktopConfig(CTX));
    expect(parsed.mcpServers.ptd).toEqual({
      type: "http",
      url: "https://ptd.example.com/mcp",
      headers: { Authorization: `Bearer ${CTX.token}` },
    });
  });
});

describe("Cursor config", () => {
  it("is valid JSON with url + headers and no stdio command", () => {
    const parsed = JSON.parse(cursorConfig(CTX));
    expect(parsed.mcpServers.ptd.url).toBe("https://ptd.example.com/mcp");
    expect(parsed.mcpServers.ptd.headers.Authorization).toBe(`Bearer ${CTX.token}`);
    expect(parsed.mcpServers.ptd).not.toHaveProperty("command");
    expect(parsed.mcpServers.ptd).not.toHaveProperty("args");
  });
});

describe("toolsListCurl", () => {
  it("is the same JSON-RPC request the Test connection button sends", () => {
    const s = toolsListCurl(CTX);
    expect(s).toContain("https://ptd.example.com/mcp");
    expect(s).toContain('"method":"tools/list"');
    expect(s).toContain('"jsonrpc":"2.0"');
    // The MCP transport may answer with SSE, so the probe must accept both.
    expect(s).toContain("Accept: application/json, text/event-stream");
    expect(s).toContain(`Authorization: Bearer ${CTX.token}`);
  });
});

describe("discoveryCurl", () => {
  it("points at the well-known manifest and needs no credentials", () => {
    const s = discoveryCurl(CTX);
    expect(s).toBe("curl -s https://ptd.example.com/.well-known/ai-agent.json");
    expect(s).not.toContain("Authorization");
  });
});

describe("buildSnippets", () => {
  it("covers registration, all three clients, verification and discovery", () => {
    const ids = buildSnippets(CTX).map((s) => s.id);
    expect(ids).toEqual(["register", "claude-code", "claude-desktop", "cursor", "tools-list", "discovery"]);
  });

  it("embeds the real origin in every snippet that names a URL", () => {
    for (const s of buildSnippets(CTX)) {
      if (s.body.includes("http")) expect(s.body).toContain("https://ptd.example.com");
      expect(s.body).not.toContain("localhost");
    }
  });

  it("gives every snippet a title, a note and a language for the copy block", () => {
    for (const s of buildSnippets(CTX)) {
      expect(s.title).toBeTruthy();
      expect(s.note).toBeTruthy();
      expect(["bash", "json"]).toContain(s.lang);
      expect(s.body.trim()).toBe(s.body);
    }
  });

  it("marks every JSON snippet as parseable JSON", () => {
    for (const s of buildSnippets(CTX).filter((x) => x.lang === "json")) {
      expect(() => JSON.parse(s.body)).not.toThrow();
    }
  });
});

describe("webhook event catalogue", () => {
  it("namespaces every kind and keeps the two families disjoint", async () => {
    const { ALL_EVENT_KINDS, STREAM_EVENTS, TASK_EVENTS } = await import("../../client/src/features/org/events");
    for (const k of TASK_EVENTS) expect(k.startsWith("task.")).toBe(true);
    for (const k of STREAM_EVENTS) expect(k.startsWith("stream.")).toBe(true);
    expect(new Set(ALL_EVENT_KINDS).size).toBe(ALL_EVENT_KINDS.length);
    // `ping` is what webhook.test delivers, so it must be subscribable.
    expect(ALL_EVENT_KINDS).toContain("ping");
  });

  it("parses the comma-separated field, trimming and de-duplicating in order", async () => {
    const { parseEvents } = await import("../../client/src/features/org/events");
    expect(parseEvents("")).toEqual([]);
    expect(parseEvents("  ")).toEqual([]);
    expect(parseEvents("task.created, task.completed")).toEqual(["task.created", "task.completed"]);
    expect(parseEvents("a,,  b , a")).toEqual(["a", "b"]);
  });

  it("flags kinds nothing emits but never flags a real one or the wildcard", async () => {
    const { ALL_EVENT_KINDS, unknownEvents } = await import("../../client/src/features/org/events");
    expect(unknownEvents("task.created, stream.renamed, ping")).toEqual([]);
    expect(unknownEvents("*")).toEqual([]);
    expect(unknownEvents("task.creted, nonsense")).toEqual(["task.creted", "nonsense"]);
    expect(unknownEvents(ALL_EVENT_KINDS.join(", "))).toEqual([]);
  });
});
