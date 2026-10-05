// The security headers of the bundled page — exactly the server's.
//
// The server applies helmet (with the CSP of server/security-headers.ts) and
// then BASE_HEADERS to every response. The desktop app serves the client's
// files itself, so it runs the same helmet configuration once and keeps what
// it would set: the page runs under the same CSP, frame-ancestors, COOP,
// CORP, HSTS, Referrer-Policy, Permissions-Policy and no-store as on the web.
// esbuild bundles helmet and server/security-headers.ts into the main
// process; a change of the server's policy changes the app's with the next
// build.

import helmet from "helmet";
import { BASE_HEADERS, helmetOptions } from "../../server/security-headers";

type HeaderSink = {
  setHeader(name: string, value: string | number | readonly string[]): void;
  removeHeader(name: string): void;
  getHeader(name: string): string | undefined;
};

/** The production header set (development only for tests: `dev` loosens script-src). */
export function webSecurityHeaders(opts: { dev?: boolean; insecureLoopback?: boolean } = {}): Record<string, string> {
  const out = new Map<string, [string, string]>();
  const res: HeaderSink = {
    setHeader(name, value) { out.set(name.toLowerCase(), [name, Array.isArray(value) ? value.join(", ") : String(value)]); },
    removeHeader(name) { out.delete(name.toLowerCase()); },
    getHeader(name) { return out.get(name.toLowerCase())?.[1]; },
  };
  let done = false;
  const middleware = helmet(helmetOptions(opts.dev === true)) as unknown as (req: unknown, res: HeaderSink, next: (err?: unknown) => void) => void;
  middleware({ method: "GET", url: "/", headers: {} }, res, (err) => {
    if (err) throw err;
    done = true;
  });
  if (!done) throw new Error("helmet did not finish synchronously");
  for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
  const headers = Object.fromEntries([...out.values()]);
  // A development server on http://localhost (M5CET_ALLOW_LOOPBACK): no
  // upgrade of its requests to https and no HSTS for it.
  if (opts.insecureLoopback) {
    const csp = headers["Content-Security-Policy"];
    if (csp) headers["Content-Security-Policy"] = csp.split(";").map((d) => d.trim()).filter((d) => d && d !== "upgrade-insecure-requests").join(";");
    delete headers["Strict-Transport-Security"];
  }
  return headers;
}
