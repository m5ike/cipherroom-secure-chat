// 6.2: a person hid or deleted a message in their own view.
//
//   POST /api/chat/message-audit        the web app (a Bearer token when signed in)
//   POST /api/android/message-audit     the Android app (signed by the device key;
//                                       registered in server/android/routes.ts)
//
// The message itself never leaves the device and is never sent here — the
// server is told only THAT it happened: the action, the message's id, the
// room (as its hash, like every audit entry), whose view it was (account,
// device or guest), whether it was the person's own message, what kind of
// message it was (text, file, a vanishing one…) and until when a hide lasts.
// It lands in the audit journal (category "message"), which seals the detail
// and keeps it in the database; the console shows it under Audit.

import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { audit } from "./monitor/audit";
import { hashRoom, truncateIp } from "./monitor/traffic";
import { accountStore, usernameOf } from "./accounts/store";

export type MessageAction = "delete" | "hide" | "unhide";

/** What a client may say about one action. */
export type MessageAuditInput = {
  action: MessageAction;
  messageId: string;
  /** The room as the client joined it (hashed before it is stored). */
  room: string;
  /** A hide's end (ms); 0 = until the next sign-in / unlock. */
  until?: number;
  /** "text" | "file" | "image" | "audio" | "video" | "location" | "tap" | "vanish" | "sealed" | "fn" | "private". */
  kinds?: string[];
  /** The person's own message (else someone else's). */
  mine?: boolean;
  /** When it happened on the device (ms). */
  at?: number;
};

const KINDS = new Set(["text", "file", "image", "audio", "video", "location", "tap", "vanish", "sealed", "fn", "private", "forwarded", "reply", "transcript"]);

/** The request body checked; null when it is not a message action. */
export function sanitizeMessageAudit(raw: unknown): MessageAuditInput | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const action = r.action === "delete" || r.action === "hide" || r.action === "unhide" ? r.action : null;
  const messageId = typeof r.messageId === "string" && /^[A-Za-z0-9_:.-]{1,120}$/.test(r.messageId) ? r.messageId : null;
  const room = typeof r.room === "string" && r.room.trim().length > 0 && r.room.length <= 200 ? r.room.trim() : null;
  if (!action || !messageId || !room) return null;
  const now = Date.now();
  const until = typeof r.until === "number" && Number.isFinite(r.until) && r.until >= 0 && r.until <= now + 400 * 86_400_000 ? Math.round(r.until) : undefined;
  const at = typeof r.at === "number" && Number.isFinite(r.at) && r.at > now - 7 * 86_400_000 && r.at <= now + 5 * 60_000 ? Math.round(r.at) : undefined;
  const kinds = Array.isArray(r.kinds) ? [...new Set(r.kinds.filter((k): k is string => typeof k === "string" && KINDS.has(k)))].slice(0, 8) : undefined;
  return { action, messageId, room, until, kinds, mine: typeof r.mine === "boolean" ? r.mine : undefined, at };
}

/** Who did it, as the audit journal names them. */
export type MessageActor = { actor: string; accountId?: string; deviceId?: string; ip?: string; via: "web" | "android" };

export function recordMessageAction(input: MessageAuditInput, who: MessageActor): void {
  audit.add({
    category: "message",
    level: input.action === "delete" ? "notice" : "info",
    event: `message.${input.action}`,
    actor: who.actor,
    accountId: who.accountId,
    roomHash: hashRoom(input.room),
    ip: who.ip,
    status: input.action === "hide" ? (input.until ? `until ${new Date(input.until).toISOString()}` : "until next sign-in") : "ok",
    detail: {
      messageId: input.messageId,
      via: who.via,
      ...(who.deviceId ? { device: who.deviceId } : {}),
      ...(input.mine !== undefined ? { mine: input.mine } : {}),
      ...(input.kinds?.length ? { kinds: input.kinds } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.at ? { deviceTime: input.at } : {}),
    },
  });
}

export function registerMessageAuditRoutes(app: Express): void {
  const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { ok: false, message: "Too many message actions; wait a moment." } });

  app.post("/api/chat/message-audit", limiter, (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    // One action or a batch (hiding a whole thread): at most 50.
    const list = Array.isArray(body.actions) ? body.actions.slice(0, 50) : [body];
    const header = req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const account = token ? accountStore.resolveToken(token) : null;
    const client = typeof body.client === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.client) ? body.client : undefined;
    const who: MessageActor = {
      actor: account ? usernameOf(account) : client ? `guest:${client}` : "guest",
      accountId: account?.id,
      ip: truncateIp(req.ip),
      via: "web",
    };
    let recorded = 0;
    for (const raw of list) {
      const input = sanitizeMessageAudit(raw);
      if (!input) continue;
      recordMessageAction(input, who);
      recorded++;
    }
    if (!recorded) return res.status(400).json({ ok: false, message: "Not a message action." });
    res.json({ ok: true, recorded });
  });
}
