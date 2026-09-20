import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const DoorsPanel = (await import("../../client/src/features/landing/DoorsPanel")).default;
const { ACTIONS, allows, renderCall, renderResult } = await import(
  "../../client/src/features/landing/DoorsPanel"
);

const stop = ACTIONS.find((a) => a.name === "time_entry.stop")!;
const schedule = ACTIONS.find((a) => a.name === "task.schedule")!;

describe("role gate", () => {
  it("lets every role stop its own timer", () => {
    expect(allows("member", "member")).toBe(true);
    expect(allows("manager", "member")).toBe(true);
    expect(allows("admin", "member")).toBe(true);
  });

  it("keeps a member out of manager and admin actions", () => {
    expect(allows("member", "manager")).toBe(false);
    expect(allows("member", "admin")).toBe(false);
    expect(allows("manager", "manager")).toBe(true);
    expect(allows("manager", "admin")).toBe(false);
    expect(allows("admin", "admin")).toBe(true);
  });

  it("answers a blocked call with a 403 that names the role it needs", () => {
    const blocked = renderResult("member", schedule);
    expect(blocked.ok).toBe(false);
    expect(blocked.body).toContain("403 forbidden");
    expect(blocked.body).toContain("task.schedule needs manager");

    expect(renderResult("manager", schedule).ok).toBe(true);
  });
});

describe("the four dialects of one action", () => {
  it("carries the same arguments through every door", () => {
    expect(renderCall("mcp", stop)).toContain('"method": "tools/call"');
    expect(renderCall("mcp", stop)).toContain('"tokensUsed":15400');
    expect(renderCall("rest", stop)).toContain("POST https://ptd.example.com/api/actions/time_entry.stop");
    expect(renderCall("rest", stop)).toContain('"apiCostUsd":0.21');
    expect(renderCall("slack", stop)).toBe("/ptd stop tokens=15400 cost=0.21");
    expect(renderCall("connector", stop)).toContain("time_entry.stop");
  });
});

describe("<DoorsPanel />", () => {
  it("opens on MCP with time_entry.stop allowed", () => {
    render(<DoorsPanel />);
    expect(screen.getByTestId("door-call").textContent).toContain('"tools/call"');
    expect(screen.getByTestId("door-result").textContent).toContain("200 ok");
  });

  it("switches dialect when a door is picked", async () => {
    render(<DoorsPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Slack" }));
    expect(screen.getByTestId("door-call").textContent).toBe("/ptd stop tokens=15400 cost=0.21");

    await userEvent.click(screen.getByRole("button", { name: "REST" }));
    expect(screen.getByTestId("door-call").textContent).toContain("curl -sX POST");
  });

  it("greys task.schedule for a member and opens it for a manager", async () => {
    render(<DoorsPanel />);
    expect(screen.getByTestId("roll-task.schedule").textContent).toContain("403 · needs manager");

    await userEvent.click(screen.getByTestId("roll-task.schedule"));
    expect(screen.getByTestId("door-result").textContent).toContain("403 forbidden");

    await userEvent.click(screen.getByRole("button", { name: "manager" }));
    expect(screen.getByTestId("roll-task.schedule").textContent).toContain("allowed");
    expect(screen.getByTestId("door-result").textContent).toContain("200 ok");
  });

  it("still blocks an admin-only action for a manager", async () => {
    render(<DoorsPanel />);
    await userEvent.click(screen.getByRole("button", { name: "manager" }));
    expect(screen.getByTestId("roll-webhook.create").textContent).toContain("403 · needs admin");

    await userEvent.click(screen.getByRole("button", { name: "admin" }));
    expect(screen.getByTestId("roll-webhook.create").textContent).toContain("allowed");
  });
});
