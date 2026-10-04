// The operator console shows m5.out.html (6.6) in a run with the chat's own
// sanitizer (window.M5Html from the editor bundle) — built as DOM nodes, styles
// through the CSSOM, links opening outside, nothing executable.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFnHtml } from "../client/src/lib/fn-html";
import { cardReport } from "../client/src/lib/nfc/card-report";

type Render = (o: unknown, ctx: unknown) => HTMLElement | null;
let render: Render;

beforeAll(() => {
  const w = window as unknown as Record<string, unknown>;
  const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: unknown[]) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== "") el.append(c instanceof Node ? c : String(c));
    return el;
  };
  w.M5Console = { h, clear: (el: HTMLElement) => { while (el.firstChild) el.firstChild.remove(); }, api: async () => ({}), toast: () => {} };
  w.M5Html = { parse: parseFnHtml };
  new Function(readFileSync(join(process.cwd(), "admin-ui/public/functions-outputs.js"), "utf8"))();
  render = (w.M5FnOut as { render: Render }).render;
});

describe("the console's html output", () => {
  it("builds only safe nodes", () => {
    const el = render({ type: "html", title: "T", html: '<h3 onclick="x()">Hi</h3><script>alert(1)</script><p style="color: red; position: fixed">p <a href="https://example.com">l</a></p><img src="https://evil/x.png">' }, null)!;
    expect(el.querySelector(".fn-html__title")?.textContent).toBe("T");
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("h3")?.getAttribute("onclick")).toBeNull();
    const p = el.querySelector("p") as HTMLElement;
    expect(p.style.color).toBe("red");
    expect(p.style.position).toBe("");
    const a = el.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("shows a whole card report", () => {
    const html = cardReport({ status: "ok", mrtd: { present: true, access: "bac", mrzInfo: { documentCode: "P", surname: "DOE", givenNames: "JANE" }, images: [{ group: "DG2", kind: "face", mime: "image/jpeg", data: "/9j/4AAQ", name: "face.jpg" }] } }, "html").value as string;
    const el = render({ type: "html", html }, null)!;
    expect(el.querySelector(".m5h-title")?.textContent).toBe("Passport · JANE DOE");
    expect(el.querySelector("figure.m5h-photo img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQ");
  });
});
