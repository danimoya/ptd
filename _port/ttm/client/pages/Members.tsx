import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2, LogOut } from "lucide-react";
import {
  acceptInvitation,
  getWorkspaceMembers,
  getWorkspaces,
  inviteMember,
  removeMember,
  updateMemberRole,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { currentUserEmail, secondsUntilExpiry, signOut } from "@/lib/auth";

type Member = {
  userId: number;
  role: "owner" | "admin" | "member";
  email: string;
  createdAt: string;
};

export default function Members() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const selectedId = parseInt(localStorage.getItem("workspaceId") || "0", 10);

  const { data: workspaces = [] } = useQuery({
    queryKey: ["/api/workspaces"],
    queryFn: getWorkspaces,
  });

  const active = workspaces.find((w) => w.id === selectedId);
  const canManage = active && (active.role === "owner" || active.role === "admin");

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ["/api/workspaces/members", selectedId],
    queryFn: () => getWorkspaceMembers(selectedId),
    enabled: selectedId > 0,
  });

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [acceptTokenInput, setAcceptTokenInput] = useState("");

  const inviteMutation = useMutation({
    mutationFn: () => inviteMember(selectedId, inviteEmail, inviteRole),
    onSuccess: (data) => {
      setInviteToken(data.token);
      setInviteEmail("");
      toast({ title: "Invitation created" });
    },
    onError: () => toast({ title: "Failed to create invitation", variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: (userId: number) => removeMember(selectedId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/workspaces/members"] });
      toast({ title: "Member removed" });
    },
    onError: () => toast({ title: "Failed to remove member", variant: "destructive" }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: Member["role"] }) =>
      updateMemberRole(selectedId, userId, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/workspaces/members"] });
      toast({ title: "Role updated" });
    },
  });

  const acceptMutation = useMutation({
    mutationFn: acceptInvitation,
    onSuccess: (data) => {
      localStorage.setItem("workspaceId", data.workspaceId.toString());
      toast({ title: "Joined workspace" });
      setAcceptTokenInput("");
      window.location.reload();
    },
    onError: () => toast({ title: "Could not accept invitation", variant: "destructive" }),
  });

  return (
    <div className="animate-ink-fade-in space-y-5 sm:space-y-6">
      <div>
        <div className="eyebrow">
          <span className="text-vermilion">§ IV.</span> The Roll
        </div>
        <h1 className="font-display text-2xl sm:text-4xl font-normal tracking-tight mt-1">
          <span className="italic">Scribes</span> on this volume
        </h1>
      </div>

      {/* ====== Session card ====== */}
      <Card className="paper p-5 rounded-sm sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">Signed in as</div>
            <div className="font-serif italic text-base truncate">
              {currentUserEmail() ?? "—"}
            </div>
            {(() => {
              const s = secondsUntilExpiry();
              if (s == null) return null;
              const label =
                s > 86400
                  ? `${Math.floor(s / 86400)} days remaining`
                  : s > 3600
                  ? `${Math.floor(s / 3600)}h remaining`
                  : s > 60
                  ? `${Math.floor(s / 60)}m remaining`
                  : s > 0
                  ? `${s}s remaining`
                  : "expired";
              return (
                <div className="eyebrow text-[10px] mt-1 text-ink-muted">
                  Session · {label}
                </div>
              );
            })()}
          </div>
          <Button
            variant="outline"
            onClick={() => signOut()}
            className="h-10 rounded-sm border-vermilion/40 text-vermilion hover:bg-vermilion hover:text-parchment font-display uppercase tracking-tight text-sm shrink-0"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </Card>

      <Card className="paper p-5 space-y-3 rounded-sm">
        <h2 className="font-display italic text-lg">Accept an invitation</h2>
        <div className="flex gap-2">
          <Input
            placeholder="Paste invitation token"
            value={acceptTokenInput}
            onChange={(e) => setAcceptTokenInput(e.target.value)}
          />
          <Button
            onClick={() => acceptMutation.mutate(acceptTokenInput)}
            disabled={!acceptTokenInput || acceptMutation.isPending}
          >
            Accept
          </Button>
        </div>
      </Card>

      {active && (
        <Card className="paper p-5 space-y-4 rounded-sm">
          <div>
            <div className="eyebrow">Current volume</div>
            <h2 className="font-display text-xl mt-1">
              <span className="italic">{active.name}</span>
            </h2>
            <p className="eyebrow mt-1">Your role · {active.role}</p>
          </div>

          {canManage && (
            <div className="space-y-2 border-t pt-3">
              <h3 className="text-sm font-semibold">Invite member</h3>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="email"
                  placeholder="teammate@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as any)}>
                  <SelectTrigger className="w-full sm:w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => inviteMutation.mutate()}
                  disabled={!inviteEmail || inviteMutation.isPending}
                >
                  Invite
                </Button>
              </div>
              {inviteToken && (
                <div className="text-xs bg-muted p-2 rounded">
                  Share this token with the invitee to accept: <code className="break-all">{inviteToken}</code>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-semibold">Members</h3>
            {members.map((m) => (
              <div key={m.userId} className="flex flex-wrap items-center gap-2 border rounded-md p-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{m.email}</div>
                </div>
                {canManage && active.role === "owner" ? (
                  <Select
                    value={m.role}
                    onValueChange={(v) => roleMutation.mutate({ userId: m.userId, role: v as Member["role"] })}
                  >
                    <SelectTrigger className="w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="member">Member</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs text-muted-foreground">{m.role}</span>
                )}
                {canManage && m.role !== "owner" && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="icon" variant="ghost" aria-label="Remove">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove {m.email}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          They will lose access to this workspace.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeMutation.mutate(m.userId)}>
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
