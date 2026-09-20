import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistentFlag, usePersistentState } from "../../client/src/features/plan/usePersistentState";

/**
 * The board's two remembered preferences: "which view was I in" and "was the
 * backlog folded away". The global test setup stubs localStorage with bare
 * spies, so give these a real in-memory store.
 */
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

describe("usePersistentFlag — the hidden backlog", () => {
  it("falls back until something is written, then round-trips", () => {
    const { result } = renderHook(() => usePersistentFlag("ptd.plan.sidebarHidden", false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(store.get("ptd.plan.sidebarHidden")).toBe("1");

    const reload = renderHook(() => usePersistentFlag("ptd.plan.sidebarHidden", false));
    expect(reload.result.current[0]).toBe(true);
  });

  it('stores "0" rather than an absent key, so a true fallback stays overridable', () => {
    store.set("ptd.plan.sidebarHidden", "0");
    const { result } = renderHook(() => usePersistentFlag("ptd.plan.sidebarHidden", true));
    expect(result.current[0]).toBe(false);
  });

  it("ignores a value it did not write", () => {
    store.set("ptd.plan.sidebarHidden", "yes please");
    const { result } = renderHook(() => usePersistentFlag("ptd.plan.sidebarHidden", true));
    expect(result.current[0]).toBe(true);
  });

  it("survives a localStorage that throws (private window)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    });
    const { result } = renderHook(() => usePersistentFlag("ptd.plan.sidebarHidden", false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe("usePersistentState — the remembered view", () => {
  it("remembers the last view and rejects one that is no longer offered", () => {
    const views = ["board", "timeline", "cascade"] as const;
    const { result } = renderHook(() => usePersistentState("ptd.plan.view", "board", views));
    act(() => result.current[1]("cascade"));
    expect(store.get("ptd.plan.view")).toBe("cascade");
    expect(renderHook(() => usePersistentState("ptd.plan.view", "board", views)).result.current[0]).toBe("cascade");

    store.set("ptd.plan.view", "gallery");
    expect(renderHook(() => usePersistentState("ptd.plan.view", "board", views)).result.current[0]).toBe("board");
  });
});
