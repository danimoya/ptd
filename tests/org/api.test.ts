import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_PROBE_BODY, parseJsonRpc, probeMcp, xhrPost, type Transport } from "../../client/src/features/org/api";

afterEach(() => vi.restoreAllMocks());

/** A transport that records what it was asked to send and replies with a canned body. */
function fakeTransport(status: number, body: string) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const t: Transport = async (url, headers, b) => {
    calls.push({ url, headers, body: b });
    return { status, body };
  };
  return { t, calls };
}

describe("parseJsonRpc", () => {
  it("reads a plain JSON body", () => {
    expect(parseJsonRpc('{"result":{"tools":[]}}')).toEqual({ result: { tools: [] } });
  });

  it("reads a Streamable-HTTP SSE frame, which is what /mcp actually answers with", () => {
    const sse = 'event: message\ndata: {"result":{"tools":[{"name":"whoami"}]}}\n\n';
    expect(parseJsonRpc(sse)?.result?.tools).toEqual([{ name: "whoami" }]);
  });

  it("returns null for empty or unparsable input rather than throwing", () => {
    expect(parseJsonRpc("")).toBeNull();
    expect(parseJsonRpc("   ")).toBeNull();
    expect(parseJsonRpc("<html>502</html>")).toBeNull();
    expect(parseJsonRpc("data: not json")).toBeNull();
  });

  it("ignores a bare scalar that happens to be valid JSON", () => {
    expect(parseJsonRpc("42")).toBeNull();
    expect(parseJsonRpc("null")).toBeNull();
  });
});

describe("probeMcp", () => {
  it("sends the bearer token, JSON-RPC tools/list, and accepts SSE", async () => {
    const { t, calls } = fakeTransport(200, '{"result":{"tools":[{"name":"b"},{"name":"a"}]}}');

    const res = await probeMcp("  ptd_token  ", t);

    expect(res).toEqual({ ok: true, status: 200, toolCount: 2, tools: ["a", "b"] });
    expect(calls[0].url).toBe("/mcp");
    // Trimmed, so a token pasted with stray whitespace still works.
    expect(calls[0].headers.Authorization).toBe("Bearer ptd_token");
    expect(calls[0].headers.Accept).toContain("text/event-stream");
    expect(JSON.parse(calls[0].body)).toEqual(MCP_PROBE_BODY);
  });

  it("reads a tool list out of an SSE frame", async () => {
    const { t } = fakeTransport(200, 'event: message\ndata: {"result":{"tools":[{"name":"whoami"}]}}\n\n');
    await expect(probeMcp("t", t)).resolves.toMatchObject({ ok: true, toolCount: 1, tools: ["whoami"] });
  });

  it("surfaces a JSON-RPC error message on a 401 rather than a bare status", async () => {
    const { t } = fakeTransport(401, '{"error":{"message":"Invalid token"}}');
    const res = await probeMcp("bad", t);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toBe("Invalid token");
  });

  it("falls back to the raw body when the failure is not JSON-RPC", async () => {
    const { t } = fakeTransport(429, "Too Many Requests");
    await expect(probeMcp("t", t)).resolves.toMatchObject({ ok: false, error: "Too Many Requests" });
  });

  it("reports a 200 with no tool list as a failure, not a silent success", async () => {
    const { t } = fakeTransport(200, '{"result":{}}');
    const res = await probeMcp("t", t);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("No tool list");
  });

  it("turns a network failure into a result instead of rejecting", async () => {
    const t: Transport = async () => { throw new Error("Network request failed"); };
    await expect(probeMcp("t", t)).resolves.toEqual({ ok: false, status: 0, error: "Network request failed" });
  });
});

describe("xhrPost", () => {
  /**
   * The probe must NOT ride on window.fetch: lib/auth.ts wraps fetch and signs the
   * user out on any 401, and testing a token is precisely the call that is allowed
   * to return 401. This pins the transport to XHR so that regression is caught.
   */
  it("uses XMLHttpRequest and never touches window.fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const sent: { method: string; url: string; headers: Record<string, string>; body: string } = { method: "", url: "", headers: {}, body: "" };
    class FakeXhr {
      status = 200;
      responseText = '{"result":{"tools":[]}}';
      timeout = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      open(method: string, url: string) { sent.method = method; sent.url = url; }
      setRequestHeader(k: string, v: string) { sent.headers[k] = v; }
      send(body: string) { sent.body = body; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);

    const res = await xhrPost("/mcp", { Authorization: "Bearer ptd_x" }, "{}");

    expect(res).toEqual({ status: 200, body: '{"result":{"tools":[]}}' });
    expect(sent).toMatchObject({ method: "POST", url: "/mcp", body: "{}" });
    expect(sent.headers.Authorization).toBe("Bearer ptd_x");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects on a transport error so probeMcp can report it", async () => {
    class FailingXhr {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      timeout = 0;
      open() {}
      setRequestHeader() {}
      send() { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal("XMLHttpRequest", FailingXhr);
    await expect(xhrPost("/mcp", {}, "{}")).rejects.toThrow("Network request failed");
    vi.unstubAllGlobals();
  });
});
