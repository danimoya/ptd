import type { Request } from "express";
import type { Role, User } from "../db/schema";

export interface AuthenticatedRequest extends Request {
  user: User[];
  authType: "human" | "agent";
}

export interface OrgRequest extends AuthenticatedRequest {
  org: { id: number; role: Role };
}

export const ROLE_RANK: Record<Role, number> = { member: 1, manager: 2, admin: 3, owner: 4 };

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in ROLE_RANK;
}
