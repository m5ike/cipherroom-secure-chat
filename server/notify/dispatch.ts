// The notifier (6.7): one notification for one account, through the first
// channel that takes it.
//
//   1. who: never the sender, never someone who is present (an awake socket
//      in the room), never an account that is gone
//   2. whether: the operator offers the kind, the user did not switch it (or
//      everything) off, it is not their quiet hours, the kind's throttle
//      (per account and room) and the account's hourly limit allow it
//   3. what: the kind's template in the user's language, at the privacy
//      level the user chose within what the operator allows — rendered by
//      the server with what it legitimately knows (the sender's display
//      name, a count, the time); the room's name and any preview only the
//      receiving device can add
//   4. how: the user's channel order (else the operator's), only channels
//      the operator switched on, the server can use, and the account has an
//      endpoint with; the first channel where an endpoint takes it wins,
//      a failure (HTTP error, dead token, timeout) moves on to the next
//   5. afterwards: every attempt in the operator's log (no content — there
//      is none), dead endpoints forgotten, an audit entry.
//
// 6.14 (call wake): a "call" with `call` (the relay's call wake) is a ring —
// the checks above, a tag of the call's own, `call` {id, video, at} in the
// payload (and the room for the app channel only, sealed per device), every
// channel's expiry 60 s; the ring is remembered. Its end goes only where the
// ring went (`callEnd`), as the quiet "missed call" in the ring's place.

import { randomBytes } from "node:crypto";
import type { AccountStore } from "../accounts/store";
import { audit } from "../monitor/audit";
import { hashRoom } from "../monitor/traffic";
import {
  CALL_MISSED_BODY, effectivePrivacy, inQuietHours, renderNotification, templateText, timeIn, visibleVars,
  type NotifyChannel, type NotifyKind, type NotifyPrivacy, type UserNotifyPrefs,
} from "../../client/src/lib/notify-template";
import type { NotifyConfig } from "./config";
import type { NotifyStore } from "./store";
import type { Attempt, Channel, NotifyPayload } from "./channels";

export type NotifyRequest = {
  accountId: string;
  kind: NotifyKind;
  /** The room id the server knows (opaque). */
  room?: string;
  from?: { name?: string; accountId?: string };
  /** Messages waiting for the account in the room. */
  count?: number;
  /** Only these channels (a test of one channel). */
  only?: NotifyChannel[];
  /** Who asked (the console, the user's own test) — for the log. */
  by?: string;
  /**
   * 6.14 (call wake, kind "call"): the call — the caller's id for it, video,
   * `end` (it ended before anyone answered: the ring stops), and `at` (when it
   * rang — set here, from the server's clock).
   */
  call?: { id: string; video: boolean; end?: boolean; at?: number };
};

/**
 * 6.14 (call wake): a ring lives `ringMs` (the push expiry everywhere — an
 * older ring must not ring); its end is sent only where the ring went, and
 * only for `rememberMs` (afterwards the end is no news). At most `rings`
 * rings are remembered.
 */
export const CALL_WAKE = { ringMs: 60_000, rememberMs: 10 * 60_000, rings: 20_000 } as const;

export type NotifyOutcome = {
  ok: boolean;
  /** The channel that took it. */
  channel?: NotifyChannel;
  /** Why nothing was sent. */
  skipped?: string;
  attempts: Attempt[];
  /** The channels tried, in order. */
  order: NotifyChannel[];
};

export type LogEntry = {
  id: number;
  at: number;
  kind: NotifyKind;
  account: string;
  room?: string;
  outcome: "sent" | "failed" | "skipped";
  reason?: string;
  channel?: NotifyChannel;
  order: NotifyChannel[];
  attempts: Attempt[];
  by?: string;
};

export type NotifierDeps = {
  accounts: Pick<AccountStore, "get" | "addAudit">;
  store: NotifyStore;
  config: () => NotifyConfig;
  channels: Channel[];
  /** An awake socket of the account in the room. */
  present?: (accountId: string, room: string) => boolean;
  now?: () => number;
};

const LOG_SIZE = 1000;

export class Notifier {
  private last = new Map<string, number>();
  private hourly = new Map<string, number[]>();
  private ring: LogEntry[] = [];
  private nextId = 1;
  private counts = { sent: 0, failed: 0, skipped: 0 };
  private byChannel = new Map<NotifyChannel, { ok: number; failed: number; gone: number }>();

  constructor(private readonly deps: NotifierDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** The channels for this account, in the order they are tried. */
  async orderFor(accountId: string, prefs: UserNotifyPrefs, config: NotifyConfig, hasPrefs: boolean, only?: NotifyChannel[]): Promise<{ order: NotifyChannel[]; why: string[] }> {
    const on = config.channels.filter((c) => c.on).map((c) => c.id);
    const wanted = hasPrefs ? prefs.order.filter((c) => on.includes(c)) : on;
    const why: string[] = [];
    const order: NotifyChannel[] = [];
    for (const id of wanted) {
      if (only && !only.includes(id)) continue;
      const ch = this.deps.channels.find((c) => c.id === id);
      if (!ch) continue;
      const ready = ch.ready(config);
      if (!ready.ready) { why.push(`${id}: ${ready.reason}`); continue; }
      if ((await ch.targets(accountId)) === 0) { why.push(`${id}: no endpoint`); continue; }
      order.push(id);
    }
    return { order, why };
  }

  /** The payload for one account (exported for the console's preview and tests). */
  payloadFor(req: NotifyRequest, prefs: UserNotifyPrefs, config: NotifyConfig, channel: NotifyChannel | "" = ""): NotifyPayload {
    const tpl = config.templates[req.kind];
    const privacy: NotifyPrivacy = effectivePrivacy(tpl, prefs);
    const at = this.now();
    const vars = visibleVars({
      app: config.appName,
      sender: req.from?.name ?? "",
      count: req.count ?? "",
      time: timeIn(at, prefs.quiet.tz),
      channel,
    }, privacy);
    const lang = prefs.lang;
    // 6.14 (call wake): a call's end is the ring's quiet "missed call" in its place.
    const call = req.kind === "call" ? req.call : undefined;
    const end = call?.end === true;
    const texts = end ? { title: tpl.title, body: CALL_MISSED_BODY } : tpl;
    const { title, body } = renderNotification(texts, lang, vars, privacy);
    const roomTag = req.room ? hashRoom(req.room) ?? "" : "";
    // 6.14: a call's ring and its end share a tag of their own (the end replaces the ring; a message does not).
    const tag = call ? `m5-call-${call.id}`.slice(0, 64)
      : tpl.group === "room" && roomTag ? `m5-${roomTag}` : tpl.group === "kind" ? `m5-${req.kind}` : `m5-${randomBytes(4).toString("hex")}`;
    const shown = Object.fromEntries(Object.entries(vars).filter(([, v]) => v)) as Record<string, string>;
    const showsRoom = privacy === "room" || privacy === "content";
    return {
      v: 1,
      id: randomBytes(9).toString("base64url"),
      kind: req.kind,
      title,
      body,
      tpl: { title: templateText(texts.title, lang), body: templateText(texts.body, lang) },
      vars: shown,
      privacy,
      ...(showsRoom && req.room ? { room: req.room } : {}),
      tag,
      group: tpl.group,
      icon: tpl.icon,
      accent: tpl.accent,
      sound: end ? false : tpl.sound,
      vibrate: end ? false : tpl.vibrate,
      sticky: end ? false : tpl.sticky,
      actions: tpl.actions,
      url: req.kind === "test" || req.kind === "function" ? "/" : "/signin",
      lang,
      at,
      // 6.14: the call for the device — its room only for the app channel (sealed for the one device,
      // which maps it to its own room; never shown, never in the clear part of a push).
      ...(call ? { call: { id: call.id, video: call.video, at: call.at ?? at, ...(end ? { end: true as const } : {}), ...(channel === "android" && req.room ? { room: req.room } : {}) } } : {}),
    };
  }

  /** `quiet`: counted, not written to the log (a burst of messages would fill it with "throttled"). */
  private skip(req: NotifyRequest, reason: string, quiet = false): NotifyOutcome {
    if (quiet) this.counts.skipped += 1;
    else this.record(req, { outcome: "skipped", reason, order: [], attempts: [] });
    return { ok: false, skipped: reason, attempts: [], order: [] };
  }

  private record(req: NotifyRequest, e: Pick<LogEntry, "outcome" | "reason" | "channel" | "order" | "attempts">): void {
    this.counts[e.outcome] += 1;
    for (const a of e.attempts) {
      const c = this.byChannel.get(a.channel) ?? { ok: 0, failed: 0, gone: 0 };
      if (a.ok) c.ok += 1; else c.failed += 1;
      if (a.gone) c.gone += 1;
      this.byChannel.set(a.channel, c);
    }
    this.ring.push({ id: this.nextId++, at: this.now(), kind: req.kind, account: req.accountId, ...(req.room ? { room: hashRoom(req.room) } : {}), ...(req.by ? { by: req.by } : {}), ...e });
    if (this.ring.length > LOG_SIZE) this.ring.splice(0, this.ring.length - LOG_SIZE);
  }

  /** Sends one notification (or says why not). Never throws. */
  async notify(req: NotifyRequest): Promise<NotifyOutcome> {
    if (req.kind === "call" && req.call?.end) return this.callEnd(req);
    const config = this.deps.config();
    const now = this.now();
    if (!config.enabled) return this.skip(req, "notifications are off (operator)");
    const acc = this.deps.accounts.get(req.accountId);
    if (!acc) return this.skip(req, "no such account");
    if (req.from?.accountId && req.from.accountId === req.accountId) return this.skip(req, "the sender themselves");
    if (req.room && this.deps.present?.(req.accountId, req.room)) return this.skip(req, "present in the room");
    const tpl = config.templates[req.kind];
    if (!tpl.on) return this.skip(req, `${req.kind}: off (operator)`);
    const prefs = this.deps.store.prefs(req.accountId);
    const test = req.kind === "test";
    if (!test) {
      if (!prefs.on) return this.skip(req, "off (user)");
      if (prefs.kinds[req.kind] === false) return this.skip(req, `${req.kind}: off (user)`);
      if (inQuietHours(prefs.quiet, now)) return this.skip(req, "quiet hours");
    }
    // The kind's throttle, per account and room.
    const key = `${req.accountId}|${req.room ?? ""}|${req.kind}`;
    if (tpl.throttle > 0 && now - (this.last.get(key) ?? -Infinity) < tpl.throttle * 1000) return this.skip(req, "throttled", true);
    // The account's hourly limit (tests have their own).
    const hk = `${req.accountId}|${test ? "test" : "all"}`;
    const recent = (this.hourly.get(hk) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= (test ? config.limits.testsPerHour : config.limits.perHour)) { this.hourly.set(hk, recent); return this.skip(req, "hourly limit"); }

    const { order, why } = await this.orderFor(req.accountId, prefs, config, this.deps.store.hasPrefs(req.accountId), req.only);
    if (order.length === 0) return this.skip(req, why.length ? `no channel (${why.join("; ")})` : "no channel");

    this.last.set(key, now);
    if (this.last.size > 50_000) this.last.clear();
    recent.push(now);
    this.hourly.set(hk, recent);
    if (this.hourly.size > 50_000) this.hourly.clear();

    // 6.14: a ring carries the time it rang (its end and every push's expiry go by it).
    const sending = req.kind === "call" && req.call ? { ...req, call: { ...req.call, at: now } } : req;
    const outcome = await this.deliver(sending, prefs, config, order);
    if (outcome.ok && outcome.channel && sending.call && sending.room) this.rememberRing(sending, outcome.channel, now);
    return outcome;
  }

  /* ------------------------------------------------- 6.14: call wakes */

  private rings = new Map<string, { at: number; channel: NotifyChannel }>();

  private ringKey(req: NotifyRequest): string { return `${req.accountId}|${req.room ?? ""}|${req.call?.id ?? ""}`; }

  private rememberRing(req: NotifyRequest, channel: NotifyChannel, at: number): void {
    this.rings.set(this.ringKey(req), { at, channel });
    if (this.rings.size > CALL_WAKE.rings) {
      for (const [k, r] of this.rings) if (at - r.at > CALL_WAKE.rememberMs) this.rings.delete(k);
      for (const k of this.rings.keys()) { if (this.rings.size <= CALL_WAKE.rings) break; this.rings.delete(k); }
    }
  }

  /**
   * A call ended before anyone answered: its ring stops — sent only where the
   * ring went (the same channel; never by e-mail), within CALL_WAKE.rememberMs.
   * The ring passed the user's switches, quiet hours and limits; its end is
   * bound to it (one end per ring) and passes them too. Someone who is in the
   * room now sees the call there.
   */
  private async callEnd(req: NotifyRequest): Promise<NotifyOutcome> {
    const config = this.deps.config();
    const now = this.now();
    const key = this.ringKey(req);
    const ring = this.rings.get(key);
    this.rings.delete(key);
    if (!config.enabled) return this.skip(req, "notifications are off (operator)", true);
    if (!ring || now - ring.at > CALL_WAKE.rememberMs) return this.skip(req, "call end: no ring of this call was sent", true);
    if (ring.channel === "email") return this.skip(req, "call end: the ring went by e-mail", true);
    if (!this.deps.accounts.get(req.accountId)) return this.skip(req, "no such account");
    if (req.room && this.deps.present?.(req.accountId, req.room)) return this.skip(req, "present in the room", true);
    const prefs = this.deps.store.prefs(req.accountId);
    return this.deliver({ ...req, call: { ...req.call!, end: true, at: ring.at } }, prefs, config, [ring.channel]);
  }

  /** Through the first channel of `order` that takes it; logged and audited. */
  private async deliver(req: NotifyRequest, prefs: UserNotifyPrefs, config: NotifyConfig, order: NotifyChannel[]): Promise<NotifyOutcome> {
    const attempts: Attempt[] = [];
    let channel: NotifyChannel | undefined;
    for (const id of order) {
      const ch = this.deps.channels.find((c) => c.id === id);
      if (!ch) continue;
      const payload = this.payloadFor(req, prefs, config, id);
      let got: Attempt[];
      try {
        got = await ch.send({ accountId: req.accountId, payload, config });
      } catch (err) {
        got = [{ channel: id, target: "?", ok: false, error: (err as Error).message.slice(0, 200), ms: 0 }];
      }
      attempts.push(...got);
      if (got.some((a) => a.ok)) { channel = id; break; }
    }

    const roomHash = req.room ? hashRoom(req.room) : undefined;
    const sentTo = attempts.filter((a) => a.ok).length;
    if (channel) {
      this.record(req, { outcome: "sent", channel, order, attempts });
      this.deps.accounts.addAudit(req.accountId, "push-sent", { devices: sentTo, channel, kind: req.kind });
      audit.add({ category: "account", event: "notify.sent", accountId: req.accountId, roomHash, status: channel, detail: { kind: req.kind, tried: attempts.length, ...(req.by ? { by: req.by } : {}) } });
      return { ok: true, channel, attempts, order };
    }
    this.record(req, { outcome: "failed", reason: "every channel failed", order, attempts });
    audit.add({ category: "account", level: "notice", event: "notify.failed", accountId: req.accountId, roomHash, status: "failed", detail: { kind: req.kind, order, errors: attempts.map((a) => `${a.channel}: ${a.error ?? "?"}`).slice(0, 6) } });
    return { ok: false, attempts, order };
  }

  /** The operator's log, newest first. */
  log(filter: { account?: string; outcome?: string; channel?: string; limit?: number } = {}): LogEntry[] {
    const out: LogEntry[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < (filter.limit ?? 200); i -= 1) {
      const e = this.ring[i];
      if (filter.account && e.account !== filter.account) continue;
      if (filter.outcome && e.outcome !== filter.outcome) continue;
      if (filter.channel && e.channel !== filter.channel && !e.attempts.some((a) => a.channel === filter.channel)) continue;
      out.push(e);
    }
    return out;
  }

  stats() {
    return { ...this.counts, channels: Object.fromEntries(this.byChannel) };
  }
}
