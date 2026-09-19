// Outgoing webhooks per organization (org_integrations.kind = "webhook"). Filled in by the
// Overview/Org work package; the signature is the contract other modules call.
export interface OutboundEvent {
  kind: string;
  taskId?: number;
  actor?: { userId: number | null; label: string | null; isAgent?: boolean };
  payload?: unknown;
}

export async function dispatchWebhooks(_orgId: number, _event: OutboundEvent): Promise<void> {
  // no-op until webhook delivery lands
}
