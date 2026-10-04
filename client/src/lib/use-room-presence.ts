// 6.7: presence of the room on screen, for App.tsx — the PresenceBook fed
// with the signaling frames (a redraw when someone's presence changes), the
// throttled foreground / background signal to the server, and the people
// lists' entries with their presence (lib/presence-book.ts).

import { useRef, useState } from "react";
import { PresenceBook, PresenceSignal, type HeldEntry } from "./presence-book";
import type { PresenceFacts } from "./presence";

/** The app is in the foreground now (a hidden tab is not). */
export const appInForeground = (): boolean => typeof document === "undefined" || document.visibilityState !== "hidden";

export type RoomPresence = {
  book: PresenceBook;
  signal: PresenceSignal;
  /** A signaling frame (every one may go here: the rest is ignored). */
  onFrame(frame: unknown): void;
  /** A new connection: nothing known yet. */
  reset(): void;
  /** A live peer's presence, or a relay-covered member's (id "away:<ref>"). */
  factsOf(id: string): PresenceFacts;
  /** Held members to list beside these peers and away members (no doubles). */
  held(peerIds: string[], awayRefs: string[]): HeldEntry[];
  /** The server holds this member (connection gone): its entry, not a closed peer's, is the one to list. */
  isHeld(id: string): boolean;
};

export function useRoomPresence(socket: () => WebSocket | null): RoomPresence {
  const [, setRev] = useState(0);
  // The book and the signal live as long as the app; the functions over them are cheap to make.
  const ref = useRef<{ book: PresenceBook; signal: PresenceSignal } | null>(null);
  ref.current ??= {
    book: new PresenceBook(),
    signal: new PresenceSignal((frame) => {
      const s = socket();
      if (!s || s.readyState !== WebSocket.OPEN) return false;
      try { s.send(JSON.stringify(frame)); return true; } catch { return false; }
    }),
  };
  const { book, signal } = ref.current;
  return {
    book,
    signal,
    onFrame: (frame) => { if (frame && typeof frame === "object" && book.onFrame(frame as Record<string, unknown>)) setRev((n) => n + 1); },
    reset: () => { book.reset(); signal.reset(); setRev((n) => n + 1); },
    factsOf: (id) => (id.startsWith("away:") ? book.awayFacts(id.slice(5)) : book.facts(id)),
    held: (peerIds, awayRefs) => book.heldList(awayRefs, peerIds),
    isHeld: (id) => Boolean(book.heldEntry(id)),
  };
}
