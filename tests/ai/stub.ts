/**
 * Local stand-ins for api.anthropic.com and api.openai.com.
 *
 * Two faces on one router, the same trick tests/billing/stub.ts plays: an
 * injectable `fetchImpl` for unit tests, and `startAiStub(port)` for the manual
 * dev loop and the headless browser check, where the PTD server talks to it over
 * HTTP via PTD_AI_BASE_URL. Every request is recorded, so a test can assert the
 * exact body each provider would have received.
 *
 * The Anthropic shape mirrors the Messages API as the claude-api skill documents
 * it: `content` is a block array (a forced tool call arrives as one `tool_use`
 * block whose `input` is the object), `usage` carries `input_tokens` /
 * `output_tokens`, and a policy decline is an HTTP 200 with
 * `stop_reason: "refusal"`.
 *
 *   npx tsx tests/ai/stub.ts 5599     # run it standalone for the dev loop
 */
import { createServer, type Server } from "http";
import type { FetchLike } from "../../server/ai/provider";

export interface StubCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** What the stub should answer with, in order. The last entry repeats. */
export type StubReply =
  | { kind: "tool"; input: unknown }
  | { kind: "text"; text: string }
  | { kind: "refusal"; category?: string }
  | { kind: "error"; status: number; message: string; type?: string };

export interface StubOptions {
  replies?: StubReply[];
  usage?: { input: number; output: number };
  /** Delay every answer, for the timeout test. */
  delayMs?: number;
}

export interface StubResponse {
  status: number;
  body: Record<string, unknown>;
}

/** A believable suggestion, used whenever a test does not script one. */
export const DEFAULT_SUGGESTION = {
  urgency: 8,
  impact: 7,
  effort: 3,
  rationale: "Overdue, two cards wait on it, and the change is a one-file fix.",
  confidence: 0.76,
};

function nextReply(replies: StubReply[], index: number): StubReply {
  if (replies.length === 0) return { kind: "tool", input: DEFAULT_SUGGESTION };
  return replies[Math.min(index, replies.length - 1)];
}

export function aiStub(opts: StubOptions = {}) {
  const calls: StubCall[] = [];
  const replies = opts.replies ?? [];
  const usage = opts.usage ?? { input: 620, output: 90 };
  let served = 0;

  function anthropic(body: Record<string, unknown>): StubResponse {
    const reply = nextReply(replies, served++);
    const base = {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: String(body.model ?? "claude-haiku-4-5"),
      usage: { input_tokens: usage.input, output_tokens: usage.output },
    };
    if (reply.kind === "error") {
      return { status: reply.status, body: { type: "error", error: { type: reply.type ?? "invalid_request_error", message: reply.message } } };
    }
    if (reply.kind === "refusal") {
      return {
        status: 200,
        body: { ...base, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: reply.category ?? "cyber", explanation: "declined" } },
      };
    }
    if (reply.kind === "text") {
      return { status: 200, body: { ...base, content: [{ type: "text", text: reply.text }], stop_reason: "end_turn", stop_details: null } };
    }
    const tools = (body.tools ?? []) as { name?: string }[];
    const name = tools[0]?.name ?? "score_priority";
    return {
      status: 200,
      body: {
        ...base,
        content: [{ type: "tool_use", id: "toolu_stub", name, input: reply.input }],
        stop_reason: "tool_use",
        stop_details: null,
      },
    };
  }

  function openai(body: Record<string, unknown>): StubResponse {
    const reply = nextReply(replies, served++);
    const base = {
      id: "chatcmpl_stub",
      object: "chat.completion",
      model: String(body.model ?? "gpt-4o-mini"),
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    };
    if (reply.kind === "error") {
      return { status: reply.status, body: { error: { message: reply.message, type: reply.type ?? "invalid_request_error" } } };
    }
    if (reply.kind === "refusal") {
      return { status: 200, body: { ...base, choices: [{ index: 0, message: { role: "assistant", content: null, refusal: "declined" }, finish_reason: "stop" }] } };
    }
    const content = reply.kind === "text" ? reply.text : JSON.stringify(reply.input);
    return { status: 200, body: { ...base, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] } };
  }

  function route(method: string, path: string, body: Record<string, unknown>): StubResponse {
    if (method === "POST" && path === "/v1/messages") return anthropic(body);
    if (method === "POST" && path === "/v1/chat/completions") return openai(body);
    return { status: 404, body: { error: { message: `stub has no route for ${method} ${path}`, type: "invalid_request_error" } } };
  }

  function handle(method: string, url: string, rawBody: string, headers: Record<string, string> = {}): StubResponse {
    const [path] = url.split("?");
    let body: Record<string, unknown> = {};
    try {
      body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    calls.push({ method, path, body, headers });
    return route(method, path, body);
  }

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const url = input.replace(/^https?:\/\/[^/]+/, "");
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const rawBody = typeof init.body === "string" ? init.body : "";
    const { status, body } = handle(method, url, rawBody, headers);
    if (opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        // Honour the caller's AbortSignal so the timeout path is testable.
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response;
  };

  return {
    calls,
    fetchImpl,
    handle,
    /** Bodies sent to one path, in order. */
    bodiesTo: (path: string) => calls.filter((c) => c.path === path).map((c) => c.body),
    last: () => calls[calls.length - 1],
    served: () => served,
  };
}

/** The same router behind a real port, for the dev loop and the browser check. */
export function startAiStub(port: number, opts: StubOptions = {}): Promise<{ server: Server; stub: ReturnType<typeof aiStub> }> {
  const stub = aiStub(opts);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const { status, body } = stub.handle((req.method ?? "GET").toUpperCase(), req.url ?? "/", Buffer.concat(chunks).toString("utf8"));
      const payload = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stub })));
}

// `npx tsx tests/ai/stub.ts [port]` — a standing stub for the manual dev loop.
if (process.argv[1] && /tests[/\\]ai[/\\]stub\.ts$/.test(process.argv[1])) {
  const port = Number(process.argv[2] ?? 5599);
  void startAiStub(port).then(() => console.log(`[ai-stub] listening on http://127.0.0.1:${port}`));
}
