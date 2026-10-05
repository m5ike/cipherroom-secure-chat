// Where a request of the M5cet page is answered from (pure — no Electron).
//
// The window loads https://<server>/ — the real origin, so cookies, the
// WebAuthn RP ID, the WebSocket and every relative URL stay exactly as on the
// web. The app intercepts that origin (desktop/src/intercept.ts) and asks
// this router about every request:
//
//   bundle    the client's own files — index.html, /assets/*, sw.js, the web
//             manifest, icons, build.json, the version and release manifests —
//             come from the copy inside the signed app (F-02: the server cannot
//             change the code that runs)
//   network   everything else — /api/*, /fn-sandbox.html, /wh/*, /hooks/*,
//             /media/*, uploads, downloads, other origins — goes to the network
//             unchanged
//   block     what must not come from anywhere: an /assets file the app does
//             not have (never fetched from the server instead), a service
//             worker other than the bundled sw.js, a malformed path
//
// Navigations (documents) are special: a page of this origin runs with all of
// its storage (keys, sessions), so a document is ALWAYS the bundled client —
// an unknown path gets index.html, as the server's SPA fallback would — with
// one exception, /fn-sandbox.html in a frame, which the server's CSP sandbox
// turns into an opaque origin. The response guard (`guardNetworkDocument`)
// checks that too: no HTML document from the network renders in this origin.

export type RouteMode = "bundled" | "server";

export type RouteContext = {
  /** The server's origin ("https://chat.example.org") — the one intercepted. */
  origin: string;
  /** "bundled": the client from the app; "server": the user chose this server's web code (nothing intercepted). */
  mode: RouteMode;
  /** Paths of the bundled files, "/index.html", "/assets/index.abc123.js", … */
  files: ReadonlySet<string>;
};

export type RouteRequest = {
  url: string;
  method: string;
  /** Lower-case header names. */
  headers: Readonly<Record<string, string | undefined>>;
};

export type RouteDecision =
  | { kind: "bundle"; file: string; status: 200 }
  | { kind: "network"; document: boolean }
  | { kind: "block"; status: 400 | 403 | 404 | 405; reason: string };

/** Paths the server answers itself (prefix match on whole segments). */
export const NETWORK_PREFIXES: readonly string[] = ["/api/", "/wh/", "/hooks/", "/media/", "/.well-known/"];
/** Exact paths the server answers itself. */
export const NETWORK_PATHS: readonly string[] = ["/fn-sandbox.html", "/ws", "/api"];
/** Documents that may come from the network (in a frame): the server's sandboxed function page. */
export const NETWORK_DOCUMENTS: readonly string[] = ["/fn-sandbox.html"];

/**
 * The client's own files that are never fetched from the server, even when
 * the bundle lacks them (then 404): the page compares itself with these —
 * build.json, the version manifest, the release manifest with its signature
 * and key (integrity.ts) — and the server's copies describe the SERVER's
 * build, not the code running here.
 */
export const BUNDLE_ONLY: readonly string[] = [
  "/index.html", "/sw.js", "/manifest.webmanifest", "/build.json", "/version-manifest.json",
  "/release-web.json", "/release-web.json.sig", "/release-signing.pub",
];

/** A navigation (top-level or frame document) as Chromium sends it: an HTML Accept, or the UIR marker. */
export function isDocumentRequest(headers: RouteRequest["headers"]): boolean {
  const accept = (headers.accept ?? "").toLowerCase();
  return accept.startsWith("text/html") || accept.includes("application/xhtml+xml") || headers["upgrade-insecure-requests"] === "1";
}

/** The service worker script fetch (Chromium marks it with "Service-Worker: script"). */
export function isServiceWorkerScript(headers: RouteRequest["headers"]): boolean {
  return (headers["service-worker"] ?? "").toLowerCase() === "script";
}

/**
 * The decoded path for a bundle lookup, or null when it is malformed: a
 * segment that decodes to "", ".", "..", or contains "/", "\", a NUL or a
 * control character (an encoded slash or a traversal attempt). The URL parser
 * has already resolved literal and %2e dot segments; this catches the rest.
 */
export function safePath(pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const parts = pathname.split("/").slice(1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    let seg: string;
    try { seg = decodeURIComponent(raw); } catch { return null; }
    // A trailing slash ("/signin/") leaves one empty last segment — fine; an empty one inside is not.
    if (seg === "" && i !== parts.length - 1) return null;
    // eslint-disable-next-line no-control-regex
    if (seg === "." || seg === ".." || /[/\\\u0000-\u001f\u007f]/.test(seg)) return null;
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

function isNetworkPath(path: string): boolean {
  return NETWORK_PATHS.includes(path) || NETWORK_PREFIXES.some((p) => path.startsWith(p));
}

/** Decides one request. Pure: the same inputs always give the same answer. */
export function route(req: RouteRequest, ctx: RouteContext): RouteDecision {
  let url: URL;
  try { url = new URL(req.url); } catch { return { kind: "block", status: 400, reason: "bad-url" }; }
  // Other origins (map tiles, opt-in web fonts, other servers) are not ours to answer.
  if (url.origin !== ctx.origin) return { kind: "network", document: false };
  if (ctx.mode === "server") return { kind: "network", document: isDocumentRequest(req.headers) };

  const method = req.method.toUpperCase();
  const document = isDocumentRequest(req.headers);
  const path = safePath(url.pathname);
  if (path === null) return { kind: "block", status: 400, reason: "bad-path" };

  // The service worker: only the bundled one (a server's worker could answer every request of this origin).
  if (isServiceWorkerScript(req.headers)) {
    return path === "/sw.js" && ctx.files.has("/sw.js") ? { kind: "bundle", file: "/sw.js", status: 200 } : { kind: "block", status: 404, reason: "service-worker" };
  }

  // The server's own routes. A document among them (an /api download opened as a
  // navigation, the function sandbox in a frame) is checked on the response:
  // guardNetworkDocument refuses one that would render as a page of this origin.
  if (isNetworkPath(path)) return { kind: "network", document };

  const read = method === "GET" || method === "HEAD";
  if (read) {
    if (path === "/" || path === "/index.html") return { kind: "bundle", file: "/index.html", status: 200 };
    if (ctx.files.has(path)) return { kind: "bundle", file: path, status: 200 };
    // The app's code — and what describes it — is never fetched from the server instead.
    if (path.startsWith("/assets/") || BUNDLE_ONLY.includes(path)) return { kind: "block", status: 404, reason: "not-bundled" };
    // A navigation to any other path is the single-page app (the server's fallback does the same).
    if (document) return { kind: "bundle", file: "/index.html", status: 200 };
    return { kind: "network", document: false };
  }
  // A form posted as a navigation would render the server's answer in this origin.
  if (document) return { kind: "block", status: 405, reason: "document-method" };
  return { kind: "network", document: false };
}

/** Content types that a browser renders as an active document (script can run). */
const ACTIVE_TYPES = ["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "multipart/x-mixed-replace"];

/**
 * A network answer to a DOCUMENT request of the server origin: may it render?
 * Yes for /fn-sandbox.html only when it carries a CSP sandbox (opaque origin),
 * for downloads (Content-Disposition: attachment) and for passive types
 * (JSON, images, PDF …); no for any other HTML / XML / SVG page — that would
 * be server code running with this origin's storage.
 */
export function guardNetworkDocument(path: string, status: number, headers: Readonly<Record<string, string | undefined>>): { ok: true } | { ok: false; reason: string } {
  // A bare redirect has no body to render (intercept.ts refuses to follow the server origin's redirects).
  if (status >= 300 && status < 400) return { ok: true };
  const type = (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const disposition = (headers["content-disposition"] ?? "").trim().toLowerCase();
  if (disposition.startsWith("attachment")) return { ok: true };
  if (NETWORK_DOCUMENTS.includes(path)) {
    const csp = (headers["content-security-policy"] ?? "").toLowerCase();
    const sandboxed = csp.split(",").some((policy) => policy.split(";").some((d) => {
      const parts = d.trim().split(/\s+/);
      return parts[0] === "sandbox" && !parts.includes("allow-same-origin");
    }));
    return sandboxed ? { ok: true } : { ok: false, reason: "sandbox-missing" };
  }
  if (type === "" || ACTIVE_TYPES.includes(type)) return { ok: false, reason: `active-type:${type || "none"}` };
  return { ok: true };
}

/**
 * The second line of defence, for Electron's webRequest (it knows the
 * resource type, which the protocol handler does not): requests that would
 * EXECUTE code in this origin — documents, frames, scripts, workers, styles —
 * must be answered from the bundle (or be the sandboxed function page).
 */
export function mayLoadExecutable(resourceType: string, decision: RouteDecision, path: string): boolean {
  const executable = ["mainFrame", "subFrame", "script", "stylesheet", "object", "worker", "sharedWorker", "serviceWorker"];
  if (!executable.includes(resourceType)) return true;
  if (decision.kind === "bundle") return true;
  if (decision.kind === "block") return false;
  if (resourceType === "subFrame" && NETWORK_DOCUMENTS.includes(path)) return true;
  // A top-level navigation to /api (a download link) is checked on the response (guardNetworkDocument).
  if (resourceType === "mainFrame" && decision.document) return true;
  return false;
}
