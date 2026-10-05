// The security headers of the web client's pages (6.13: one source).
//
// server/index.ts applies them to every response; M5cet Desktop
// (desktop/src/web-headers.ts) applies the very same set to the client files
// it serves from inside the signed app instead of the server — the bundled
// page must run under the CSP and the policies the server would send, not
// under weaker ones. Change them here and both follow.

import type { HelmetOptions } from "helmet";

/**
 * Helmet's options: its default headers plus a Content-Security-Policy that
 * allows the WebSocket/WebRTC client (self) and OSM tiles for the map
 * preview. The production bundle has no inline script and no eval, so its
 * script-src is 'self' alone; the Vite dev server injects inline modules and
 * needs 'unsafe-inline' / 'unsafe-eval'.
 */
export function helmetOptions(dev: boolean): Readonly<HelmetOptions> {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "wss:", "ws:", "https://tile.openstreetmap.org"],
        // 'wasm-unsafe-eval' lets WebAssembly compile (Argon2id, kdf.ts) —
        // it does not allow eval() or inline script.
        scriptSrc: dev ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"] : ["'self'", "'wasm-unsafe-eval'"],
        objectSrc: ["'none'"],
        // Google Fonts: only fetched after the user opts in (Appearance → Typography).
        styleSrc: ["'self'", "'unsafe-inline'", "https://api.fontshare.com", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
        fontSrc: ["'self'", "https://api.fontshare.com", "https://fonts.gstatic.com"],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'"],
        childSrc: ["'none'"],
        // 5.3: only this site's own pages may be framed — /fn-sandbox.html, where a
        // function's browser code runs (sandboxed, opaque origin).
        frameSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false, // WebRTC/getUserMedia does not require COEP
  };
}

/** No cache anywhere: intermediaries must not keep encrypted payloads or even the HTML shell. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
};

/** Set on every response after helmet (server/index.ts). */
export const BASE_HEADERS: Readonly<Record<string, string>> = {
  ...NO_STORE_HEADERS,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // (self), not (): an empty allowlist disables the feature for this document
  // too — getUserMedia / geolocation then fail without ever prompting, which
  // breaks calls, speech-to-text and location sharing. (self) still blocks
  // every embedded third-party frame, and the browser prompt still applies.
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(self), interest-cohort=()",
};
