import { callAction } from "@/lib/api";

export interface ExportGrant {
  downloadUrl: string;
  path: string;
  filename: string;
  expiresAt: string;
  expiresInSeconds: number;
  singleUse: true;
}

/**
 * Two calls, not one: the action mints a short-lived single-use link, and the
 * browser then follows it. The archive is binary and can be large, and an action
 * answers JSON — so the link is the handover, and the ZIP is built when it is
 * fetched rather than held in memory waiting.
 */
export const requestExport = () => callAction<ExportGrant>("org.export", {});

export const deleteOrg = (confirmName: string) =>
  callAction<{ deleted: true; orgId: number; name: string; deletedAgentSeats: number }>("org.delete", { confirmName });
