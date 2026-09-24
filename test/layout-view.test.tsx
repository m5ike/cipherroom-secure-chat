// LayoutView (4.0.5): how a Layout builder tree is drawn — templates as text
// (never markup), conditions, repeats with their own scope, typed attributes,
// events with arguments, refs, live parts, reusable templates, safe HTML and
// addresses, the designer's style — and errors reported, not thrown.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { renderLayout, setLayoutPreviewMode, type LayoutEnv } from "../client/src/components/LayoutView";
import type { LNode } from "../client/src/lib/layout-tree";

beforeEach(() => { cleanup(); setLayoutPreviewMode(null); });

const draw = (tree: LNode, env: Partial<LayoutEnv> = {}) => render(<>{renderLayout(tree, { data: {}, ...env })}</>);

describe("LayoutView", () => {
  it("puts values in as text: markup in data stays text", () => {
    const { container } = draw(
      { id: "p", el: "paragraph", tag: "p", text: "Hi {$name}, {_'k'}" },
      { data: { name: "<b>bold</b> & co" }, translate: (k) => `[${k}]` },
    );
    expect(container.querySelector("p")!.textContent).toBe("Hi <b>bold</b> & co, [k]");
    expect(container.querySelector("b")).toBeNull();
  });

  it("shows only when, repeats with its own scope and keys", () => {
    const tree: LNode = {
      id: "ul", el: "list", tag: "ul", children: [
        { id: "li", el: "item", tag: "li", each: "$people", as: "p", key: "$p.id", if: "!$p.hidden", attrs: { "data-testid": "row-{$p.id}", class: "{if $iterator.first}first{/if}" }, text: "{$iterator.counter}. {$p.name|upper}" },
      ],
    };
    const { container } = draw(tree, { data: { people: [{ id: "a", name: "ann" }, { id: "b", name: "bob", hidden: true }, { id: "c", name: "cyd" }] } });
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((r) => r.textContent)).toEqual(["1. ANN", "3. CYD"]);
    expect(rows[0].getAttribute("class")).toBe("first");
    expect(rows[1].getAttribute("data-testid")).toBe("row-c");
  });

  it("keeps an expression's type: booleans, numbers, null leaves the attribute out", () => {
    const { container } = draw({
      id: "b", el: "button", tag: "button", text: "x",
      attrs: { type: "button", disabled: "=$n == 0", "aria-pressed": "=$on", "data-private": "=$priv ? '1' : null", title: "{$n} people", tabindex: "=$n" },
    }, { data: { n: 0, on: false, priv: false } });
    const b = container.querySelector("button")!;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.hasAttribute("data-private")).toBe(false);
    expect(b.getAttribute("title")).toBe("0 people");
    expect(b.getAttribute("tabindex")).toBe("0");
  });

  it("runs actions with the event and an argument from its scope", () => {
    const reply = vi.fn();
    const { getAllByRole } = draw({
      id: "l", el: "panel", tag: "div", children: [{ id: "btn", el: "button", tag: "button", each: "$ids", as: "i", text: "{$i}", on: { click: { action: "reply", arg: "$i" } } }],
    }, { data: { ids: ["x", "y"] }, actions: { reply } });
    fireEvent.click(getAllByRole("button")[1]);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][1]).toBe("y");
    expect((reply.mock.calls[0][0] as { type: string }).type).toBe("click");
  });

  it("hands refs, live parts (with an argument) and templates to the component", () => {
    const ref = createRef<HTMLDivElement>();
    const tree: LNode = {
      id: "root", el: "panel", tag: "div", ref: "box", children: [
        { id: "s", el: "slot", slot: "card", each: "$items", as: "it", arg: "$it" },
        { id: "blk", el: "block", block: "hello", arg: "'Ann'" },
        { id: "missing", el: "slot", slot: "nope" },
      ],
    };
    const { container } = draw(tree, {
      data: { items: [1, 2] },
      refs: { box: ref as never },
      slots: { card: (arg) => <i data-card={String(arg)} /> },
      blocks: { hello: { id: "h", el: "area", tag: "span", text: "Hello {$arg}" } },
    });
    expect(ref.current).toBe(container.firstElementChild);
    expect([...container.querySelectorAll("i")].map((i) => i.getAttribute("data-card"))).toEqual(["1", "2"]);
    expect(container.querySelector("span")!.textContent).toBe("Hello Ann");
  });

  it("stops a template that uses itself", () => {
    const loop: LNode = { id: "b", el: "block", block: "self" };
    const { container } = draw({ id: "r", el: "panel", tag: "div", children: [loop] }, { blocks: { self: { id: "p", el: "panel", tag: "div", attrs: { class: "x" }, children: [loop] } } });
    expect(container.querySelectorAll(".x").length).toBeLessThanOrEqual(6);
  });

  it("draws safe HTML only, and data-action runs an action", () => {
    const go = vi.fn();
    const { container } = draw({
      id: "h", el: "html", text: "<b onclick=\"x()\">{$who}</b><script>alert(1)</script><a href=\"javascript:x\">l</a><button data-action=\"fn:go:7\">go</button>",
    }, { data: { who: "<i>Ann</i>" }, actions: { go } });
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toMatch(/onclick|javascript:/);
    expect(container.querySelector("b")!.textContent).toBe("<i>Ann</i>");
    fireEvent.click(container.querySelector("button")!);
    expect(go).toHaveBeenCalledWith(expect.anything(), "7");
  });

  it("checks addresses when drawn, and reports what does not work", () => {
    const onError = vi.fn();
    const { container } = draw({
      id: "r", el: "panel", tag: "div", children: [
        { id: "a1", el: "link", tag: "a", attrs: { href: "=$bad" }, text: "bad" },
        { id: "a2", el: "link", tag: "a", attrs: { href: "=$file", download: "f.pdf" }, text: "file" },
        { id: "t", el: "text", text: "{if $x}unclosed" },
        { id: "e", el: "panel", tag: "div", if: "$a +* $b" },
      ],
    }, { data: { bad: "javascript:alert(1)", file: "data:application/pdf;base64,AA" }, onError });
    const links = container.querySelectorAll("a");
    expect(links[0].hasAttribute("href")).toBe(false);
    expect(links[1].getAttribute("href")).toBe("data:application/pdf;base64,AA");
    const failed = onError.mock.calls.map((c) => c[0]);
    expect(failed).toEqual(expect.arrayContaining(["a1", "t", "e"]));
  });

  it("applies CSS, CSS from data and the designer's style with states", () => {
    const { container } = draw({
      id: "d", el: "panel", tag: "div",
      css: { display: "flex", "font-size": "{$size}px", background: "{$bg}" },
      styleBind: "$bound",
      style: { fontWeight: "700", states: { hover: { background: "primary" } } },
      attrs: { class: "box" },
    }, { data: { size: 13, bg: "url(x)", bound: { color: "red" } } });
    const d = container.querySelector("div")!;
    expect(d.style.display).toBe("flex");
    expect(d.style.fontSize).toBe("13px");
    expect(d.style.background).toBe(""); // url() from data is refused too
    expect(d.style.color).toBe("red");
    expect(d.style.fontWeight).toBe("700");
    expect(d.className).toBe("box mb-hover-bg");
  });

  it("draws icons by name or by an old name, the logo and avatars", () => {
    const { container } = draw({
      id: "r", el: "panel", tag: "div", children: [
        { id: "i1", el: "icon", props: { icon: "{if $on}moon{else}sun{/if}" }, attrs: { class: "h-4 w-4" } },
        { id: "i2", el: "icon", props: { icon: "smile" }, attrs: { class: "h-4 w-4", "aria-label": "smile" } },
        { id: "lg", el: "logo", props: { size: "16", mono: "=true" }, attrs: { class: "logo" } },
        { id: "av", el: "avatar", props: { name: "Ann", size: "20" } },
      ],
    }, { data: { on: true } });
    const svgs = container.querySelectorAll("svg");
    expect(svgs[0].getAttribute("class")).toContain("lucide-moon");
    expect(svgs[0].getAttribute("aria-hidden")).toBe("true");
    expect(svgs[1].getAttribute("class")).toContain("lucide-face-slightly-smiling");
    expect(svgs[1].getAttribute("aria-label")).toBe("smile");
    expect(svgs[2].getAttribute("class")).toBe("logo");
    expect(container.querySelector(".user-avatar")!.textContent).toBe("A");
  });

  it("marks every element in the builder's preview", () => {
    setLayoutPreviewMode({});
    const { container } = draw({ id: "r", el: "panel", tag: "div", children: [{ id: "s", el: "slot", slot: "x" }, { id: "b", el: "button", tag: "button", text: "b" }] }, { slots: { x: () => <em>part</em> } });
    expect(container.querySelector('[data-lb-id="r"]')).not.toBeNull();
    expect(container.querySelector('[data-lb-id="b"]')!.tagName).toBe("BUTTON");
    expect(container.querySelector('[data-lb-id="s"] em')).not.toBeNull();
  });
});
