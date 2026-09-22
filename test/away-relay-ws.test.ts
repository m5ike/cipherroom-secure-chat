// @vitest-environment node
//
// The away relay over the real signaling socket (server/routes.ts +
// server/accounts/relay.ts): a signed-in user who loses their connection
// stays in the room as away, the server takes the ciphertext others send
// them, answers "stored", and hands everything over — with the delivery and
// read receipts the senders expect — when the user comes back.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-ws-relay-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
  process.env.WEBAUTHN_RP_ID = "localhost";
});

import express from "express";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage/service";
import { accountStore } from "../server/accounts/store";
import { FakeAuthenticator } from "./helpers/authenticator";
import { WsClient, type Frame } from "./helpers/ws-client";

let server: Server;
let base = "";

const ENVELOPE = { iv: "aXYtYmFzZTY0", ciphertext: "Y2lwaGVydGV4dA==" };

beforeAll(async () => {
  const app = express();
  app.use("/api/account/vault", express.json({ limit: "8mb" }));
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  // registerRoutes opened the storage; give the databases back.
  storage.close();
  rmSync(process.env.ACCOUNTS_DIR!, { recursive: true, force: true });
});

/** Registers a passkey account through the HTTP API, as the browser would. */
async function account(userName: string) {
  const auth = new FakeAuthenticator("localhost", "http://localhost");
  const options = await (await fetch(`${base}/api/account/register/options`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userName }),
  })).json() as { publicKey: { challenge: string } };
  const r = await (await fetch(`${base}/api/account/register/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: auth.register(options.publicKey.challenge) }),
  })).json() as { ok: boolean; token: string; account: { id: string } };
  expect(r.ok).toBe(true);
  return { token: r.token, accountId: r.account.id, userName };
}

async function join(room: string, name: string, opts: { auth?: string; away?: boolean } = {}) {
  const client = await WsClient.connect(base);
  const hello = await client.next("hello");
  client.send({ type: "join", room, peerId: String(hello.peerId), name, ...(opts.auth ? { auth: opts.auth } : {}), ...(opts.away ? { away: true } : {}) });
  const joined = await client.next("joined");
  return { client, peerId: String(joined.peerId), joined };
}

describe("away relay", () => {
  it("carries a message to a user whose connection went away, and reports back", async () => {
    const alice = await account("Alice");
    const room = `relay-${Date.now()}`;

    // Alice is signed in and asks the server to cover for her.
    const a1 = await join(room, "Alice", { auth: alice.token, away: true });
    expect(a1.joined.account).toMatchObject({ id: alice.accountId, away: true });

    const bob = await join(room, "Bob");
    expect((bob.joined.peers as Array<{ accountId?: string }>)[0]).toMatchObject({ accountId: alice.accountId });

    // Her tab closes: the room sees her leave, then go away.
    await a1.client.close();
    await bob.client.next("peer-left");
    const away = await bob.client.next("peer-away");
    expect(away).toMatchObject({ accountId: alice.accountId, name: "Alice" });

    // Bob writes anyway; the server answers on her behalf.
    bob.client.send({ type: "relay", messageId: "msg-1", to: [alice.accountId], envelope: ENVELOPE });
    const stored = await bob.client.next("relay-status");
    expect(stored).toMatchObject({ messageId: "msg-1", state: "stored", recipient: { accountId: alice.accountId, name: "Alice" } });
    expect(accountStore.mailbox(alice.accountId, room)).toHaveLength(1);

    // She comes back: the room learns it, and her mailbox is handed over.
    const a2 = await join(room, "Alice", { auth: alice.token, away: true });
    expect(await bob.client.next("peer-back")).toMatchObject({ accountId: alice.accountId });
    const delivery = await a2.client.next("relay-deliver");
    const items = delivery.items as Array<{ id: string; messageId: string; envelope: typeof ENVELOPE; from: { name: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ messageId: "msg-1", envelope: ENVELOPE, from: { name: "Bob" } });

    // Her client decrypted them: acknowledge, and Bob's message turns delivered.
    a2.client.send({ type: "relay-ack", ids: items.map((i) => i.id) });
    expect(await bob.client.next("relay-status")).toMatchObject({ messageId: "msg-1", state: "delivered", recipient: { accountId: alice.accountId } });
    expect(accountStore.mailbox(alice.accountId, room)).toHaveLength(0);

    // …and when she reads it, so does the read receipt.
    a2.client.send({ type: "receipt", to: { peerId: bob.peerId }, messageIds: ["msg-1"], state: "read" });
    expect(await bob.client.next("relay-status")).toMatchObject({ messageId: "msg-1", state: "read" });

    const audit = accountStore.get(alice.accountId)!.audit.map((e) => e.kind);
    expect(audit).toEqual(expect.arrayContaining(["away", "relay-stored", "back", "relay-delivered"]));

    await Promise.all([a2.client.close(), bob.client.close()]);
  });

  it("lists away members in the joined frame so a newcomer can address them", async () => {
    const carol = await account("Carol");
    const room = `list-${Date.now()}`;
    const c1 = await join(room, "Carol", { auth: carol.token, away: true });
    await c1.client.close();
    await new Promise((r) => setTimeout(r, 50));

    const dave = await join(room, "Dave");
    expect(dave.joined.away).toEqual([{ accountId: carol.accountId, name: "Carol", since: expect.any(Number) }]);
    await dave.client.close();
  });

  it("refuses a relay to someone who is not away in the room", async () => {
    const erin = await account("Erin");
    const room = `refuse-${Date.now()}`;
    const frank = await join(room, "Frank");

    frank.client.send({ type: "relay", messageId: "nope-1", to: ["thisaccountdoesnotexist"], envelope: ENVELOPE });
    expect(await frank.client.next("relay-status")).toMatchObject({ messageId: "nope-1", state: "rejected" });

    // Erin has an account but never joined this room.
    frank.client.send({ type: "relay", messageId: "nope-2", to: [erin.accountId], envelope: ENVELOPE });
    const r = await frank.client.next("relay-status");
    expect(r).toMatchObject({ messageId: "nope-2", state: "rejected" });
    expect(String(r.reason)).toMatch(/not in this room/);

    frank.client.send({ type: "relay", messageId: "", to: [], envelope: null });
    expect((await frank.client.next("error")).message).toMatch(/relay/i);
    await frank.client.close();
  });

  it("does not make a user away when they disconnect on purpose or never asked for it", async () => {
    const gina = await account("Gina");
    const room = `explicit-${Date.now()}`;
    const watcher = await join(room, "Watcher");

    // Signed in, but away was not requested (chat kept only in this session).
    const plain = await join(room, "Gina", { auth: gina.token });
    await plain.client.close();
    await watcher.client.next("peer-left");
    expect(await watcher.client.none("peer-away")).toBe(true);
    expect(accountStore.isAway(gina.accountId, room)).toBe(false);

    // With away enabled but an explicit goodbye: still not away.
    const bye = await join(room, "Gina", { auth: gina.token, away: true });
    bye.client.send({ type: "leave", away: false });
    await watcher.client.next("peer-left");
    expect(await watcher.client.none("peer-away")).toBe(true);
    expect(accountStore.isAway(gina.accountId, room)).toBe(false);

    await Promise.all([bye.client.close(), watcher.client.close()]);
  });

  it("keeps a user present while another tab of the same account is open", async () => {
    const hana = await account("Hana");
    const room = `tabs-${Date.now()}`;
    const watcher = await join(room, "Watcher");
    const tab1 = await join(room, "Hana", { auth: hana.token, away: true });
    const tab2 = await join(room, "Hana", { auth: hana.token, away: true });

    await tab1.client.close();
    await watcher.client.next("peer-left");
    expect(await watcher.client.none("peer-away")).toBe(true);
    expect(accountStore.isAway(hana.accountId, room)).toBe(false);

    await tab2.client.close();
    expect(await watcher.client.next("peer-away")).toMatchObject({ accountId: hana.accountId });
    await watcher.client.close();
  });

  it("holds a receipt for a sender who is away, and delivers it when they return", async () => {
    const ivan = await account("Ivan");   // sender, signed in
    const jana = await account("Jana");   // recipient, signed in
    const room = `both-${Date.now()}`;

    const i1 = await join(room, "Ivan", { auth: ivan.token, away: true });
    const j1 = await join(room, "Jana", { auth: jana.token, away: true });
    await j1.client.close();
    await i1.client.next("peer-away");

    i1.client.send({ type: "relay", messageId: "msg-x", to: [jana.accountId], envelope: ENVELOPE });
    expect(await i1.client.next("relay-status")).toMatchObject({ state: "stored" });

    // Ivan leaves too, before Jana ever comes back.
    await i1.client.close();
    await new Promise((r) => setTimeout(r, 50));

    const j2 = await join(room, "Jana", { auth: jana.token, away: true });
    const items = (await j2.client.next("relay-deliver")).items as Array<{ id: string }>;
    j2.client.send({ type: "relay-ack", ids: items.map((i) => i.id) });
    await new Promise((r) => setTimeout(r, 100));

    // The "delivered" status waited in Ivan's own mailbox.
    const i2 = await join(room, "Ivan", { auth: ivan.token, away: true });
    const back = await i2.client.next("relay-deliver");
    const statuses = (back.items as Array<Frame & { kind: string; messageId: string; status?: { state: string } }>).filter((x) => x.kind === "status");
    expect(statuses[0]).toMatchObject({ messageId: "msg-x", status: { state: "delivered", recipientName: "Jana" } });

    await Promise.all([i2.client.close(), j2.client.close()]);
  });

  it("forwards to a signed-in peer who is present but has no direct channel", async () => {
    const kim = await account("Kim");
    const room = `forward-${Date.now()}`;
    const kimClient = await join(room, "Kim", { auth: kim.token, away: true });
    const leo = await join(room, "Leo");

    leo.client.send({ type: "relay", messageId: "msg-f", to: [kim.accountId], envelope: ENVELOPE });
    const delivered = await kimClient.client.next("relay-deliver");
    expect((delivered.items as Array<{ messageId: string }>)[0].messageId).toBe("msg-f");
    expect(await leo.client.next("relay-status")).toMatchObject({ messageId: "msg-f", state: "forwarded" });

    await Promise.all([kimClient.client.close(), leo.client.close()]);
  });
});
