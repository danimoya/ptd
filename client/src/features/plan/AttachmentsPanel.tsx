import { useRef, useState } from "react";
import { Bot, Download, FileText, Image as ImageIcon, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMe, canAccess } from "@/hooks/use-me";
import { openAttachment, useAttachmentMutations, useTaskAttachments } from "./api";
import type { TaskAttachment } from "./types";

/** Same ceiling as `express.raw` on the upload route — checked here so a 25 MB mistake never leaves the browser. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Files on the card: a drop zone and a list.
 *
 * Downloads go through `fetch` rather than an `<a href>` because the route is
 * bearer-authenticated (see openAttachment); inline types open in a tab, the
 * rest save to disk, which mirrors what the server's Content-Disposition says.
 */
export function AttachmentsPanel({ taskId, open }: { taskId: number; open: boolean }) {
  const { me, role } = useMe();
  const { toast } = useToast();
  const { data: attachments = [], isLoading } = useTaskAttachments(taskId, open);
  const { upload, remove } = useAttachmentMutations(taskId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const send = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        toast({ title: `${file.name} is empty`, variant: "destructive" });
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast({ title: `${file.name} is too large`, description: "The limit is 25 MB per file.", variant: "destructive" });
        continue;
      }
      try {
        await upload.mutateAsync({ file });
      } catch {
        // useAttachmentMutations already surfaced it as a toast.
      }
    }
  };

  const download = async (attachment: TaskAttachment, mode: "open" | "download") => {
    setBusy(attachment.id);
    try {
      await openAttachment(attachment, mode);
    } catch (error) {
      toast({ title: "Download failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const canDelete = (attachment: TaskAttachment) => attachment.uploadedBy.userId === me?.user.id || canAccess(role, "manager");
  const total = attachments.reduce((sum, a) => sum + a.sizeBytes, 0);

  return (
    <details className="rule-t pt-3">
      <summary className="flex cursor-pointer items-center justify-between text-sm">
        <span className="eyebrow">Files</span>
        <span className="font-mono text-xs tabular-nums text-ink-muted" data-testid="attachment-count">
          {isLoading ? "…" : attachments.length === 0 ? "—" : `${attachments.length} · ${humanSize(total)}`}
        </span>
      </summary>

      <div className="mt-3 space-y-2" data-testid="attachments-panel">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="flex items-center gap-2 border border-rule bg-card px-2.5 py-2" data-testid={`attachment-${attachment.id}`}>
            {attachment.mime.startsWith("image/") ? (
              <ImageIcon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            )}
            <button
              type="button"
              onClick={() => download(attachment, attachment.inline ? "open" : "download")}
              className="min-w-0 flex-1 text-left focus-ink"
              title={attachment.inline ? "Open in a new tab" : "Download"}
            >
              <span className="block truncate font-serif text-sm underline decoration-rule underline-offset-2 hover:decoration-ink">{attachment.filename}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-ink-muted">
                <span className="tabular-nums">{humanSize(attachment.sizeBytes)}</span>
                <span>·</span>
                <span className="truncate">{attachment.uploadedBy.displayName ?? "removed user"}</span>
                {attachment.uploadedBy.isAgent && (
                  <span className="stamp inline-flex items-center gap-0.5 border-vermilion/50 !text-vermilion" data-testid={`attachment-agent-${attachment.id}`}>
                    <Bot className="h-2.5 w-2.5" /> agent
                  </span>
                )}
                <span>·</span>
                <span>{attachment.mime}</span>
              </span>
            </button>
            {busy === attachment.id ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-muted" />
            ) : (
              <button
                type="button"
                onClick={() => download(attachment, "download")}
                title="Download"
                aria-label={`Download ${attachment.filename}`}
                className="shrink-0 text-ink-muted transition-colors hover:text-ink focus-ink"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            {canDelete(attachment) &&
              (confirming === attachment.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={async () => {
                      await remove.mutateAsync({ attachmentId: attachment.id });
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
                  onClick={() => setConfirming(attachment.id)}
                  title="Delete this file"
                  aria-label={`Delete ${attachment.filename}`}
                  className="shrink-0 text-ink-muted transition-colors hover:text-vermilion focus-ink"
                  data-testid={`attachment-delete-${attachment.id}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              ))}
          </div>
        ))}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) void send(e.dataTransfer.files);
          }}
          className={cn(
            "flex items-center justify-center gap-2 border border-dashed px-3 py-4 text-center transition-colors",
            dragging ? "border-vermilion bg-vermilion/5" : "border-rule"
          )}
          data-testid="attachment-dropzone"
        >
          {upload.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-muted" />
              <span className="eyebrow">Uploading…</span>
            </>
          ) : (
            <>
              <Paperclip className="h-3.5 w-3.5 text-ink-muted" />
              <span className="font-serif text-xs text-ink-muted">Drop a file here, or</span>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="inline-flex items-center gap-1.5 border border-rule px-2 py-1 transition-colors hover:border-ink focus-ink"
                data-testid="attachment-browse"
              >
                <Upload className="h-3 w-3" />
                <span className="eyebrow !text-current">choose</span>
              </button>
              <span className="font-mono text-[10px] text-ink-muted">≤ 25 MB</span>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void send(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </details>
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
