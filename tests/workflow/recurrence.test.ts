import { describe, expect, it } from "vitest";

/**
 * The recurrence rule grammar.
 *
 * Two things are being protected here: the grammar itself (what the scheduler
 * will do, in UTC, for every shape of rule), and the fact that the client's copy
 * of the module agrees with the server's — the dialog previews a rule before the
 * server has ever seen it, so a divergence would show the user one schedule and
 * store another.
 */
import * as server from "../../server/plan/recurrence";
import * as client from "../../client/src/features/plan/recurrence";

const at = (iso: string) => new Date(iso);

describe("parseRule", () => {
  it("accepts every cadence in the grammar and normalises it", () => {
    const cases: [string, string][] = [
      ["daily", "daily at:09:00"],
      ["DAILY at:07:05", "daily at:07:05"],
      ["weekdays", "weekdays at:09:00"],
      ["weekly:mon,wed", "weekly:mon,wed at:09:00"],
      // A person types the comma list with spaces; it is still one cadence.
      ["weekly:mon, wed", "weekly:mon,wed at:09:00"],
      ["weekly:wed,mon,mon", "weekly:mon,wed at:09:00"],
      ["weekly:monday,friday", "weekly:mon,fri at:09:00"],
      ["monthly:15", "monthly:15 at:09:00"],
      ["every:3d", "every:3d at:09:00"],
      ["every:2w at:23:59", "every:2w at:23:59"],
    ];
    for (const [input, canonical] of cases) {
      const parsed = server.parseRule(input);
      expect(parsed.ok, `${input}: ${parsed.ok ? "" : parsed.error}`).toBe(true);
      if (parsed.ok) expect(parsed.canonical).toBe(canonical);
    }
  });

  it("refuses anything else, with a message that names the grammar", () => {
    for (const bad of ["", "   ", "fortnightly", "weekly", "weekly:funday", "monthly", "monthly:0", "monthly:32", "every", "every:3y", "every:0d", "daily at:25:00", "daily at:9", "daily weekly:mon"]) {
      const parsed = server.parseRule(bad);
      expect(parsed.ok, `"${bad}" should not parse`).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(10);
    }
  });

  it("re-parses its own canonical form to the same rule", () => {
    for (const input of ["daily", "weekdays at:07:30", "weekly:tue,thu", "monthly:1", "every:5d", "every:1w"]) {
      const first = server.parseRule(input);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = server.parseRule(first.canonical);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.rule).toEqual(first.rule);
    }
  });
});

describe("nextRunAfter", () => {
  const next = (rule: string, from: string) => {
    const parsed = server.parseRule(rule);
    if (!parsed.ok) throw new Error(parsed.error);
    return server.nextRunAfter(parsed.rule, at(from)).toISOString();
  };

  it("is always strictly in the future, so feeding a firing back in advances it", () => {
    expect(next("daily at:09:00", "2026-09-20T09:00:00.000Z")).toBe("2026-09-21T09:00:00.000Z");
    expect(next("daily at:09:00", "2026-09-20T08:59:59.000Z")).toBe("2026-09-20T09:00:00.000Z");
  });

  it("skips the weekend for weekdays", () => {
    // 2026-09-18 is a Friday: the next weekday firing is Monday the 21st.
    expect(next("weekdays at:06:00", "2026-09-18T12:00:00.000Z")).toBe("2026-09-21T06:00:00.000Z");
    expect(next("weekdays at:06:00", "2026-09-19T00:00:00.000Z")).toBe("2026-09-21T06:00:00.000Z");
  });

  it("lands on the named weekdays only", () => {
    // Sunday the 20th → Monday, then Wednesday.
    const monday = next("weekly:mon,wed", "2026-09-20T12:00:00.000Z");
    expect(monday).toBe("2026-09-21T09:00:00.000Z");
    expect(next("weekly:mon,wed", monday)).toBe("2026-09-23T09:00:00.000Z");
  });

  it("clamps a monthly day to the length of a short month", () => {
    expect(next("monthly:31", "2026-09-01T00:00:00.000Z")).toBe("2026-09-30T09:00:00.000Z");
    expect(next("monthly:31", "2026-09-30T10:00:00.000Z")).toBe("2026-10-31T09:00:00.000Z");
    // February 2028 is a leap month: the 29th exists, the 31st does not.
    expect(next("monthly:29", "2028-02-01T00:00:00.000Z")).toBe("2028-02-29T09:00:00.000Z");
    expect(next("monthly:31", "2027-02-01T00:00:00.000Z")).toBe("2027-02-28T09:00:00.000Z");
  });

  it("steps a fixed cadence by whole days or weeks", () => {
    expect(next("every:3d at:06:00", "2026-09-20T07:00:00.000Z")).toBe("2026-09-23T06:00:00.000Z");
    expect(next("every:2w", "2026-09-20T12:00:00.000Z")).toBe("2026-10-04T09:00:00.000Z");
  });
});

describe("catchUp", () => {
  it("skips the firings a paused rule missed instead of replaying them", () => {
    const parsed = server.parseRule("daily at:09:00");
    if (!parsed.ok) throw new Error(parsed.error);
    const missedSince = at("2026-08-01T09:00:00.000Z");
    const now = at("2026-09-20T12:00:00.000Z");
    // The next firing is tomorrow, not the 2nd of August 50 times over.
    expect(server.catchUp(parsed.rule, missedSince, now).toISOString()).toBe("2026-09-21T09:00:00.000Z");
  });
});

describe("describeRule", () => {
  const say = (rule: string) => {
    const parsed = server.parseRule(rule);
    if (!parsed.ok) throw new Error(parsed.error);
    return server.describeRule(parsed.rule);
  };

  it("reads as a sentence, and says UTC out loud", () => {
    expect(say("daily")).toBe("every day at 09:00 UTC");
    expect(say("weekdays at:07:30")).toBe("every weekday at 07:30 UTC");
    expect(say("weekly:mon,wed")).toBe("every Monday and Wednesday at 09:00 UTC");
    expect(say("weekly:mon,wed,fri")).toBe("every Monday, Wednesday and Friday at 09:00 UTC");
    expect(say("monthly:1")).toBe("on the 1st of each month at 09:00 UTC");
    expect(say("monthly:22")).toBe("on the 22nd of each month at 09:00 UTC");
    expect(say("monthly:13")).toBe("on the 13th of each month at 09:00 UTC");
    expect(say("every:3d")).toBe("every 3 days at 09:00 UTC");
    expect(say("every:1w")).toBe("every week at 09:00 UTC");
  });
});

describe("instanceKey", () => {
  it("stamps the template key with the firing's UTC day", () => {
    expect(server.instanceKey("SEC-6", at("2026-09-20T23:30:00.000Z"))).toBe("SEC-6-20260920");
    expect(server.instanceKey("TASK-12", at("2026-01-05T00:00:00.000Z"))).toBe("TASK-12-20260105");
  });
});

describe("the client's copy", () => {
  const RULES = [
    "daily",
    "daily at:23:15",
    "weekdays",
    "weekly:mon,wed",
    "weekly:sat,sun at:10:00",
    "monthly:31",
    "monthly:1 at:00:00",
    "every:3d",
    "every:2w at:06:30",
    "fortnightly",
    "weekly:funday",
    "",
  ];
  const FROM = ["2026-09-20T12:00:00.000Z", "2026-09-18T06:00:00.000Z", "2026-02-27T23:59:00.000Z", "2027-12-31T09:00:00.000Z"];

  it("parses, previews and schedules exactly like the server's", () => {
    for (const rule of RULES) {
      const a = server.parseRule(rule);
      const b = client.parseRule(rule);
      expect(b, rule).toEqual(a);
      if (!a.ok || !b.ok) continue;
      expect(client.describeRule(b.rule)).toBe(server.describeRule(a.rule));
      for (const from of FROM) {
        expect(client.nextRunAfter(b.rule, at(from)).toISOString(), `${rule} from ${from}`).toBe(
          server.nextRunAfter(a.rule, at(from)).toISOString()
        );
      }
    }
  });
});
