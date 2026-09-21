import { api } from "@/lib/api";

/**
 * The telemetry surface, client side. Four calls, all owner-only; a non-owner
 * gets 403 and the section is not rendered for them at all.
 *
 * `GET /api/telemetry` answers everything the section shows in one response —
 * status, the exact payload (stamped now), the six offline snippets built from
 * that same payload, and the policy text. "Refresh timestamp" is a refetch of
 * this call, which is why the snippets can never disagree with the preview.
 */

export type OfflineFormat = "url" | "curl" | "wget" | "httpie" | "powershell" | "json";

/** Exactly four fields. This interface is the whole payload. */
export interface TelemetryPayload {
  installation_id: string;
  dashboard_version: string;
  heliosdb_version: string | null;
  timestamp: string;
}

export interface PingOutcome {
  ok: boolean;
  at: string;
  status: number | null;
  error: string | null;
}

export interface TelemetryStatus {
  installationId: string;
  telemetryEnabled: boolean;
  updateChecksEnabled: boolean;
  envPinned: boolean;
  decided: boolean;
  decidedAt: string | null;
  lastPingAt: string | null;
  lastPingResult: PingOutcome | null;
  lastUpdateCheckAt: string | null;
  latestVersionSeen: string | null;
  version: string;
  endpoint: string;
  updateCheckUrl: string;
  nextPingDueAt: string | null;
}

export interface TelemetryPolicy {
  summary: string;
  fields: { key: string; source: string; risk: string }[];
  retention: string[];
  receiverSource: string;
  offlineNote: string;
}

export interface TelemetryView {
  status: TelemetryStatus;
  payload: TelemetryPayload;
  offline: { formats: { id: OfflineFormat; label: string; lang: string }[]; commands: Record<OfflineFormat, string> };
  policy: TelemetryPolicy;
}

export interface TelemetryPingResult {
  ok: boolean;
  sentAt: string;
  payload: TelemetryPayload;
  receiverStatus: number | null;
  error: string | null;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  upgradeAvailable: boolean;
  notes: string | null;
  fetchedAt: string;
  url: string | null;
}

export const TELEMETRY_KEY = ["/api/telemetry"] as const;

export const getTelemetry = () => api<TelemetryView>("/telemetry");

export const setTelemetryPreferences = (prefs: { telemetryEnabled?: boolean; updateChecksEnabled?: boolean; dismissed?: boolean }) =>
  api<TelemetryStatus>("/telemetry/preferences", { method: "POST", body: JSON.stringify(prefs) });

export const sendTelemetryPing = () => api<TelemetryPingResult>("/telemetry/ping", { method: "POST" });

export const checkTelemetryUpdates = () => api<UpdateCheckResult>("/telemetry/updates");
