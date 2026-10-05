// Where the app window may go, and what opens elsewhere (pure).
//
//   allow     the chosen server's origin (the page navigates within itself)
//   external  http(s) of another origin, mailto:, tel:, sms: — the system
//             browser / mail / phone app, after the user confirms
//   deep-link m5cet:// — handled by the app itself
//   block     everything else: javascript:, data:, file:, blob: and filesystem:
//             as a top-level document, chrome:, devtools:, about: (except
//             about:blank), unknown schemes, URLs with credentials
//
// New windows (window.open, target=_blank): never a second app window of
// the server origin with the bridge in it — a same-origin link navigates the
// main window instead, a blob: of the server origin (a decrypted file the
// page opens) is opened in a locked-down viewer, the rest is "external" or
// "block" as above.

export type NavDecision = "allow" | "external" | "deep-link" | "block";
export type WindowOpenDecision = "navigate" | "viewer" | "external" | "deep-link" | "block";

const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:", "sms:"]);

function parse(raw: string): URL | null {
  // eslint-disable-next-line no-control-regex
  if (typeof raw !== "string" || raw.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try { return new URL(raw); } catch { return null; }
}

/** A navigation of the app window (will-navigate, will-redirect, will-frame-navigate of the main frame). */
export function decideNavigation(target: string, serverOrigin: string): NavDecision {
  const url = parse(target);
  if (!url) return "block";
  if (url.username || url.password) return "block";
  if (url.protocol === "m5cet:") return "deep-link";
  if (url.protocol === "https:" || url.protocol === "http:") {
    if (url.origin === serverOrigin) return "allow";
    // Plain http to another site still opens — in the browser, which warns as it does.
    return "external";
  }
  if (EXTERNAL_SCHEMES.has(url.protocol)) return "external";
  return "block";
}

/** window.open / target=_blank from the page. */
export function decideWindowOpen(target: string, serverOrigin: string): WindowOpenDecision {
  const url = parse(target);
  if (!url) return "block";
  if (url.protocol === "blob:") {
    // blob:https://server/uuid — the page's own decrypted content.
    try { return new URL(url.pathname).origin === serverOrigin ? "viewer" : "block"; } catch { return "block"; }
  }
  if (target === "about:blank") return "block";
  const nav = decideNavigation(target, serverOrigin);
  if (nav === "allow") return "navigate";
  return nav;
}

/** What the "open in browser?" confirmation shows: scheme + host (+ path), never credentials, at most 200 characters. */
export function describeExternal(target: string): string {
  const url = parse(target);
  if (!url) return "";
  if (url.protocol === "mailto:" || url.protocol === "tel:" || url.protocol === "sms:") return `${url.protocol}${decodeURIComponentSafe(url.pathname)}`.slice(0, 200);
  const shown = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
