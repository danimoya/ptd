/**
 * The one query behind `usage.summary`.
 *
 * Every closed, non-break agent entry in a window, with both the reported and
 * the verified columns, handed to the pure fold in `./fold.ts`. One read then a
 * pure fold is the shape `server/overview/hybrid.ts` uses, and for the same
 * reason: two panels on the same page cannot disagree.
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../../db";
import { streams, timeEntries, users } from "../../db/schema";
import { foldUsage, MAX_SUMMARY_ROWS, type UsageEntryRow, type UsageSummary } from "./fold";

export * from "./fold";

/**
 * Breaks and still-open sessions are excluded: a break is not work and an
 * unfinished session has no final usage figure to verify. Org scope comes from
 * the action context, never from an argument.
 */
export async function readUsageRows(orgId: number, from: Date, to: Date, limit = MAX_SUMMARY_ROWS): Promise<UsageEntryRow[]> {
  return db
    .select({
      entryId: timeEntries.id,
      userId: timeEntries.userId,
      displayName: users.displayName,
      agentLabel: timeEntries.agentLabel,
      streamId: timeEntries.streamId,
      streamName: streams.name,
      taskId: timeEntries.taskId,
      checkIn: timeEntries.checkIn,
      tokensUsed: timeEntries.tokensUsed,
      apiCostUsd: timeEntries.apiCostUsd,
      verifiedTokens: timeEntries.verifiedTokens,
      verifiedCostUsd: timeEntries.verifiedCostUsd,
      verifiedSource: timeEntries.verifiedSource,
      verifiedAt: timeEntries.verifiedAt,
    })
    .from(timeEntries)
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .leftJoin(streams, eq(timeEntries.streamId, streams.id))
    .where(
      and(
        eq(timeEntries.orgId, orgId),
        eq(timeEntries.entrySource, "agent"),
        eq(timeEntries.isBreak, false),
        sql`${timeEntries.checkOut} is not null`,
        gte(timeEntries.checkIn, from),
        lte(timeEntries.checkIn, to),
      ),
    )
    .orderBy(desc(timeEntries.checkIn))
    .limit(limit) as unknown as Promise<UsageEntryRow[]>;
}

export async function usageSummary(orgId: number, from: Date, to: Date): Promise<UsageSummary> {
  const rows = await readUsageRows(orgId, from, to);
  return foldUsage(rows, { from, to });
}
