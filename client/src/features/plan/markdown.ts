import DOMPurify from "dompurify";

/**
 * Markdown-lite for comments.
 *
 * Comment bodies are stored exactly as they were typed (server/plan/comments.ts)
 * because they can be written by a human in the dialog, by an agent over MCP or
 * by a chat bot through `/ptd comment` — there is no trustworthy moment to bake
 * HTML into the column. So the rendering lives here, and it is deliberately
 * small: **bold**, _italic_, `code`, [text](url) and bare links. Everything
 * else, including any HTML the author typed, shows as literal text.
 *
 * Two layers, on purpose:
 *   1. `markdownLiteToHtml` escapes first and only ever emits its own tags, so
 *      it cannot produce anything unexpected from any input;
 *   2. `renderMarkdownLite` still runs the result through DOMPurify, because a
 *      renderer nobody sanitises is one refactor away from an XSS.
 */

const ALLOWED_TAGS = ["p", "br", "strong", "em", "code", "a"];
const ALLOWED_ATTR = ["href", "rel", "target"];

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Only these schemes ever become a link; everything else stays as text. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(trimmed)) return null;
  if (/[\s<>"']/.test(trimmed)) return null;
  return trimmed;
}

function link(href: string, label: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
}

/**
 * The inline pass. Code spans are lifted out first so the characters inside them
 * are never read as emphasis — `**not bold**` inside backticks stays literal.
 */
function inline(escaped: string): string {
  const code: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, body: string) => {
    code.push(body);
    return `\u0000${code.length - 1}\u0000`;
  });

  // [label](url)
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) => {
    // The text arrives HTML-escaped, so "&amp;" in a URL has to come back.
    const href = safeHref(url.replace(/&amp;/g, "&"));
    return href ? link(escapeHtml(href), label) : match;
  });

  // Bare URLs, but not ones already inside an href we just wrote.
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"')]+)/g, (match, lead: string, url: string) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return match;
    const trimmed = href.replace(/[.,;:!?]+$/, "");
    const tail = href.slice(trimmed.length);
    return `${lead}${link(escapeHtml(trimmed), escapeHtml(trimmed))}${tail}`;
  });

  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    // A single * or _ around text, but not one glued to a word (snake_case) and
    // not one with a space just inside it — "2 * 3 * 4" is arithmetic, not italics.
    .replace(/(^|[\s(])\*([^\s*]|[^\s*][^*\n]*[^\s*])\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^\s_]|[^\s_][^_\n]*[^\s_])_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${code[Number(i)]}</code>`);
}

/** Markdown-lite source → HTML. Pure: no DOM, so it is testable in node. */
export function markdownLiteToHtml(text: string): string {
  const escaped = escapeHtml(String(text ?? "").replace(/\r\n?/g, "\n").trim());
  if (!escaped) return "";
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${inline(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Markdown-lite source → HTML that is safe to inject. */
export function renderMarkdownLite(text: string): string {
  return DOMPurify.sanitize(markdownLiteToHtml(text), { ALLOWED_TAGS, ALLOWED_ATTR });
}
