import { errorReply, ephemeral, type Reply } from "./format";
import {
  clearLinkFailures,
  consumeLinkCode,
  linkAttemptsBlocked,
  peekLinkCode,
  recordLinkFailure,
  type LinkCodeEntry,
} from "./linkCodes";

/**
 * Spending a link code, for every chat adapter.
 *
 * The rules are identical wherever the code is typed — ten minutes, one use, ten bad
 * guesses per account and then a cool-off — and the differences are all wording, so
 * they are parameters rather than a second copy of the flow. Nothing here writes to
 * the database: the caller supplies `link`, because what an `externalId` means is the
 * adapter's business.
 */

export interface LinkFlow {
  /** `chat_identities.provider`, which is also the link-code namespace. */
  provider: string;
  /** The chat account, for the failed-attempt counter. */
  accountKey: string;
  /**
   * The organization this surface is tied to, or null when the code itself decides.
   * Slack knows its org from the workspace install, so a code minted elsewhere is a
   * mistake worth naming; the Telegram bot and a Teams webhook serve any org, so
   * whichever org minted the code is the right answer.
   */
  orgId: number | null;
  orgName: string | null;
  /**
   * Names the organization a code turned out to belong to, when this surface did not
   * know it up front (`orgId: null`) — so the confirmation can still say which one.
   */
  orgNameFor?: (orgId: number) => Promise<string | null>;
  code: string | undefined;
  now: number;
  /** The command as typed here, e.g. `"/ptd link ABC123"`. */
  example: string;
  /** Where a code comes from, e.g. `"PTD → Org → Integrations → Slack"`. */
  mintPath: string;
  /** What this surface is, for the wrong-organization sentence: `"Slack workspace"`. */
  scopeLabel: string;
  /** The chat account as this surface writes it, pre-escaped: `"<@U1>"`. */
  account: string;
  /** A few commands worth trying next, already quoted. */
  suggestions: string[];
  link: (entry: LinkCodeEntry) => Promise<void>;
}

export interface LinkOutcome {
  reply: Reply;
  /** The code's entry when the link happened, else null. */
  linked: LinkCodeEntry | null;
}

export async function runLinkFlow(flow: LinkFlow): Promise<LinkOutcome> {
  const fail = (reply: Reply): LinkOutcome => ({ reply, linked: null });

  if (linkAttemptsBlocked(flow.provider, flow.accountKey, flow.now)) {
    return fail(errorReply("Too many bad codes. Wait ten minutes, then mint a fresh one in PTD."));
  }
  if (!flow.code) {
    return fail(errorReply(`Give me the code: \`${flow.example}\`.`, [`mint one in ${flow.mintPath}`]));
  }

  const peeked = peekLinkCode(flow.provider, flow.code, flow.now);
  if (!peeked) {
    const { failures } = recordLinkFailure(flow.provider, flow.accountKey, flow.now);
    return fail(
      errorReply("That code is not valid — it may have expired, or already been used.", [`mint a fresh one in PTD (attempt ${failures})`]),
    );
  }
  if (flow.orgId !== null && peeked.orgId !== flow.orgId) {
    const { failures } = recordLinkFailure(flow.provider, flow.accountKey, flow.now);
    return fail(
      errorReply(`That code belongs to a different PTD organization than this ${flow.scopeLabel} is connected to.`, [
        `mint the code while the ${flow.orgName ?? "connected"} organization is selected (attempt ${failures})`,
      ]),
    );
  }

  const entry = consumeLinkCode(flow.provider, flow.code, flow.now);
  if (!entry) {
    recordLinkFailure(flow.provider, flow.accountKey, flow.now);
    return fail(errorReply("That code expired while we were looking at it — mint a fresh one."));
  }
  await flow.link(entry);
  clearLinkFailures(flow.provider, flow.accountKey);
  const orgName = flow.orgName ?? (flow.orgNameFor ? await flow.orgNameFor(entry.orgId).catch(() => null) : null);
  return {
    linked: entry,
    reply: ephemeral(
      [`*Linked.* ${flow.account} is now ${entry.displayName} in PTD${orgName ? ` (${orgName})` : ""}.`],
      flow.suggestions.length > 0 ? [`try ${flow.suggestions.join(", ")}`] : [],
    ),
  };
}
