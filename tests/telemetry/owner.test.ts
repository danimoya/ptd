import { describe, expect, it, vi } from "vitest";

/**
 * The owner gate.
 *
 * Telemetry is instance-wide, so the gate cannot be "owner of the org in the
 * X-Org-Id header" — it is "owner of at least one organization on this
 * deployment". A member, manager or admin gets 403 and is told nothing about the
 * install, not even the id.
 */
vi.mock("../../db", () => ({ db: {} }));

import { ownerGate } from "../../server/telemetry/routes";

function res() {
  const sent: { status: number; body: unknown } = { status: 200, body: null };
  const r = {
    status(code: number) {
      sent.status = code;
      return r;
    },
    json(body: unknown) {
      sent.body = body;
      return r;
    },
  };
  return { r, sent };
}

describe("ownerGate", () => {
  it("passes an owner through", async () => {
    const next = vi.fn();
    const { r, sent } = res();
    await ownerGate(async () => true)({ user: [{ id: 7 }] } as never, r as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(sent.body).toBeNull();
  });

  it("refuses everyone else with 403 and no part of the record", async () => {
    const next = vi.fn();
    const { r, sent } = res();
    await ownerGate(async () => false)({ user: [{ id: 7 }] } as never, r as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(sent.status).toBe(403);
    expect(JSON.stringify(sent.body)).not.toMatch(/[a-f0-9]{16,}/);
  });

  it("refuses an unauthenticated request with 401", async () => {
    const next = vi.fn();
    const { r, sent } = res();
    await ownerGate(async () => true)({} as never, r as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(sent.status).toBe(401);
  });

  it("fails closed when the ownership lookup throws", async () => {
    const next = vi.fn();
    const { r, sent } = res();
    await ownerGate(async () => {
      throw new Error("database down");
    })({ user: [{ id: 7 }] } as never, r as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(sent.status).toBe(500);
  });

  it("asks about the caller, not about a user id from the request body", async () => {
    const seen: number[] = [];
    const next = vi.fn();
    const { r } = res();
    await ownerGate(async (id) => {
      seen.push(id);
      return true;
    })({ user: [{ id: 42 }], body: { userId: 1 }, query: { userId: "1" } } as never, r as never, next);
    expect(seen).toEqual([42]);
  });
});
