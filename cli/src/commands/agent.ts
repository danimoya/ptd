/**
 * The two commands that make an agent's own cost figure checkable by something
 * other than the agent.
 *
 *   ptd agent-run [--task KEY] -- <command…>
 *       Start an entry, run the command, stop the entry with whatever usage the
 *       command reported, then attest it. The command's exit code is the CLI's,
 *       so it drops into a Makefile or a CI step without changing what "failed"
 *       means.
 *
 *   ptd ci-report [--task KEY] [--tokens N] [--cost USD] [--minutes N]
 *       The same attestation for work that already happened — a build step that
 *       called a model and can now say what it spent. Reads GITHUB_* for
 *       evidence, so the attestation names the run and the commit that produced
 *       it.
 *
 * Neither command can invent a usage figure: with nothing reported, the entry is
 * still stopped (the time is real) but no attestation is written, because an
 * attestation with no measurement behind it is the unverifiable self-report this
 * whole feature exists to replace.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { numberFlag, stringFlag } from "../args.ts";
import { callAction } from "../api.ts";
import { bold, dim, green, red, yellow } from "../color.ts";
import { ChildFailed, CliError, UsageError } from "../errors.ts";
import { json, keyValue, minutes as fmtMinutes } from "../table.ts";
import { label, resolveTask, type TaskBrief } from "../tasks.ts";
import { repoTask } from "../repoTask.ts";
import { evidenceFrom, githubEvidence, isCi, normalizeUsage, parseUsageMarkers, readUsageFile, USAGE_MARKER, type UsageReport } from "../usage.ts";
import type { Ctx } from "../context.ts";

const ATTEST_SOURCES = ["claude_code_hook", "ci", "provider"] as const;
type AttestSource = (typeof ATTEST_SOURCES)[number];

/** How much of a command's stdout is kept for marker parsing. Markers go last; a log can be enormous. */
const TAIL_BYTES = 256 * 1024;

function attestSource(ctx: Ctx): AttestSource {
  const flag = stringFlag(ctx.flags, "source");
  if (flag === undefined) return "ci";
  if (!(ATTEST_SOURCES as readonly string[]).includes(flag)) {
    throw new UsageError(`--source must be one of ${ATTEST_SOURCES.join(", ")}, got "${flag}".`);
  }
  return flag as AttestSource;
}

/**
 * The card to book against: --task, else this checkout's label ($PTD_TASK or a
 * .ptd-task file), else whatever `next_task` says is next for this seat.
 */
async function pickTask(ctx: Ctx, command: string): Promise<{ task: TaskBrief | null; picked: string }> {
  const flag = stringFlag(ctx.flags, "task");
  if (flag) return { task: await resolveTask(ctx.client, flag), picked: "--task" };

  const local = repoTask();
  if (local) {
    try {
      return { task: await resolveTask(ctx.client, local.ref), picked: local.from === "env" ? "$PTD_TASK" : ".ptd-task" };
    } catch (err) {
      ctx.print(yellow(`Ignoring ${local.from === "env" ? "$PTD_TASK" : local.path} — ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  if (ctx.flags.has("no-next")) return { task: null, picked: "none" };
  const next = (await callAction(ctx.client, "next_task", { assignee: "me" })) as { task?: TaskBrief | null };
  if (next?.task) return { task: next.task, picked: "next_task" };
  ctx.print(dim(`Nothing assigned to this seat — \`${command}\` will be timed without a card. Name one with --task.`));
  return { task: null, picked: "none" };
}

/** Run the child, echoing its output while keeping the tail for marker parsing. */
function runCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; signal: NodeJS.Signals | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["inherit", "pipe", "inherit"], env });
    let tail = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES);
    });
    child.on("error", (err) => reject(new CliError(`Cannot run \`${argv[0]}\` — ${err.message}`)));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, tail }));
  });
}

/** File first, then stdout markers — a file is deliberate, a marker is incidental. */
function collectUsage(tokensFile: string | undefined, tail: string): { report: UsageReport | null; from: string } {
  if (tokensFile) {
    const fromFile = readUsageFile(tokensFile);
    if (fromFile) return { report: fromFile, from: tokensFile };
  }
  const fromMarker = parseUsageMarkers(tail);
  if (fromMarker) return { report: fromMarker, from: `${USAGE_MARKER} marker` };
  return { report: null, from: "nothing" };
}

interface StopResult {
  entry?: { id?: number; tokensUsed?: number | null; apiCostUsd?: number | null };
  minutes?: number;
  ignored?: string[];
}

interface AttestResult {
  verified?: { tokens?: number; costUsd?: number | null; source?: string };
  reported?: { tokens?: number; costUsd?: number };
  delta?: { tokens?: number; costUsd?: number | null };
  costBasis?: string;
  note?: string;
}

/** What PTD's price table makes of a token split, or null when it cannot say. */
async function priceUsage(ctx: Ctx, report: UsageReport | null): Promise<number | null> {
  if (!report || !report.model || report.tokens <= 0) return null;
  try {
    const priced = (await callAction(ctx.client, "usage.price", {
      model: report.model,
      ...(report.inputTokens !== undefined ? { inputTokens: report.inputTokens } : {}),
      ...(report.outputTokens !== undefined ? { outputTokens: report.outputTokens } : {}),
      ...(report.cacheReadTokens !== undefined ? { cacheReadTokens: report.cacheReadTokens } : {}),
      ...(report.cacheCreationTokens !== undefined ? { cacheCreationTokens: report.cacheCreationTokens } : {}),
      // Nothing itemised: price the whole figure as input tokens, which is what
      // the server does with the same evidence.
      ...(report.inputTokens === undefined && report.outputTokens === undefined ? { inputTokens: report.tokens } : {}),
    })) as { costUsd?: number; priced?: boolean };
    return priced.priced && typeof priced.costUsd === "number" ? priced.costUsd : null;
  } catch {
    return null;
  }
}

/** Stop the open entry with the reported usage, then attest it. Shared by both commands. */
async function stopAndAttest(
  ctx: Ctx,
  args: { report: UsageReport | null; source: AttestSource; notes: string; evidence: Record<string, unknown> },
): Promise<{ stop: StopResult; attest: AttestResult | null }> {
  const stopBody: Record<string, unknown> = { notes: args.notes };
  if (args.report && args.report.tokens > 0) stopBody.tokensUsed = args.report.tokens;
  if (args.report?.costUsd !== undefined) stopBody.apiCostUsd = args.report.costUsd;
  else {
    // The command reported tokens but no money. Ask the server what its own table
    // makes of them, so the *reported* cost and the cost PTD derives on
    // attestation are the same arithmetic — otherwise every attested run would
    // show a cost discrepancy that is really just a missing figure.
    const priced = await priceUsage(ctx, args.report);
    if (priced !== null) stopBody.apiCostUsd = priced;
  }

  const stop = (await callAction(ctx.client, "time_entry.stop", stopBody)) as StopResult;
  const entryId = stop.entry?.id;
  if (!entryId || !args.report || args.report.tokens <= 0) return { stop, attest: null };

  const attest = (await callAction(ctx.client, "time_entry.attest", {
    entryId,
    tokens: args.report.tokens,
    ...(args.report.costUsd !== undefined ? { costUsd: args.report.costUsd } : {}),
    source: args.source,
    evidence: evidenceFrom(args.report, args.evidence),
  })) as AttestResult;
  return { stop, attest };
}

function printAttestation(ctx: Ctx, attest: AttestResult | null, stop: StopResult): void {
  const entryId = stop.entry?.id;
  if (!attest) {
    ctx.print(dim(`Stopped entry #${entryId} after ${fmtMinutes(stop.minutes)}. Nothing reported its usage, so no attestation was written.`));
    ctx.print(dim(`  Report one by writing {"tokens":N,"model":"…"} to $PTD_TOKENS_FILE, or printing \`${USAGE_MARKER} {"tokens":N}\` on stdout.`));
    return;
  }
  ctx.print(green(`Stopped and attested entry #${entryId} after ${fmtMinutes(stop.minutes)}.`));
  ctx.print(
    keyValue({
      verified: `${attest.verified?.tokens ?? 0} tok${attest.verified?.costUsd !== null && attest.verified?.costUsd !== undefined ? ` · $${attest.verified.costUsd.toFixed(4)}` : " · cost unpriced"}`,
      reported: `${attest.reported?.tokens ?? 0} tok · $${(attest.reported?.costUsd ?? 0).toFixed(4)}`,
      source: attest.verified?.source,
      cost: attest.costBasis,
    }),
  );
  if (attest.note) ctx.print(dim(attest.note));
}

/* ── ptd agent-run ───────────────────────────────────────────────────── */

export async function agentRun(ctx: Ctx): Promise<void> {
  const argv = ctx.args;
  if (argv.length === 0) {
    throw new UsageError("Name the command to run — `ptd agent-run --task SEC-3 -- npm test`.", "agent-run");
  }
  const printable = argv.join(" ");
  const source = attestSource(ctx);
  const { task, picked } = await pickTask(ctx, printable);

  const started = (await callAction(ctx.client, "time_entry.start", {
    ...(task ? { taskId: task.id } : {}),
    notes: `ptd agent-run: ${printable}`.slice(0, 2000),
  }).catch((err: unknown) => {
    // A timer already running is the one failure worth continuing through: the
    // command is what the user asked for, and stopping somebody else's session
    // to make room would be worse than not tracking this one.
    const message = err instanceof Error ? err.message : String(err);
    ctx.print(yellow(`Not tracking this run — ${message}`));
    return null;
  })) as { entry?: { id?: number; entrySource?: string } } | null;

  if (started?.entry?.id) {
    ctx.print(dim(`Entry #${started.entry.id} (${started.entry.entrySource}) open on ${task ? label(task) : "no card"} via ${picked}.`));
  }

  // A temp file is offered even when the caller set no PTD_TOKENS_FILE, so a
  // wrapped program can report usage without the operator wiring anything up.
  const ownedDir = process.env.PTD_TOKENS_FILE ? null : mkdtempSync(join(tmpdir(), "ptd-usage-"));
  const tokensFile = process.env.PTD_TOKENS_FILE ?? (ownedDir ? join(ownedDir, "usage.json") : undefined);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(tokensFile ? { PTD_TOKENS_FILE: tokensFile } : {}),
    ...(started?.entry?.id ? { PTD_ENTRY_ID: String(started.entry.id) } : {}),
    ...(task ? { PTD_TASK_ID: String(task.id) } : {}),
  };

  let result: { code: number; signal: NodeJS.Signals | null; tail: string };
  try {
    result = await runCommand(argv, childEnv);
  } catch (err) {
    // The command never ran, but the timer is open. Close it before rethrowing,
    // or the seat is left with a session nobody will stop.
    if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });
    if (started?.entry?.id) {
      await callAction(ctx.client, "time_entry.stop", { notes: `ptd agent-run: ${printable} → could not start` }).catch(() => {});
    }
    throw err;
  }

  const { report, from } = collectUsage(tokensFile, result.tail);
  if (ownedDir) rmSync(ownedDir, { recursive: true, force: true });

  if (!started?.entry?.id) {
    if (ctx.raw) ctx.print(json({ tracked: false, exitCode: result.code, usage: report }));
    else ctx.print(dim(`\`${printable}\` exited ${result.code}. Nothing was tracked.`));
    if (result.code !== 0) throw new ChildFailed(result.code, `\`${printable}\` exited ${result.code}.`);
    return;
  }

  const notes = `ptd agent-run: ${printable} → exit ${result.code}${result.signal ? ` (${result.signal})` : ""}`.slice(0, 2000);
  const { stop, attest } = await stopAndAttest(ctx, {
    report,
    source,
    notes,
    evidence: {
      command: argv,
      exitCode: result.code,
      ...(result.signal ? { signal: result.signal } : {}),
      usageFrom: from,
      runner: "ptd agent-run",
      ...(isCi() ? githubEvidence() : {}),
    },
  });

  if (ctx.raw) {
    ctx.print(json({ tracked: true, exitCode: result.code, usageFrom: from, stop, attest }));
  } else {
    printAttestation(ctx, attest, stop);
  }

  if (result.code !== 0) throw new ChildFailed(result.code, `\`${printable}\` exited ${result.code} — the entry was still stopped and attested.`);
}

/* ── ptd ci-report ───────────────────────────────────────────────────── */

const MAX_STDIN_BYTES = 4 * 1024 * 1024;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function ciReport(ctx: Ctx): Promise<void> {
  const source = attestSource(ctx);
  const tokens = numberFlag(ctx.flags, "tokens");
  const cost = numberFlag(ctx.flags, "cost");
  const model = stringFlag(ctx.flags, "model");
  const entryFlag = numberFlag(ctx.flags, "entry");
  const usageFile = stringFlag(ctx.flags, "usage-file") ?? process.env.PTD_TOKENS_FILE;

  // Flags beat a file, a file beats piped output — most explicit wins.
  let report: UsageReport | null = null;
  let from = "nothing";
  if (tokens !== undefined || cost !== undefined) {
    report = normalizeUsage({ tokens: tokens ?? 0, ...(cost !== undefined ? { costUsd: cost } : {}), ...(model ? { model } : {}) });
    from = "flags";
  }
  if (!report && usageFile) {
    report = readUsageFile(usageFile);
    if (report) from = usageFile;
  }
  if (!report) {
    const piped = await readStdin();
    if (piped) {
      report = parseUsageMarkers(piped);
      if (report) from = `${USAGE_MARKER} marker on stdin`;
    }
  }
  if (report && model && !report.model) report.model = model;

  const evidence: Record<string, unknown> = { usageFrom: from, runner: "ptd ci-report", ...githubEvidence() };
  const notes = stringFlag(ctx.flags, "notes") ?? ctx.args.join(" ").trim();

  // ── attest an entry that already exists ──
  if (entryFlag !== undefined) {
    if (!report || report.tokens <= 0) {
      throw new UsageError("Nothing to attest — pass --tokens, or point --usage-file at a JSON usage report.", "ci-report");
    }
    const attested = (await callAction(ctx.client, "time_entry.attest", {
      entryId: entryFlag,
      tokens: report.tokens,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
      source,
      evidence: evidenceFrom(report, evidence),
    })) as AttestResult;
    if (ctx.raw) return ctx.print(json(attested));
    ctx.print(green(`Attested entry #${entryFlag}: ${attested.verified?.tokens ?? 0} tok (${attested.verified?.source}).`));
    ctx.print(keyValue({ reported: `${attested.reported?.tokens ?? 0} tok`, delta: attested.delta?.tokens, cost: attested.costBasis }));
    if (attested.note) ctx.print(dim(attested.note));
    return;
  }

  // ── log the session, then attest it ──
  const minutesFlag = numberFlag(ctx.flags, "minutes") ?? 1;
  if (minutesFlag <= 0 || minutesFlag > 24 * 60) throw new UsageError("--minutes must be between 1 and 1440.", "ci-report");
  const { task, picked } = await pickTask(ctx, "this CI job");

  const checkOut = new Date();
  const checkIn = new Date(checkOut.getTime() - minutesFlag * 60_000);
  const logged = (await callAction(ctx.client, "time_entry.log_past", {
    ...(task ? { taskId: task.id } : {}),
    checkIn: checkIn.toISOString(),
    checkOut: checkOut.toISOString(),
    notes: (notes || `ptd ci-report${evidence.workflow ? ` · ${evidence.workflow}` : ""}${evidence.runId ? ` #${evidence.runId}` : ""}`).slice(0, 2000),
    ...(report && report.tokens > 0 ? { tokensUsed: report.tokens } : {}),
    ...(report?.costUsd !== undefined ? { apiCostUsd: report.costUsd } : {}),
  })) as { entry?: { id?: number; entrySource?: string }; minutes?: number; ignored?: string[] };

  const entryId = logged.entry?.id;
  if (!entryId) throw new CliError("time_entry.log_past returned no entry — nothing to attest.");
  if (logged.entry?.entrySource !== "agent") {
    ctx.print(yellow("This credential is a human session, so PTD dropped the token figures and the entry cannot be attested."));
    ctx.print(dim("Use an agent seat's token (Org → Agents) in CI: PTD_TOKEN=ptd_…"));
    if (ctx.raw) ctx.print(json(logged));
    return;
  }

  let attested: AttestResult | null = null;
  if (report && report.tokens > 0) {
    attested = (await callAction(ctx.client, "time_entry.attest", {
      entryId,
      tokens: report.tokens,
      ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
      source,
      evidence: evidenceFrom(report, evidence),
    })) as AttestResult;
  }

  if (ctx.raw) return ctx.print(json({ logged, attested, usageFrom: from, picked }));
  ctx.print(bold(`Logged ${fmtMinutes(logged.minutes)} on ${task ? label(task) : "no card"} as entry #${entryId} (via ${picked}).`));
  if (!attested) {
    ctx.print(red("No usage figure was reported, so nothing was attested."));
    ctx.print(dim(`Pass --tokens N (and --model), or write a usage JSON to $PTD_TOKENS_FILE.`));
    return;
  }
  ctx.print(green(`Attested: ${attested.verified?.tokens ?? 0} tok (${attested.verified?.source}, usage from ${from}).`));
  if (attested.note) ctx.print(dim(attested.note));
}
