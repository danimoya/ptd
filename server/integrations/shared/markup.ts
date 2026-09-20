import type { Reply } from "./format";

/**
 * One reply, three dialects.
 *
 * `shared/format.ts` renders every action result once, in Slack's mrkdwn inside Block
 * Kit: `*bold*`, `_italic_`, `` `code` ``, `<!date^…>`, `<@U1>`, `:emoji:`, and `&`
 * `<` `>` already escaped. That is the intermediate representation. This module turns
 * it into what Telegram and Teams accept, so a command reads the same wherever it was
 * typed and no adapter has to re-render anything.
 *
 * Telegram gets HTML (`parse_mode: "HTML"`) rather than MarkdownV2 on purpose:
 * MarkdownV2 demands that eighteen characters be backslash-escaped *including inside
 * the text of every entity*, so a task title with a `-` or a `.` in it silently breaks
 * the whole message. Telegram's HTML mode needs exactly `&`, `<` and `>` escaped —
 * which the shared renderers already did for Slack's sake — and only the tags this
 * module emits are ever markup. Teams gets flat text with the markers removed.
 */

/** Block Kit → the lines the renderers wrote, body first, context last. */
export function linesOf(reply: Reply): { body: string; context: string } {
  const blocks = (reply.blocks ?? []) as {
    type?: string;
    text?: { text?: string };
    elements?: { text?: string }[];
  }[];
  const body: string[] = [];
  const context: string[] = [];
  for (const block of blocks) {
    if (block?.type === "context") {
      for (const element of block.elements ?? []) if (element?.text) context.push(element.text);
    } else if (block?.text?.text) {
      body.push(block.text.text);
    }
  }
  return { body: body.join("\n"), context: context.join("\n") };
}

/** The handful of Slack emoji shortcodes the renderers use. */
const EMOJI: Record<string, string> = {
  white_check_mark: "✅",
  rotating_light: "🚨",
  calendar: "🗓",
  handshake: "🤝",
  hourglass: "⏳",
};

export function emojify(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (whole, name: string) => EMOJI[name] ?? whole);
}

/**
 * Resolve the Slack-only tokens: a `<!date^…|fallback>` becomes its fallback (the
 * viewer's timezone is Slack's trick and nobody else's), and a `<@U1>` / `<#C1|general>`
 * mention becomes the readable half. Everything this touches carries a literal `<`,
 * so it has to run before the text is treated as escaped.
 */
export function resolveSlackTokens(text: string): string {
  return text
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, "$1")
    .replace(/<([@#!])([^|>]+)(?:\|([^>]*))?>/g, (_m, sigil: string, id: string, label?: string) => {
      const shown = label && label.length > 0 ? label : id;
      return sigil === "#" ? `#${shown}` : `@${shown}`;
    });
}

interface Span {
  code: string;
}

/** The entities the shared renderers escaped, put back so they can be re-applied once. */
export function unescapeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** `&`, `<` and `>` — the three characters Telegram's HTML mode needs escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * mrkdwn → Telegram HTML.
 *
 * The order matters. Slack's own tokens are resolved first, because they are the only
 * place a literal `<` is structure rather than content. Then the text is unescaped and
 * re-escaped once, so the result is correct whether the caller's content had already
 * been escaped (everything from `./format.ts`) or not (a stray string, a future
 * renderer) — and the only `<` left in the output is a tag this function emitted.
 *
 * Code spans are lifted out before emphasis so an asterisk inside `` `like this` ``
 * stays literal. Emphasis is deliberately conservative: the pair has to open and close
 * on the same line with non-space content, so an unbalanced marker in a task title is
 * left as text instead of swallowing the rest of the message.
 */
export function toTelegramHtml(text: string): string {
  const spans: Span[] = [];
  let out = unescapeEntities(resolveSlackTokens(text)).replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push({ code });
    return `\u0000${spans.length - 1}\u0000`;
  });
  out = escapeHtml(out)
    .replace(/\*(?=\S)([^*\n]*\S)\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_(?=\S)([^_\n]*\S)_(?=$|[\s.,;:!?)])/g, "$1<i>$2</i>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => `<code>${escapeHtml(spans[Number(index)]?.code ?? "")}</code>`);
  return emojify(out);
}

/** mrkdwn → flat text, markers gone and entities restored. What Teams shows. */
export function toPlainText(text: string): string {
  return emojify(unescapeEntities(resolveSlackTokens(text).replace(/[*_`]/g, "")));
}

/** A whole reply as Telegram HTML: the body, then the context line in italics. */
export function replyToTelegramHtml(reply: Reply): string {
  const { body, context } = linesOf(reply);
  const html = toTelegramHtml(body);
  // The context line is italic as a whole, so any italics inside it would nest.
  const hint = toTelegramHtml(context).replace(/<\/?i>/g, "");
  return context ? `${html}\n<i>${hint}</i>` : html;
}

/** A whole reply as flat text: the body, then the context line in parentheses. */
export function replyToPlainText(reply: Reply): string {
  const { body, context } = linesOf(reply);
  const text = toPlainText(body);
  return context ? `${text}\n(${toPlainText(context)})` : text;
}
