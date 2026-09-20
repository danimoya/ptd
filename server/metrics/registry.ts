/**
 * A very small Prometheus registry.
 *
 * Three primitives (counter, gauge, histogram), the text exposition format, and a
 * cardinality cap. It is deliberately hand-rolled: `prom-client` would be a
 * dependency, package.json is frozen for this work, and what a single-process app
 * needs from a registry is a hundred lines.
 *
 * Metric names follow the convention the rest of the ecosystem expects — base unit
 * in the name (`_seconds`, `_bytes`), `_total` on counters — because a dashboard
 * built for PTD should not need a translation table.
 */

export type LabelValues = Record<string, string | number | undefined>;

const REGISTRY: Metric[] = [];
/**
 * Per-metric ceiling on distinct label sets. A route label built from a URL is one
 * mistake away from unbounded, and a metrics endpoint that grows without limit is a
 * memory leak that only shows up in production. Overflow is counted, not hidden.
 */
export const MAX_SERIES_PER_METRIC = 500;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function keyOf(labels: LabelValues): string {
  const entries = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(",");
}

function labelsOf(labels: LabelValues): string {
  const entries = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(String(v))}"`).join(",")}}`;
}

/** A number as Prometheus wants it: integers plain, floats short, no exponent games. */
function fmt(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN";
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e6) / 1e6);
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
  ) {
    REGISTRY.push(this);
  }
  abstract render(): string[];
  abstract reset(): void;

  protected header(): string[] {
    return [`# HELP ${this.name} ${this.help.replace(/\n/g, " ")}`, `# TYPE ${this.name} ${this.type}`];
  }
}

class SeriesMetric extends Metric {
  protected values = new Map<string, { labels: LabelValues; value: number }>();

  protected slot(labels: LabelValues): { labels: LabelValues; value: number } | null {
    const key = keyOf(labels);
    const existing = this.values.get(key);
    if (existing) return existing;
    if (this.values.size >= MAX_SERIES_PER_METRIC) {
      seriesDropped.inc({ metric: this.name });
      return null;
    }
    const fresh = { labels, value: 0 };
    this.values.set(key, fresh);
    return fresh;
  }

  render(): string[] {
    if (this.values.size === 0) return [];
    return [...this.header(), ...Array.from(this.values.values()).map((s) => `${this.name}${labelsOf(s.labels)} ${fmt(s.value)}`)];
  }

  reset(): void {
    this.values.clear();
  }

  /** Distinct label sets currently held — the tests assert the cap with this. */
  get size(): number {
    return this.values.size;
  }
}

export class Counter extends SeriesMetric {
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }
  inc(labels: LabelValues = {}, by = 1): void {
    const slot = this.slot(labels);
    if (slot) slot.value += by;
  }
  get(labels: LabelValues = {}): number {
    return this.values.get(keyOf(labels))?.value ?? 0;
  }
}

export class Gauge extends SeriesMetric {
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }
  set(value: number, labels: LabelValues = {}): void {
    const slot = this.slot(labels);
    if (slot) slot.value = value;
  }
  inc(labels: LabelValues = {}, by = 1): void {
    const slot = this.slot(labels);
    if (slot) slot.value += by;
  }
  dec(labels: LabelValues = {}, by = 1): void {
    this.inc(labels, -by);
  }
  get(labels: LabelValues = {}): number {
    return this.values.get(keyOf(labels))?.value ?? 0;
  }
}

/** Seconds, log-ish spread from 5 ms to 10 s: web requests and action handlers. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  private series = new Map<string, { labels: LabelValues; counts: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help, "histogram");
  }

  observe(value: number, labels: LabelValues = {}): void {
    const key = keyOf(labels);
    let row = this.series.get(key);
    if (!row) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        seriesDropped.inc({ metric: this.name });
        return;
      }
      row = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, row);
    }
    row.sum += value;
    row.count += 1;
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) row.counts[i] += 1;
  }

  render(): string[] {
    if (this.series.size === 0) return [];
    const lines = this.header();
    for (const row of this.series.values()) {
      // counts[i] already holds "observations <= buckets[i]" — observe() bumps every
      // bucket the value fits in, so the series is cumulative by construction.
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket${labelsOf({ ...row.labels, le: fmt(this.buckets[i]) })} ${fmt(row.counts[i])}`);
      }
      lines.push(`${this.name}_bucket${labelsOf({ ...row.labels, le: "+Inf" })} ${fmt(row.count)}`);
      lines.push(`${this.name}_sum${labelsOf(row.labels)} ${fmt(row.sum)}`);
      lines.push(`${this.name}_count${labelsOf(row.labels)} ${fmt(row.count)}`);
    }
    return lines;
  }

  reset(): void {
    this.series.clear();
  }

  get size(): number {
    return this.series.size;
  }
}

/* ── collectors ──────────────────────────────────────────────────────────── */

type Collector = () => void;
const collectors: Collector[] = [];

/** Runs just before a scrape renders: for values that are read, not accumulated. */
export function registerCollector(collect: Collector): void {
  collectors.push(collect);
}

const seriesDropped = new Counter(
  "ptd_metrics_series_dropped_total",
  "Label sets refused because a metric hit its cardinality cap.",
);

/** The whole registry in Prometheus text exposition format, newline-terminated. */
export function renderMetrics(): string {
  for (const collect of collectors) {
    try {
      collect();
    } catch (err) {
      console.warn("[metrics] collector failed:", err instanceof Error ? err.message : err);
    }
  }
  const lines: string[] = [];
  for (const metric of REGISTRY) lines.push(...metric.render());
  return lines.join("\n") + "\n";
}

/** Test seam: forget every series (the metric objects themselves stay registered). */
export function resetMetrics(): void {
  for (const metric of REGISTRY) metric.reset();
}
