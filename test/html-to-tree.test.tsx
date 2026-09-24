// Pasted HTML → a Layout builder tree (client/src/lib/html-to-tree.ts, 4.13):
// each tag becomes its palette element, style becomes CSS, what is unsafe
// or does not fit goes (with a warning) — and the tree draws what the HTML
// showed.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { htmlToTree } from "../client/src/lib/html-to-tree";
import { renderLayout } from "../client/src/components/LayoutView";
import { renderTemplate } from "../client/src/lib/menu-template";
import { sanitizeTree, walkTree, type LNode } from "../client/src/lib/layout-tree";
import { canonOf } from "./helpers/canon";

const kinds = (t: LNode) => { const out: string[] = []; walkTree(t, (n) => out.push(`${n.el}${n.tag ? `:${n.tag}` : ""}`)); return out; };

describe("htmlToTree", () => {
  it("maps tags to the palette and keeps classes, attributes and text", () => {
    const { tree, warnings } = htmlToTree(`
      <section class="card p-2" id="Main Card">
        <h2 class="title">Hello &amp; welcome</h2>
        <p>Some <b>bold</b> text, <a href="https://example.org" target="_blank">a link</a>.</p>
        <ul><li>one<li>two</ul>
        <button type="button" class="btn" aria-label="Go">Go</button>
        <input type="text" placeholder="Name" disabled>
        <select name="s"><option value="a">A<option value="b" selected>B</select>
        <img src="/logo.png" alt="Logo"><hr>
      </section>`);
    expect(warnings).toEqual([]);
    expect(kinds(tree!)).toEqual([
      "panel:section", "heading:h2", "paragraph:p", "text", "area:b", "text", "text", "link:a", "text", "list:ul", "item:li", "text", "item:li", "text",
      "button:button", "input:input", "select:select", "option:option", "option:option", "image:img", "separator:hr",
    ]);
    expect(tree!.id).toBe("main-card");
    expect(tree!.attrs).toEqual({ class: "card p-2", id: "Main Card" });
    const [h2, p, ul, button, input, select] = tree!.children!;
    expect(h2.text).toBe("Hello & welcome");
    expect(p.children!.map((c) => c.text ?? c.children?.[0].text)).toEqual(["Some ", "bold", " text, ", "a link", "."]);
    expect(ul.children!.map((c) => c.children![0].text)).toEqual(["one", "two"]);
    expect(button).toMatchObject({ text: "Go", attrs: { type: "button", class: "btn", "aria-label": "Go" } });
    expect(input.attrs).toEqual({ type: "text", placeholder: "Name", disabled: "" });
    expect(select.children!.map((o) => [o.text, o.attrs])).toEqual([["A", { value: "a" }], ["B", { value: "b", selected: "" }]]);
    expect(sanitizeTree(tree)).toEqual(tree);
  });

  it("drops scripts, handlers, frames and unsafe addresses, with warnings", () => {
    const { tree, warnings } = htmlToTree(`<div onclick="steal()"><script>alert(1)</script><iframe src="https://x"></iframe><a href="javascript:alert(1)">x</a><img src="data:text/html,<b>" alt=""><span style="color: red; background: url(https://evil/x.png)">s</span></div>`);
    const json = JSON.stringify(tree);
    expect(json).not.toMatch(/steal|alert|iframe|javascript|evil|text\/html/);
    expect(warnings.join("\n")).toMatch(/<script> removed/);
    expect(warnings.join("\n")).toMatch(/<iframe> removed/);
    expect(warnings.join("\n")).toMatch(/on… handlers removed/);
    expect(warnings.join("\n")).toMatch(/href="…" left out/);
    expect(warnings.join("\n")).toMatch(/CSS background left out/);
    expect(tree!.children!.find((c) => c.el === "area")!.css).toEqual({ color: "red" });
  });

  it("turns lucide SVGs into icons and several top elements into a group", () => {
    const { tree } = htmlToTree(`<svg class="lucide lucide-send h-4 w-4" aria-hidden="true"><path d="M1 1"/></svg><span>x</span>`);
    expect(tree!.el).toBe("group");
    expect(tree!.children![0]).toMatchObject({ el: "icon", props: { icon: "send" }, attrs: { class: "h-4 w-4", "aria-hidden": "true" } });
  });

  it("keeps working templates, and makes other braces and a leading = literal", () => {
    const { tree } = htmlToTree(`<p>Hi {$user.nickname}</p><p>a{b} and {if}</p><input value="=1+1">`);
    const [p1, p2, input] = tree!.children!;
    expect(p1.text).toBe("Hi {$user.nickname}");
    expect(renderTemplate(p2.text!, {}, { raw: true })).toBe("a{b} and {if}");
    expect(renderTemplate(input.attrs!.value, {}, { raw: true })).toBe("=1+1");
  });

  it("draws what the HTML showed", () => {
    const html = `<div class="row"><span class="a">One</span> <strong>two</strong><ul><li>x</li><li>y</li></ul><a href="/p">link</a></div>`;
    const { tree } = htmlToTree(html);
    const a = render(<>{renderLayout(tree!, { data: {} })}</>).container;
    const b = document.createElement("div");
    b.innerHTML = html;
    expect(canonOf(a)).toBe(canonOf(b));
  });

  it("refuses what is too long or empty", () => {
    expect(htmlToTree("x".repeat(200_001)).tree).toBeNull();
    expect(htmlToTree("  <!-- only a comment -->  ").tree).toBeNull();
  });
});
