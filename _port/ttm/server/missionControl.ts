// Fire-and-forget signup/login reporting to Mission Control.
//
// Posts to Mission Control's non-blocking ingest endpoint (202 Accepted, queued
// server-side). Best-effort: never awaited and never throws into the request
// path. No-op when MC_INGEST_URL / MC_API_KEY are unset.

const MC_URL = (process.env.MC_INGEST_URL || "").replace(/\/+$/, "");
const MC_KEY = process.env.MC_API_KEY || "";

export function reportAuthEvent(
  kind: "signup" | "login",
  user?: string | number,
  meta?: Record<string, unknown>
): void {
  if (!MC_URL || !MC_KEY) return;

  void fetch(`${MC_URL}/api/events/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": MC_KEY },
    body: JSON.stringify({
      service: "ttm",
      kind,
      user: user != null ? String(user) : "",
      source: "ttm",
      meta: meta ?? {},
    }),
  }).catch(() => {
    /* best-effort */
  });
}
