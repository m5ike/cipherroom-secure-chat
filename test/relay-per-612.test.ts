// @vitest-environment node
//
// 6.12 — the relay frame with an envelope per recipient (protocol 4, § 7.4):
// `per: { [ref]: envelope }` gives each away recipient its own queue item
// (a protocol-4 `mb` / `mb-set` sealed for its devices' mailboxes), the others
// get `envelope` (protocol 3). Shapes and sizes are checked, nested JSON is
// rebuilt from validated fields only, the size limit applies per item, and
// receipts and the ledger work as before.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { randomBytes } from "node:crypto";
import { AccountStore } from "../server/accounts/store";
import { MemoryQueue } from "../server/accounts/memqueue";
import { SignalingHub } from "../server/signaling/hub";
import { MB_SET_MAX_ITEMS, parseFrame, parseP4Envelope, isFrameError } from "../server/signaling/frames";
import { accountRef } from "../server/signaling/refs";
import type { StoredCredential } from "../server/accounts/webauthn";
import { WsClient } from "./helpers/ws-client";

/* ------------------------------------------------------------- helpers */

const b64 = (n: number) => randomBytes(n).toString("base64");
const b64url = (n: number) => randomBytes(n).toString("base64url");

/** A protocol-4 mailbox item of realistic sizes (the server never opens it). */
function mailboxItem(id: string, extra: Record<string, unknown> = {}) {
  return {
    v: 4, kind: "mb", id, to: b64url(8),
    sb: { id: b64url(8), dh: b64(91), kem: b64(1184), exp: Date.now() + 86_400_000, sig: b64(64) },
    spk: b64(91), e: b64(91), kct: b64(1088), c: b64(300),
    ...extra,
  };
}
const mbSet = (id: string, n: number) => ({ v: 4, kind: "mb-set", id, items: Array.from({ length: n }, () => mailboxItem(id)) });
const P3 = { iv: "aXYtYmFzZTY0", ciphertext: "Y2lwaGVydGV4dA==" };

let dir = "";
let store: AccountStore;
let queue: MemoryQueue;
let hub: SignalingHub;
let server: Server;
let base = "";
const clients: WsClient[] = [];

beforeEach(async () => {
  dir = mkdtempSync(joinPath(tmpdir(), "m5cet-relay-per-"));
  store = new AccountStore(dir);
  queue = new MemoryQueue();
  hub = new SignalingHub({
    accounts: store,
    queue: () => queue,
    storageFrame: (socket, _state, frame, send) => send(socket, { type: "storage-result", id: frame.id, ok: true }),
    newStorageState: () => ({ windowStart: Date.now(), count: 0 }),
    trustProxy: false,
  });
  server = createServer();
  hub.attach(server);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await hub.shutdown();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function account(name: string) {
  const credential: StoredCredential = { credentialId: `cred-${name}-000000000`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, alg: -7, signCount: 1 };
  const r = store.create(credential, name);
  if (!r.ok) throw new Error(r.reason);
  return { id: r.account.id, token: store.issueToken(r.account.id) };
}

async function join(room: string, name: string, auth?: string) {
  const c = await WsClient.connect(base);
  clients.push(c);
  const hello = await c.next("hello");
  c.send({ type: "join", protocol: 2, room, name, peerId: hello.peerId, ...(auth ? { auth, away: true } : {}) });
  const joined = await c.next("joined");
  return { c, peerId: String(joined.peerId) };
}

/** Signs in, joins, and goes away (the connection closes): the relay covers for them. */
async function away(room: string, name: string) {
  const acc = account(name);
  const first = await join(room, name, acc.token);
  await first.c.close();
  await new Promise((r) => setTimeout(r, 30));
  expect(hub.relay.isAway(acc.id, room)).toBe(true);
  return { ...acc, ref: accountRef(room, acc.id) };
}

/* ---------------------------------------------------------------- frames */

describe("the relay frame's `per`", () => {
  const frame = (f: Record<string, unknown>) => parseFrame(JSON.stringify({ type: "relay", messageId: "m-1", ...f }));

  it("keeps an envelope per recipient in `to`, drops references outside it, and needs no `envelope` when every recipient has one", () => {
    const set = mbSet("m-1", 2);
    const parsed = frame({ to: ["ref-a", "ref-b"], per: { "ref-a": set, "ref-b": P3, "ref-x": P3 } });
    expect(isFrameError(parsed)).toBe(false);
    expect(parsed).toMatchObject({ type: "relay", to: ["ref-a", "ref-b"], per: { "ref-a": set, "ref-b": P3 } });
    expect((parsed as { per: Record<string, unknown> }).per["ref-x"]).toBeUndefined();
    expect((parsed as { envelope?: unknown }).envelope).toBeUndefined();
    // A recipient without its own envelope needs `envelope`.
    expect(frame({ to: ["ref-a", "ref-b"], per: { "ref-a": set } })).toMatchObject({ code: "invalid-frame" });
    expect(frame({ to: ["ref-a", "ref-b"], per: { "ref-a": set }, envelope: P3 })).toMatchObject({ envelope: P3, per: { "ref-a": set } });
    // The old frame is unchanged.
    expect(frame({ to: ["ref-a"], envelope: P3 })).toEqual({ type: "relay", messageId: "m-1", to: ["ref-a"], envelope: P3 });
  });

  it("a reference named __proto__ is only ever an own key", () => {
    const raw = (per: string) => `{"type":"relay","messageId":"m-1","to":["__proto__"],"per":${per}}`;
    const parsed = parseFrame(raw(`{"__proto__":${JSON.stringify(P3)}}`)) as { per: Record<string, unknown> };
    expect(Object.getPrototypeOf(parsed.per)).toBeNull();
    expect(Object.hasOwn(parsed.per, "__proto__")).toBe(true);
    expect(parseFrame(raw(`{"other":${JSON.stringify(P3)}}`))).toMatchObject({ code: "invalid-frame" });
  });

  it("accepts a protocol-4 envelope in place of `envelope` too", () => {
    const item = mailboxItem("m-1");
    expect(frame({ to: ["ref-a"], envelope: item })).toMatchObject({ envelope: item });
  });

  it("rebuilds protocol-4 envelopes from validated fields only", () => {
    const item = mailboxItem("m-1", { sacc: { apk: b64(32), ac: b64(64), cv: 2, exp: 123, junk: "x" }, extra: "planted", __proto__x: 1 });
    const out = parseP4Envelope(item)!;
    expect(out).not.toHaveProperty("extra");
    expect(out.sacc).toEqual({ apk: (item.sacc as { apk: string }).apk, ac: (item.sacc as { ac: string }).ac, cv: 2, exp: 123 });
    expect(Object.keys(out)).toEqual(["v", "kind", "id", "to", "sb", "spk", "sacc", "e", "kct", "c"]);
    const set = parseP4Envelope({ ...mbSet("m-2", 1), more: 1 })!;
    expect(Object.keys(set)).toEqual(["v", "kind", "id", "items"]);
  });

  it("refuses bad shapes and sizes", () => {
    const bad: Array<[string, unknown]> = [
      ["unknown kind", { v: 4, kind: "other", id: "m" }],
      ["mb without kct", { ...mailboxItem("m-1"), kct: undefined }],
      ["mb with a non-base64 c", { ...mailboxItem("m-1"), c: "not base64 !" }],
      ["a bundle without exp", { ...mailboxItem("m-1"), sb: { ...mailboxItem("m-1").sb, exp: "soon" } }],
      ["a kem too long", { ...mailboxItem("m-1"), kct: b64(1300) }],
      ["an empty mb-set", { v: 4, kind: "mb-set", id: "m", items: [] }],
      ["too many devices", mbSet("m-1", MB_SET_MAX_ITEMS + 1)],
      ["an item of another kind in a set", { v: 4, kind: "mb-set", id: "m", items: [{ ...mailboxItem("m"), kind: "mb-set" }] }],
      ["sacc with another cert version", { ...mailboxItem("m-1"), sacc: { apk: b64(32), ac: b64(64), cv: 3 } }],
      ["a huge c", { ...mailboxItem("m-1"), c: "A".repeat(130_000) }],
    ];
    for (const [why, envelope] of bad) {
      expect(parseP4Envelope(envelope), why).toBeNull();
      expect(frame({ to: ["ref-a"], per: { "ref-a": envelope } }), why).toMatchObject({ code: "invalid-frame" });
    }
    expect(frame({ to: ["ref-a"], per: "nope", envelope: P3 })).toMatchObject({ code: "invalid-frame" });
    expect(frame({ to: ["ref-a"], per: { "not a ref!": P3 }, envelope: P3 })).toMatchObject({ code: "invalid-frame" });
    expect(frame({ to: ["ref-a"], per: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`r-${i}`, P3])), envelope: P3 })).toMatchObject({ code: "invalid-frame" });
  });
});

/* ------------------------------------------------------------- the hub */

describe("relay per recipient on the hub", () => {
  it("stores each recipient's own envelope; the others get `envelope`; receipts route back as before", async () => {
    const room = `per-${Date.now()}`;
    const alice = await away(room, "Alice");
    const carol = await away(room, "Carol");
    const bob = await join(room, "Bob");

    const set = mbSet("msg-1", 3);
    bob.c.send({ type: "relay", messageId: "msg-1", to: [alice.ref, carol.ref], per: { [alice.ref]: set }, envelope: P3 });
    const statuses = [await bob.c.next("relay-status"), await bob.c.next("relay-status")];
    expect(statuses.map((s) => s.state)).toEqual(["stored", "stored"]);

    expect(queue.pending(alice.id, room)[0].envelope).toEqual(set);
    expect(queue.pending(carol.id, room)[0].envelope).toEqual(P3);

    // Alice comes back: her own envelope, exactly; her acknowledgement turns delivered for Bob.
    const a2 = await join(room, "Alice", alice.token);
    const delivery = await a2.c.next("relay-deliver");
    const items = delivery.items as Array<{ id: string; messageId: string; envelope: unknown }>;
    expect(items).toEqual([expect.objectContaining({ messageId: "msg-1", envelope: set })]);
    a2.c.send({ type: "relay-ack", ids: items.map((i) => i.id) });
    expect(await bob.c.next("relay-status")).toMatchObject({ messageId: "msg-1", state: "delivered", recipient: { account: alice.ref } });
    a2.c.send({ type: "receipt", messageIds: ["msg-1"], state: "read" });
    expect(await bob.c.next("relay-status")).toMatchObject({ messageId: "msg-1", state: "read" });

    const c2 = await join(room, "Carol", carol.token);
    const theirs = await c2.c.next("relay-deliver");
    expect((theirs.items as Array<{ envelope: unknown }>)[0].envelope).toEqual(P3);
  });

  it("needs no `envelope` when every recipient has its own", async () => {
    const room = `per-only-${Date.now()}`;
    const alice = await away(room, "Alice");
    const bob = await join(room, "Bob");
    const item = mailboxItem("msg-2");
    bob.c.send({ type: "relay", messageId: "msg-2", to: [alice.ref], per: { [alice.ref]: item } });
    expect(await bob.c.next("relay-status")).toMatchObject({ state: "stored" });
    expect(queue.pending(alice.id, room)[0].envelope).toEqual(item);
  });

  it("applies the size limit per item: one recipient's oversized envelope is refused, the other's stored", async () => {
    const room = `per-size-${Date.now()}`;
    const alice = await away(room, "Alice");
    const carol = await away(room, "Carol");
    const bob = await join(room, "Bob");
    const huge = { iv: "aXYtYmFzZTY0", ciphertext: "A".repeat(135_000) };
    bob.c.send({ type: "relay", messageId: "msg-3", to: [alice.ref, carol.ref], per: { [alice.ref]: huge }, envelope: P3 });
    const statuses = [await bob.c.next("relay-status"), await bob.c.next("relay-status")];
    const byRef = Object.fromEntries(statuses.map((s) => [(s.recipient as { account: string }).account, s]));
    expect(byRef[alice.ref]).toMatchObject({ state: "rejected", reason: "too large" });
    expect(byRef[carol.ref]).toMatchObject({ state: "stored" });
    expect(queue.pending(alice.id, room)).toHaveLength(0);
    expect(queue.pending(carol.id, room)).toHaveLength(1);
  });

  it("a reference outside the room gets the same generic answer, with or without `per`", async () => {
    const room = `per-foreign-${Date.now()}`;
    const bob = await join(room, "Bob");
    const stranger = account("Stranger");
    const foreign = accountRef("another-room", stranger.id);
    bob.c.send({ type: "relay", messageId: "msg-4", to: [foreign], per: { [foreign]: mailboxItem("msg-4") } });
    expect(await bob.c.next("relay-status")).toMatchObject({ state: "rejected", reason: "not reachable" });
  });
});
