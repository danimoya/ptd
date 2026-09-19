import { describe, expect, it, vi } from "vitest";

// parseSlashBody lives next to the db-backed identity helpers; nothing here touches
// the database, so the module is stubbed rather than a connection configured.
vi.mock("../../db", () => ({ db: {} }));

import {
  cleanCommandText,
  extractKeyValues,
  flattenSlackLinks,
  formatMinutes,
  normaliseTaskRef,
  parseCommandText,
  parseDuration,
  parseIsoDate,
  parseNumber,
  parsePositiveInt,
  unescapeSlackText,
} from "../../server/integrations/slack/parse";
import { parseSlashBody } from "../../server/integrations/slack/commands";

describe("parseDuration", () => {
  it("reads the shapes people type", () => {
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("1h30m")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("90min")).toBe(90);
    expect(parseDuration("1hr")).toBe(60);
    expect(parseDuration("2 hours")).toBe(120);
    expect(parseDuration("45M")).toBe(45);
  });

  it("refuses anything that is not a duration", () => {
    for (const bad of ["", "   ", "soon", "m", "h", "0m", "0", "-30m", "1h2h", "30s", "1.5h", "PTD-12"]) {
      expect(parseDuration(bad), bad).toBeNull();
    }
  });
});

describe("formatMinutes", () => {
  it("is compact and never says 0h", () => {
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(60)).toBe("1h");
    expect(formatMinutes(90)).toBe("1h 30m");
    expect(formatMinutes(605)).toBe("10h 5m");
  });
});

describe("parseCommandText", () => {
  it("splits the subcommand from its arguments and keeps the remainder", () => {
    expect(parseCommandText("start PTD-12 fixing the parser")).toEqual({
      sub: "start",
      args: ["PTD-12", "fixing", "the", "parser"],
      rest: "PTD-12 fixing the parser",
    });
    expect(parseCommandText("  NEXT  ")).toEqual({ sub: "next", args: [], rest: "" });
    expect(parseCommandText("")).toEqual({ sub: "", args: [], rest: "" });
  });

  it("undoes Slack's escaping and auto-linking", () => {
    expect(unescapeSlackText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    expect(flattenSlackLinks("see <https://ptd.example.com/plan|the plan>")).toBe("see the plan");
    expect(flattenSlackLinks("ping <@U123|bob> in <#C456|general>")).toBe("ping @bob in #general");
    expect(cleanCommandText("stop  notes   with &amp; spaces")).toBe("stop notes with & spaces");
  });
});

describe("extractKeyValues", () => {
  it("pulls only the wanted keys and leaves the note alone", () => {
    expect(extractKeyValues(["tokens=1200", "cost=0.12", "shipped", "the", "adapter"], ["tokens", "cost"])).toEqual({
      values: { tokens: "1200", cost: "0.12" },
      rest: ["shipped", "the", "adapter"],
    });
    expect(extractKeyValues(["ratio=1:2", "done"], ["tokens"])).toEqual({ values: {}, rest: ["ratio=1:2", "done"] });
    expect(extractKeyValues(["TOKENS=5"], ["tokens"]).values).toEqual({ tokens: "5" });
    expect(extractKeyValues(["=5"], ["tokens"]).rest).toEqual(["=5"]);
  });
});

describe("scalar parsers", () => {
  it("parseNumber accepts money-ish input and refuses the rest", () => {
    expect(parseNumber("0.12")).toBe(0.12);
    expect(parseNumber("$1,200")).toBe(1200);
    expect(parseNumber("-1")).toBeNull();
    expect(parseNumber("lots")).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
  });

  it("parseIsoDate takes YYYY-MM-DD only, and only real dates", () => {
    expect(parseIsoDate("2026-10-01")).toBe("2026-10-01");
    expect(parseIsoDate(" 2026-10-01 ")).toBe("2026-10-01");
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("01/10/2026")).toBeNull();
    expect(parseIsoDate("next-week")).toBeNull();
  });

  it("parsePositiveInt is for day counts", () => {
    expect(parsePositiveInt("3")).toBe(3);
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("3.5")).toBeNull();
    expect(parsePositiveInt("three")).toBeNull();
  });

  it("normaliseTaskRef strips the sigil and trailing punctuation", () => {
    expect(normaliseTaskRef("#42")).toBe("42");
    expect(normaliseTaskRef(" PTD-12. ")).toBe("PTD-12");
    expect(normaliseTaskRef("PTD-12,")).toBe("PTD-12");
  });
});

describe("parseSlashBody", () => {
  it("reads Slack's urlencoded slash-command payload", () => {
    const raw = new URLSearchParams({
      token: "legacy",
      team_id: "T111",
      team_domain: "acme",
      channel_id: "C222",
      channel_name: "general",
      user_id: "U333",
      user_name: "dani",
      command: "/ptd",
      text: "start PTD-12 fixing &amp; shipping",
      response_url: "https://hooks.slack.com/commands/T111/1/abc",
      trigger_id: "trig",
      api_app_id: "A444",
    }).toString();
    expect(parseSlashBody(raw)).toEqual({
      teamId: "T111",
      teamDomain: "acme",
      channelId: "C222",
      channelName: "general",
      userId: "U333",
      userName: "dani",
      command: "/ptd",
      text: "start PTD-12 fixing &amp; shipping",
      responseUrl: "https://hooks.slack.com/commands/T111/1/abc",
      triggerId: "trig",
      apiAppId: "A444",
    });
  });

  it("survives a payload with nothing in it", () => {
    const payload = parseSlashBody("");
    expect(payload.teamId).toBe("");
    expect(payload.userId).toBe("");
    expect(payload.text).toBe("");
  });
});
