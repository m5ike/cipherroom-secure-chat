// What the user types as "the server" → an origin the app will load (pure).
//
//   chat.example.org           → https://chat.example.org
//   https://chat.example.org/  → https://chat.example.org
//   https://chat.example.org/#j=…  (an invite link) → the origin; the link part is reported
//   https://müller.example     → https://xn--mller-kva.example (IDN: the ASCII form is
//                                what is loaded and stored; both forms are shown)
//
// Refused: anything but https (http only for a loopback development server,
// and only when the app allows it), credentials in the URL, hosts without a
// dot (except localhost), malformed hosts or ports, and over-long names.

import { domainToUnicode } from "node:url";

export type ServerUrlError =
  | "empty" | "invalid" | "scheme" | "credentials" | "host" | "port" | "too-long" | "insecure";

export type ServerUrl = {
  /** "https://chat.example.org[:port]" — the ASCII (punycode) origin. */
  origin: string;
  /** The ASCII host[:port]. */
  host: string;
  /** What to show: the Unicode name, with the ASCII form when they differ (a look-alike shows its real name). */
  display: string;
  /** The Unicode form of the host name differs from its ASCII form. */
  idn: boolean;
  /** Path, query and fragment that came with the input (an invite link: "/#j=…") — not part of the server; "" when none. */
  rest: string;
  /** http on a loopback address (development only). */
  insecure: boolean;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

/** Normalises and validates a server address. `allowLoopbackHttp` permits http://localhost (development). */
export function parseServerUrl(input: string, opts: { allowLoopbackHttp?: boolean } = {}): { ok: true; value: ServerUrl } | { ok: false; error: ServerUrlError } {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "empty" };
  if (raw.length > 2048) return { ok: false, error: "too-long" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return { ok: false, error: "invalid" };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, error: "invalid" }; }
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(withScheme)) return { ok: false, error: "credentials" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "scheme" };
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, error: "host" };
  const loopback = isLoopbackHost(host);
  if (url.protocol === "http:" && !(loopback && opts.allowLoopbackHttp)) return { ok: false, error: loopback ? "insecure" : "scheme" };
  if (host.length > 253) return { ok: false, error: "too-long" };
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.startsWith("[") && host.endsWith("]");
  if (!ipv4 && !ipv6) {
    const labels = host.split(".");
    if (labels.length < 2 && !loopback) return { ok: false, error: "host" };
    if (labels.some((l) => l.length === 0 || l.length > 63 || !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/.test(l))) return { ok: false, error: "host" };
    if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, error: "host" };
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return { ok: false, error: "port" };
  const unicode = ipv4 || ipv6 ? host : domainToUnicode(host) || host;
  const idn = unicode !== host;
  const port = url.port ? `:${url.port}` : "";
  const tail = `${url.pathname}${url.search}${url.hash}`;
  const rest = tail === "/" ? "" : tail;
  return {
    ok: true,
    value: {
      origin: `${url.protocol}//${host}${port}`,
      host: `${host}${port}`,
      display: idn ? `${unicode}${port} (${host}${port})` : `${host}${port}`,
      idn,
      rest,
      insecure: url.protocol === "http:",
    },
  };
}
