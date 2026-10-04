// @vitest-environment node
//
// The relay's in-memory away map is bounded like the account store (6.7,
// audit S5): the store kept an account away in at most maxAwayRooms rooms,
// the relay kept every room — 10 000 × join+leave(away) left 10 000 entries.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { AccountStore, ACCOUNT_LIMITS } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { AwayRelay, type RelayPeer } from "../server/signaling/relay";
import type { StoredCredential } from "../server/accounts/webauthn";

const credential = (id: string): StoredCredential => ({ credentialId: id, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 });

let dir = "";
let store: AccountStore;
let rooms: Map<string, Map<string, RelayPeer>>;
let sent: Array<Record<string, unknown>>;
let now = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-relay-bound-"));
  store = new AccountStore(dir);
  rooms = new Map();
  sent = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("S5 — the away map follows the store's per-account limit", () => {
  it("join + leave(away) in many rooms keeps at most maxAwayRooms per account", () => {
    const queue = new MemoryQueue(() => now);
    const relay = new AwayRelay(store, rooms, (_s, p) => { sent.push(p as Record<string, unknown>); return true; }, () => queue, undefined, () => now);
    const r = store.create(credential("cred-bound-000000"), "Alice", now);
    if (!r.ok) throw new Error(r.reason);
    const id = r.account.id;
    // A watcher in the first room sees the eviction as peer-back.
    const watcherSocket = { id: "w" } as unknown as WebSocket;
    rooms.set("room-0", new Map([["w", { id: "w", connId: "c-w", room: "room-0", name: "W", socket: watcherSocket }]]));
    for (let i = 0; i < 200; i++) {
      now += 1000;
      const room = `room-${i}`;
      const p: RelayPeer = { id: `p${i}`, connId: `c${i}`, room, name: "Alice", socket: { id: `s${i}` } as unknown as WebSocket, accountId: id, awayEnabled: true };
      relay.onJoin(p);
      expect(relay.onLeave(p, room, true)).toBe(true);
    }
    const awayRooms = relay.awayRooms().filter((room) => relay.isAway(id, room));
    expect(awayRooms.length).toBe(ACCOUNT_LIMITS.maxAwayRooms);
    // The newest rooms stay; the store and the relay agree.
    expect(relay.isAway(id, "room-199")).toBe(true);
    expect(relay.isAway(id, "room-0")).toBe(false);
    expect(new Set(store.get(id)!.away.map((a) => a.room))).toEqual(new Set(awayRooms));
    expect(sent.some((p) => p.type === "peer-back")).toBe(true);
  });
});
