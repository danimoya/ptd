/**
 * The one rule the whole product is built on.
 *
 * `time_entries.entry_source` says whether a human or an agent did the work.
 * It is derived from `ctx.authType` — which the auth middleware sets from the
 * credential that was presented (a JWT session vs. a `ptd_…` bearer token) —
 * and never from anything in the request body. No action in this surface takes
 * `entrySource` or `agentLabel` as input, so there is nothing for a caller to
 * spoof: an agent cannot log work as a human, and a human cannot claim an
 * agent's tokens.
 *
 * Token counts and API cost are agent-only facts. When a human sends them they
 * are dropped rather than stored, and the names come back in the result's
 * `ignored` array so that an agent misconfigured with a human session (a very
 * easy mistake to make) learns why its numbers vanished instead of silently
 * losing them.
 */

export type EntrySource = "human" | "agent";

export interface AttributionCtx {
  authType: EntrySource;
  displayName: string;
}

export interface Attribution {
  entrySource: EntrySource;
  /** Who the agent was, denormalised so the ledger reads correctly forever. */
  agentLabel: string | null;
}

/** Server-decided attribution for a new entry. */
export function attributionFor(ctx: AttributionCtx): Attribution {
  return ctx.authType === "agent"
    ? { entrySource: "agent", agentLabel: ctx.displayName.slice(0, 80) }
    : { entrySource: "human", agentLabel: null };
}

export interface AgentMetricsInput {
  tokensUsed?: number | null;
  apiCostUsd?: number | null;
}

export interface AgentMetrics {
  /** Columns to write. Empty for humans — not even a null, so an update cannot blank an agent's numbers by accident. */
  values: { tokensUsed?: number | null; apiCostUsd?: number | null };
  /** Field names that were supplied but not stored, with the reason. */
  ignored: string[];
  reason?: string;
}

/**
 * Accept tokensUsed / apiCostUsd only from an agent credential.
 *
 * `entrySource` is passed explicitly rather than read from ctx so that a stop
 * on an entry opened earlier is judged by the entry's own attribution: an
 * entry that was started by an agent keeps its agent fields even if the row is
 * closed later, and a human-sourced entry can never grow agent metrics.
 */
export function agentMetricsFor(entrySource: EntrySource, input: AgentMetricsInput): AgentMetrics {
  const supplied = (["tokensUsed", "apiCostUsd"] as const).filter((k) => input[k] !== undefined && input[k] !== null);
  if (entrySource === "agent") {
    const values: AgentMetrics["values"] = {};
    if (input.tokensUsed !== undefined && input.tokensUsed !== null) values.tokensUsed = Math.round(input.tokensUsed);
    if (input.apiCostUsd !== undefined && input.apiCostUsd !== null) values.apiCostUsd = input.apiCostUsd;
    return { values, ignored: [] };
  }
  return {
    values: {},
    ignored: supplied,
    ...(supplied.length
      ? { reason: "tokensUsed and apiCostUsd are recorded only for entries whose entry_source is 'agent'. This entry was logged over a human session, so the server dropped them." }
      : {}),
  };
}
