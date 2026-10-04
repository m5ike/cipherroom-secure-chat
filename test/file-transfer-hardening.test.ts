// 6.7 (audit S19, S20): a received file belongs to the peer that delivered it,
// and receiving files cannot exhaust this page's memory.
//
//   S19  the meta's senderId was taken as it was: a member could send a file
//        "from" another member — or from "system", drawn as the app's own
//        notice — and anyone could cancel, fill or end someone else's transfer.
//   S20  a meta could claim 2 M chunks (two arrays of 2 M slots), any number of
//        transfers could be open at once and stay open forever, received files
//        and messages were never let go.

import { describe, expect, it } from "vitest";
import {
  newIncomingRegistry, handleIncomingFrame, encryptBytes, encryptJSON, sweepIncoming, checkMeta,
  INCOMING_IDLE_MS, INCOMING_MAX_BYTES, MAX_INCOMING, MAX_TOTAL_CHUNKS,
  type FileTransferEnvelope, type IncomingCallbacks,
} from "../client/src/lib/file-transfer";
import { deriveRoomKey } from "../client/src/lib/crypto";
import { BLOB_BUDGET, rememberBlob } from "../client/src/lib/attachment-media";
import { capMessages, withReleasedFiles } from "../client/src/lib/memory-caps";

const key = await deriveRoomKey("hardening-room", "hardening-passphrase");

async function frames(transferId: string, senderId: string | undefined, body = new Uint8Array([1, 2, 3, 4])): Promise<FileTransferEnvelope[]> {
  const meta = await encryptJSON(key, { transferId, name: "a.bin", mime: "application/octet-stream", size: body.byteLength, totalChunks: 1, chunkSize: body.byteLength, ...(senderId !== undefined ? { senderId } : {}), senderName: "Alice", createdAt: Date.now() });
  return [
    { kind: "file-meta", transferId, transport: "p2p", ...meta },
    { kind: "file-chunk", transferId, seq: 0, transport: "p2p", ...(await encryptBytes(key, body)) },
    { kind: "file-end", transferId, transport: "p2p" },
  ];
}

function sink() {
  const errors: string[] = [];
  const done: Array<{ id: string; senderId: string }> = [];
  const cancelled: string[] = [];
  const cb: IncomingCallbacks = {
    onError: (_id, m) => errors.push(m),
    onComplete: (id, _b, meta) => done.push({ id, senderId: meta.senderId }),
    onCancel: (id) => cancelled.push(id),
  };
  return { errors, done, cancelled, cb };
}

describe("the file's sender is the peer that delivered it (S19)", () => {
  it("a meta naming another member than the channel's peer is refused", async () => {
    const reg = newIncomingRegistry();
    const s = sink();
    for (const f of await frames("x-spoof", "p-alice")) await handleIncomingFrame(key, reg, f, 1e9, s.cb, "p-mallory");
    expect(s.done).toEqual([]);
    expect(s.errors[0]).toMatch(/another sender/);
  });

  it("a meta naming an id the app keeps for itself is refused", async () => {
    const s = sink();
    for (const f of await frames("x-system", "system")) await handleIncomingFrame(key, newIncomingRegistry(), f, 1e9, s.cb);
    expect(s.done).toEqual([]);
    expect(s.errors[0]).toMatch(/no valid sender/);
  });

  it("the peer's own file arrives under its id (an older meta without a senderId too)", async () => {
    const s = sink();
    const reg = newIncomingRegistry();
    for (const f of await frames("x-ok", "p-alice")) await handleIncomingFrame(key, reg, f, 1e9, s.cb, "p-alice");
    for (const f of await frames("x-old", undefined)) await handleIncomingFrame(key, reg, f, 1e9, s.cb, "p-alice");
    expect(s.errors).toEqual([]);
    expect(s.done).toEqual([{ id: "x-ok", senderId: "p-alice" }, { id: "x-old", senderId: "p-alice" }]);
  });

  it("another member cannot cancel, fill or end someone else's transfer", async () => {
    const s = sink();
    const reg = newIncomingRegistry();
    const [meta, chunk, end] = await frames("x-victim", "p-alice");
    await handleIncomingFrame(key, reg, meta, 1e9, s.cb, "p-alice");
    await handleIncomingFrame(key, reg, { kind: "file-cancel", transferId: "x-victim", transport: "p2p" }, 1e9, s.cb, "p-mallory");
    await handleIncomingFrame(key, reg, { ...chunk, ...(await encryptBytes(key, new Uint8Array([9, 9, 9, 9]))) } as FileTransferEnvelope, 1e9, s.cb, "p-mallory");
    await handleIncomingFrame(key, reg, end, 1e9, s.cb, "p-mallory");
    expect(s.cancelled).toEqual([]);
    expect(reg.has("x-victim")).toBe(true);
    await handleIncomingFrame(key, reg, chunk, 1e9, s.cb, "p-alice");
    await handleIncomingFrame(key, reg, end, 1e9, s.cb, "p-alice");
    expect(s.done).toEqual([{ id: "x-victim", senderId: "p-alice" }]);
  });
});

describe("receiving cannot exhaust memory (S20)", () => {
  it("a meta is held to 2 GiB and a bounded number of chunks, whatever the user's limit says", () => {
    const meta = (size: number, chunkSize: number) => ({ transferId: "t", name: "n", mime: "x/y", size, chunkSize, totalChunks: Math.max(1, Math.ceil(size / chunkSize)), senderId: "p", senderName: "P", createdAt: 1 });
    expect(checkMeta(meta(INCOMING_MAX_BYTES + 1, 1024 * 1024), "t", Number.MAX_SAFE_INTEGER)).toMatch(/too large/);
    expect(typeof checkMeta(meta(INCOMING_MAX_BYTES, 32 * 1024), "t", Number.MAX_SAFE_INTEGER)).toBe("object"); // what the apps send
    expect(checkMeta(meta(MAX_TOTAL_CHUNKS + 1, 1), "t", Number.MAX_SAFE_INTEGER)).toBe("Too many chunks.");
    expect(MAX_TOTAL_CHUNKS).toBeLessThanOrEqual(128 * 1024);
  });

  it("only a few files arrive at once — per sender and in all", async () => {
    const s = sink();
    const reg = newIncomingRegistry();
    for (let i = 0; i <= MAX_INCOMING.perSender; i++) await handleIncomingFrame(key, reg, (await frames(`x-a${i}`, "p-a"))[0], 1e9, s.cb, "p-a");
    expect(reg.size).toBe(MAX_INCOMING.perSender);
    expect(s.errors).toEqual([expect.stringMatching(/Too many files/)]);
    for (let i = 0; reg.size < MAX_INCOMING.total; i++) await handleIncomingFrame(key, reg, (await frames(`x-o${i}`, `p-o${i}`))[0], 1e9, s.cb, `p-o${i}`);
    await handleIncomingFrame(key, reg, (await frames("x-late", "p-late"))[0], 1e9, s.cb, "p-late");
    expect(reg.has("x-late")).toBe(false);
  });

  it("a transfer that went quiet is dropped, freeing its slot", async () => {
    const s = sink();
    const reg = newIncomingRegistry();
    await handleIncomingFrame(key, reg, (await frames("x-stall", "p-a"))[0], 1e9, s.cb, "p-a");
    expect(sweepIncoming(reg, Date.now() + INCOMING_IDLE_MS - 1000, s.cb)).toEqual([]);
    expect(sweepIncoming(reg, Date.now() + INCOMING_IDLE_MS + 1000, s.cb)).toEqual(["x-stall"]);
    expect(reg.size).toBe(0);
    expect(s.errors).toEqual([expect.stringMatching(/stopped arriving/)]);
  });

  it("received files kept in memory stay within a budget; the oldest are released first", () => {
    const urls = Array.from({ length: 5 }, (_, i) => `blob:test/${i}`);
    const released = urls.flatMap((u) => rememberBlob(u, new Blob([new Uint8Array(10)]), { files: 3, bytes: 1000 }));
    expect(released).toEqual(["blob:test/0", "blob:test/1"]);
    expect(rememberBlob("blob:test/big", new Blob([new Uint8Array(5000)]), { files: 3, bytes: 1000 })).toEqual(urls.slice(2)); // the newest stays, however big
    expect(BLOB_BUDGET.bytes).toBeGreaterThan(0);
    const msgs = [{ id: "a", text: "", attachment: { kind: "file" as const, name: "f", mime: "x", size: 1, dataUrl: "blob:test/0" } }, { id: "b", text: "hi" }];
    expect(withReleasedFiles(msgs, ["blob:test/0"])[0].attachment).toMatchObject({ dataUrl: "", dropped: true, name: "f" });
  });

  it("the conversation keeps the newest messages within a count and a byte budget", () => {
    const list = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: "x".repeat(100) }));
    expect(capMessages(list, { messages: 4, bytes: 1e9 }).kept.map((m) => m.id)).toEqual(["6", "7", "8", "9"]);
    const byBytes = capMessages(list, { messages: 100, bytes: 1000 });
    expect(byBytes.kept.map((m) => m.id)).toEqual(["8", "9"]); // 356 bytes each (text + overhead): a third would pass 1000
    expect(byBytes.dropped).toHaveLength(8);
    expect(capMessages(list.slice(0, 3)).dropped).toEqual([]);
  });
});
