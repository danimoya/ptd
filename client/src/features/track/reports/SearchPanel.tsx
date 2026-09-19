/**
 * Search the ledger by what was written on it.
 *
 * The query only goes to the server when the reader means it — on submit, or
 * after they stop typing — because each search is a real two-statement read, and
 * a keystroke-per-request box on a work tracker's whole history is a way to make
 * the database look slow.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SourceBadge from "../SourceBadge";
import { formatMinutes } from "../format";
import { searchLedger } from "./api";
import { Empty, Failed, Loading, Panel } from "./bits";
import type { Range } from "./ranges";

const PAGE = 25;

export default function SearchPanel({ range, scope, numeral }: { range: Range; scope: "mine" | "all"; numeral?: string }) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);

  // Settle on the typed text before asking the server for it.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(draft.trim());
      setOffset(0);
    }, 350);
    return () => clearTimeout(t);
  }, [draft]);

  const args = useMemo(
    () => ({
      query,
      from: range.from,
      to: range.to,
      limit: PAGE,
      offset,
      ...(scope === "all" ? { userId: "all" as const } : {}),
    }),
    [query, range.from, range.to, offset, scope]
  );

  const q = useQuery({
    queryKey: ["track", "reports", "search", args],
    queryFn: () => searchLedger(args),
    enabled: query.length > 0,
  });

  const hits = q.data?.results ?? [];

  return (
    <Panel
      eyebrow="Find a line"
      title={
        <>
          <span className="italic">Search the</span> ledger
        </>
      }
      numeral={numeral}
      aside={
        q.data && query ? (
          <span className="eyebrow text-[9px]">
            {q.data.total} {q.data.total === 1 ? "line" : "lines"} · {formatMinutes(q.data.totalMinutes)}
          </span>
        ) : undefined
      }
    >
      <form
        className="flex items-center gap-2 mb-4"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
          setOffset(0);
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-muted" aria-hidden />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="A note, or a task title…"
            aria-label="Search notes and task titles"
            className="h-10 pl-9 rounded-sm border-rule font-serif"
          />
        </div>
        <Button type="submit" variant="outline" className="h-10 rounded-sm border-ink/30 font-display uppercase tracking-tight text-sm">
          Search
        </Button>
      </form>

      {!query ? (
        <p className="eyebrow text-[10px] normal-case tracking-normal font-serif text-ink-muted">
          Searches entry notes and the titles of the tasks they point at, within the period above.
        </p>
      ) : q.isLoading ? (
        <Loading>Turning pages…</Loading>
      ) : q.isError ? (
        <Failed>The search could not be run.</Failed>
      ) : hits.length === 0 ? (
        <Empty>Nothing on the page matches “{query}”.</Empty>
      ) : (
        <>
          <ul className="divide-y divide-rule">
            {hits.map((hit, i) => (
              <li key={hit.id} className="py-2.5 flex items-start gap-3">
                <span className="ledger-cell text-ink-muted tabular-nums w-7 shrink-0 pt-0.5">{String(offset + i + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-display truncate">{hit.taskTitle ?? hit.streamName ?? "Unattributed"}</span>
                    <SourceBadge entry={hit} showName />
                    {hit.isBreak && <span className="eyebrow text-[9px]">recess</span>}
                  </div>
                  {hit.notes && <p className="text-sm text-ink-muted mt-0.5 line-clamp-2">{hit.notes}</p>}
                  <div className="eyebrow text-[9px] mt-1">
                    {format(new Date(hit.checkIn), "EEE d MMM, HH:mm")}
                    {hit.streamName && ` · ${hit.streamName}`}
                    {scope === "all" && hit.userName && ` · ${hit.userName}`}
                  </div>
                </div>
                <span className="ledger-cell tabular-nums shrink-0 pt-0.5">{formatMinutes(hit.minutes)}</span>
              </li>
            ))}
          </ul>

          {(offset > 0 || q.data?.hasMore) && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-rule">
              <Button
                type="button"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
                className="h-8 rounded-sm font-display text-sm"
              >
                ← Earlier page
              </Button>
              <span className="eyebrow text-[9px]">
                {offset + 1}–{offset + hits.length} of {q.data?.total ?? 0}
              </span>
              <Button
                type="button"
                variant="ghost"
                disabled={!q.data?.hasMore}
                onClick={() => setOffset((o) => o + PAGE)}
                className="h-8 rounded-sm font-display text-sm"
              >
                Later page →
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
