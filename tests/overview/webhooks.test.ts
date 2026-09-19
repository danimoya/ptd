import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

// dispatchWebhooks reads org_integrations, so the db module is stubbed with a
// tiny query-builder shim: select().from().where() resolves to the rows we set.
const rows: { id: number; config: unknown }[] = [];
vi.mock("../../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  },
}));

const {
  buildEnvelope, deliver, dispatchWebhooks, generateWebhookSecret,
  isWebhookConfig, readSecret, sealSecret, signBody, WEBHOOK_TIMEOUT_MS,
} = await import("../../server/webhooks");
const { encryptSecret } = await import("../../server/crypto");

const realFetch = globalThis.fetch;

beforeEach(() => {
  rows.length = 0;
  process.env.PTD_SECRET_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("signBody", () => {
  it("is sha256=<hex HMAC-SHA256 of the raw body>", () => {
    const body = '{"event":"ping"}';
    const expected = `sha256=${createHmac("sha256", "s3cret").update(body, "utf8").digest("hex")}`;
    expect(signBody(body, "s3cret")).toBe(expected);
    expect(signBody(body, "s3cret")).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("changes with the body and with the key", () => {
    expect(signBody("a", "k")).not.toBe(signBody("b", "k"));
    expect(signBody("a", "k1")).not.toBe(signBody("a", "k2"));
  });

  it("signs the exact bytes, so whitespace matters", () => {
    expect(signBody('{"a":1}', "k")).not.toBe(signBody('{"a": 1}', "k"));
  });
});

describe("secret storage", () => {
  it("round-trips through AES-256-GCM and never stores plaintext", () => {
    const secret = generateWebhookSecret();
    const sealed = sealSecret(secret);
    expect(sealed).not.toContain(secret);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(readSecret(sealed)).toBe(secret);
  });

  it("generates a distinct whsec_ secret each time", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it("falls back to a hand-written plaintext secret rather than throwing", () => {
    expect(readSecret("literal-secret")).toBe("literal-secret");
    expect(readSecret(undefined)).toBe("");
  });
});

describe("buildEnvelope", () => {
  it("normalises the optional fields to null and stamps an ISO ts", () => {
    const e = buildEnvelope(7, { kind: "task.created" });
    expect(e).toMatchObject({ event: "task.created", orgId: 7, taskId: null, actor: null, payload: null });
    expect(new Date(e.ts).toISOString()).toBe(e.ts);
  });

  it("carries the actor and payload through untouched", () => {
    const actor = { userId: 3, label: "Scout Agent", isAgent: true };
    const e = buildEnvelope(1, { kind: "task.completed", taskId: 42, actor, payload: { status: "completed" } });
    expect(e.taskId).toBe(42);
    expect(e.actor).toEqual(actor);
    expect(e.payload).toEqual({ status: "completed" });
  });
});

describe("deliver", () => {
  it("POSTs JSON with the signature header and reports the status", async () => {
    const calls: [string, RequestInit][] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push([String(url), init]);
      return { ok: true, status: 202 } as unknown as Response;
    }) as unknown as typeof fetch;

    const secret = "abc";
    const body = '{"event":"ping"}';
    const result = await deliver({ url: "https://hook.test/x", secret: encryptSecret(secret), events: ["*"] }, body);

    expect(result).toEqual({ ok: true, status: 202 });
    const [url, init] = calls[0];
    expect(url).toBe("https://hook.test/x");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(body);
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-PTD-Signature"]).toBe(signBody(body, secret));
  });

  it("reports a non-2xx as not ok without throwing", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response) as unknown as typeof fetch;
    const result = await deliver({ url: "https://hook.test/x", secret: "s", events: ["*"] }, "{}");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it("returns an error instead of rejecting when the endpoint is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const result = await deliver({ url: "http://127.0.0.1:1/x", secret: "s", events: ["*"] }, "{}");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("aborts a hanging endpoint and calls it a timeout", async () => {
    globalThis.fetch = vi.fn(
      (_url: any, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    ) as unknown as typeof fetch;
    const result = await deliver({ url: "https://slow.test", secret: "s", events: ["*"] }, "{}", 30);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timeout");
  });

  it("defaults to a 5 second budget", () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(5_000);
  });
});

describe("isWebhookConfig", () => {
  it("requires a non-empty url", () => {
    expect(isWebhookConfig({ url: "https://x" })).toBe(true);
    expect(isWebhookConfig({ url: "" })).toBe(false);
    expect(isWebhookConfig({})).toBe(false);
    expect(isWebhookConfig(null)).toBe(false);
  });
});

describe("dispatchWebhooks", () => {
  it("sends one request per matching subscriber with a shared signed body", async () => {
    const seen: { url: string; sig: string; body: string }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      seen.push({ url: String(url), sig: (init.headers as Record<string, string>)["X-PTD-Signature"], body: init.body });
      return { ok: true, status: 200 } as unknown as Response;
    }) as unknown as typeof fetch;

    rows.push(
      { id: 1, config: { url: "https://a.test", secret: encryptSecret("k1"), events: ["*"] } },
      { id: 2, config: { url: "https://b.test", secret: encryptSecret("k2"), events: ["task.created"] } },
    );

    await dispatchWebhooks(5, { kind: "task.created", taskId: 9, actor: { userId: 3, label: "Scout", isAgent: true } });
    await new Promise((r) => setTimeout(r, 20));

    expect(seen).toHaveLength(2);
    expect(seen.map((s) => s.url).sort()).toEqual(["https://a.test", "https://b.test"]);
    const envelope = JSON.parse(seen[0].body);
    expect(envelope).toMatchObject({ event: "task.created", orgId: 5, taskId: 9 });
    // Each subscriber gets its own key, so the same body yields different signatures.
    expect(seen[0].sig).toBe(signBody(seen[0].body, "k1"));
    expect(seen[1].sig).toBe(signBody(seen[1].body, "k2"));
    expect(seen[0].sig).not.toBe(seen[1].sig);
  });

  it("skips a subscriber that did not ask for this event kind", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => { urls.push(String(url)); return { ok: true, status: 200 } as unknown as Response; }) as unknown as typeof fetch;
    rows.push(
      { id: 1, config: { url: "https://wants.test", secret: "k", events: ["task.completed"] } },
      { id: 2, config: { url: "https://not.test", secret: "k", events: ["task.created"] } },
    );
    await dispatchWebhooks(1, { kind: "task.completed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toEqual(["https://wants.test"]);
  });

  it("treats an empty or wildcard event list as every event", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: any) => { urls.push(String(url)); return { ok: true, status: 200 } as unknown as Response; }) as unknown as typeof fetch;
    rows.push(
      { id: 1, config: { url: "https://empty.test", secret: "k", events: [] } },
      { id: 2, config: { url: "https://star.test", secret: "k", events: ["*"] } },
    );
    await dispatchWebhooks(1, { kind: "anything.at.all" });
    await new Promise((r) => setTimeout(r, 20));
    expect(urls.sort()).toEqual(["https://empty.test", "https://star.test"]);
  });

  it("ignores a row whose config has no url", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    rows.push({ id: 1, config: { secret: "k" } });
    await dispatchWebhooks(1, { kind: "task.created" });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing, quietly, when the org has no webhooks", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(dispatchWebhooks(1, { kind: "task.created" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never rejects when a subscriber fails — a broken hook cannot fail a task write", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("DNS boom"); }) as unknown as typeof fetch;
    rows.push({ id: 1, config: { url: "https://gone.test", secret: "k", events: ["*"] } });
    await expect(dispatchWebhooks(1, { kind: "task.created" })).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("returns before deliveries settle, so callers are not blocked", async () => {
    let released: (() => void) | undefined;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => { released = () => resolve({ ok: true, status: 200 } as unknown as Response); }),
    ) as unknown as typeof fetch;
    rows.push({ id: 1, config: { url: "https://slow.test", secret: "k", events: ["*"] } });
    const started = Date.now();
    await dispatchWebhooks(1, { kind: "task.created" });
    expect(Date.now() - started).toBeLessThan(200);
    released?.();
  });
});
