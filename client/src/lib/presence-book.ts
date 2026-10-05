// Presence of the people in the room on screen (6.7), from the signaling
// frames: who is connected with the app in the foreground, when the others
// were last seen, and the members whose connection went without a goodbye
// ("held" — the server keeps them listed as away until they come back).
//
//   joined         peers[].foreground / lastSeen, held[], away[].lastSeen
//   peer-joined    a member (back): live again
//   peer-presence  foreground / background, lastSeen
//   peer-left      held: true — listed as away; without it: gone
//   peer-away / peer-back / peer-gone   the relay's signed-in members
//
// Also: presenceView() words it (dot colour, label, "last seen …"),
// PresenceSignal tells the server foreground / background without tripping
// its rate limit, and usePresenceClock() redraws as minutes pass.

import { useEffect, useState } from "react";
import { agoParts, presenceOf, type PresenceFacts, type PresenceState } from "./presence";
import { t, tf, type Lang } from "./i18n";
import { relativeFormat } from "./i18n-intl";

export type HeldEntry = { peerId: string; name: string; account: string; lastSeen: number; since: number };

type Raw = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const refOf = (f: Raw): string => str(f.account) || str(f.accountId);

export class PresenceBook {
  /** peer id → a live member's presence. */
  private readonly live = new Map<string, { foreground: boolean; lastSeen: number }>();
  /** peer id → a member whose connection went (held by the server). */
  private readonly held = new Map<string, HeldEntry>();
  /** account reference → when a relay-covered (away) member was last seen. */
  private readonly away = new Map<string, number>();

  reset(): void {
    this.live.clear();
    this.held.clear();
    this.away.clear();
  }

  private setLive(f: Raw): void {
    const peerId = str(f.peerId);
    if (!peerId) return;
    this.held.delete(peerId);
    // A server before 6.7 says nothing: the member counts as in the foreground.
    this.live.set(peerId, { foreground: f.foreground !== false, lastSeen: num(f.lastSeen) });
  }

  private setHeld(f: Raw): void {
    const peerId = str(f.peerId);
    if (!peerId) return;
    this.live.delete(peerId);
    this.held.set(peerId, { peerId, name: str(f.name), account: refOf(f), lastSeen: num(f.lastSeen), since: num(f.since) });
  }

  /** A signaling frame; true when it changed someone's presence. */
  onFrame(f: Raw): boolean {
    switch (f.type) {
      case "joined": {
        this.reset();
        for (const p of Array.isArray(f.peers) ? (f.peers as Raw[]) : []) this.setLive(p);
        for (const h of Array.isArray(f.held) ? (f.held as Raw[]) : []) this.setHeld(h);
        for (const a of Array.isArray(f.away) ? (f.away as Raw[]) : []) if (refOf(a)) this.away.set(refOf(a), num(a.lastSeen) || num(a.since));
        return true;
      }
      case "peer-joined":
        this.setLive(f);
        return true;
      case "peer-presence": {
        const peerId = str(f.peerId);
        if (!peerId) return false;
        this.live.set(peerId, { foreground: f.foreground === true, lastSeen: num(f.lastSeen) });
        return true;
      }
      case "peer-left": {
        const peerId = str(f.peerId);
        if (f.held === true) this.setHeld(f);
        else { this.live.delete(peerId); this.held.delete(peerId); }
        return true;
      }
      case "peer-away":
        if (!refOf(f)) return false;
        this.away.set(refOf(f), num(f.lastSeen) || num(f.since) || Date.now());
        return true;
      case "peer-back":
      case "peer-gone":
        return this.away.delete(refOf(f));
      default:
        return false;
    }
  }

  /** A member's presence by peer id: live, held, or (unknown) as connected. */
  facts(peerId: string): PresenceFacts {
    const live = this.live.get(peerId);
    if (live) return { connected: true, foreground: live.foreground, lastSeen: live.lastSeen };
    const held = this.held.get(peerId);
    if (held) return { connected: false, foreground: false, lastSeen: held.lastSeen };
    return { connected: true, foreground: true, lastSeen: 0 };
  }

  /** A relay-covered member's presence by account reference. */
  awayFacts(ref: string): PresenceFacts {
    return { connected: false, foreground: false, lastSeen: this.away.get(ref) ?? 0 };
  }

  /** Held members to list — not those the relay already lists under their account, nor peers that are live. */
  heldList(skipAccounts: Iterable<string> = [], skipPeers: Iterable<string> = []): HeldEntry[] {
    const accounts = new Set(skipAccounts);
    const peers = new Set(skipPeers);
    return [...this.held.values()].filter((h) => !peers.has(h.peerId) && !(h.account && accounts.has(h.account)));
  }

  heldEntry(peerId: string): HeldEntry | undefined {
    return this.held.get(peerId);
  }
}

/** How a member's presence is shown: the dot's state, its label, and "last seen …". */
export function presenceView(f: PresenceFacts, now: number, lang: Lang): { presence: PresenceState; presenceLabel: string; seenText: string } {
  const presence = presenceOf(f, now);
  const seenText = f.connected && f.foreground
    ? t(lang, "presence.now")
    : !f.lastSeen
      ? t(lang, "presence.seen.unknown")
      : tf(lang, "presence.seen", { ago: agoText(f.lastSeen, now, lang) });
  return { presence, presenceLabel: t(lang, `presence.${presence}`), seenText };
}

/** "5 min ago", "2 h ago" — in the language (6.13: Intl.RelativeTimeFormat; the presence.ago.* texts where Intl cannot). */
export function agoText(lastSeen: number, now: number, lang: Lang): string {
  const { unit, n } = agoParts(lastSeen, now);
  if (unit === "now") return t(lang, "presence.ago.now");
  const rtf = relativeFormat(lang, "short");
  if (rtf) { try { return rtf.format(-n, unit === "min" ? "minute" : unit === "h" ? "hour" : "day"); } catch { /* below */ } }
  return tf(lang, `presence.ago.${unit}`, { n });
}

/** The time, every `everyMs` (default 30 s): a dot changes colour as minutes pass without any news. */
export function usePresenceClock(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

/**
 * Tells the server foreground / background (`presence` frames) without
 * tripping its rate limit (a burst of 10, then one per 5 s): a change
 * within GAP_MS of the last frame waits and only the latest state goes.
 * `urgent` (the page may never run again: a freeze, a pagehide) sends at once.
 */
export class PresenceSignal {
  static readonly GAP_MS = 6_000;
  private last = 0;
  private sent: string | null = null;
  private pending: { away: boolean; foreground: boolean } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (frame: { type: "presence"; away: boolean; foreground: boolean }) => boolean, private readonly now: () => number = Date.now) {}

  set(state: { away: boolean; foreground: boolean }, urgent = false): void {
    this.pending = state;
    const wait = this.last + PresenceSignal.GAP_MS - this.now();
    if (urgent || wait <= 0) { this.flush(); return; }
    this.timer ??= setTimeout(() => { this.timer = null; this.flush(); }, wait);
  }

  /** A new connection: the server knows only what the join said (`known`), else nothing. */
  reset(known?: { away: boolean; foreground: boolean }): void {
    this.sent = known ? `${known.away}|${known.foreground}` : null;
    this.last = 0;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const state = this.pending;
    this.pending = null;
    if (!state) return;
    const key = `${state.away}|${state.foreground}`;
    if (key === this.sent) return;
    if (this.send({ type: "presence", ...state })) {
      this.sent = key;
      this.last = this.now();
    }
  }
}
