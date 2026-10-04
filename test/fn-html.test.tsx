// m5.out.html (6.6): the sanitizer every side shares (fn-html.ts), the
// output check, and the chat's renderer — only document markup survives.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { fnHtmlText, parseFnHtml, sanitizeFnHtml } from "../client/src/lib/fn-html";
import { checkFnOutput, outputsToMarkdown } from "../client/src/lib/fn-outputs";
import { cardReport } from "../client/src/lib/nfc/card-report";
import { FnHtml } from "../client/src/components/fn/FnHtml";

afterEach(() => cleanup());

describe("the HTML sanitizer", () => {
  it("drops scripts, styles, frames and forms with what is inside them", () => {
    expect(sanitizeFnHtml('<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="x">x</iframe><form><input name="p"><button>go</button></form><p>b</p>')).toBe("<p>a</p><p>b</p>");
    expect(sanitizeFnHtml("<svg><script>x</script></svg><math>y</math>ok")).toBe("ok");
  });

  it("drops handlers and unknown attributes; keeps only m5h-* classes", () => {
    expect(sanitizeFnHtml('<div class="m5h-sec app-button evil" id="x" data-a="1" onclick="x()" onmouseover=y>t</div>')).toBe('<div class="m5h-sec">t</div>');
    expect(sanitizeFnHtml('<td colspan="2" rowspan="999999" onclick=1>c</td>')).toBe('<td colspan="2">c</td>');
  });

  it("keeps harmless styles only", () => {
    expect(sanitizeFnHtml('<span style="color: red; position: fixed; background: url(https://e/x); font-weight: 700; background-color: expression(x)">s</span>')).toBe('<span style="color: red; font-weight: 700">s</span>');
  });

  it("keeps http(s) and mailto links, data:image pictures — nothing else", () => {
    expect(sanitizeFnHtml('<a href="javascript:alert(1)">a</a><a href="https://example.com/?q=1&amp;b=2">b</a><a href="mailto:x@y.z">c</a><a href="data:text/html,x">d</a>')).toBe('<a>a</a><a href="https://example.com/?q=1&amp;b=2">b</a><a href="mailto:x@y.z">c</a><a>d</a>');
    expect(sanitizeFnHtml('<img src="https://evil/track.png"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:image/png;base64,iVBORw0K" alt="ok" width="40" height="99999">')).toBe('<img src="data:image/png;base64,iVBORw0K" alt="ok" width="40">');
  });

  it("decodes entities and escapes them again", () => {
    expect(sanitizeFnHtml("<p>&lt;b&gt; &amp; &#x41;&#66; &nbsp;</p>")).toBe("<p>&lt;b&gt; &amp; AB  </p>");
    expect(parseFnHtml("<p>&lt;script&gt;</p>")).toEqual([{ t: "p", a: {}, c: ["<script>"] }]);
  });

  it("is linear on a hostile input", () => {
    const t0 = Date.now();
    sanitizeFnHtml("<a ".repeat(200_000));
    sanitizeFnHtml(`<p title="${"<".repeat(200_000)}`);
    sanitizeFnHtml("<".repeat(300_000) + ">");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("keeps a whole card report as it is", () => {
    const emv = cardReport({ status: "ok", emv: { aids: ["A0000000041010"], apps: [{ aid: "A0000000041010", label: "MASTERCARD", scheme: "Mastercard", pan: "5413330089020011", log: [{ date: "2025-09-14", amount: "1.00", currency: "CZK", merchant: "A & B", raw: "00" }], tags: [{ tag: "50", name: "Application label", value: "MASTERCARD", hex: "4D" }], records: [{ sfi: 1, record: 1, hex: "70" }] }] } }, "html").value as string;
    expect(sanitizeFnHtml(emv)).toBe(emv);
    const mrtd = cardReport({ status: "ok", mrtd: { present: true, access: "bac", mrzInfo: { documentCode: "P", surname: "X", givenNames: "Y" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: "/9j/4AAQ", name: "face.jpg" }], security: { passive: "ok" } } }, "html").value as string;
    expect(sanitizeFnHtml(mrtd)).toBe(mrtd);
    expect(fnHtmlText(parseFnHtml(mrtd))).toContain("Passport · Y X");
  });
});

describe("the html output", () => {
  it("is checked and sanitized like every output", () => {
    const r = checkFnOutput({ type: "html", html: '<h3 onclick="x">Hi</h3><script>bad()</script>', title: "T" });
    expect(r).toEqual({ ok: true, output: { type: "html", html: "<h3>Hi</h3>", title: "T" } });
    expect(checkFnOutput({ type: "html", html: 42 }).ok).toBe(false);
    expect(outputsToMarkdown([{ type: "html", html: "<h3>Hi</h3><p>there</p>", title: "T" }])).toBe("**T**\n\nHi\n\nthere");
  });

  it("renders as elements in the chat — no script, links open outside", () => {
    const view = render(<FnHtml o={{ type: "html", html: '<h3>Card</h3><p>See <a href="https://example.com">this</a></p><img src="x" onerror="alert(1)"><script>alert(2)</script><table class="m5h-grid"><tbody><tr><td>1</td></tr></tbody></table>' }} />);
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    const a = view.container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(view.container.querySelector("table.m5h-grid td")?.textContent).toBe("1");
  });
});
