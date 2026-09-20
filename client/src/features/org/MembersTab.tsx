import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, BadgeCheck, Loader2, ReceiptText, Trash2, UserPlus } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { callAction, getCurrentOrg, getMembers, inviteMember, removeMember, updateMemberRole, type MemberRow } from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import { ROLES, type Role } from "../../../../db/schema";
import CopyBlock from "./CopyBlock";
import Explainer from "./Explainer";
import { Hint } from "./Hint";

/* ── Billing (contractors) ───────────────────────────────────────────────
 * A seat is a seat, but an hour is not always an hour: a salaried member logs
 * time to see where it went, and an external one logs time somebody has to pay
 * for. `memberships.billable` is the switch between those two readings, and the
 * rest — rate, issuer details, whether a manager must sign the hours off —
 * follows from it. It lives on this tab because it is a property of the seat.
 */

export interface BillingProfile {
  userId: number;
  displayName: string;
  email: string;
  isAgent: boolean;
  role: Role;
  billable: boolean;
  hourlyRate: number | null;
  currency: string;
  billingName: string | null;
  billingAddress: string | null;
  taxId: string | null;
  requireApproval: boolean;
}

export interface BillingDraft {
  userId: number;
  billable: boolean;
  hourlyRate: number | null;
  currency: string;
  billingName: string | null;
  billingAddress: string | null;
  taxId: string | null;
  requireApproval: boolean;
}

const listBilling = () => callAction<BillingProfile[]>("member.billing");
const saveBilling = (draft: BillingDraft) => callAction<BillingProfile>("member.set_billing", draft as unknown as Record<string, unknown>);

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };

/** "$45/h", or "1,200 SEK/h" for a currency with no symbol on the keyboard. */
export function rateLabel(rate: number | null, currency: string): string {
  if (rate === null) return "no rate";
  const amount = rate.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const symbol = SYMBOLS[currency?.toUpperCase() ?? ""];
  return symbol ? `${symbol}${amount}/h` : `${amount} ${currency.toUpperCase()}/h`;
}

const ROLE_NOTE: Record<Role, string> = {
  owner: "Everything, including billing and handing the org to someone else.",
  admin: "Members, tokens, integrations — everything except transferring ownership.",
  manager: "Plan and Overview: the backlog, apps, streams and stats.",
  member: "Track their own time, read the board. Agents live here.",
};

/** the original tracker's Members page, on PTD's four-role model with agent seats called out. */
export default function MembersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { me } = useMe();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "manager" | "member">("member");
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const org = useQuery({ queryKey: ["/api/orgs/current"], queryFn: getCurrentOrg });
  const members = useQuery({ queryKey: ["/api/orgs/current/members"], queryFn: getMembers });
  const billing = useQuery({ queryKey: ["org", "member-billing"], queryFn: listBilling });
  const [billingFor, setBillingFor] = useState<number | null>(null);

  const myRole = org.data?.role;
  const isOwner = myRole === "owner";
  const canManage = myRole === "owner" || myRole === "admin";

  const invite = useMutation({
    mutationFn: () => inviteMember(email.trim(), role) as Promise<{ token: string }>,
    onSuccess: (data) => {
      setInviteToken(data.token);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["/api/orgs/current/members"] });
      toast({ title: "Invitation created", description: "Send the token to the invitee — they accept it from their own account." });
    },
    onError: (err: Error) => toast({ title: "Could not invite", description: err.message, variant: "destructive" }),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, next }: { userId: number; next: Role }) => updateMemberRole(userId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/orgs/current/members"] });
      toast({ title: "Role updated" });
    },
    onError: (err: Error) => toast({ title: "Could not change role", description: err.message, variant: "destructive" }),
  });

  const setBilling = useMutation({
    mutationFn: saveBilling,
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["org", "member-billing"] });
      qc.invalidateQueries({ queryKey: ["track", "contractors"] });
      setBillingFor(null);
      toast({
        title: row.billable ? `${row.displayName} bills at ${rateLabel(row.hourlyRate, row.currency)}` : `${row.displayName} is no longer billed`,
        description: row.billable
          ? row.requireApproval
            ? "Their hours arrive as pending and must be approved before an invoice can be issued."
            : "Their hours can be invoiced as soon as they are logged."
          : "The rate and issuer details are kept, in case they come back.",
      });
    },
    onError: (err: Error) => toast({ title: "Could not save the billing settings", description: err.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (userId: number) => removeMember(userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/orgs/current/members"] });
      qc.invalidateQueries({ queryKey: ["/api/org/stats"] });
      toast({ title: "Member removed" });
    },
    onError: (err: Error) => toast({ title: "Could not remove member", description: err.message, variant: "destructive" }),
  });

  const rows = members.data ?? [];
  const humans = rows.filter((m) => !m.isAgent);
  const agents = rows.filter((m) => m.isAgent);

  return (
    <div className="space-y-5">
      <Explainer
        testId="members-explainer"
        why={
          <>
            This is the list of everyone who may open your ledger — people and agents in one roll, because a seat is a seat. A
            role decides what each of them can do: owners and admins run the organization, managers shape the plan, members
            track their own time and read the board. Everything else in PTD — who can see a budget, what an agent may touch —
            is decided from this list, so it is the first thing to get right.
          </>
        }
        technical={
          <>
            <li>
              <code>memberships.role</code> is one of <code>owner</code> &gt; <code>admin</code> &gt; <code>manager</code> &gt;{" "}
              <code>member</code>. Every action declares the minimum role it needs and the server checks it on each request, not
              just in this UI.
            </li>
            <li>
              Inviting writes an <code>invitations</code> row with the email, the role and a random token that expires after 7
              days. Nothing is emailed: you hand over the token and the invitee accepts it at{" "}
              <code>POST /api/invitations/accept</code> while signed in with that same address.
            </li>
            <li>Only an owner may change roles or hand the organization over, and the last owner cannot demote or remove themselves.</li>
            <li>
              Agents are ordinary rows here with <code>users.is_agent</code> set — same roles, a bearer token instead of a
              password. The Agents tab is how one gets in.
            </li>
            <li>
              One account can belong to several organizations. API callers choose which with the <code>X-Org-Id</code> header
              (or <code>?orgId=</code>); otherwise the token's own organization is used.
            </li>
            <li>Removing a member frees the seat at once; the time entries and task events they made stay on the record.</li>
            <li>
              <strong>Billing</strong> writes <code>memberships.billable</code> plus a rate, a currency, the legal name, address and
              tax id an invoice prints as the issuer, and <code>require_approval</code>. Only an admin may set them — a rate is
              money, and nobody sets their own. Turning billing off keeps the details, so a returning contractor does not have to be
              re-typed.
            </li>
            <li>
              With <code>require_approval</code> on, that member's entries close as <code>pending</code> instead of{" "}
              <code>none</code>; they hand a month over with <code>time_entry.submit</code>, and a manager signs it off with{" "}
              <code>time_entry.approve</code> (or sends it back with <code>time_entry.reject</code> and a reason). Only approved
              entries reach their invoice.
            </li>
            <li>
              <code>invoice.contractor_generate</code> then freezes those entries into a signed snapshot: each entry's immutable
              columns are hashed, the whole record is hashed and signed with the deployment's Ed25519 key, and every included entry is
              locked — <code>time_entry.update</code> and <code>time_entry.delete</code> answer 409 until an admin voids the
              invoice. The PDF carries a verification URL anyone holding it can open; the public keys live at{" "}
              <code>/.well-known/ptd-signing-key.json</code>.
            </li>
          </>
        }
      />

      <section className="paper p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="eyebrow text-[9px]">Current organization</div>
            <h3 className="font-display text-xl tracking-tight mt-0.5">
              <span className="italic">{org.data?.name ?? "…"}</span>
            </h3>
          </div>
          <div className="text-right">
            <div className="eyebrow text-[9px]">your role</div>
            <div className="font-numeric text-sm">{myRole ?? "…"}</div>
          </div>
        </div>
        <p className="eyebrow text-[9px] mt-3 pt-3 border-t border-rule">
          {humans.length} human{humans.length === 1 ? "" : "s"}
          <span className="mx-2">·</span>
          {agents.length} agent{agents.length === 1 ? "" : "s"}
          <span className="mx-2">·</span>
          plan {org.data?.plan ?? "—"}
        </p>
      </section>

      {canManage ? (
        <section className="paper-flat">
          <div className="px-3 py-2 border-b border-rule flex items-center gap-2">
            <UserPlus className="h-3.5 w-3.5" />
            <span className="microcaps">Invite a person</span>
            <Hint text="Creates an invitation token that lasts 7 days. Nothing is emailed — copy the token, send it yourself, and they accept it signed in with that address." />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              invite.mutate();
            }}
            className="p-3 grid gap-2.5 sm:grid-cols-[1fr_150px_auto]"
          >
            <label className="block">
              <span className="eyebrow text-[9px]">email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" className="draft-input w-full mt-1 text-sm focus-ink" data-testid="invite-email" />
            </label>
            <label className="block">
              <span className="eyebrow text-[9px]">role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)} className="draft-input w-full mt-1 text-sm h-[38px] focus-ink" data-testid="invite-role">
                <option value="member">member</option>
                <option value="manager">manager</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={invite.isPending || !email.trim()}
              className="self-end inline-flex items-center justify-center gap-2 px-4 h-[38px] border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors rounded-sm focus-ink disabled:opacity-60"
              data-testid="invite-submit"
            >
              {invite.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              <span className="eyebrow text-[10px] !text-current">invite</span>
            </button>
          </form>
          {inviteToken ? (
            <div className="px-3 pb-3">
              <CopyBlock body={inviteToken} label="invitation token — the invitee pastes this once, signed in as themselves" testId="invite-token" />
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="paper-flat" data-testid="members-table">
        <div className="px-3 py-2 border-b border-rule flex items-center justify-between">
          <span className="microcaps">The roll</span>
          <span className="eyebrow text-[9px] font-numeric">{rows.length}</span>
        </div>
        {members.isLoading ? (
          <div className="py-10 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-ink-muted" /></div>
        ) : members.error ? (
          <p className="px-3 py-8 text-center font-serif italic text-vermilion">{(members.error as Error).message}</p>
        ) : (
          <ul className="divide-y divide-rule">
            {rows.map((m) => (
              <MemberRowItem
                key={m.userId}
                member={m}
                billing={billing.data?.find((b) => b.userId === m.userId)}
                isSelf={m.userId === me?.user.id}
                canManage={canManage}
                isOwner={isOwner}
                billingOpen={billingFor === m.userId}
                onToggleBilling={() => setBillingFor(billingFor === m.userId ? null : m.userId)}
                onSaveBilling={(draft) => setBilling.mutate(draft)}
                savingBilling={setBilling.isPending}
                onRole={(next) => changeRole.mutate({ userId: m.userId, next })}
                onRemove={() => remove.mutate(m.userId)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="paper-flat">
        <div className="px-3 py-2 border-b border-rule">
          <span className="microcaps">What each role may do</span>
        </div>
        <dl className="divide-y divide-rule">
          {ROLES.map((r) => (
            <div key={r} className="px-3 py-2 grid grid-cols-[84px_1fr] gap-3">
              <dt className="eyebrow text-[9px] pt-0.5">{r}</dt>
              <dd className="text-sm font-serif">{ROLE_NOTE[r]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function MemberRowItem({
  member, billing, isSelf, canManage, isOwner, billingOpen, onToggleBilling, onSaveBilling, savingBilling, onRole, onRemove,
}: {
  member: MemberRow;
  billing?: BillingProfile;
  isSelf: boolean;
  canManage: boolean;
  isOwner: boolean;
  billingOpen: boolean;
  onToggleBilling: () => void;
  onSaveBilling: (draft: BillingDraft) => void;
  savingBilling: boolean;
  onRole: (next: Role) => void;
  onRemove: () => void;
}) {
  // Only an owner may change roles (the server enforces it too), and the last
  // owner must not be able to demote or delete themselves out of the org.
  const canEditRole = isOwner && !(isSelf && member.role === "owner");
  const canRemove = canManage && !(member.role === "owner" && isSelf);
  const isBillable = billing?.billable ?? false;

  return (
    <li className="px-3 py-2.5" data-testid={`member-${member.userId}`}>
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-serif truncate">{member.displayName}</span>
          {member.isAgent ? (
            <span className="stamp inline-flex items-center gap-1 border-ink/50 shrink-0" data-testid={`member-agent-${member.userId}`}>
              <Bot className="h-2.5 w-2.5" /> agent
            </span>
          ) : null}
          {isSelf ? <span className="stamp border-rule text-ink-muted shrink-0">you</span> : null}
          {isBillable ? (
            <span
              className="stamp inline-flex items-center gap-1 border-vermilion/60 !text-vermilion shrink-0"
              title={
                billing?.requireApproval
                  ? "External: their hours are invoiced, and a manager must approve them first."
                  : "External: their hours are invoiced as soon as they are logged."
              }
              data-testid={`member-billable-${member.userId}`}
            >
              <ReceiptText className="h-2.5 w-2.5" /> external · {rateLabel(billing?.hourlyRate ?? null, billing?.currency ?? "USD")}
            </span>
          ) : null}
          {isBillable && billing?.requireApproval ? (
            <span className="stamp border-rule text-ink-muted shrink-0 inline-flex items-center gap-1" title="Their entries close as pending and need a manager's approval before they can be invoiced.">
              <BadgeCheck className="h-2.5 w-2.5" /> approval
            </span>
          ) : null}
        </div>
        <div className={cn("text-[11px] font-mono text-ink-muted truncate", member.isAgent && "italic")}>{member.email}</div>
      </div>

      {canEditRole ? (
        <select
          value={member.role}
          onChange={(e) => onRole(e.target.value as Role)}
          className="draft-input h-8 py-0 text-xs w-[112px] focus-ink"
          aria-label={`Role for ${member.displayName}`}
          data-testid={`member-role-${member.userId}`}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      ) : (
        <span className="stamp border-rule">{member.role}</span>
      )}

      {canManage ? (
        <Hint text="Whether PTD invoices this seat's hours: the rate, the name and tax id the invoice prints as the issuer, and whether a manager must approve the hours first.">
          <button
            onClick={onToggleBilling}
            aria-expanded={billingOpen}
            aria-label={`Billing for ${member.displayName}`}
            className={cn(
              "h-8 px-2.5 rounded-sm border focus-ink inline-flex items-center gap-1.5 transition-colors",
              billingOpen ? "border-ink bg-ink text-parchment" : isBillable ? "border-vermilion/50 text-vermilion hover:bg-vermilion/5" : "border-rule text-ink-muted hover:text-ink"
            )}
            data-testid={`member-billing-toggle-${member.userId}`}
          >
            <ReceiptText className="h-3 w-3" />
            <span className="eyebrow text-[9px] !text-current">billing</span>
          </button>
        </Hint>
      ) : null}

      {canRemove ? (
        <AlertDialog>
          <Hint text={member.isAgent ? "Asks first, then takes the agent's seat away: its tokens stop working immediately and the work it logged stays." : "Asks first, then removes their access to this organization. Their logged time and task history stay on the record."}>
            <AlertDialogTrigger asChild>
              <button aria-label={`Remove ${member.displayName}`} className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5" data-testid={`member-remove-${member.userId}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </AlertDialogTrigger>
          </Hint>
          <AlertDialogContent className="bg-card border border-ink/30 rounded-sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display text-xl font-normal">Remove {member.displayName}?</AlertDialogTitle>
              <AlertDialogDescription className="font-serif">
                {member.isAgent
                  ? "The agent loses its seat immediately; its tokens stop working and the time and events it logged stay on the record."
                  : "They lose access to this organization. Their time entries and task history stay on the record."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="rounded-sm">Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onRemove} className="rounded-sm bg-vermilion text-parchment hover:bg-vermilion/90">Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
      {billingOpen && canManage ? (
        <BillingForm member={member} billing={billing} saving={savingBilling} onSave={onSaveBilling} onCancel={onToggleBilling} />
      ) : null}
    </li>
  );
}

/**
 * The per-member billing form.
 *
 * Deliberately small and inline rather than a modal: turning a colleague into a
 * contractor is four fields and a switch, and pulling it into a dialog would make
 * it feel like a bigger decision than it is. The rate and issuer details stay
 * visible while `billable` is off, greyed rather than hidden, so it is obvious
 * that switching it back on restores what was there.
 */
function BillingForm({
  member, billing, saving, onSave, onCancel,
}: {
  member: MemberRow;
  billing?: BillingProfile;
  saving: boolean;
  onSave: (draft: BillingDraft) => void;
  onCancel: () => void;
}) {
  const [billable, setBillable] = useState(billing?.billable ?? false);
  const [rate, setRate] = useState(billing?.hourlyRate === null || billing?.hourlyRate === undefined ? "" : String(billing.hourlyRate));
  const [currency, setCurrency] = useState(billing?.currency ?? "USD");
  const [billingName, setBillingName] = useState(billing?.billingName ?? "");
  const [billingAddress, setBillingAddress] = useState(billing?.billingAddress ?? "");
  const [taxId, setTaxId] = useState(billing?.taxId ?? "");
  const [requireApproval, setRequireApproval] = useState(billing?.requireApproval ?? false);

  const parsedRate = rate.trim() === "" ? null : Number(rate);
  const rateInvalid = parsedRate !== null && (!Number.isFinite(parsedRate) || parsedRate < 0);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (rateInvalid) return;
        onSave({
          userId: member.userId,
          billable,
          hourlyRate: parsedRate,
          currency: currency.trim().toUpperCase() || "USD",
          billingName: billingName.trim() || null,
          billingAddress: billingAddress.trim() || null,
          taxId: taxId.trim() || null,
          requireApproval,
        });
      }}
      className="mt-3 pt-3 border-t border-rule grid gap-3"
      data-testid={`member-billing-form-${member.userId}`}
    >
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="accent-vermilion h-3.5 w-3.5"
            data-testid={`member-billable-switch-${member.userId}`}
          />
          <span className="eyebrow text-[9px]">external · invoice these hours</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
            className="accent-vermilion h-3.5 w-3.5"
            data-testid={`member-approval-switch-${member.userId}`}
          />
          <span className="eyebrow text-[9px]">a manager must approve the hours</span>
        </label>
      </div>

      <div className={cn("grid gap-2.5 sm:grid-cols-[120px_90px_1fr_150px]", !billable && "opacity-60")}>
        <label className="block">
          <span className="eyebrow text-[9px]">rate / hour</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="45"
            className="draft-input w-full mt-1 text-sm focus-ink font-numeric"
            data-testid={`member-rate-${member.userId}`}
          />
        </label>
        <label className="block">
          <span className="eyebrow text-[9px]">currency</span>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.slice(0, 3).toUpperCase())}
            maxLength={3}
            className="draft-input w-full mt-1 text-sm focus-ink font-numeric uppercase"
            data-testid={`member-currency-${member.userId}`}
          />
        </label>
        <label className="block">
          <span className="eyebrow text-[9px]">invoice name (issuer)</span>
          <input
            value={billingName}
            onChange={(e) => setBillingName(e.target.value)}
            placeholder={member.displayName}
            className="draft-input w-full mt-1 text-sm focus-ink"
            data-testid={`member-billing-name-${member.userId}`}
          />
        </label>
        <label className="block">
          <span className="eyebrow text-[9px]">tax id</span>
          <input value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="VAT / registration" className="draft-input w-full mt-1 text-sm focus-ink font-mono" data-testid={`member-tax-id-${member.userId}`} />
        </label>
      </div>

      <label className={cn("block", !billable && "opacity-60")}>
        <span className="eyebrow text-[9px]">invoice address</span>
        <textarea
          value={billingAddress}
          onChange={(e) => setBillingAddress(e.target.value)}
          rows={2}
          placeholder={"9 Rue Bleue\n75009 Paris"}
          className="draft-input w-full mt-1 text-sm focus-ink font-serif"
          data-testid={`member-billing-address-${member.userId}`}
        />
      </label>

      <p className="text-[11px] font-serif text-ink-muted">
        {billable
          ? requireApproval
            ? "Their finished entries will close as pending. A manager approves a month, then PTD can issue a certified invoice whose hours are locked against later edits."
            : "Every recorded entry in a month can be invoiced. Turn approval on if someone should sign the hours off first."
          : "Off: their hours are tracked like anyone else's and PTD will not invoice them. The rate and issuer details are kept either way."}
      </p>

      <div className="flex items-center justify-end gap-2">
        {rateInvalid ? <span className="eyebrow text-[9px] !text-vermilion mr-auto">a rate cannot be negative</span> : null}
        <button type="button" onClick={onCancel} className="h-8 px-3 rounded-sm border border-rule text-ink-muted hover:text-ink focus-ink">
          <span className="eyebrow text-[9px] !text-current">cancel</span>
        </button>
        <button
          type="submit"
          disabled={saving || rateInvalid}
          className="h-8 px-4 rounded-sm border border-ink bg-ink text-parchment hover:bg-parchment hover:text-ink transition-colors focus-ink disabled:opacity-60 inline-flex items-center gap-2"
          data-testid={`member-billing-save-${member.userId}`}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          <span className="eyebrow text-[9px] !text-current">save</span>
        </button>
      </div>
    </form>
  );
}
