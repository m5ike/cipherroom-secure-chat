// @vitest-environment node
//
// The menu's template language (client/src/lib/menu-template.ts): Latte-like
// tags and filters over live variables — and the safe HTML it must end in,
// because an operator's template reaches every user's menu.

import { describe, it, expect } from "vitest";
import {
  formatDate, parseSafeHtml, renderMenuHtml, renderTemplate, renderText, sampleTemplateVars, TemplateError,
  TEMPLATE_FILTERS, FILTERS,
} from "../client/src/lib/menu-template";

const vars = sampleTemplateVars(Date.UTC(2026, 8, 24, 10, 5));
const allow = { panels: ["settings", "profile"], fns: ["toggleTone", "openRoom"] };

describe("printing", () => {
  it("prints variables with paths and escapes them", () => {
    expect(renderTemplate("Hi {$user.nickname}, {$session.current_username}", vars)).toBe("Hi Alice, bystry-sokol-7k3q");
    expect(renderTemplate("{$room.people[1]}", vars)).toBe("Carol");
    expect(renderTemplate("{$x}", { x: "<img src=x onerror=alert(1)>" })).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(renderTemplate("{$nothing.here}", vars)).toBe("");
  });

  it("applies filters in a chain, with arguments", () => {
    expect(renderTemplate("{$session.room|upper}", vars)).toBe("TYM-BRNO");
    expect(renderTemplate("{$session.room|replace:'-':' '|capitalize}", vars)).toBe("Tym Brno");
    expect(renderTemplate("{$user.username|truncate:8}", vars)).toBe("bystry-…");
    expect(renderTemplate("{$missing|default:'host'}", vars)).toBe("host");
    expect(renderTemplate("{$room.people|join:' & '}", vars)).toBe("Bob &amp; Carol");
    expect(renderTemplate("{$room.people|length}", vars)).toBe("2");
    expect(renderTemplate("{=12345.678|number:2}", vars)).toBe("12 345,68");
    expect(renderTemplate("{$session.connected|yesno:'online':'offline'}", vars)).toBe("online");
    expect(() => renderTemplate("{$x|nosuchfilter}", {})).toThrow(/unknown filter/);
    // Every documented filter exists.
    for (const f of TEMPLATE_FILTERS) for (const name of f.name.split(" / ")) expect(FILTERS[name]).toBeTypeOf("function");
  });

  it("formats dates with PHP letters", () => {
    const at = new Date(2026, 8, 4, 7, 3, 9).getTime();
    expect(formatDate(at, "d.m.Y H:i:s")).toBe("04.09.2026 07:03:09");
    expect(formatDate(at, "j. n. \\Y")).toBe("4. 9. Y");
  });

  it("evaluates expressions", () => {
    expect(renderTemplate("{=$room.peers + 1}", vars)).toBe("3");
    expect(renderTemplate("{='Room ' ~ $session.room}", vars)).toBe("Room tym-brno");
    expect(renderTemplate("{=($room.peers * 10) / 4}", vars)).toBe("5");
  });
});

describe("macros", () => {
  it("branches with if / elseif / else and conditions", () => {
    const tpl = "{if $session.peers > 5}many{elseif $session.peers >= 2 && $user.signedIn}some{else}few{/if}";
    expect(renderTemplate(tpl, vars)).toBe("some");
    expect(renderTemplate(tpl, { ...vars, session: { peers: 9 } })).toBe("many");
    expect(renderTemplate(tpl, { ...vars, session: { peers: 1 } })).toBe("few");
    expect(renderTemplate("{if !$user.signedIn}out{else}in{/if}", vars)).toBe("in");
    expect(renderTemplate("{if $settings.theme == 'ios'}iOS{/if}", vars)).toBe("iOS");
  });

  it("loops over lists and maps, with the iterator and an else", () => {
    expect(renderTemplate("{foreach $room.people as $n}{$iterator.counter}.{$n}{if !$iterator.last},{/if}{/foreach}", vars)).toBe("1.Bob,2.Carol");
    expect(renderTemplate("{foreach $m as $k => $v}{$k}={$v};{/foreach}", { m: { a: 1, b: 2 } })).toBe("a=1;b=2;");
    expect(renderTemplate("{foreach $empty as $x}{$x}{else}none{/foreach}", { empty: [] })).toBe("none");
  });

  it("ifset, var, icon, translation, comments and literal braces", () => {
    expect(renderTemplate("{ifset $session.room}in {$session.room}{else}nowhere{/ifset}", vars)).toBe("in tym-brno");
    expect(renderTemplate("{var $g = 'Ahoj'}{$g} {$user.nickname}", vars)).toBe("Ahoj Alice");
    expect(renderTemplate("{icon shield-check}", vars)).toBe('<i data-icon="shield-check"></i>');
    expect(renderTemplate("{_'menu.room'}", vars, { translate: (k) => (k === "menu.room" ? "Místnost" : k) })).toBe("Místnost");
    expect(renderTemplate("a{* hidden *}b{l}c{r}", vars)).toBe("ab{c}");
    // "{" followed by a space is plain text: CSS passes through.
    expect(renderTemplate(".x { color: red }", vars)).toBe(".x { color: red }");
  });

  it("reports mistakes with a position", () => {
    expect(() => renderTemplate("{if $a}x", vars)).toThrow(TemplateError);
    expect(() => renderTemplate("{foreach $a}{/foreach}", vars)).toThrow(/foreach/);
  });

  it("cannot reach prototypes or run away", () => {
    expect(renderTemplate("{$user.constructor}{$user.__proto__}", vars)).toBe("");
    const big = renderTemplate("{foreach $l as $x}{foreach $l as $y}xx{/foreach}{/foreach}", { l: Array.from({ length: 2000 }, (_, i) => i) });
    expect(big.length).toBeLessThanOrEqual(20_000);
  });

  it("renders plain-text labels", () => {
    expect(renderText("{$user.nickname} ({$session.peers})", vars)).toBe("Alice (2)");
    expect(renderText("Plain", vars)).toBe("Plain");
  });
});

describe("safe HTML", () => {
  const html = (s: string) => parseSafeHtml(s, allow);

  it("keeps allowed tags and harmless attributes", () => {
    expect(html('<div class="a" style="color: red; position: fixed; background: url(x)"><b>hi</b></div>')).toEqual([
      { t: "div", a: { class: "a", style: "color: red" }, c: [{ t: "b", a: {}, c: ["hi"] }] },
    ]);
  });

  it("drops scripts, event handlers, javascript: links and foreign images", () => {
    const out = JSON.stringify(html('<script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">x</a><img src="https://evil.example/p.png"><iframe src="/"></iframe><svg onload=1><g/></svg>'));
    expect(out).not.toMatch(/script|javascript|onclick|evil|iframe|svg|onload/);
    expect(html('<a href="https://example.org" target="_blank">ok</a>')).toEqual([
      { t: "a", a: { href: "https://example.org", target: "_blank", rel: "noopener noreferrer" }, c: ["ok"] },
    ]);
  });

  it("allows only the menu's actions", () => {
    expect(html('<button data-action="panel:settings">s</button><span data-action="panel:admin">x</span><span data-action="fn:eval">y</span>')).toEqual([
      { t: "button", a: { "data-action": "panel:settings", type: "button" }, c: ["s"] },
      { t: "span", a: {}, c: ["x"] },
      { t: "span", a: {}, c: ["y"] },
    ]);
  });

  it("decodes entities into text and survives broken markup", () => {
    expect(html("a &amp; b &lt;c&gt; &#x1F600;")).toEqual(["a & b <c> 😀"]);
    expect(html("<div><b>x</div>y")).toEqual([{ t: "div", a: {}, c: [{ t: "b", a: {}, c: ["x"] }] }, "y"]);
    expect(html("<unknown>text</unknown>")).toEqual(["text"]);
  });

  it("template to safe tree in one step, with an error instead of a throw", () => {
    const ok = renderMenuHtml("<p>{$user.nickname}</p>", vars, allow);
    expect(ok).toEqual({ nodes: [{ t: "p", a: {}, c: ["Alice"] }], error: "" });
    const bad = renderMenuHtml("{if $x}", vars, allow);
    expect(bad.nodes).toEqual([]);
    expect(bad.error).toMatch(/missing/);
    // A variable that holds markup stays text.
    expect(renderMenuHtml("<p>{$x}</p>", { x: "<b>no</b>" }, allow).nodes).toEqual([{ t: "p", a: {}, c: ["<b>no</b>"] }]);
  });
});
