/** Shared formatting for the Track surface. Kept in one place so the timer, the ledger and the day page all read the same. */

export function splitElapsed(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return {
    h: String(Math.floor(s / 3600)).padStart(2, "0"),
    m: String(Math.floor((s % 3600) / 60)).padStart(2, "0"),
    s: String(s % 60).padStart(2, "0"),
  };
}

/** "45m", "1h 30m" — the ledger's duration column. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  if (h === 0) return `${m}m`;
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${String(rest).padStart(2, "0")}m`;
}

export const formatSeconds = (seconds: number): string => formatMinutes(seconds / 60);

/** Tokens read as "12.4k" past a thousand — a badge has no room for 12,400. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens % 1000 === 0 ? 0 : 1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Cost to the cent, or to a tenth of a cent while it is still under one. */
export function formatUsd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(4).replace(/0+$/, "")}`;
  return `$${cost.toFixed(2)}`;
}

export const elapsedSeconds = (from: string, now: number): number => Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));

export const minutesBetween = (from: string, to: string | null, now = Date.now()): number =>
  Math.max(0, Math.round(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 60_000));

/** Local `YYYY-MM-DD`, the key both the calendar and the day query use. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
