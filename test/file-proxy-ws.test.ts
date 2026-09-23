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
import { encodeChunk, FRAME_P2P_CHUNK, FRAME_PROXY_CHUNK } from "../client/src/lib/binary-frames";

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

async function join(room: string, name: string, features?: string[]) {
  const client = await WsClient.connect(base);
  const hello = await client.next("hello");
  client.send({ type: "join", room, peerId: String(hello.peerId), name, ...(features ? { features } : {}) });
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

  it("relays binary chunks as they came to a binary peer, and as JSON to an older one", async () => {
    const room = `proxy-bin-${Date.now()}`;
    const probe = await WsClient.connect(base);
    expect((await probe.next("hello")).features).toContain("bin");
    await probe.close();

    const sender = await join(room, "Alice", ["bin", "unknown-feature"]);
    const modern = await join(room, "Bob", ["bin"]);
    const older = await join(room, "Carol");

    const transferId = "xfer-proxy-bin";
    sender.send({ type: "proxy-meta", kind: "proxy-meta", transferId, iv: "aXY=", ciphertext: "bWV0YQ==" });
    expect(await sender.next("proxy-ack")).toMatchObject({ accepted: true });

    const iv = new Uint8Array(12).fill(9);
    const data = new Uint8Array(64).map((_, i) => i);
    const chunk = encodeChunk({ type: FRAME_PROXY_CHUNK, version: 3, transferId, seq: 4, iv, data });
    sender.sendBinary(chunk);

    const got = await modern.next("binary");
    expect(Buffer.compare(got.data as Buffer, Buffer.from(chunk))).toBe(0);
    expect(await older.next("proxy-chunk")).toMatchObject({
      transferId, seq: 4, v: 3, from: expect.any(String),
      iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(data).toString("base64"),
    });
    // Nothing comes back to the sender.
    expect(await sender.none("binary")).toBe(true);

    // A P2P chunk layout, or garbage, is refused rather than relayed.
    sender.sendBinary(encodeChunk({ type: FRAME_P2P_CHUNK, version: 3, transferId, seq: 5, iv, data }));
    expect(await sender.next("error")).toMatchObject({ code: "invalid-frame" });
    sender.sendBinary(new Uint8Array([1, 2, 3]));
    expect(await sender.next("error")).toMatchObject({ code: "invalid-frame" });
    expect(await modern.none("binary")).toBe(true);

    // A chunk for a transfer that never began is refused too.
    sender.sendBinary(encodeChunk({ type: FRAME_PROXY_CHUNK, version: 3, transferId: "xfer-nope", seq: 0, iv, data }));
    expect(await sender.next("error")).toMatchObject({ code: "proxy-refused" });

    await Promise.all([sender.close(), modern.close(), older.close()]);
  });
});
