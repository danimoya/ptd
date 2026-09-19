import { useQuery } from "@tanstack/react-query";
import { getCurrentOrg, getMe, type CurrentOrg, type Me } from "@/lib/api";
import type { Role } from "../../../db/schema";

export const SURFACES = {
  overview: { path: "/overview", label: "Overview", min: "manager" as Role },
  plan: { path: "/plan", label: "Plan", min: "manager" as Role },
  track: { path: "/track", label: "Track", min: "member" as Role },
  org: { path: "/org", label: "Org", min: "admin" as Role },
} as const;

const RANK: Record<Role, number> = { member: 1, manager: 2, admin: 3, owner: 4 };
export const canAccess = (role: Role | undefined, min: Role) => !!role && RANK[role] >= RANK[min];

export function useMe() {
  const me = useQuery<Me>({ queryKey: ["/api/auth/me"], queryFn: getMe });
  const org = useQuery<CurrentOrg>({ queryKey: ["/api/orgs/current"], queryFn: getCurrentOrg, enabled: !!me.data });
  const role = org.data?.role;
  const surfaces = (Object.keys(SURFACES) as (keyof typeof SURFACES)[]).filter((k) => canAccess(role, SURFACES[k].min));
  const home = canAccess(role, "manager") ? "/overview" : "/track";
  return { me: me.data, org: org.data, role, surfaces, home, isLoading: me.isLoading || org.isLoading, error: me.error || org.error };
}
