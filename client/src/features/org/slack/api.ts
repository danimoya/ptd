import { api, callAction } from "@/lib/api";

/** Client face of the Slack adapter: registry actions plus the one-time install URL. */

export interface SlackStatus {
  /** SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET are all set on the server. */
  appConfigured: boolean;
  connected: boolean;
  canManage: boolean;
  scopes: string[];
  teamId: string | null;
  teamName: string | null;
  botUserId: string | null;
  channelId: string | null;
  installedAt: string | null;
  installedBy: number | null;
  /** Whether the caller's own Slack account is bound to their PTD user. */
  linked: boolean;
  slackUserId: string | null;
  linkedWorkspaces: string[];
}

export interface SlackInstallUrl {
  url: string;
  redirectUri: string;
  scopes: string[];
  expiresInSeconds: number;
}

export interface SlackLinkCode {
  code: string;
  command: string;
  expiresAt: string;
  ttlMinutes: number;
  teamName: string | null;
}

export interface SlackTestResult {
  posted: boolean;
  channel: string | null;
  error: string | null;
}

export interface SlackBudgetSweep {
  checked: number;
  overBudget: number;
  posted: number;
  skipped: string[];
}

export const SLACK_STATUS_KEY = ["/api/actions/slack.status"] as const;

export const getSlackStatus = () => callAction<SlackStatus>("slack.status", {});
export const mintSlackLinkCode = () => callAction<SlackLinkCode>("slack.link_code", {});
export const setSlackChannel = (channelId: string) => callAction<{ channelId: string }>("slack.set_channel", { channelId });
export const testSlack = () => callAction<SlackTestResult>("slack.test", {});
export const checkSlackBudgets = () => callAction<SlackBudgetSweep>("slack.check_budgets", {});
export const disconnectSlack = () => callAction<{ disconnected: boolean; removed: number }>("slack.disconnect", {});
export const unlinkSlack = () => callAction<{ removed: number }>("slack.unlink", {});

/**
 * "Add to Slack" is a browser navigation, so it cannot carry the JWT. The server
 * mints a URL whose signed `state` stands in for the session for ten minutes.
 */
export const slackInstallUrl = () => api<SlackInstallUrl>("/integrations/slack/install-url", { method: "POST" });

export const SLASH_COMMANDS: { usage: string; note: string; role?: string }[] = [
  { usage: "/ptd next", note: "the highest-priority task worth starting" },
  { usage: "/ptd start PTD-12 [notes]", note: "start your timer on a task" },
  { usage: "/ptd stop [tokens=N cost=0.12]", note: "stop your timer" },
  { usage: "/ptd log 45m PTD-12 [notes]", note: "log a session that ended just now" },
  { usage: "/ptd today", note: "your day so far" },
  { usage: "/ptd tasks [status]", note: "the organization's open tasks" },
  { usage: "/ptd plan PTD-12 2026-10-01 [days]", note: "schedule a task, cascade its dependents", role: "manager" },
  { usage: "/ptd done PTD-12", note: "mark a task complete" },
  { usage: "/ptd who", note: "which PTD user this Slack account is" },
  { usage: "/ptd stats", note: "organization KPI roll-up", role: "manager" },
  { usage: "/ptd help", note: "only the commands your role allows" },
];
