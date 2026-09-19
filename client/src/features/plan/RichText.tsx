import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import DOMPurify from "dompurify";
import { Bold, Italic, List, ListChecks, ListOrdered, Underline as UnderlineIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Card descriptions are rich text stored as HTML on `tasks.description`.
 * Editor and renderer live together so the allow-list on the way out can be
 * read against the toolbar on the way in.
 */

interface RichEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

export function RichEditor({ value, onChange, placeholder }: RichEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [3, 4] } }), Underline, TaskList, TaskItem.configure({ nested: true })],
    content: value || "",
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none min-h-[110px] max-h-[260px] overflow-auto nice-scroll px-3 py-2 focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // Tiptap emits "<p></p>" for an empty document — store it as "" so every
      // `if (description)` check downstream behaves.
      onChange(html === "<p></p>" ? "" : html);
    },
  });

  // Follow the parent when it resets the field (dialog reopened on another card).
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === value) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="border border-rule bg-card min-h-[140px] p-3">
        <span className="eyebrow">Loading editor…</span>
      </div>
    );
  }

  return (
    <div className="border border-rule bg-card">
      <div className="flex items-center gap-1 px-2 py-1.5 rule-b bg-parchment-deep/40">
        <ToolbarButton icon={Bold} label="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolbarButton icon={Italic} label="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolbarButton icon={UnderlineIcon} label="Underline" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <span className="mx-1 h-4 w-px bg-rule" />
        <ToolbarButton icon={List} label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolbarButton icon={ListOrdered} label="Ordered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolbarButton icon={ListChecks} label="Checklist" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()} />
      </div>
      {editor.isEmpty && placeholder && (
        <div className="px-3 pt-2 font-serif text-sm text-ink-muted/70 italic pointer-events-none select-none">{placeholder}</div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarButton({ icon: Icon, label, active, onClick }: { icon: LucideIcon; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "h-7 w-7 flex items-center justify-center transition-colors focus-ink",
        active ? "bg-ink text-parchment" : "text-ink-muted hover:text-ink hover:bg-parchment"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: ["p", "strong", "em", "u", "s", "code", "pre", "br", "ul", "ol", "li", "a", "blockquote", "h3", "h4", "label", "input", "div", "span"],
  ALLOWED_ATTR: ["data-type", "data-checked", "checked", "type", "href", "rel", "target"],
  USE_PROFILES: { html: true },
};

/**
 * Renders editor HTML. DOMPurify is not optional here: a description can be
 * written by an agent over MCP, so it is untrusted input by construction.
 * Plain text (rows written before the editor existed, or by an integration)
 * is wrapped in a paragraph instead of being pushed through the sanitiser.
 */
export function RichDisplay({ html, className, clamp }: { html: string; className?: string; clamp?: 2 | 3 | 4 }) {
  if (!html) return null;
  const looksLikeHtml = /<[a-z][^>]*>/i.test(html);
  const sanitized = looksLikeHtml ? DOMPurify.sanitize(html, SANITIZE_CONFIG) : `<p>${escapeHtml(html)}</p>`;
  const clampClass = clamp === 2 ? "line-clamp-2" : clamp === 3 ? "line-clamp-3" : clamp === 4 ? "line-clamp-4" : undefined;
  return (
    <div
      className={cn("prose prose-sm max-w-none font-serif text-ink-muted", clampClass, className)}
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
