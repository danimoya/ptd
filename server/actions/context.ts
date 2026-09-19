import type { Request } from "express";
import type { ActionContext, Via } from "./registry";
import type { OrgRequest } from "../types";

/** Build an ActionContext from a request that passed `auth` + `resolveOrg`. */
export function contextFromRequest(req: Request, via?: Via): ActionContext {
  const r = req as OrgRequest;
  const user = r.user[0];
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    orgId: r.org.id,
    role: r.org.role,
    authType: r.authType,
    via: via ?? (r.authType === "agent" ? "api" : "web"),
  };
}
