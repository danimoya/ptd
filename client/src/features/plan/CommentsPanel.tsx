import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Bot, MessageSquare, Send, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMe, canAccess } from "@/hooks/use-me";
import { useCommentMutations, useTaskComments } from "./api";
import { renderMarkdownLite } from "./markdown";
import type { TaskComment } from "./types";

/**
 * The card's discussion, chronological, with the composer at the bottom — the
 * shape every chat-like thread has, and the opposite of the History panel above
 * it (newest first), because history is a log and this is a conversation.
 *
 * Bodies are markdown-lite source; `renderMarkdownLite` escapes, converts the
 * five marks it supports and sanitises the result. An agent's comment is
 * labelled as one, the same way the History panel labels an agent actor.
 */
export function CommentsPanel({ taskId, open }: { taskId: number; open: boolean }) {
  const { me, role } = useMe();
  const { data: comments = [], isLoading } = useTaskComments(taskId, open);
  const { add, remove } = useCommentMutations(taskId);
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    try {
      await add.mutateAsync({ body: text });
      setBody("");
    } catch {
      // useCommentMutations already surfaced it as a toast.
    }
  };

  const canDelete = (comment: TaskComment) => comment.author.userId === me?.user.id || canAccess(role, "manager");

  return (
    <details className="rule-t pt-3" open>
      <summary className="flex cursor-pointer items-center justify-between text-sm">
        <span className="eyebrow">Comments</span>
        <span className="font-mono text-xs tabular-nums text-ink-muted" data-testid="comment-count">
          {isLoading ? "…" : comments.length}
        </span>
      </summary>

      <div className="mt-3 space-y-3" data-testid="comments-panel">
        {isLoading && <div className="eyebrow">Loading…</div>}
        {!isLoading && comments.length === 0 && (
          <div className="font-serif text-xs text-ink-muted">
            <MessageSquare className="mr-1.5 -mt-0.5 inline h-3 w-3" />
            No comments yet — the first one sets the context.
          </div>
        )}

        {comments.map((comment) => (
          <article key={comment.id} className="border-l-2 border-rule pl-2.5" data-testid={`comment-${comment.id}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className={cn("truncate font-mono text-[11px]", comment.author.isAgent && "text-vermilion")}>
                  {comment.author.displayName ?? "removed user"}
                </span>
                {comment.author.isAgent && (
                  <span className="stamp inline-flex shrink-0 items-center gap-0.5 border-vermilion/50 !text-vermilion" data-testid={`comment-agent-${comment.id}`}>
                    <Bot className="h-2.5 w-2.5" /> agent
                  </span>
                )}
                <span className="shrink-0 font-mono text-[10px] text-ink-muted/80">{when(comment.createdAt)} · via {comment.via}</span>
              </span>
              {canDelete(comment) &&
                (confirming === comment.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={async () => {
                        await remove.mutateAsync({ commentId: comment.id });
                        setConfirming(null);
                      }}
                      className="eyebrow border border-vermilion bg-vermilion px-1.5 py-0.5 !text-parchment"
                    >
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="eyebrow border border-rule px-1.5 py-0.5">
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(comment.id)}
                    title="Delete this comment"
                    aria-label="Delete this comment"
                    className="shrink-0 text-ink-muted transition-colors hover:text-vermilion focus-ink"
                    data-testid={`comment-delete-${comment.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                ))}
            </div>
            <div
              className="prose prose-sm mt-1 max-w-none font-serif text-sm text-ink [&_a]:text-vermilion [&_code]:font-mono [&_code]:text-[12px] [&_p]:my-1"
              // Sanitised by renderMarkdownLite; a body can come from an agent or a chat bot.
              dangerouslySetInnerHTML={{ __html: renderMarkdownLite(comment.body) }}
            />
          </article>
        ))}

        <div className="paper-flat p-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — and Ctrl/⌘+Enter too,
              // for anyone whose muscle memory came from a comment box that needs it.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="Comment — **bold**, _italic_, `code`, links"
            aria-label="New comment"
            className="draft-input w-full resize-y font-serif text-sm"
            data-testid="comment-input"
          />
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-ink-muted">markdown-lite · enter sends</span>
            <button
              type="button"
              onClick={submit}
              disabled={!body.trim() || add.isPending}
              className="flex items-center gap-1.5 border border-ink bg-ink px-3 py-1.5 text-parchment transition-colors hover:bg-parchment hover:text-ink focus-ink disabled:opacity-50"
              data-testid="comment-submit"
            >
              <Send className="h-3 w-3" />
              <span className="eyebrow !text-current">{add.isPending ? "Sending" : "Comment"}</span>
            </button>
          </div>
        </div>
      </div>
    </details>
  );
}

function when(value: string | null): string {
  if (!value) return "just now";
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return value;
  }
}
