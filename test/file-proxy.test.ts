import { describe, expect, it, vi } from "vitest";
import { FileProxy, FILE_PROXY_MAX_BYTES, relayProxyFrame } from "../server/file-proxy";

describe("FileProxy", () => {
  function makeTransferId(seed: number): string {
    return `test-xfer-${seed}-${Math.random().toString(36).slice(2, 10)}`;
  }

  it("begins a transfer for valid metadata", () => {
    const proxy = new FileProxy();
    const id = makeTransferId(1);
    const r = proxy.begin("peer-A", { transferId: id, iv: "AAAA", ciphertext: "BBBB" }, 4096);
    expect(r.ok).toBe(true);
    expect(proxy.stats().totalActive).toBe(1);
  });

  it("rejects duplicate transfer IDs", () => {
    const proxy = new FileProxy();
    const id = makeTransferId(2);
    proxy.begin("peer-A", { transferId: id, iv: "AAAA", ciphertext: "BBBB" }, 4096);
    const r = proxy.begin("peer-A", { transferId: id, iv: "CCCC", ciphertext: "DDDD" }, 4096);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
  });

  it("enforces the per-sender cap", () => {
    const proxy = new FileProxy();
    for (let i = 0; i < 4; i += 1) {
      proxy.begin("peer-A", { transferId: makeTransferId(100 + i), iv: "i", ciphertext: "c" }, 1);
    }
    const r = proxy.begin("peer-A", { transferId: makeTransferId(105), iv: "i", ciphertext: "c" }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("per-peer-cap");
  });

  it("rejects files larger than MAX_BYTES", () => {
    const proxy = new FileProxy();
    const r = proxy.begin("peer-A", {
      transferId: makeTransferId(3),
      iv: "A", ciphertext: "B",
    }, FILE_PROXY_MAX_BYTES + 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too-large");
  });

  it("rejects invalid transfer IDs", () => {
    const proxy = new FileProxy();
    const r = proxy.begin("peer-A", { transferId: "x", iv: "A", ciphertext: "B" }, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid-id");
  });

  it("accepts chunk pushes for an existing transfer", () => {
    const proxy = new FileProxy();
    const id = makeTransferId(4);
    proxy.begin("peer-A", { transferId: id, iv: "A", ciphertext: "B" }, 4096);
    const r = proxy.pushChunk("peer-A", { transferId: id, seq: 0, iv: "A", ciphertext: "B" });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1);
  });

  it("rejects chunk push from wrong sender", () => {
    const proxy = new FileProxy();
    const id = makeTransferId(5);
    proxy.begin("peer-A", { transferId: id, iv: "A", ciphertext: "B" }, 4096);
    const r = proxy.pushChunk("peer-B", { transferId: id, seq: 0, iv: "A", ciphertext: "B" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong-sender");
  });

  it("cancels and frees the slot", () => {
    const proxy = new FileProxy();
    const id = makeTransferId(6);
    proxy.begin("peer-A", { transferId: id, iv: "A", ciphertext: "B" }, 4096);
    proxy.pushChunk("peer-A", { transferId: id, seq: 0, iv: "A", ciphertext: "B" });
    const r = proxy.cancel(id);
    expect(r.ok).toBe(true);
    expect(proxy.stats().totalActive).toBe(0);
  });

  it("relayProxyFrame dispatches begin / chunk / end by kind", () => {
    const proxy = new FileProxy();
    const forward = vi.fn();
    const id = makeTransferId(7);
    const beginR = relayProxyFrame(proxy, "peer-A", {
      kind: "proxy-meta",
      transferId: id,
      iv: "A",
      ciphertext: "B",
    }, forward);
    expect(beginR.ok).toBe(true);
    const pushR = relayProxyFrame(proxy, "peer-A", {
      kind: "proxy-chunk",
      transferId: id,
      seq: 0,
      iv: "A",
      ciphertext: "B",
    }, forward);
    expect(pushR.ok).toBe(true);
    const endR = relayProxyFrame(proxy, "peer-A", {
      kind: "proxy-end",
      transferId: id,
    }, forward);
    expect(endR.ok).toBe(true);
    expect(forward).toHaveBeenCalled();
  });
});
