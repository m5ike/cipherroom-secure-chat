// Web Push routes of the main service.
//
//   GET  /api/push/status      VAPID public key + readiness
//   POST /api/push/subscribe   register an endpoint → { id } (the client keeps
//                              it in localStorage "m5cet:push:id")
//   POST /api/push/test        { id }                 self-test: one push, fixed
//                                                     text, to that subscription
//                                                     only — no token needed
//                              { broadcast: true }    push to EVERY subscriber with
//                              (or no id)             caller text — admin token only
//
// The subscription id is a random UUID handed only to the subscribing
// device, so it works as a capability for "push to myself". Before this
// split, a request without an id pushed caller-supplied text to someone
// else's device without any authentication.

import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { checkAdminRequest, sendAdminAuthFailure } from "./admin-auth";
import { eventStore } from "./events";
import { isWebPushReady, sendWebPush } from "./push";
import { pushSubscriptions } from "./routes-admin-shared";
import { safeDeviceId } from "./util";

const SELF_TEST = { title: "M5cet · test", body: "Push delivery test" } as const;

const vapidConfigured = () => Boolean(process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim());

export function registerPushRoutes(app: Express): void {
  // Each test hits a third-party push service: keep it well under the global
  // /api limit. Default key = client IP (IPv6-safe; see index.ts TRUST_PROXY).
  const pushTestLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, message: "Too many push tests; wait a minute." },
  });

  app.get("/api/push/status", (_req, res) => {
    const vapidPublic = process.env.VAPID_PUBLIC_KEY?.trim() || "";
    res.json({
      enabled: vapidConfigured(),
      vapidPublicKey: vapidPublic || null,
      subscribers: pushSubscriptions.size,
    });
  });

  app.post("/api/push/subscribe", (req: Request, res: Response) => {
    if (!vapidConfigured()) {
      return res.status(503).json({ ok: false, message: "Push not configured." });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const subscription = body.subscription as { endpoint?: unknown } | undefined;
    if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://")) {
      return res.status(400).json({ ok: false, message: "Invalid subscription." });
    }
    const endpoint = subscription.endpoint.slice(0, 512);
    const keys = (subscription as Record<string, unknown>).keys as Record<string, unknown> | undefined;
    const p256dh = typeof keys?.p256dh === "string" ? String(keys.p256dh).slice(0, 256) : undefined;
    const auth = typeof keys?.auth === "string" ? String(keys.auth).slice(0, 128) : undefined;
    const id = crypto.randomUUID();
    const deviceId = safeDeviceId(body.deviceId) || undefined;
    pushSubscriptions.set(id, {
      endpoint,
      keys: p256dh && auth ? { p256dh, auth } : undefined,
      createdAt: Date.now(),
      deviceId,
    });
    eventStore.record({ kind: "push-subscribe", meta: { count: pushSubscriptions.size } });
    res.json({ ok: true, id });
  });

  app.post("/api/push/test", pushTestLimiter, async (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const id = typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 64) : null;
    const broadcast = body.broadcast === true || !id;

    // Broadcast (or no id at all): operators only — checked before anything
    // else, so an unauthenticated caller learns nothing about the setup.
    if (broadcast) {
      const failure = checkAdminRequest(req);
      if (failure) return sendAdminAuthFailure(res, failure);
    }
    if (!isWebPushReady()) {
      return res.status(503).json({ ok: false, message: "Push not configured (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)." });
    }

    if (!broadcast && id) {
      const sub = pushSubscriptions.get(id);
      if (!sub) {
        return res.status(404).json({ ok: false, message: "Unknown subscription id — subscribe again on this device." });
      }
      // Fixed text: a leaked id can at most repeat the test notification.
      const r = await sendWebPush(sub, SELF_TEST);
      eventStore.record({ kind: "push-test", meta: { mode: "self", ok: r.ok } });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, mode: "self", error: r.error });
    }

    const targets = Array.from(pushSubscriptions.values());
    if (targets.length === 0) return res.status(404).json({ ok: false, message: "No subscriptions yet." });
    const title = typeof body.title === "string" && body.title.trim() ? body.title.slice(0, 64) : "M5cet";
    const text = typeof body.body === "string" && body.body.trim() ? body.body.slice(0, 200) : "Test push from the operator.";
    const results: Array<{ endpoint: string; ok: boolean; error?: string }> = [];
    for (const sub of targets) {
      const r = await sendWebPush(sub, { title, body: text });
      results.push({ endpoint: sub.endpoint.slice(0, 80), ok: r.ok, error: r.error });
    }
    const sent = results.filter((r) => r.ok).length;
    eventStore.record({ kind: "push-test", meta: { mode: "broadcast", count: results.length, sent } });
    res.json({ ok: true, mode: "broadcast", sent, failed: results.length - sent, results });
  });
}
