import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Trash2, UserPlus } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { getCurrentOrg, getMembers, inviteMember, removeMember, updateMemberRole, type MemberRow } from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import { ROLES, type Role } from "../../../../db/schema";
import CopyBlock from "./CopyBlock";

const ROLE_NOTE: Record<Role, string> = {
  owner: "Everything, including billing and handing the org to someone else.",
  admin: "Members, tokens, integrations — everything except transferring ownership.",
  manager: "Plan and Overview: the backlog, apps, streams and stats.",
  member: "Track their own time, read the board. Agents live here.",
};

/** TTM's Members page, on PTD's four-role model with agent seats called out. */
export default function MembersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { me } = useMe();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "manager" | "member">("member");
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  const org = useQuery({ queryKey: ["/api/orgs/current"], queryFn: getCurrentOrg });
  const members = useQuery({ queryKey: ["/api/orgs/current/members"], queryFn: getMembers });

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
                isSelf={m.userId === me?.user.id}
                canManage={canManage}
                isOwner={isOwner}
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
  member, isSelf, canManage, isOwner, onRole, onRemove,
}: {
  member: MemberRow;
  isSelf: boolean;
  canManage: boolean;
  isOwner: boolean;
  onRole: (next: Role) => void;
  onRemove: () => void;
}) {
  // Only an owner may change roles (the server enforces it too), and the last
  // owner must not be able to demote or delete themselves out of the org.
  const canEditRole = isOwner && !(isSelf && member.role === "owner");
  const canRemove = canManage && !(member.role === "owner" && isSelf);

  return (
    <li className="px-3 py-2.5 flex flex-wrap items-center gap-2" data-testid={`member-${member.userId}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-serif truncate">{member.displayName}</span>
          {member.isAgent ? (
            <span className="stamp inline-flex items-center gap-1 border-ink/50 shrink-0" data-testid={`member-agent-${member.userId}`}>
              <Bot className="h-2.5 w-2.5" /> agent
            </span>
          ) : null}
          {isSelf ? <span className="stamp border-rule text-ink-muted shrink-0">you</span> : null}
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

      {canRemove ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button aria-label={`Remove ${member.displayName}`} className="text-ink-muted hover:text-vermilion focus-ink rounded-sm p-1.5" data-testid={`member-remove-${member.userId}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </AlertDialogTrigger>
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
    </li>
  );
}
