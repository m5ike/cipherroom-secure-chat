// Markdown of AI answers (client/src/lib/markdown.ts, components/Markdown.tsx,
// 4.14): what is parsed, how it is drawn, that nothing in an answer becomes
// markup or a script link, and that half-written answers (a stream) draw.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { parseInline, parseMarkdown, plainText, safeHref } from "../client/src/lib/markdown";
import { Markdown } from "../client/src/components/Markdown";

afterEach(() => cleanup());

const html = (md: string) => {
  const { container } = render(<Markdown text={md} />);
  return container.innerHTML;
};

describe("parsing", () => {
  it("blocks: headings, paragraphs, lists, code, quotes, rules, tables", () => {
    const md = [
      "# Nadpis", "", "Odstavec s **tučným**, *kurzívou* a `kódem`.", "Druhý řádek.", "",
      "- jedna", "- dvě", "  - vnořená", "", "3. tři", "4. čtyři", "", "```ts", "const x = 1;", "```", "", "> citace", "", "---", "",
      "| a | b |", "|---|:-:|", "| 1 | 2 |",
    ].join("\n");
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "list", "list", "code", "quote", "hr", "table"]);
    expect(blocks[2]).toMatchObject({ t: "list", ordered: false });
    expect((blocks[2] as { items: unknown[][] }).items).toHaveLength(2);
    expect((blocks[2] as { items: Array<Array<{ t: string }>> }).items[1].map((b) => b.t)).toEqual(["p", "list"]);
    expect(blocks[3]).toMatchObject({ t: "list", ordered: true, start: 3 });
    expect(blocks[4]).toEqual({ t: "code", lang: "ts", v: "const x = 1;" });
    expect(blocks[7]).toMatchObject({ t: "table", head: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]] });
  });

  it("inline: code first, emphasis, strike-through, links, bare addresses, escapes; snake_case stays", () => {
    expect(parseInline("a `**not bold**` b")).toEqual([{ t: "text", v: "a " }, { t: "code", v: "**not bold**" }, { t: "text", v: " b" }]);
    expect(parseInline("~~staré~~ __nové__ _jemně_")).toEqual([
      { t: "del", c: [{ t: "text", v: "staré" }] }, { t: "text", v: " " }, { t: "strong", c: [{ t: "text", v: "nové" }] }, { t: "text", v: " " }, { t: "em", c: [{ t: "text", v: "jemně" }] },
    ]);
    expect(parseInline("some_snake_case_name")).toEqual([{ t: "text", v: "some_snake_case_name" }]);
    expect(parseInline("viz https://example.org/a_(b). Konec")).toEqual([
      { t: "text", v: "viz " }, { t: "link", href: "https://example.org/a_(b)", c: [{ t: "text", v: "https://example.org/a_(b)" }] }, { t: "text", v: ". Konec" },
    ]);
    expect(parseInline("\\*ne\\*")).toEqual([{ t: "text", v: "*ne*" }]);
    expect(parseInline("[M5cet](https://chat.fir.ma \"titulek\")")).toEqual([{ t: "link", href: "https://chat.fir.ma", c: [{ t: "text", v: "M5cet" }] }]);
  });

  it("an unclosed code block (an answer still being written) runs to the end", () => {
    expect(parseMarkdown("Tady:\n```py\nprint(1)\nprint(2")).toEqual([
      { t: "p", c: [{ t: "text", v: "Tady:" }] }, { t: "code", lang: "py", v: "print(1)\nprint(2" },
    ]);
    expect(parseMarkdown("**nedokonč")).toEqual([{ t: "p", c: [{ t: "text", v: "**nedokonč" }] }]);
  });

  it("plain text without the marks (copying)", () => {
    expect(plainText(parseMarkdown("# A\n\n- **b**\n- c\n\n```\nx\n```"))).toBe("A\n\n- b\n- c\n\nx");
  });
});

describe("safety", () => {
  it("links only to https, http and mailto", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(" JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>x</b>")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("https://ok.example/a?b=1")).toBe("https://ok.example/a?b=1");
    expect(safeHref("mailto:a@b.cz")).toBe("mailto:a@b.cz");
    expect(parseInline("[klikni](javascript:alert(1))")).toEqual([{ t: "text", v: "klikni" }, { t: "text", v: ")" }]);
  });

  it("HTML in an answer stays text", () => {
    const out = html("<img src=x onerror=alert(1)> <script>alert(2)</script> [x](javascript:alert(3)) <b>b</b>");
    expect(out).not.toMatch(/<img|<script|<b>|href="javascript/i);
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links open in a new tab without the page's opener", () => {
    const out = html("[a](https://example.org)");
    expect(out).toContain('href="https://example.org"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("deep nesting and huge input end (no endless recursion, no hang)", () => {
    const deep = "> ".repeat(200) + "x";
    expect(() => parseMarkdown(deep)).not.toThrow();
    const stars = "*".repeat(20_000);
    const started = Date.now();
    parseMarkdown(stars + " x " + stars);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("drawing", () => {
  it("draws lists tight, code as pre, headings a size down, tables", () => {
    const out = html("## Kroky\n\n1. **první**\n2. druhý\n\n```sh\nnpm run build\n```\n\n| k | v |\n|---|---|\n| a | `b` |");
    expect(out).toContain('<h3 class="md-h md-h2">Kroky</h3>');
    expect(out).toContain('<ol class="md-list"><li><strong>první</strong></li><li>druhý</li></ol>');
    expect(out).toContain('<pre class="md-pre" data-lang="sh"><code>npm run build</code></pre>');
    expect(out).toContain('<td><code class="md-code">b</code></td>');
  });
});
