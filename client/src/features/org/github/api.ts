import { api, callAction } from "@/lib/api";

/** Client face of the GitHub adapter: registry actions plus the one-time install URL. */

export type SyncDirection = "both" | "in" | "out";

export interface GithubMappingRow {
  streamId: number;
  streamName: string | null;
  repo: string;
  url: string;
  direction: SyncDirection;
  mappedBy: number | null;
  mappedAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
  lastImported: number | null;
}

export interface GithubStatus {
  /** GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_SLUG / GITHUB_WEBHOOK_SECRET are all set. */
  appConfigured: boolean;
  missingEnv: string[];
  appSlug: string | null;
  connected: boolean;
  canManage: boolean;
  installationId: number | null;
  account: { login: string; type: string | null; id: number | null } | null;
  installedAt: string | null;
  installedBy: number | null;
  lastEventAt: string | null;
  lastError: string | null;
  webhookUrl: string;
  permissions: Record<string, string>;
  events: string[];
  mappings: GithubMappingRow[];
}

export interface GithubInstallUrl {
  url: string;
  slug: string;
  webhookUrl: string;
  setupUrl: string;
  permissions: Record<string, string>;
  events: string[];
  expiresInSeconds: number;
}

export interface GithubSyncSummary {
  repo: string;
  streamId: number;
  issues: number;
  created: number;
  updated: number;
  errors: string[];
}

export const GITHUB_STATUS_KEY = ["/api/actions/github.status"] as const;

export const getGithubStatus = () => callAction<GithubStatus>("github.status", {});
export const mapGithubStream = (input: { streamId: number; repo: string; direction: SyncDirection }) =>
  callAction<{ mapped: boolean; repo: string; mappings: GithubMappingRow[] }>("github.map_stream", input);
export const unmapGithubStream = (streamId: number) =>
  callAction<{ unmapped: boolean; mappings: GithubMappingRow[] }>("github.unmap_stream", { streamId });
export const syncGithubNow = (streamId: number) => callAction<GithubSyncSummary>("github.sync_now", { streamId });
export const disconnectGithub = () => callAction<{ disconnected: boolean; mappingsDropped: number }>("github.disconnect", {});

/**
 * "Install on GitHub" is a browser navigation, so it cannot carry the JWT. The server
 * mints a URL whose signed `state` stands in for the session for ten minutes.
 */
export const githubInstallUrl = () => api<GithubInstallUrl>("/integrations/github/install-url", { method: "POST" });

export interface StreamOption {
  id: number;
  name: string;
  archived: boolean;
}

export const listStreamOptions = async (): Promise<StreamOption[]> => {
  const result = await callAction<{ streams: StreamOption[] }>("stream.list", { includeArchived: false });
  return result.streams ?? [];
};

export const DIRECTION_NOTES: Record<SyncDirection, string> = {
  both: "issues become tasks and tasks become issues",
  in: "GitHub → PTD only: issues become tasks, PTD never writes back",
  out: "PTD → GitHub only: new cards open issues, completing one closes it",
};
