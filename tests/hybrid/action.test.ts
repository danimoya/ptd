import { describe, expect, it, vi } from "vitest";

// Registering the actions pulls in the whole server module graph, which opens a
// pool at import. Nothing here reaches a query: the role gate refuses before the
// handler runs, and the window is resolved by a pure function.
vi.mock("../../db", () => ({ db: { execute: async () => [] } }));

import { ActionError, getAction, runAction, type ActionContext } from "../../server/actions/registry";
import { hybridWindow } from "../../server/actions/hybrid";
import "../../server/actions/hybrid";

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 2,
  email: "elena@atelier14.demo",
  displayName: "Elena Draftworks",
  orgId: 5,
  role: "owner",
  authType: "human",
  via: "web",
  ...over,
});

/** Calendar days the window covers — `to` is the last day's 23:59:59.999. */
const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

describe("registration", () => {
  it("registers both reads at manager level, on the overview surface", () => {
    for (const name of ["hybrid.summary", "digest.preview"]) {
      const def = getAction(name);
      expect(def, name).toBeDefined();
      expect(def!.requiredRole).toBe("manager");
      expect(def!.surface).toBe("overview");
      expect(def!.description.length).toBeGreaterThan(80);
    }
  });
});

describe("role gate", () => {
  it("refuses a member — the whole point of the tab is other people's hours and dollars", async () => {
    await expect(runAction("hybrid.summary", {}, ctx({ role: "member" }))).rejects.toBeInstanceOf(ActionError);
    await expect(runAction("hybrid.summary", {}, ctx({ role: "member" }))).rejects.toMatchObject({ code: "forbidden" });
    await expect(runAction("digest.preview", {}, ctx({ role: "member" }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an argument that is not a date before anything touches the database", async () => {
    await expect(runAction("hybrid.summary", { from: 20260914 }, ctx())).rejects.toMatchObject({ code: "invalid" });
    await expect(runAction("hybrid.summary", { groupBy: "month" }, ctx())).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("hybridWindow", () => {
  it("defaults to the last thirty days, bucketed by day", () => {
    const w = hybridWindow({});
    expect(w.groupBy).toBe("day");
    expect(days(w.from, w.to)).toBe(30);
    expect(w.from.getHours()).toBe(0);
    expect(w.to.getHours()).toBe(23);
  });

  it("reads a bare calendar day as local midnight to local midnight", () => {
    const w = hybridWindow({ from: "2026-09-14", to: "2026-09-20" });
    expect(w.from.getFullYear()).toBe(2026);
    expect(w.from.getDate()).toBe(14);
    expect(w.to.getDate()).toBe(20);
    expect(days(w.from, w.to)).toBe(7);
  });

  it("counts back from an explicit `to` when only that is given", () => {
    const w = hybridWindow({ to: "2026-09-20" });
    expect(w.to.getDate()).toBe(20);
    expect(days(w.from, w.to)).toBe(30);
  });

  it("carries the bucket size through", () => {
    expect(hybridWindow({ groupBy: "week" }).groupBy).toBe("week");
  });

  it("refuses a backwards window", () => {
    expect(() => hybridWindow({ from: "2026-09-20", to: "2026-09-14" })).toThrow(ActionError);
  });

  it("refuses a window wider than a year — that is an export, not a dashboard", () => {
    expect(() => hybridWindow({ from: "2024-01-01", to: "2026-09-20" })).toThrow(/366/);
  });

  it("refuses a date it cannot read", () => {
    expect(() => hybridWindow({ from: "the ides of March" })).toThrow(ActionError);
  });
});
