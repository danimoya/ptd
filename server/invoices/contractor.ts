/**
 * The contractor invoice: hours a member of the organization bills *to* the
 * organization.
 *
 * This is the document the whole billing feature exists for. A customer invoice
 * bills outwards and is read by a client; a contractor invoice bills inwards and
 * is read by whoever pays the external person — so the roles are reversed. The
 * contractor is the issuer (their billing name, their tax id), the organization is
 * the bill-to, and unlike the customer document this one does multiply hours by a
 * rate, because a member's rate is recorded on their membership.
 *
 * Two things are deliberate:
 *
 *  - **Lines are one per day × stream × task.** That is the grain a payer can
 *    check against a calendar. The *snapshot* underneath keeps one line per entry,
 *    with the exact clock times, because that is what gets hashed and what a
 *    verifier re-hashes against the live ledger.
 *
 *  - **Approval is visible, not silent.** When a member's membership has
 *    `require_approval`, only approved entries bill, and the preview says how many
 *    minutes are still waiting so nobody invoices half a month by accident.
 */

import { format } from "date-fns";
import { ActionError } from "../actions/registry";
import { minutesFrom, num, usd } from "../track/aggregate";
import { monthLabel, monthWindow } from "../track/invoice";
import { billableEntries, billingProfile, snapshotLine, type BillingProfile, type InvoiceEntryRow } from "./entries";
import { amountCentsFor, SNAPSHOT_VERSION, type Certification, type InvoiceSnapshot, type SnapshotLine } from "./snapshot";

export type { Certification };

export type LineSource = "human" | "agent" | "mixed";

/** One day's work on one task, as the payer reads it. */
export interface ContractorLine {
  date: string;
  dateLabel: string;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  sessions: number;
  minutes: number;
  source: LineSource;
  tokens: number;
  costUsd: number;
  amountCents: number | null;
  /** "approved" / "pending" / "rejected" / "none", or "mixed" when a day is split. */
  approval: string;
}

export interface ContractorTotals {
  sessions: number;
  minutes: number;
  hours: number;
  humanMinutes: number;
  agentMinutes: number;
  tokens: number;
  costUsd: number;
  amountCents: number | null;
}

export interface ContractorInvoiceData {
  kind: "contractor";
  orgName: string;
  org: { id: number; name: string };
  invoiceId: number | null;
  reference: string;
  status: string;
  contractor: {
    userId: number;
    name: string;
    billingName: string | null;
    billingAddress: string | null;
    taxId: string | null;
    email: string;
  };
  period: { month: number; year: number; label: string; from: string; to: string };
  currency: string;
  rate: number | null;
  onlyApproved: boolean;
  lines: ContractorLine[];
  entries: SnapshotLine[];
  totals: ContractorTotals;
  /** Minutes left out of this invoice because they are not approved yet. */
  excluded: { pendingMinutes: number; rejectedMinutes: number; unsubmittedMinutes: number };
  /** Entries already frozen into another invoice — blocks generating. */
  alreadyInvoiced: { entryId: number; invoiceId: number }[];
  issuedAt: string;
  certification?: Certification;
}

/** "PTD-CTR-2026-09-0007" — the contractor series, distinct from the customer one. */
export function contractorReference(year: number, month: number, invoiceId: number | null): string {
  const tail = invoiceId === null ? "DRAFT" : String(invoiceId).padStart(4, "0");
  return `PTD-CTR-${year}-${String(month).padStart(2, "0")}-${tail}`;
}

const dayOf = (d: Date | string): string => format(new Date(d), "yyyy-MM-dd");

const sourceOf = (human: number, agent: number): LineSource => (agent === 0 ? "human" : human === 0 ? "agent" : "mixed");

interface Acc {
  date: string;
  streamId: number | null;
  streamName: string | null;
  taskId: number | null;
  taskKey: string | null;
  taskTitle: string | null;
  sessions: number;
  humanSessions: number;
  agentSessions: number;
  minutes: number;
  tokens: number;
  cost: number;
  approvals: Set<string>;
  /** Earliest session in the group, so a day reads in the order it happened. */
  firstCheckIn: string;
}

/** Fold entries into day × stream × task lines, priced at one rate. */
export function foldContractorLines(rows: SnapshotLine[], rate: number | null): { lines: ContractorLine[]; totals: ContractorTotals } {
  const acc = new Map<string, Acc>();
  let humanMinutes = 0;
  let agentMinutes = 0;
  for (const row of rows) {
    const date = dayOf(row.checkIn);
    const key = `${date}|${row.streamId ?? "-"}|${row.taskId ?? "-"}`;
    const cur =
      acc.get(key) ??
      ({
        date,
        streamId: row.streamId,
        streamName: row.streamName,
        taskId: row.taskId,
        taskKey: row.taskKey,
        taskTitle: row.taskTitle,
        sessions: 0,
        humanSessions: 0,
        agentSessions: 0,
        minutes: 0,
        tokens: 0,
        cost: 0,
        approvals: new Set<string>(),
        firstCheckIn: row.checkIn,
      } satisfies Acc);
    if (row.checkIn < cur.firstCheckIn) cur.firstCheckIn = row.checkIn;
    cur.sessions += 1;
    cur.minutes += row.minutes;
    cur.approvals.add(row.approvalStatus);
    if (row.entrySource === "agent") {
      cur.agentSessions += 1;
      agentMinutes += row.minutes;
      cur.tokens += num(row.tokensUsed);
      cur.cost += num(row.apiCostUsd);
    } else {
      cur.humanSessions += 1;
      humanMinutes += row.minutes;
    }
    acc.set(key, cur);
  }

  const lines: ContractorLine[] = Array.from(acc.values())
    // A day reads in the order the work happened, which is how a payer checks it
    // against a calendar; the stream and task only break a tie.
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.firstCheckIn.localeCompare(b.firstCheckIn) ||
        (a.streamName ?? "").localeCompare(b.streamName ?? "") ||
        (a.taskTitle ?? "").localeCompare(b.taskTitle ?? "")
    )
    .map((a) => ({
      date: a.date,
      dateLabel: format(new Date(`${a.date}T12:00:00`), "EEE d MMM"),
      streamId: a.streamId,
      streamName: a.streamName,
      taskId: a.taskId,
      taskKey: a.taskKey,
      taskTitle: a.taskTitle,
      sessions: a.sessions,
      minutes: a.minutes,
      source: sourceOf(a.humanSessions, a.agentSessions),
      tokens: Math.round(a.tokens),
      costUsd: usd(a.cost),
      amountCents: amountCentsFor(a.minutes, rate),
      approval: a.approvals.size === 1 ? Array.from(a.approvals)[0] : "mixed",
    }));

  const minutes = humanMinutes + agentMinutes;
  const totals: ContractorTotals = {
    sessions: rows.length,
    minutes,
    hours: Math.round((minutes / 60) * 100) / 100,
    humanMinutes,
    agentMinutes,
    tokens: lines.reduce((t, l) => t + l.tokens, 0),
    costUsd: usd(lines.reduce((t, l) => t + l.costUsd, 0)),
    // Priced from the month's total, not from the sum of the lines, so a rate
    // never drifts by a cent per day.
    amountCents: amountCentsFor(minutes, rate),
  };
  return { lines, totals };
}

/**
 * Whether an entry counts towards this invoice.
 *
 * `requireApproval` members bill only approved entries; everyone else bills
 * everything that is not explicitly rejected. A caller may force either way.
 */
export function includedFor(profile: BillingProfile, onlyApproved: boolean) {
  return (row: { approvalStatus: string }): boolean =>
    onlyApproved ? row.approvalStatus === "approved" : row.approvalStatus !== "rejected";
}

export async function buildContractorInvoice(args: {
  orgId: number;
  orgName: string;
  userId: number;
  month: number;
  year: number;
  onlyApproved?: boolean;
  invoiceId?: number | null;
  status?: string;
  issuedAt?: Date;
  certification?: Certification;
}): Promise<ContractorInvoiceData> {
  const profile = await billingProfile(args.orgId, args.userId);
  if (!profile) throw new ActionError("not_found", `User ${args.userId} is not a member of this organization`);
  if (!profile.billable) {
    throw new ActionError(
      "conflict",
      `${profile.displayName} is not marked billable. An admin turns billing on for a member with member.set_billing before PTD will invoice their hours.`
    );
  }

  const onlyApproved = args.onlyApproved ?? profile.requireApproval;
  const { from, to } = monthWindow(args.month, args.year);
  const rows = await billableEntries({ orgId: args.orgId, from, to, userId: args.userId });
  const keep = includedFor(profile, onlyApproved);

  const excluded = { pendingMinutes: 0, rejectedMinutes: 0, unsubmittedMinutes: 0 };
  const included: InvoiceEntryRow[] = [];
  for (const row of rows) {
    if (keep(row)) {
      included.push(row);
      continue;
    }
    const minutes = minutesFrom((new Date(row.checkOut).getTime() - new Date(row.checkIn).getTime()) / 1000);
    if (row.approvalStatus === "pending") excluded.pendingMinutes += minutes;
    else if (row.approvalStatus === "rejected") excluded.rejectedMinutes += minutes;
    else excluded.unsubmittedMinutes += minutes;
  }

  const entries = included.map(snapshotLine);
  const { lines, totals } = foldContractorLines(entries, profile.hourlyRate);

  return {
    kind: "contractor",
    orgName: args.orgName,
    org: { id: args.orgId, name: args.orgName },
    invoiceId: args.invoiceId ?? null,
    reference: contractorReference(args.year, args.month, args.invoiceId ?? null),
    status: args.status ?? "preview",
    contractor: {
      userId: profile.userId,
      name: profile.displayName,
      billingName: profile.billingName,
      billingAddress: profile.billingAddress,
      taxId: profile.taxId,
      email: profile.email,
    },
    period: { month: args.month, year: args.year, label: monthLabel(args.month, args.year), from: from.toISOString(), to: to.toISOString() },
    currency: profile.currency,
    rate: profile.hourlyRate,
    onlyApproved,
    lines,
    entries,
    totals,
    excluded,
    alreadyInvoiced: included.filter((r) => Boolean(r.lockedInvoiceId)).map((r) => ({ entryId: r.id, invoiceId: r.lockedInvoiceId as number })),
    issuedAt: (args.issuedAt ?? new Date()).toISOString(),
    ...(args.certification ? { certification: args.certification } : {}),
  };
}

/** The frozen record. `reference` is inside it, so the invoice id must exist first. */
export function contractorSnapshot(data: ContractorInvoiceData): InvoiceSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    kind: "contractor",
    org: data.org,
    contractor: {
      userId: data.contractor.userId,
      name: data.contractor.name,
      billingName: data.contractor.billingName,
      taxId: data.contractor.taxId,
    },
    period: data.period,
    currency: data.currency,
    rate: data.rate,
    lines: data.entries,
    totals: {
      minutes: data.totals.minutes,
      amountCents: data.totals.amountCents,
      humanMinutes: data.totals.humanMinutes,
      agentMinutes: data.totals.agentMinutes,
      tokens: data.totals.tokens,
      costUsd: data.totals.costUsd,
    },
    issuedAt: data.issuedAt,
    reference: data.reference,
  };
}

/**
 * Re-draw an already-issued contractor invoice from its own snapshot.
 *
 * Same reason as the customer side: the hash printed on the document is the hash
 * of this record, so the document has to be drawn from the record.
 */
export function contractorDataFromSnapshot(
  snapshot: InvoiceSnapshot,
  args: { invoiceId: number; status: string; certification?: Certification; billingAddress?: string | null; email?: string }
): ContractorInvoiceData {
  const { lines, totals } = foldContractorLines(snapshot.lines, snapshot.rate);
  return {
    kind: "contractor",
    orgName: snapshot.org.name,
    org: snapshot.org,
    invoiceId: args.invoiceId,
    reference: snapshot.reference,
    status: args.status,
    contractor: {
      userId: snapshot.contractor?.userId ?? 0,
      name: snapshot.contractor?.name ?? "(member removed)",
      billingName: snapshot.contractor?.billingName ?? null,
      billingAddress: args.billingAddress ?? null,
      taxId: snapshot.contractor?.taxId ?? null,
      email: args.email ?? "",
    },
    period: snapshot.period,
    currency: snapshot.currency,
    rate: snapshot.rate,
    onlyApproved: snapshot.lines.every((l) => l.approvalStatus === "approved"),
    lines,
    entries: snapshot.lines,
    totals,
    excluded: { pendingMinutes: 0, rejectedMinutes: 0, unsubmittedMinutes: 0 },
    alreadyInvoiced: [],
    issuedAt: snapshot.issuedAt,
    ...(args.certification ? { certification: args.certification } : {}),
  };
}
