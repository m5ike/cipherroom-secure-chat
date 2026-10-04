// "A path on this site" (6.7, audit N22).
//
// Push notifications, layouts and menus may point at this site's own pages
// ("/signin"). The checks used to be "starts with / but not //" — which lets
// "/\evil.example" through (a URL parser reads the backslash as a slash:
// //evil.example, another host), and "/<TAB>/evil.example" too (tabs and
// newlines are dropped while parsing). A site path now has neither, and must
// resolve to this origin.

const PROBE = "https://site.invalid";

export function isSitePath(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { return new URL(value, PROBE).origin === PROBE; } catch { return false; }
}

/** 6.7 (N29): an https: URL — the only kind a link from a card opens in a new window
 *  (never javascript:, data:, blob: or file:, which would run in or read from this origin). */
export function isHttpsUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}
