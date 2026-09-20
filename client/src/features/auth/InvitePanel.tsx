import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InviteInfo } from "./api";

/**
 * What the invitation in the URL is for, stated before anyone types anything.
 *
 * An invitation is bound to an address, so the panel names it: half the failures
 * of an invite flow are somebody signing in with a different account and then
 * wondering why they are in the wrong organization.
 */
export default function InvitePanel({ invite }: { invite: InviteInfo }) {
  const dead = invite.expired || invite.accepted;
  return (
    <div
      className={cn("border p-4", dead ? "border-rule bg-card" : "border-vermilion/60 bg-vermilion/5")}
      data-testid="invite-panel"
    >
      <div className="eyebrow mb-1 flex items-center gap-1.5 text-vermilion">
        <Mail className="h-3 w-3" />
        {invite.accepted ? "Already accepted" : invite.expired ? "Expired invitation" : "An invitation"}
      </div>

      {invite.accepted ? (
        <p className="text-[0.9rem] leading-relaxed text-ink-muted">
          This invitation to <strong className="text-ink">{invite.orgName}</strong> has already been accepted. Sign in with{" "}
          <span className="font-numeric text-[0.8rem] text-ink">{invite.email}</span> and you are already on the roll.
        </p>
      ) : invite.expired ? (
        <p className="text-[0.9rem] leading-relaxed text-ink-muted">
          This invitation to <strong className="text-ink">{invite.orgName}</strong> has expired. Ask an admin there to send it again —
          they can resend it from the Org tab without starting over.
        </p>
      ) : (
        <p className="text-[0.9rem] leading-relaxed text-ink-muted">
          You have been invited to <strong className="text-ink">{invite.orgName}</strong> as{" "}
          <span className="text-ink">{invite.role}</span>. Sign in as{" "}
          <span className="font-numeric text-[0.8rem] text-ink">{invite.email}</span>, or create an account with that address, and
          you will be added on the way in.
        </p>
      )}
    </div>
  );
}
