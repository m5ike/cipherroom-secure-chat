// 6.7: the audit's low web findings fixed in this release — each reproduced
// first (the payload from the audit), then refused.
//
//   N22  "/\host" (and "/<tab>/host") passed as "a path on this site" — an open
//        redirect from push notifications, layouts and menus
//   N26  formatted HTML from a function could paint over other messages
//   N27  the DTLS fingerprint store grew without end (a readable contact log)
//   N29  a card's link opened whatever scheme it had (javascript:, data:…)
//   N30  WebNFC scanOnce never answered after its timeout

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { isHttpsUrl, isSitePath } from "../client/src/lib/site-path";
import { isSafeUrl } from "../client/src/lib/layout-tree";
import { sanitizeMenuConfig } from "../client/src/lib/menu-config";
import { parseSafeHtml } from "../client/src/lib/menu-template";
import { sanitizeFnHtml } from "../client/src/lib/fn-html";
import { FINGERPRINTS_KEPT, loadFingerprints, persistFingerprint, saveFingerprints } from "../client/src/lib/fingerprint";
import { scanOnce } from "../client/src/lib/nfc";

const OTHER_HOSTS = ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example", "/\\\\evil.example"];

describe("N22: a path on this site is one", () => {
  it("the shared check", () => {
    for (const v of OTHER_HOSTS) expect(isSitePath(v), JSON.stringify(v)).toBe(false);
    for (const v of ["/", "/signin", "/a/b?x=1#y", "/rooms/%5Cx"]) expect(isSitePath(v), v).toBe(true);
    // What a browser makes of the audit's payload: another host.
    expect(new URL("/\\evil.example/x", "https://chat.example").host).toBe("evil.example");
  });

  it("layouts, menu links and menu HTML refuse another host dressed as a path", () => {
    for (const v of OTHER_HOSTS) expect(isSafeUrl(v), JSON.stringify(v)).toBe(false);
    expect(isSafeUrl("/help")).toBe(true);
    const c = sanitizeMenuConfig({ items: OTHER_HOSTS.map((href, i) => ({ kind: "item", id: `i${i}`, icon: "star", label: "x", action: { type: "url", href } })) });
    expect(c.items.map((n) => (n.kind === "item" ? n.action.type : null))).toEqual(OTHER_HOSTS.map(() => "none"));
    const nodes = parseSafeHtml('<a href="/\\evil.example/x">a</a><img src="/\\evil.example/i.png"><a href="/ok">b</a>', { panels: [], fns: [] });
    const attrs = JSON.stringify(nodes);
    expect(attrs).not.toContain("evil.example");
    expect(attrs).toContain('"/ok"');
  });

  it("the service worker opens only this site from a notification", () => {
    const src = readFileSync(join(__dirname, "../client/public/sw.js"), "utf8");
    const self = { location: { origin: "https://chat.example" }, addEventListener: () => undefined, navigator: { language: "en" } };
    const ctx: Record<string, unknown> = { self, URL, console };
    runInNewContext(`${src}\nthis.safeUrl = safeUrl;`, ctx);
    const safeUrl = ctx.safeUrl as (v: unknown) => string;
    for (const v of OTHER_HOSTS) expect(safeUrl(v), JSON.stringify(v)).toBe("/");
    expect(safeUrl("/signin?x=1")).toBe("/signin?x=1");
    expect(safeUrl("https://chat.example/a")).toBe("/a");
  });
});

describe("N26: formatted HTML stays in its box", () => {
  it("no negative margins, no window-relative sizes", () => {
    const html = sanitizeFnHtml('<div style="margin-top:-500px; width:100vw; height:100dvh; color:red; margin: 0 -2em">x</div><p style="margin: 4px 8px">ok</p>');
    expect(html).not.toMatch(/-500px|100vw|100dvh|-2em/);
    expect(html).toContain("color: red");
    expect(html).toContain("margin: 4px 8px");
  });

  it("and the box clips what it paints", () => {
    const css = readFileSync(join(__dirname, "../client/src/components/fn/fn.css"), "utf8");
    expect(css).toMatch(/\.fn-html__body \{[^}]*contain: paint/);
  });
});

describe("N27: the DTLS fingerprint store is bounded", () => {
  it("keeps the most recently seen peers only — and always the one just seen", () => {
    const many: Record<string, { digest: string; firstSeenAt: string; lastSeenAt: string }> = {};
    for (let i = 0; i < FINGERPRINTS_KEPT + 50; i++) many[`old-${i}`] = { digest: "ab", firstSeenAt: "2020-01-01T00:00:00.000Z", lastSeenAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString() };
    saveFingerprints(many);
    persistFingerprint("peer-now", "cd");
    const kept = loadFingerprints();
    expect(Object.keys(kept)).toHaveLength(FINGERPRINTS_KEPT);
    expect(kept["peer-now"]?.digest).toBe("cd");
    expect(kept["old-0"]).toBeUndefined(); // the longest unseen go first
    expect(kept[`old-${FINGERPRINTS_KEPT + 49}`]).toBeDefined();
    saveFingerprints({});
  });
});

describe("N29: a card's link opens only over https", () => {
  it("javascript:, data:, blob: and file: are not https", () => {
    for (const v of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>1</script>", "blob:https://x/1", "file:///etc/passwd", "http://plain.example", "//evil.example"]) {
      expect(isHttpsUrl(v), JSON.stringify(v)).toBe(false);
    }
    expect(isHttpsUrl("https://example.org/login")).toBe(true);
  });

  it("the M5 card panel checks the scheme before window.open", () => {
    const src = readFileSync(join(__dirname, "../client/src/components/M5CardPanel.tsx"), "utf8");
    expect(src).toMatch(/if \(isHttpsUrl\(url\)\) window\.open\(url, "_blank", "noopener"\)/);
    expect(src).not.toMatch(/if \(url\) window\.open\(url/);
  });
});

describe("N30: WebNFC scanOnce answers when it times out", () => {
  const w = window as unknown as { NDEFReader?: unknown };
  afterEach(() => { delete w.NDEFReader; vi.useRealTimers(); });

  it("resolves with a timeout instead of hanging", async () => {
    vi.useFakeTimers();
    let aborted = false;
    w.NDEFReader = class {
      async scan(opts: { signal?: AbortSignal }) { opts.signal?.addEventListener("abort", () => { aborted = true; }); }
      async write() { /* not used */ }
      addEventListener() { /* no tag ever comes */ }
    };
    const result = scanOnce(1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(aborted).toBe(true);
  });
});
