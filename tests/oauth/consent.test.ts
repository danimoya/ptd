import { describe, expect, it } from "vitest";
import {
  callbackHost, decisionBody, missingConsentParams, readConsentParams, scopeList, toolsBySurface,
  type ActionRow,
} from "../../client/src/features/oauth/api";

const query = (s: string) => new URLSearchParams(s);
const FULL =
  "response_type=code&client_id=ptdc_1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
  "&scope=ptd%3Amember&state=st8&code_challenge=" + "a".repeat(43) + "&code_challenge_method=S256&resource=https%3A%2F%2Fptd.example%2Fmcp";

describe("readConsentParams", () => {
  it("reads the whole authorize query the server forwarded", () => {
    const p = readConsentParams(query(FULL));
    expect(p.clientId).toBe("ptdc_1");
    expect(p.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(p.state).toBe("st8");
    expect(p.resource).toBe("https://ptd.example/mcp");
    expect(missingConsentParams(p)).toEqual([]);
  });

  it("defaults response_type and the challenge method rather than inventing values", () => {
    const p = readConsentParams(query("client_id=ptdc_1"));
    expect(p.responseType).toBe("code");
    expect(p.codeChallengeMethod).toBe("S256");
    expect(p.state).toBe("");
  });

  it("names every missing or unsupported piece", () => {
    expect(missingConsentParams(readConsentParams(query("")))).toEqual(["client_id", "redirect_uri", "code_challenge"]);
    expect(missingConsentParams(readConsentParams(query("response_type=token&client_id=c&redirect_uri=https://a/cb&code_challenge=x"))))
      .toEqual(["response_type=code"]);
    expect(missingConsentParams(readConsentParams(query("client_id=c&redirect_uri=https://a/cb&code_challenge=x&code_challenge_method=plain"))))
      .toEqual(["code_challenge_method=S256"]);
  });
});

describe("decisionBody", () => {
  it("posts the original parameters back with the chosen org", () => {
    const body = decisionBody(readConsentParams(query(FULL)), 7, "approve") as Record<string, unknown>;
    expect(body).toMatchObject({
      decision: "approve",
      client_id: "ptdc_1",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      code_challenge_method: "S256",
      orgId: 7,
      scope: "ptd:member",
      state: "st8",
      resource: "https://ptd.example/mcp",
    });
  });

  it("omits the optional parameters the client never sent", () => {
    const body = decisionBody(readConsentParams(query("client_id=c&redirect_uri=https://a/cb&code_challenge=x")), 1, "deny");
    expect(body).not.toHaveProperty("state");
    expect(body).not.toHaveProperty("resource");
    expect(body).not.toHaveProperty("scope");
    expect(body.decision).toBe("deny");
  });
});

describe("display helpers", () => {
  it("shows the host the user will be returned to", () => {
    expect(callbackHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
    expect(callbackHost("http://localhost:6274/cb")).toBe("localhost:6274");
    expect(callbackHost("not a url")).toBe("not a url");
  });

  it("splits a scope string", () => {
    expect(scopeList("ptd:member ptd:manager")).toEqual(["ptd:member", "ptd:manager"]);
    expect(scopeList("")).toEqual([]);
  });

  it("groups the role's tools by surface in reading order", () => {
    const rows: ActionRow[] = [
      { name: "time_entry.start", title: "", description: "", surface: "track", requiredRole: "member" },
      { name: "app.list", title: "", description: "", surface: "overview", requiredRole: "member" },
      { name: "task.create", title: "", description: "", surface: "plan", requiredRole: "manager" },
      { name: "whoami", title: "", description: "", surface: "org", requiredRole: "member" },
      { name: "app.get", title: "", description: "", surface: "overview", requiredRole: "member" },
    ];
    expect(toolsBySurface(rows)).toEqual([
      { surface: "overview", names: ["app.get", "app.list"] },
      { surface: "plan", names: ["task.create"] },
      { surface: "track", names: ["time_entry.start"] },
      { surface: "org", names: ["whoami"] },
    ]);
  });
});
