import React, { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, ClipboardPaste, History, Loader2, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { canAccess, useMe } from "@/hooks/use-me";
import Explainer from "./Explainer";
import { Hint } from "./Hint";
import CalendarFeed from "./import/CalendarFeed";
import MappingTable from "./import/MappingTable";
import PreviewGrid from "./import/PreviewGrid";
import SourcePicker from "./import/SourcePicker";
import {
  commitImport,
  importHistory,
  listSources,
  previewImport,
  uploadCsv,
  type CommitResult,
  type PreviewResult,
  type SourceArg,
} from "./import/api";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Import — the on-ramp.
 *
 * Four steps in one column, in the order the work actually happens: give PTD the
 * file, agree with what it thinks the file is, correct the mapping if it guessed
 * wrong, then commit. Nothing is written until the last button, and the preview
 * on screen is the server's own dry run rather than a browser-side approximation,
 * so the numbers above the Commit button are the numbers that will happen.
 *
 * Re-importing the same file is the expected case, not an edge case: cards are
 * matched on their external key, so the second run reports updates rather than
 * duplicates. The counts say so out loud, because "N will be updated" is the only
 * reassurance that makes a second upload safe to attempt.
 */
export default function ImportTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { role } = useMe();
  const fileInput = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState<string | null>(null);
  const [source, setSource] = useState<SourceArg>("auto");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [defaultStreamName, setDefaultStreamName] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const sources = useQuery({ queryKey: ["/api/import/sources"], queryFn: listSources });
  const history = useQuery({ queryKey: ["import.history"], queryFn: importHistory });

  // The org-wide feed and the importer itself are both manager+; the tab is only
  // reachable at admin+, but the scope select must still agree with the server.
  const canSeeOrgFeed = canAccess(role, "manager");

  const fail = (err: Error) => toast({ title: "Import failed", description: err.message, variant: "destructive" });

  /** Re-run the dry run with the mapping and options currently on screen. */
  const recheck = useMutation({
    mutationFn: (args: { text: string; source: SourceArg; mapping: Record<string, string>; stream: string }) =>
      previewImport({
        csv: args.text,
        source: args.source,
        mapping: Object.keys(args.mapping).length > 0 ? args.mapping : undefined,
        defaultStreamName: args.stream.trim() || undefined,
      }),
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
    },
    onError: fail,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > MAX_BYTES) throw new Error(`${(file.size / 1_048_576).toFixed(1)} MB is over the 5 MB limit.`);
      const text = await file.text();
      const data = await uploadCsv(file, source);
      return { text, data, name: file.name };
    },
    onSuccess: ({ text, data, name }) => {
      setCsv(text);
      setFilename(name);
      setOverrides({});
      setPreview(data);
      setResult(null);
    },
    onError: fail,
  });

  const commit = useMutation({
    mutationFn: () =>
      commitImport({
        csv,
        source,
        mapping: Object.keys(overrides).length > 0 ? overrides : undefined,
        defaultStreamName: defaultStreamName.trim() || undefined,
      }),
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["import.history"] });
      // Everything the import touched is read by other surfaces.
      for (const key of [["/api/tasks"], ["/api/streams"], ["/api/time-entries"], ["/api/overview"]]) {
        qc.invalidateQueries({ queryKey: key });
      }
      toast({
        title: data.errors.length > 0 ? "Imported with errors" : "Import complete",
        description: `${data.created} created · ${data.updated} updated · ${data.skipped} skipped`,
        variant: data.errors.length > 0 ? "destructive" : undefined,
      });
    },
    onError: fail,
  });

  const busy = upload.isPending || recheck.isPending || commit.isPending;

  const takeFile = useCallback(
    (file: File | undefined) => {
      if (file) upload.mutate(file);
    },
    [upload]
  );

  const clear = () => {
    setCsv("");
    setFilename(null);
    setPreview(null);
    setResult(null);
    setOverrides({});
    setSource("auto");
    if (fileInput.current) fileInput.current.value = "";
  };

  const counts = preview?.counts;
  const titleMapped = !preview || preview.kind === "time" || Object.values({ ...preview.mapping, ...overrides }).includes("title");

  return (
    <div className="space-y-5">
      <Explainer
        testId="import-explainer"
        why={
          <>
            Nobody should start from an empty board: bring across the backlog and the timesheets you already keep in Jira,
            Trello, Asana, Linear, Notion, Toggl, Clockify or Harvest. PTD shows exactly what it is about to write before it
            writes anything, and it recognises cards by their key in the old tool, so importing the same export twice updates
            them instead of duplicating them. The calendar feed at the bottom sends dates the other way — into Google, Apple or
            Outlook.
          </>
        }
        technical={
          <>
            <li>CSV up to 5 MB, uploaded or pasted. The source tool is detected from the headers; you can override it and correct any column the guess got wrong.</li>
            <li>
              The preview is the server's own dry run, not a browser approximation — the counts above the Commit button are the
              counts that will happen, and nothing is written until you press it.
            </li>
            <li>
              Idempotent on <code>externalKey</code> (the issue key from the old tool, or a hash of the row when the file has
              none), which is unique per organization: a second run reports updates, not duplicates.
            </li>
            <li>Imported time rows attach themselves to a card when the key matches one; rows with no lane of their own land in the default stream you name.</li>
            <li>
              The iCal feed is read-only — dates out, nothing in — and its URL carries its own token, because a calendar client
              cannot send a header. Treat the link as a password and revoke its token in Org → Tokens to switch it off.
            </li>
          </>
        }
      />

      <section className="paper p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="eyebrow text-[9px]">Organization · inbound</div>
            <h3 className="font-display text-xl tracking-tight mt-0.5 flex items-center gap-2">
              <Upload className="h-4 w-4" /> Import a CSV
            </h3>
            <p className="text-sm font-serif text-ink-muted mt-1 max-w-prose">
              Bring a backlog or a time sheet across from Jira, Trello, Asana, Linear, Notion, Toggl, Clockify or Harvest — or any CSV
              at all. Nothing is written until you commit, and cards are matched on their key from the old tool, so importing the same
              export twice updates rather than duplicates.
            </p>
          </div>
          {preview ? (
            <span className="stamp shrink-0 font-numeric" data-testid="import-kind">
              {preview.kind === "task" ? "tasks" : "time"}
            </span>
          ) : null}
        </div>
      </section>

      {/* ── 1 · the file ─────────────────────────────────────────────── */}
      <section className="paper-flat">
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between gap-2">
          <span className="microcaps flex items-center gap-2">
            <span className="section-num">i.</span> The file
            <Hint text="Uploading writes nothing. PTD reads the file, guesses the source and hands back a dry run you can correct." />
          </span>
          {csv ? (
            <button onClick={clear} className="text-[11px] font-mono text-ink-muted hover:text-ink focus-ink inline-flex items-center gap-1" data-testid="import-clear">
              <X className="h-3 w-3" /> start over
            </button>
          ) : null}
        </div>

        <div className="p-3 space-y-3">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              takeFile(e.dataTransfer.files?.[0]);
            }}
            className={cn(
              "border border-dashed rounded-sm px-4 py-6 text-center transition-colors",
              dragging ? "border-vermilion bg-vermilion/5" : "border-rule"
            )}
            data-testid="import-dropzone"
          >
            <p className="font-serif text-sm text-ink-muted">
              Drop a .csv here, or{" "}
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="underline decoration-vermilion decoration-2 underline-offset-2 text-ink focus-ink"
                data-testid="import-browse"
              >
                choose a file
              </button>
              . Up to 5 MB.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={(e) => takeFile(e.target.files?.[0] ?? undefined)}
              data-testid="import-file"
            />
            {filename ? (
              <p className="mt-2 font-mono text-[11px] text-ink">
                {filename} · {preview?.bytes ? `${(preview.bytes / 1024).toFixed(1)} kB` : ""}
              </p>
            ) : null}
          </div>

          <details className="group">
            <summary className="cursor-pointer microcaps inline-flex items-center gap-1.5 focus-ink">
              <ClipboardPaste className="h-3 w-3" /> or paste the text
            </summary>
            <div className="mt-2 space-y-2">
              <textarea
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setFilename(null);
                  setPreview(null);
                  setResult(null);
                }}
                rows={6}
                spellCheck={false}
                placeholder={"Issue key,Summary,Status,Project name\nATL-101,Rework the checkout summary,In Progress,Storefront"}
                className="draft-input w-full text-[12px] font-mono focus-ink"
                data-testid="import-paste"
              />
              <button
                type="button"
                onClick={() => recheck.mutate({ text: csv, source, mapping: {}, stream: defaultStreamName })}
                disabled={busy || csv.trim().length === 0}
                className="stamp px-3 py-1.5 focus-ink disabled:opacity-40"
                data-testid="import-read-paste"
              >
                Read it
              </button>
            </div>
          </details>
        </div>
      </section>

      {/* ── 2 · the source ───────────────────────────────────────────── */}
      {csv ? (
        <section className="paper-flat">
          <div className="px-3 py-2 border-b border-rule">
            <span className="microcaps flex items-center gap-2">
              <span className="section-num">ii.</span> Where it came from
            </span>
          </div>
          <div className="p-3">
            <SourcePicker
              sources={sources.data ?? []}
              detected={preview}
              value={source}
              disabled={busy}
              onChange={(next) => {
                setSource(next);
                setOverrides({});
                recheck.mutate({ text: csv, source: next, mapping: {}, stream: defaultStreamName });
              }}
            />
          </div>
        </section>
      ) : null}

      {/* ── 3 · the mapping and the dry run ──────────────────────────── */}
      {preview ? (
        <section className="paper-flat">
          <div className="px-3 py-2 border-b border-rule">
            <span className="microcaps flex items-center gap-2">
              <span className="section-num">iii.</span> How the columns land
            </span>
          </div>
          <div className="p-3 space-y-4">
            <MappingTable
              preview={preview}
              fields={preview.fields}
              value={overrides}
              disabled={busy}
              onChange={(next) => setOverrides(next)}
            />

            <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="block">
                <span className="eyebrow text-[9px]">stream for rows without one</span>
                <input
                  value={defaultStreamName}
                  onChange={(e) => setDefaultStreamName(e.target.value)}
                  maxLength={255}
                  placeholder="Imported"
                  className="draft-input w-full mt-1 text-sm focus-ink"
                  data-testid="import-default-stream"
                />
              </label>
              <Hint text="Runs the dry run again with the mapping and default stream now on screen. Still a rehearsal — nothing is written.">
                <button
                  type="button"
                  onClick={() => recheck.mutate({ text: csv, source, mapping: overrides, stream: defaultStreamName })}
                  disabled={busy}
                  className="stamp px-3 py-2 focus-ink inline-flex items-center gap-1.5 justify-self-start sm:justify-self-end"
                  data-testid="import-recheck"
                >
                  {recheck.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Re-check
                </button>
              </Hint>
            </div>

            <PreviewGrid preview={preview} />

            {preview.warnings.length > 0 ? (
              <details className="paper-flat bg-parchment-deep/40 p-3" data-testid="import-warnings">
                <summary className="cursor-pointer microcaps inline-flex items-center gap-1.5 focus-ink text-vermilion">
                  <AlertTriangle className="h-3 w-3" /> {preview.warnings.length} note{preview.warnings.length === 1 ? "" : "s"} about this file
                </summary>
                <ul className="mt-2 space-y-1 text-[12px] font-serif text-ink-muted">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── 4 · commit ───────────────────────────────────────────────── */}
      {preview && counts ? (
        <section className="paper p-4 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <span className="microcaps flex items-center gap-2">
                <span className="section-num">iv.</span> Commit
              </span>
              <p className="mt-1.5 font-display text-2xl tracking-tight" data-testid="import-counts">
                <span className="font-numeric">{counts.create}</span> to create ·{" "}
                <span className="font-numeric">{counts.update}</span> to update ·{" "}
                <span className="font-numeric text-ink-muted">{counts.skip}</span> skipped
              </p>
              {preview.creates.streams.length > 0 || preview.creates.customers.length > 0 ? (
                <p className="text-[12px] font-serif text-ink-muted mt-1">
                  Will also create{" "}
                  {[
                    preview.creates.streams.length > 0 ? `stream${preview.creates.streams.length === 1 ? "" : "s"} ${preview.creates.streams.join(", ")}` : "",
                    preview.creates.customers.length > 0 ? `customer${preview.creates.customers.length === 1 ? "" : "s"} ${preview.creates.customers.join(", ")}` : "",
                  ]
                    .filter(Boolean)
                    .join(" and ")}
                  .
                </p>
              ) : null}
            </div>
            <Hint
              side="left"
              text="The only button here that writes: it creates the new rows and updates the ones matched by their old key. Run it twice and the second pass updates rather than duplicates."
            >
              <button
                onClick={() => commit.mutate()}
                disabled={busy || !titleMapped || counts.create + counts.update === 0}
                className="stamp stamp-strong px-4 py-2.5 focus-ink inline-flex items-center gap-1.5 disabled:opacity-40"
                data-testid="import-commit"
              >
                {commit.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Write {counts.create + counts.update} row{counts.create + counts.update === 1 ? "" : "s"}
              </button>
            </Hint>
          </div>

          {result ? (
            <div className="rule-t pt-3" data-testid="import-result">
              <p className="font-serif text-sm flex items-start gap-2">
                {result.errors.length > 0 ? (
                  <AlertTriangle className="h-4 w-4 text-vermilion shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-sage shrink-0 mt-0.5" />
                )}
                <span>
                  <b className="font-numeric">{result.created}</b> created, <b className="font-numeric">{result.updated}</b> updated,{" "}
                  <b className="font-numeric">{result.skipped}</b> skipped
                  {result.tasksLinked !== undefined ? <> · {result.tasksLinked} entries linked to a card</> : null}
                  {(result.streamsCreated?.length ?? 0) > 0 ? <> · streams {result.streamsCreated!.join(", ")}</> : null}
                  {(result.customersCreated?.length ?? 0) > 0 ? <> · customers {result.customersCreated!.join(", ")}</> : null}
                </span>
              </p>
              {result.errors.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[12px] font-serif text-vermilion">
                  {result.errors.slice(0, 6).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── history ──────────────────────────────────────────────────── */}
      {history.data && (history.data.runs.length > 0 || history.data.taskEventsViaImport > 0) ? (
        <section className="paper-flat" data-testid="import-history">
          <div className="px-3 py-2 border-b border-rule flex items-center justify-between gap-2">
            <span className="microcaps inline-flex items-center gap-1.5">
              <History className="h-3 w-3" /> Recent imports
            </span>
            <span className="text-[11px] font-mono text-ink-muted">{history.data.taskEventsViaImport} card writes all-time</span>
          </div>
          {history.data.runs.length === 0 ? (
            <p className="p-3 text-[12px] font-serif text-ink-muted">{history.data.note}</p>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {history.data.runs.map((run, i) => (
                  <tr key={`${run.at}-${i}`} className="border-b border-rule/50 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-[11px] text-ink-muted whitespace-nowrap">{format(new Date(run.at), "d MMM HH:mm")}</td>
                    <td className="px-3 py-1.5">{run.source}</td>
                    <td className="px-3 py-1.5 font-serif text-ink-muted">{run.by}</td>
                    <td className="px-3 py-1.5 ledger-cell text-right whitespace-nowrap">
                      +{run.created} ↻{run.updated} ⌀{run.skipped}
                      {run.errors > 0 ? <span className="text-vermilion"> !{run.errors}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      <CalendarFeed canSeeOrg={canSeeOrgFeed} />
    </div>
  );
}
