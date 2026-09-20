import { useQuery } from "@tanstack/react-query";
import { canAccess, useMe } from "@/hooks/use-me";
import { fetchAiStatus } from "../api";
import type { AiStatus } from "../types";

/**
 * Is AI-assisted priority available to the person looking at this page?
 *
 * Two independent gates, and both have to be open before a control renders:
 *
 *  - the deployment has a provider and a key (`ai.status.configured`). PTD is
 *    open-core and most self-hosters will never set one, so a hidden button is
 *    the correct default — not a disabled one with a tooltip explaining a
 *    feature they did not buy;
 *  - the viewer is a manager or above, which is the role the two suggestion
 *    actions require. The Overview surface already needs manager, so this is
 *    belt and braces for a future reader-level route.
 *
 * `ai.status` never fails loudly: a member-level action that 500s should not take
 * the backlog table with it, so an error resolves to "not configured".
 */
export function useAiStatus() {
  const { role } = useMe();
  const query = useQuery<AiStatus>({
    queryKey: ["/api/actions/ai.status"],
    queryFn: fetchAiStatus,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const status: AiStatus = query.data ?? { configured: false, provider: null, model: null };
  const isManager = canAccess(role, "manager");
  return {
    ...status,
    isLoading: query.isLoading,
    /** Render the AI controls. */
    available: status.configured && isManager,
    /** The model a suggestion would run on, for the button's tooltip. */
    modelLabel: status.provider && status.model ? `${status.provider} · ${status.model}` : null,
  };
}
