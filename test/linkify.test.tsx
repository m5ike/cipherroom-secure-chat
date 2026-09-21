import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { linkify } from "../client/src/lib/linkify";

// Chat text comes from other peers, so which strings become clickable links
// is a security boundary: only http(s)/ftp/www may, never an executable scheme.
function anchors(text: string) {
  const { container } = render(<p>{linkify(text)}</p>);
  return Array.from(container.querySelectorAll("a"));
}

describe("linkify", () => {
  it("links http, https, ftp and bare www hosts", () => {
    const hrefs = anchors("a http://a.example b https://b.example/x?y=1 c ftp://c.example d www.d.example e")
      .map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["http://a.example", "https://b.example/x?y=1", "ftp://c.example", "https://www.d.example"]);
  });

  it("never links executable or inline-content schemes", () => {
    for (const evil of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://x.example/abc",
    ]) {
      // Nothing may carry the dangerous scheme. (An https:// URL embedded in
      // e.g. "blob:https://…" still becomes an ordinary https link — fine.)
      for (const a of anchors(`click ${evil} now`)) {
        expect(a.getAttribute("href")).toMatch(/^(https?|ftp):\/\//);
      }
    }
    expect(anchors("javascript:alert(1)")).toEqual([]);
    expect(anchors("data:text/html,<script>alert(1)</script>")).toEqual([]);
  });

  it("keeps a dangerous scheme inert even next to a real link", () => {
    const found = anchors("javascript:alert(1) https://ok.example");
    expect(found.map((a) => a.getAttribute("href"))).toEqual(["https://ok.example"]);
  });

  it("opens links in a new tab without handing over the opener or the referrer", () => {
    const [a] = anchors("https://ok.example");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("rel")).toContain("noreferrer");
  });

  it("renders markup in the text as text, not as elements", () => {
    const { container } = render(<p>{linkify('<img src=x onerror=alert(1)> https://ok.example "><script>alert(1)</script>')}</p>);
    expect(container.querySelectorAll("img, script").length).toBe(0);
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("returns plain text untouched", () => {
    expect(anchors("no links here")).toEqual([]);
    expect(linkify("")).toBe("");
  });
});
