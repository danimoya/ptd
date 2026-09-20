import { describe, expect, it } from "vitest";

/**
 * Markdown-lite rendering for comments.
 *
 * A comment body can be written by a human, by an agent over MCP or by a chat
 * bot, so the renderer is treated as a security boundary: it escapes first,
 * emits only its own five marks, and is sanitised afterwards anyway.
 */
import { escapeHtml, markdownLiteToHtml, renderMarkdownLite } from "../../client/src/features/plan/markdown";

describe("markdownLiteToHtml", () => {
  it("wraps text in paragraphs and keeps single newlines as breaks", () => {
    expect(markdownLiteToHtml("one")).toBe("<p>one</p>");
    expect(markdownLiteToHtml("one\ntwo")).toBe("<p>one<br>two</p>");
    expect(markdownLiteToHtml("one\n\ntwo")).toBe("<p>one</p><p>two</p>");
    expect(markdownLiteToHtml("   ")).toBe("");
    expect(markdownLiteToHtml("")).toBe("");
  });

  it("renders the five marks it claims to support", () => {
    expect(markdownLiteToHtml("**bold**")).toBe("<p><strong>bold</strong></p>");
    expect(markdownLiteToHtml("__bold__")).toBe("<p><strong>bold</strong></p>");
    expect(markdownLiteToHtml("say *this* now")).toBe("<p>say <em>this</em> now</p>");
    expect(markdownLiteToHtml("say _this_ now")).toBe("<p>say <em>this</em> now</p>");
    expect(markdownLiteToHtml("run `npm test`")).toBe("<p>run <code>npm test</code></p>");
  });

  it("leaves snake_case and maths alone", () => {
    expect(markdownLiteToHtml("task_custom_values is a table")).toBe("<p>task_custom_values is a table</p>");
    expect(markdownLiteToHtml("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
  });

  it("does not read emphasis inside a code span", () => {
    expect(markdownLiteToHtml("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  it("links [text](url) and bare URLs, for http(s) and mailto only", () => {
    expect(markdownLiteToHtml("[the spec](https://example.com/a)")).toBe(
      '<p><a href="https://example.com/a" target="_blank" rel="noopener noreferrer nofollow">the spec</a></p>'
    );
    expect(markdownLiteToHtml("see https://example.com/x for more")).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">https://example.com/x</a>'
    );
    // Trailing punctuation belongs to the sentence, not the URL.
    expect(markdownLiteToHtml("see https://example.com/x.")).toContain('href="https://example.com/x"');
    expect(markdownLiteToHtml("see https://example.com/x.")).toMatch(/<\/a>\.<\/p>$/);
    // A scheme that is not http(s)/mailto is left as plain text.
    expect(markdownLiteToHtml("[click](javascript:alert(1))")).toBe("<p>[click](javascript:alert(1))</p>");
    expect(markdownLiteToHtml("[click](data:text/html,<script>)")).not.toContain("<a ");
  });

  it("escapes every HTML character in the source", () => {
    expect(escapeHtml('<b>"x" & y</b>')).toBe("&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;");
    const out = markdownLiteToHtml('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(markdownLiteToHtml("<script>alert(1)</script>")).not.toContain("<script");
  });

  it("cannot be talked into an attribute or a tag through a link label", () => {
    const out = markdownLiteToHtml('[" onmouseover="alert(1)](https://example.com)');
    expect(out).not.toContain("onmouseover=\"alert");
    expect(out).toContain("&quot;");
  });
});

describe("renderMarkdownLite", () => {
  it("emits sanitised HTML with only the tags the panel styles", () => {
    expect(renderMarkdownLite("**hi** `x` [a](https://e.com)")).toBe(
      '<p><strong>hi</strong> <code>x</code> <a href="https://e.com" target="_blank" rel="noopener noreferrer nofollow">a</a></p>'
    );
  });

  it("emits no tag it does not own, whatever the body says", () => {
    for (const evil of ['<img src=x onerror="alert(1)">', "<script>alert(1)</script>", "<iframe src=//evil></iframe>", "<svg/onload=alert(1)>", "<a href=javascript:alert(1)>x</a>"]) {
      const out = renderMarkdownLite(evil);
      // Every tag in the output is one of the five the panel styles — the
      // payload survives only as visible text, which is the point.
      for (const tag of out.match(/<\/?([a-z0-9]+)/gi) ?? []) {
        expect(["<p", "</p", "<br", "<strong", "</strong", "<em", "</em", "<code", "</code", "<a", "</a"]).toContain(tag.toLowerCase());
      }
      expect(out).toContain("&lt;");
      // And any link that IS rendered can only point somewhere navigable.
      const holder = document.createElement("div");
      holder.innerHTML = out;
      for (const anchor of Array.from(holder.querySelectorAll("a"))) {
        expect(anchor.getAttribute("href") ?? "").toMatch(/^(https?:|mailto:)/);
      }
    }
  });
});
