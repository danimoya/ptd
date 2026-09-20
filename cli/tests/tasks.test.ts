/** Key resolution and the HTTP layer, against a stubbed fetch — no server needed. */
import { describe, expect, it, vi } from "vitest";
import { callAction, request, type Client } from "../src/api.ts";
import { ApiError, CliError } from "../src/errors.ts";
import { isTaskId, label, listTasks, resolveTask, resolveTaskId } from "../src/tasks.ts";

const TASKS = [
  { id: 3, title: "Add CSRF tokens to every form", externalKey: "SEC-3", status: "in-progress", priorityScore: 21, completed: false },
  { id: 4, title: "Pin TLS 1.3", externalKey: "SEC-4", status: "in-progress", priorityScore: 32, completed: false },
  { id: 9, title: "No key at all", externalKey: null, status: "backlog", priorityScore: 5, completed: false },
];

/** A `callAction` stand-in that records what was asked for. */
function stubCaller(tasks = TASKS) {
  const calls: { name: string; args: unknown }[] = [];
  const call = async (_client: Client, name: string, args?: unknown) => {
    calls.push({ name, args });
    if (name === "task.list") return { count: tasks.length, tasks };
    throw new Error(`unexpected action ${name}`);
  };
  return { call, calls };
}

const client: Client = { baseUrl: "https://ptd.example", token: "ptd_test" };

describe("resolveTask", () => {
  it("passes a numeric reference straight through", async () => {
    const { call } = stubCaller();
    expect(await resolveTaskId(client, "3", call)).toBe(3);
    expect(isTaskId("3")).toBe(true);
    expect(isTaskId("SEC-3")).toBe(false);
  });

  it("looks an external key up through task.list, completed cards included", async () => {
    const { call, calls } = stubCaller();
    const task = await resolveTask(client, "SEC-4", call);
    expect(task.id).toBe(4);
    expect(calls).toEqual([{ name: "task.list", args: { includeCompleted: true } }]);
  });

  it("matches a key case-insensitively", async () => {
    const { call } = stubCaller();
    expect(await resolveTaskId(client, "sec-3", call)).toBe(3);
  });

  it("names the known keys when nothing matches", async () => {
    const { call } = stubCaller();
    await expect(resolveTask(client, "NOPE-9", call)).rejects.toThrow(/No task with external key "NOPE-9"/);
    await expect(resolveTask(client, "NOPE-9", call)).rejects.toThrow(/SEC-3, SEC-4/);
    await expect(resolveTask(client, "NOPE-9", call)).rejects.toBeInstanceOf(CliError);
  });

  it("refuses an ambiguous key instead of guessing", async () => {
    const { call } = stubCaller([
      { ...TASKS[0], id: 1, externalKey: "dup" },
      { ...TASKS[0], id: 2, externalKey: "DUP" },
    ]);
    await expect(resolveTask(client, "Dup", call)).rejects.toThrow(/matches 2 tasks \(ids 1, 2\)/);
  });

  it("keeps an id the list does not carry, so the action itself reports it", async () => {
    const { call } = stubCaller();
    expect((await resolveTask(client, "9999", call)).id).toBe(9999);
  });

  it("labels a card for one line of output", () => {
    expect(label(TASKS[0])).toBe("SEC-3 · #3 Add CSRF tokens to every form");
    expect(label(TASKS[2])).toBe("#9 No key at all");
    expect(label(null)).toBe("(no task)");
  });
});

describe("listTasks", () => {
  it("drops anything that is not a task row", async () => {
    const { call } = stubCaller([...TASKS, null, { title: "no id" }] as never);
    expect((await listTasks(client, call)).map((t) => t.id)).toEqual([3, 4, 9]);
  });
});

describe("request", () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  it("sends the bearer token and the org header", async () => {
    const fetchImpl = ok({ ok: true });
    await callAction({ ...client, orgId: 7, fetchImpl: fetchImpl as never }, "whoami");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ptd.example/api/actions/whoami");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ptd_test");
    expect((init.headers as Record<string, string>)["X-Org-Id"]).toBe("7");
    expect(init.body).toBe("{}");
  });

  it("omits the org header when no organization is selected", async () => {
    const fetchImpl = ok([]);
    await request({ ...client, fetchImpl: fetchImpl as never }, "/api/orgs");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Org-Id"]).toBeUndefined();
  });

  it("turns {error, message} into an ApiError carrying both", async () => {
    const fetchImpl = ok({ error: "forbidden", message: "stats requires role manager or higher" }, 403);
    await expect(callAction({ ...client, fetchImpl: fetchImpl as never }, "stats")).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: "stats requires role manager or higher",
    });
  });

  it("reports a transport failure as a network error, not a crash", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(callAction({ ...client, fetchImpl: fetchImpl as never }, "whoami")).rejects.toMatchObject({ code: "network" });
  });

  it("refuses to call an authenticated route with no credential", async () => {
    await expect(callAction({ baseUrl: "https://ptd.example" }, "whoami")).rejects.toBeInstanceOf(ApiError);
  });
});
