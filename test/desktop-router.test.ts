// @vitest-environment node
//
// M5cet Desktop (6.13): which requests of the server origin the app answers
// from its bundle and which go to the network (desktop/src/router.ts), and
// how a bundled file is answered (desktop/src/bundle.ts). The property that
// matters (F-02): no code of the server origin ever comes from the network —
// not an unknown /assets file, not a service worker, not a document.

import { describe, expect, it } from "vitest";
import {
  BUNDLE_ONLY, guardNetworkDocument, isDocumentRequest, mayLoadExecutable, route, safePath, type RouteContext,
} from "../desktop/src/router";
import { answerBundled, contentType, isHashedAsset, parseRange } from "../desktop/src/bundle";
import { isHashedAsset as serverIsHashedAsset } from "../server/static";

const ORIGIN = "https://chat.example.org";
const files = new Set([
  "/index.html", "/sw.js", "/manifest.webmanifest", "/icon-192.svg", "/build.json", "/version-manifest.json", "/release-web.json",
  "/assets/index.Ab12Cd34.js", "/assets/index.Zx98Yw76.css", "/assets/kdf.worker-Qq11Ww22.js", "/layout-preview.html",
]);
const ctx: RouteContext = { origin: ORIGIN, mode: "bundled", files };
const NAV = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "upgrade-insecure-requests": "1" };
const get = (path: string, headers: Record<string, string> = {}, method = "GET") => route({ url: `${ORIGIN}${path}`, method, headers }, ctx);

describe("desktop router — the client's files come from the app", () => {
  it("serves / and index.html from the bundle", () => {
    expect(get("/", NAV)).toEqual({ kind: "bundle", file: "/index.html", status: 200 });
    expect(get("/index.html")).toEqual({ kind: "bundle", file: "/index.html", status: 200 });
  });

  it("serves bundled assets, the service worker, the manifests and icons", () => {
    for (const p of ["/assets/index.Ab12Cd34.js", "/assets/index.Zx98Yw76.css", "/sw.js", "/manifest.webmanifest", "/icon-192.svg", "/build.json", "/version-manifest.json", "/release-web.json"]) {
      expect(get(p)).toMatchObject({ kind: "bundle", file: p });
    }
  });

  it("ignores the query string when choosing the file", () => {
    expect(get("/version-manifest.json?ts=123")).toMatchObject({ kind: "bundle", file: "/version-manifest.json" });
    expect(get("/assets/index.Ab12Cd34.js?v=2")).toMatchObject({ kind: "bundle", file: "/assets/index.Ab12Cd34.js" });
  });

  it("never fetches an /assets file the app does not have from the server", () => {
    expect(get("/assets/evil.12345678.js")).toMatchObject({ kind: "block", status: 404 });
    expect(get("/assets/index.Ab12Cd34.js.map")).toMatchObject({ kind: "block", status: 404 });
  });

  it("never fetches the files that describe the client from the server (signature, key, manifests)", () => {
    const small: RouteContext = { ...ctx, files: new Set(["/index.html"]) };
    for (const p of BUNDLE_ONLY.filter((x) => x !== "/index.html")) {
      expect(route({ url: `${ORIGIN}${p}`, method: "GET", headers: {} }, small)).toMatchObject({ kind: "block", status: 404 });
    }
    expect(get("/release-web.json.sig")).toMatchObject({ kind: "block", status: 404 });
    expect(get("/release-signing.pub")).toMatchObject({ kind: "block", status: 404 });
  });

  it("answers any other navigation with the single-page app (as the server's fallback does)", () => {
    expect(get("/signin", NAV)).toMatchObject({ kind: "bundle", file: "/index.html" });
    expect(get("/r/some-room/", NAV)).toMatchObject({ kind: "bundle", file: "/index.html" });
    expect(get("/desktop-signin?id=abc", NAV)).toMatchObject({ kind: "bundle", file: "/index.html" });
    expect(get("/layout-preview.html", NAV)).toMatchObject({ kind: "bundle", file: "/layout-preview.html" });
  });

  it("refuses a form posted as a navigation (the server's answer would render in this origin)", () => {
    expect(get("/signin", NAV, "POST")).toMatchObject({ kind: "block", status: 405 });
  });

  it("only the bundled service worker, never the server's", () => {
    expect(get("/sw.js", { "service-worker": "script" })).toMatchObject({ kind: "bundle", file: "/sw.js" });
    expect(get("/other-sw.js", { "service-worker": "script" })).toMatchObject({ kind: "block", status: 404 });
    expect(get("/api/sw.js", { "service-worker": "script" })).toMatchObject({ kind: "block", status: 404 });
    const none: RouteContext = { ...ctx, files: new Set(["/index.html"]) };
    expect(route({ url: `${ORIGIN}/sw.js`, method: "GET", headers: { "service-worker": "script" } }, none)).toMatchObject({ kind: "block" });
  });
});

describe("desktop router — the service goes to the network", () => {
  it("API, function sandbox, webhooks, media, uploads", () => {
    expect(get("/api/health")).toEqual({ kind: "network", document: false });
    expect(get("/api/account/vault", {}, "PUT")).toEqual({ kind: "network", document: false });
    expect(get("/api/storage/blob", { range: "bytes=0-99" })).toEqual({ kind: "network", document: false });
    expect(get("/fn-sandbox.html?origin=peer", NAV)).toEqual({ kind: "network", document: true });
    expect(get("/wh/twilio/voice", {}, "POST")).toMatchObject({ kind: "network" });
    expect(get("/hooks/r/token", {}, "POST")).toMatchObject({ kind: "network" });
    expect(get("/media/tel/client/x")).toMatchObject({ kind: "network" });
    expect(get("/.well-known/assetlinks.json")).toMatchObject({ kind: "network" });
  });

  it("HEAD of a bundled file is the bundle, HEAD of the API the network", () => {
    expect(get("/assets/index.Ab12Cd34.js", {}, "HEAD")).toMatchObject({ kind: "bundle" });
    expect(get("/api/health", {}, "HEAD")).toMatchObject({ kind: "network" });
  });

  it("leaves other origins alone (tiles, fonts, other servers)", () => {
    expect(route({ url: "https://tile.openstreetmap.org/1/2/3.png", method: "GET", headers: {} }, ctx)).toEqual({ kind: "network", document: false });
    expect(route({ url: "https://chat.example.org:8443/assets/x.js", method: "GET", headers: {} }, ctx)).toEqual({ kind: "network", document: false });
    expect(route({ url: "http://chat.example.org/assets/x.js", method: "GET", headers: {} }, ctx)).toEqual({ kind: "network", document: false });
    expect(route({ url: "https://evil.chat.example.org/", method: "GET", headers: NAV }, ctx)).toEqual({ kind: "network", document: false });
  });

  it("intercepts nothing when the user chose this server's web code", () => {
    const server: RouteContext = { ...ctx, mode: "server" };
    expect(route({ url: `${ORIGIN}/assets/index.Ab12Cd34.js`, method: "GET", headers: {} }, server)).toEqual({ kind: "network", document: false });
    expect(route({ url: `${ORIGIN}/`, method: "GET", headers: NAV }, server)).toEqual({ kind: "network", document: true });
  });
});

describe("desktop router — malformed paths", () => {
  it("dot segments are resolved by the URL parser, encoded slashes and backslashes are refused", () => {
    // /assets/../index.html → /index.html (the parser resolves it; still the bundle)
    expect(get("/assets/../index.html")).toMatchObject({ kind: "bundle", file: "/index.html" });
    expect(get("/assets/%2e%2e/index.html")).toMatchObject({ kind: "bundle", file: "/index.html" });
    expect(get("/assets/..%2f..%2fetc%2fpasswd")).toMatchObject({ kind: "block", status: 400 });
    expect(get("/assets%2f..%2findex.html")).toMatchObject({ kind: "block", status: 400 });
    expect(get("/assets/%5c..%5cindex.html")).toMatchObject({ kind: "block", status: 400 });
    expect(get("/assets/index.Ab12Cd34.js%00.png")).toMatchObject({ kind: "block", status: 400 });
    expect(get("/assets/%E0%A4%A")).toMatchObject({ kind: "block", status: 400 });
    expect(get("//assets/x.js")).toMatchObject({ kind: "block", status: 400 });
  });

  it("safePath decodes segments and refuses traversal", () => {
    expect(safePath("/a/b%20c")).toBe("/a/b c");
    expect(safePath("/signin/")).toBe("/signin/");
    expect(safePath("/a/%2e%2e/b")).toBeNull();
    expect(safePath("/a/%2E/b")).toBeNull();
    expect(safePath("/a%2Fb")).toBeNull();
    expect(safePath("relative")).toBeNull();
  });

  it("a request that is not a URL is refused", () => {
    expect(route({ url: "not a url", method: "GET", headers: {} }, ctx)).toMatchObject({ kind: "block", status: 400 });
  });
});

describe("desktop router — documents from the network", () => {
  it("recognises Chromium's navigations", () => {
    expect(isDocumentRequest(NAV)).toBe(true);
    expect(isDocumentRequest({ accept: "*/*" })).toBe(false);
    expect(isDocumentRequest({ "upgrade-insecure-requests": "1" })).toBe(true);
  });

  it("the function sandbox renders only with a CSP sandbox (no allow-same-origin)", () => {
    expect(guardNetworkDocument("/fn-sandbox.html", 200, { "content-type": "text/html", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; sandbox allow-scripts" })).toEqual({ ok: true });
    expect(guardNetworkDocument("/fn-sandbox.html", 200, { "content-type": "text/html" })).toMatchObject({ ok: false });
    expect(guardNetworkDocument("/fn-sandbox.html", 200, { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts allow-same-origin" })).toMatchObject({ ok: false });
  });

  it("an HTML / SVG / XML page from /api never renders in this origin; downloads and passive types do", () => {
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "text/html; charset=utf-8" })).toMatchObject({ ok: false });
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "image/svg+xml" })).toMatchObject({ ok: false });
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "application/xhtml+xml" })).toMatchObject({ ok: false });
    expect(guardNetworkDocument("/api/x", 200, {})).toMatchObject({ ok: false });
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "text/html", "content-disposition": "attachment; filename=x.html" })).toEqual({ ok: true });
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "application/json" })).toEqual({ ok: true });
    expect(guardNetworkDocument("/api/x", 200, { "content-type": "application/pdf" })).toEqual({ ok: true });
    expect(guardNetworkDocument("/api/x", 302, { location: "/elsewhere" })).toEqual({ ok: true });
  });

  it("webRequest guard: executable resources of the origin only from the bundle", () => {
    expect(mayLoadExecutable("script", get("/assets/index.Ab12Cd34.js"), "/assets/index.Ab12Cd34.js")).toBe(true);
    expect(mayLoadExecutable("script", get("/api/evil.js"), "/api/evil.js")).toBe(false);
    expect(mayLoadExecutable("stylesheet", get("/api/x.css"), "/api/x.css")).toBe(false);
    expect(mayLoadExecutable("script", get("/assets/evil.12345678.js"), "/assets/evil.12345678.js")).toBe(false);
    expect(mayLoadExecutable("subFrame", get("/fn-sandbox.html", NAV), "/fn-sandbox.html")).toBe(true);
    expect(mayLoadExecutable("subFrame", get("/api/page", NAV), "/api/page")).toBe(false);
    expect(mayLoadExecutable("mainFrame", get("/signin", NAV), "/signin")).toBe(true);
    expect(mayLoadExecutable("xhr", get("/api/health"), "/api/health")).toBe(true);
    expect(mayLoadExecutable("image", get("/api/avatar"), "/api/avatar")).toBe(true);
  });
});

describe("desktop bundle — answering a bundled file", () => {
  const SEC = { "Content-Security-Policy": "default-src 'self'", "Cache-Control": "no-store" };

  it("hashed assets are immutable, the rest no-store, both with the security headers", () => {
    const a = answerBundled("/assets/index.Ab12Cd34.js", 100, "GET", undefined, SEC);
    expect(a).toMatchObject({ status: 200, slice: { start: 0, end: 99 } });
    expect(a.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(a.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(a.headers["Content-Security-Policy"]).toBe("default-src 'self'");
    expect(a.headers["Content-Length"]).toBe("100");
    const i = answerBundled("/index.html", 10, "GET", undefined, SEC);
    expect(i.headers["Cache-Control"]).toBe("no-store");
    expect(i.headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("HEAD has the length but no body", () => {
    expect(answerBundled("/sw.js", 42, "HEAD", undefined, SEC)).toMatchObject({ status: 200, slice: null, headers: { "Content-Length": "42" } });
  });

  it("a single range gets 206, an unsatisfiable one 416, several the whole file", () => {
    expect(answerBundled("/icon-192.svg", 1000, "GET", "bytes=0-99", SEC)).toMatchObject({ status: 206, slice: { start: 0, end: 99 }, headers: { "Content-Range": "bytes 0-99/1000", "Content-Length": "100" } });
    expect(answerBundled("/icon-192.svg", 1000, "GET", "bytes=900-", SEC)).toMatchObject({ status: 206, slice: { start: 900, end: 999 } });
    expect(answerBundled("/icon-192.svg", 1000, "GET", "bytes=-10", SEC)).toMatchObject({ status: 206, slice: { start: 990, end: 999 } });
    expect(answerBundled("/icon-192.svg", 1000, "GET", "bytes=5000-6000", SEC)).toMatchObject({ status: 416, slice: null, headers: { "Content-Range": "bytes */1000" } });
    expect(answerBundled("/icon-192.svg", 1000, "GET", "bytes=0-1,5-6", SEC)).toMatchObject({ status: 200, slice: { start: 0, end: 999 } });
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-999", 10)).toEqual({ start: 0, end: 9 });
  });

  it("refuses other methods", () => {
    expect(answerBundled("/index.html", 10, "POST", undefined, SEC)).toMatchObject({ status: 405, slice: null, headers: { Allow: "GET, HEAD" } });
  });

  it("content types of the client's files", () => {
    expect(contentType("/manifest.webmanifest")).toBe("application/manifest+json; charset=utf-8");
    expect(contentType("/assets/x.wasm")).toBe("application/wasm");
    expect(contentType("/assets/x.woff2")).toBe("font/woff2");
    expect(contentType("/release-signing.pub")).toBe("text/plain; charset=utf-8");
    expect(contentType("/noext")).toBe("application/octet-stream");
  });

  it("recognises hashed assets exactly as the server does", () => {
    for (const p of ["/assets/index.Ab12Cd34.js", "/assets/kdf.worker-Qq11Ww22.js", "/assets/x.12345678.css", "/assets/short.123.js", "/index.html", "/assets/a/b.12345678.js"]) {
      expect(isHashedAsset(p)).toBe(serverIsHashedAsset(p));
    }
  });
});
