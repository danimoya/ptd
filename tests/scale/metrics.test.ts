import { beforeEach, describe, expect, it } from "vitest";
import {
  Counter,
  Gauge,
  Histogram,
  MAX_SERIES_PER_METRIC,
  renderMetrics,
  resetMetrics,
} from "../../server/metrics/registry";
import { normalisePath, outcomeForStatus, recordAction, routeOf, actionCalls } from "../../server/metrics/http";
import { isLoopback, metricsGuard, METRICS_CONTENT_TYPE } from "../../server/metrics/health";

/**
 * The exposition format is a contract with Prometheus, not a log line: a stray label
 * quote or a bucket out of order makes a scrape fail, and a scrape that fails is an
 * alert that never arrives. These tests parse what the registry renders.
 */

const counter = new Counter("test_requests_total", "Requests, for the tests.");
const gauge = new Gauge("test_queue_depth", "Queue depth, for the tests.");
const histogram = new Histogram("test_duration_seconds", "Durations, for the tests.", [0.1, 1]);

beforeEach(() => resetMetrics());

/** A minimal exposition-format parser: enough to prove the output is machine-readable. */
function parse(text: string) {
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
  const help: Record<string, string> = {};
  const types: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const helpMatch = /^# HELP (\S+) (.*)$/.exec(line);
    if (helpMatch) {
      help[helpMatch[1]] = helpMatch[2];
      continue;
    }
    const typeMatch = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (typeMatch) {
      types[typeMatch[1]] = typeMatch[2];
      continue;
    }
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (-?[0-9.eE+]+|[+-]Inf|NaN)$/.exec(line);
    expect(sample, `unparsable line: ${line}`).not.toBeNull();
    const labels: Record<string, string> = {};
    if (sample![2]) {
      for (const pair of sample![2].slice(1, -1).matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
        labels[pair[1]] = pair[2];
      }
    }
    samples.push({ name: sample![1], labels, value: Number(sample![3]) });
  }
  return { samples, help, types };
}

describe("the registry's exposition format", () => {
  it("renders HELP, TYPE and one parsable sample line per label set", () => {
    counter.inc({ route: "/api/tasks", status: 200 });
    counter.inc({ route: "/api/tasks", status: 200 });
    counter.inc({ route: "/api/tasks", status: 500 });
    gauge.set(3);

    const { samples, help, types } = parse(renderMetrics());
    expect(help.test_requests_total).toBe("Requests, for the tests.");
    expect(types.test_requests_total).toBe("counter");
    expect(types.test_queue_depth).toBe("gauge");
    const hits = samples.filter((s) => s.name === "test_requests_total");
    expect(hits).toHaveLength(2);
    expect(hits.find((s) => s.labels.status === "200")!.value).toBe(2);
    expect(samples.find((s) => s.name === "test_queue_depth")!.value).toBe(3);
  });

  it("renders a histogram as cumulative buckets plus _sum and _count", () => {
    histogram.observe(0.05, { route: "/api/x" });
    histogram.observe(0.5, { route: "/api/x" });
    histogram.observe(9, { route: "/api/x" });

    const { samples, types } = parse(renderMetrics());
    expect(types.test_duration_seconds).toBe("histogram");
    const buckets = samples.filter((s) => s.name === "test_duration_seconds_bucket");
    expect(buckets.map((b) => [b.labels.le, b.value])).toEqual([
      ["0.1", 1],
      ["1", 2],
      ["+Inf", 3],
    ]);
    expect(samples.find((s) => s.name === "test_duration_seconds_count")!.value).toBe(3);
    expect(samples.find((s) => s.name === "test_duration_seconds_sum")!.value).toBeCloseTo(9.55, 6);
  });

  it("escapes a label value that would otherwise break the line", () => {
    counter.inc({ route: 'weird"\\path' });
    const rendered = renderMetrics();
    expect(rendered).toContain('route="weird\\"\\\\path"');
    expect(() => parse(rendered)).not.toThrow();
  });

  it("stops adding series at the cardinality cap and counts what it dropped", () => {
    for (let i = 0; i < MAX_SERIES_PER_METRIC + 25; i++) counter.inc({ route: `/r/${i}` });
    expect(counter.size).toBe(MAX_SERIES_PER_METRIC);
    const dropped = parse(renderMetrics()).samples.find(
      (s) => s.name === "ptd_metrics_series_dropped_total" && s.labels.metric === "test_requests_total",
    );
    expect(dropped!.value).toBe(25);
  });

  it("omits a metric nobody has touched, so an empty scrape is empty", () => {
    expect(renderMetrics()).not.toContain("test_requests_total");
  });
});

describe("route labels", () => {
  it("replaces the parts of a path that would explode the cardinality", () => {
    expect(normalisePath("/api/tasks/42")).toBe("/api/tasks/:n");
    expect(normalisePath("/api/ical/ptd_deadbeefdeadbeef/me.ics")).toBe("/api/ical/:token/me.ics");
    expect(normalisePath("/api/x/3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe("/api/x/:uuid");
    expect(normalisePath("/api/attachments/9f86d081884c7d659a2feaa0c55ad015")).toBe("/api/attachments/:hex");
    expect(normalisePath("/overview")).toBe("/overview");
    expect(normalisePath(`/api/${"x".repeat(60)}`)).toBe("/api/:long");
  });

  it("keeps the mount prefix when no route matched, so /.well-known/x is not just /x", () => {
    const req = { path: "/ai-agent.json", originalUrl: "/.well-known/ai-agent.json?x=1", baseUrl: "/.well-known" } as never;
    expect(routeOf(req)).toBe("/.well-known/ai-agent.json");
  });

  it("caps a pathological path rather than emitting a kilobyte of label", () => {
    const label = normalisePath("/api/" + "seg/".repeat(200));
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith("...")).toBe(true);
  });
});

describe("the action counter", () => {
  it("splits a caller's mistake from ours", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(302)).toBe("ok");
    expect(outcomeForStatus(403)).toBe("refused");
    expect(outcomeForStatus(500)).toBe("error");
  });

  it("counts by action, surface and outcome", () => {
    recordAction("task.create", "http", "ok");
    recordAction("task.create", "mcp", "ok");
    recordAction("task.create", "mcp", "refused");
    expect(actionCalls.get({ action: "task.create", surface: "mcp", outcome: "ok" })).toBe(1);
    expect(actionCalls.get({ action: "task.create", surface: "http", outcome: "ok" })).toBe(1);
    expect(actionCalls.get({ action: "task.create", surface: "mcp", outcome: "error" })).toBe(0);
  });
});

describe("who may scrape", () => {
  it("is the exposition content type", () => {
    expect(METRICS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("wants the bearer token when METRICS_TOKEN is set, and nothing else will do", () => {
    expect(metricsGuard({ token: "s3cret", authorization: "Bearer s3cret" })).toMatchObject({ allowed: true, reason: "token" });
    expect(metricsGuard({ token: "s3cret", authorization: "Bearer nope" })).toMatchObject({ allowed: false, status: 401 });
    expect(metricsGuard({ token: "s3cret", socketAddress: "127.0.0.1" })).toMatchObject({ allowed: false, status: 401 });
  });

  it("falls back to loopback only, and a forwarded request is never loopback", () => {
    expect(metricsGuard({ socketAddress: "127.0.0.1" })).toMatchObject({ allowed: true, reason: "loopback" });
    expect(metricsGuard({ socketAddress: "::1" })).toMatchObject({ allowed: true });
    expect(metricsGuard({ socketAddress: "10.0.0.7" })).toMatchObject({ allowed: false, reason: "not_loopback" });
    // A proxy on the same host connects from 127.0.0.1 on behalf of the internet.
    expect(metricsGuard({ socketAddress: "127.0.0.1", forwarded: "203.0.113.9" })).toMatchObject({
      allowed: false,
      reason: "forwarded",
    });
  });

  it("knows a loopback address from a routable one", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("127.13.2.9")).toBe(true);
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
