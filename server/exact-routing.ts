// 6.10 (security review G-02): routes match their paths exactly as written.
//
// Express matches routes case-insensitively by default, while the console's
// rights are decided from the path by code that compares it exactly
// (consoleGuard's rightOf: telephony/control/guard.ts, android/admin-routes.ts,
// functions/admin-routes.ts…). "GET /admin/telephony/LOG/<id>" therefore
// reached the log entry handler while its guard saw no known endpoint and
// asked only for the module — the "log" right (raw provider payloads), the
// Android "devices" right (positions) and the Functions "webhooks" right
// could be skipped by changing the case of a letter. Every route in this
// server is written in lower case and every client calls it so; making the
// matching exact closes the gap for all guards at once.

import type { Express, RouterOptions } from "express";

/** Call right after express(): the app's router is created on first use with this setting. */
export function exactRouting(app: Express): Express {
  app.set("case sensitive routing", true);
  return app;
}

/** For express.Router(): the same exact matching. */
export const EXACT_ROUTER: RouterOptions = { caseSensitive: true };
