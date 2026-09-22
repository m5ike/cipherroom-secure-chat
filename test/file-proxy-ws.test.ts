// @vitest-environment node
//
// The server relay for file transfers, over a real socket. Proxy mode used
// to forward only the end frame: the recipient never saw the meta or the
// chunks, so a file sent this way could not arrive at all. It also carries
// the receiver's request to repeat chunks that went missing.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  const base = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp";
  process.env.ACCOUNTS_DIR = `${base}/m5cet-ws-proxy-${process.pid}-${Date.now()}`;
  process.env.DATA_DIR = process.env.ACCOUNTS_DIR;
});

import express from "express";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage/service";
import { WsClient } from "./helpers/ws-client";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
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

async function join(room: string, name: string) {
  const client = await WsClient.connect(base);
  const hello = await client.next("hello");
  client.send({ type: "join", room, peerId: String(hello.peerId), name });
  await client.next("joined");
  return client;
}

describe("file transfer through the server relay", () => {
  it("forwards meta, chunks and the end frame to the other side", async () => {
    const room = `proxy-${Date.now()}`;
    const sender = await join(room, "Alice");
    const receiver = await join(room, "Bob");

    const transferId = "xfer-proxy-1";
    sender.send({ type: "proxy-meta", kind: "proxy-meta", transferId, iv: "aXY=", ciphertext: "bWV0YQ==" });
    expect(await sender.next("proxy-ack")).toMatchObject({ transferId, accepted: true });

    const meta = await receiver.next("proxy-meta");
    expect(meta).toMatchObject({ transferId, ciphertext: "bWV0YQ==" });

    sender.send({ type: "proxy-chunk", kind: "proxy-chunk", transferId, seq: 0, iv: "aXY=", ciphertext: "Y2h1bmsw" });
    sender.send({ type: "proxy-chunk", kind: "proxy-chunk", transferId, seq: 1, iv: "aXY=", ciphertext: "Y2h1bmsx" });
    expect(await receiver.next("proxy-chunk")).toMatchObject({ seq: 0, ciphertext: "Y2h1bmsw" });
    expect(await receiver.next("proxy-chunk")).toMatchObject({ seq: 1, ciphertext: "Y2h1bmsx" });

    sender.send({ type: "proxy-end", kind: "proxy-end", transferId });
    expect(await receiver.next("proxy-end")).toMatchObject({ transferId });

    // The ciphertext is opaque to the server and comes through untouched.
    expect(receiver.seen("proxy-chunk").every((f) => String(f.ciphertext).length === 8)).toBe(true);

    await Promise.all([sender.close(), receiver.close()]);
  });

  it("carries a request to repeat lost chunks back to the sender", async () => {
    const room = `proxy-need-${Date.now()}`;
    const sender = await join(room, "Alice");
    const receiver = await join(room, "Bob");

    const transferId = "xfer-proxy-2";
    sender.send({ type: "proxy-meta", kind: "proxy-meta", transferId, iv: "aXY=", ciphertext: "bWV0YQ==" });
    await receiver.next("proxy-meta");

    receiver.send({ type: "proxy-need", transferId, seqs: [2, 7] });  // the app omits `kind` here
    expect(await sender.next("proxy-need")).toMatchObject({ transferId, seqs: [2, 7] });

    // Junk requests go nowhere.
    receiver.send({ type: "proxy-need", transferId, seqs: ["nope"] });
    expect(await sender.none("proxy-need")).toBe(true);

    await Promise.all([sender.close(), receiver.close()]);
  });
});
