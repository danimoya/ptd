import { callAction } from "@/lib/api";

/** Client face of the Teams adapter: all registry actions, no redirects. */

export interface TeamsStatus {
  /** Always true — a Teams Outgoing Webhook needs nothing on the server side. */
  appConfigured: boolean;
  connected: boolean;
  canManage: boolean;
  teamName: string | null;
  connectedAt: string | null;
  connectedBy: number | null;
  lastEventAt: string | null;
  lastError: string | null;
  callbackUrl: string;
  /** Whether the caller's own Teams account is bound to their PTD user. */
  linked: boolean;
  aadObjectId: string | null;
}

export interface TeamsLinkCode {
  code: string;
  command: string;
  expiresAt: string;
  ttlMinutes: number;
  teamName: string | null;
}

export const TEAMS_STATUS_KEY = ["/api/actions/teams.status"] as const;

export const getTeamsStatus = () => callAction<TeamsStatus>("teams.status", {});
export const connectTeams = (input: { secret: string; teamName?: string }) =>
  callAction<{ connected: boolean; teamName: string | null; callbackUrl: string; next: string }>("teams.connect", input);
export const mintTeamsLinkCode = () => callAction<TeamsLinkCode>("teams.link_code", {});
export const unlinkTeams = () => callAction<{ removed: number }>("teams.unlink", {});
export const disconnectTeams = () => callAction<{ disconnected: boolean }>("teams.disconnect", {});

export const TEAMS_COMMANDS: { usage: string; note: string; role?: string }[] = [
  { usage: "@PTD next", note: "the highest-priority task worth starting" },
  { usage: "@PTD start PTD-12 [notes]", note: "start your timer on a task" },
  { usage: "@PTD stop [tokens=N cost=0.12]", note: "stop your timer" },
  { usage: "@PTD log 45m PTD-12", note: "log a session that ended just now" },
  { usage: "@PTD today", note: "your day so far" },
  { usage: "@PTD tasks [status]", note: "the organization's open tasks" },
  { usage: "@PTD plan PTD-12 2026-10-01", note: "schedule a task, cascade its dependents", role: "manager" },
  { usage: "@PTD done PTD-12", note: "mark a task complete" },
  { usage: "@PTD who", note: "which PTD user this Teams account is" },
  { usage: "@PTD stats", note: "organization KPI roll-up", role: "manager" },
  { usage: "@PTD help", note: "only the commands your role allows" },
];
