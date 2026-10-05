// m5cet:// links (pure).
//
//   m5cet://auth/callback?id=<handoff id>
//        the browser finished a sign-in for this app (desktop-auth): wake up
//        and collect the encrypted result. The link carries only the id — the
//        result itself is fetched with a secret only the app has.
//   m5cet://open?url=<https URL of a server>
//   m5cet://<server host[:port]>/<path>[?query][#fragment]
//        open a server page in the app — e.g. an invite link
//        m5cet://chat.example.org/#j=<id>.<key> (the same as
//        https://chat.example.org/#j=…). A server the user has not added yet
//        is only opened after a confirmation.
//
// Anything else — unknown actions, credentials, a path that is not a plain
// site path, over-long links — is "invalid" and ignored.

import { parseServerUrl } from "./server-url";

export const SCHEME = "m5cet";
const MAX_LENGTH = 4096;

export type DeepLink =
  | { kind: "auth"; id: string }
  | { kind: "open"; origin: string; host: string; display: string; path: string }
  | { kind: "invalid"; reason: string };

/** A same-site path: "/…", no "//", no backslash or control characters (= client/src/lib/site-path.ts). */
export function isSitePath(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { return new URL(value, "https://site.invalid").origin === "https://site.invalid"; } catch { return false; }
}

/** The handoff id the server issues: 22–64 base64url characters. */
export const HANDOFF_ID = /^[A-Za-z0-9_-]{22,64}$/;

export function parseDeepLink(raw: string, opts: { allowLoopbackHttp?: boolean } = {}): DeepLink {
  if (typeof raw !== "string" || raw.length > MAX_LENGTH) return { kind: "invalid", reason: "length" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return { kind: "invalid", reason: "characters" };
  if (!raw.toLowerCase().startsWith(`${SCHEME}://`)) return { kind: "invalid", reason: "scheme" };
  // Parse as https with the same authority and path: m5cet: is not a "special" scheme for the URL parser.
  let url: URL;
  try { url = new URL(`https://${raw.slice(SCHEME.length + 3)}`); } catch { return { kind: "invalid", reason: "url" }; }
  if (url.username || url.password) return { kind: "invalid", reason: "credentials" };
  const host = url.host.toLowerCase();

  if (host === "auth") {
    if (url.pathname !== "/callback") return { kind: "invalid", reason: "auth-action" };
    const id = url.searchParams.get("id") ?? "";
    if (!HANDOFF_ID.test(id)) return { kind: "invalid", reason: "auth-id" };
    return { kind: "auth", id };
  }

  let target: string;
  if (host === "open") {
    target = url.searchParams.get("url") ?? "";
  } else {
    target = `https://${raw.slice(SCHEME.length + 3)}`;
  }
  const server = parseServerUrl(target, { allowLoopbackHttp: opts.allowLoopbackHttp });
  if (!server.ok) return { kind: "invalid", reason: `server-${server.error}` };
  let path = "/";
  try {
    const u = new URL(target);
    path = `${u.pathname}${u.search}${u.hash}` || "/";
  } catch { return { kind: "invalid", reason: "url" }; }
  if (!isSitePath(path)) return { kind: "invalid", reason: "path" };
  return { kind: "open", origin: server.value.origin, host: server.value.host, display: server.value.display, path };
}

/** The deep link in a command line (Windows / Linux pass it as an argument). */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === "string" && arg.toLowerCase().startsWith(`${SCHEME}://`)) return arg;
  }
  return null;
}
