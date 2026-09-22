// Messages waiting for a recipient who is not there yet
// (client/src/lib/outbox.ts). In light mode there is no server to hold
// them, so they wait here and are retried when a channel opens.

import { describe, it, expect, vi } from "vitest";
import { createOutbox, OUTBOX_LIMITS, type QueuedMessage } from "../client/src/lib/outbox";

type Env = { iv: string; ciphertext: string };

function entry(over: Partial<QueuedMessage<Env>> = {}) {
  return {
    messageId: over.messageId ?? "m1",
    room: "alpha",
    envelope: { iv: "aXY=", ciphertext: "Y3Q=" } as Env,
    targets: over.targets ?? [],
    toNames: over.toNames ?? [],
    createdAt: over.createdAt ?? 1_000,
    expiresAt: over.expiresAt ?? 0,
  };
}

describe("waiting for someone to come online", () => {
  it("keeps a message until a send succeeds, then lets it go", async () => {
    let open = false;
    const send = vi.fn(() => (open ? 1 : 0));
    const outbox = createOutbox<Env>(send);
    outbox.add(entry());

    expect((await outbox.flush(2_000)).failed).toEqual(["m1"]);
    expect(outbox.size()).toBe(1);
    expect(outbox.list()[0]).toMatchObject({ attempts: 1, lastAttemptAt: 2_000 });

    open = true;
    expect(await outbox.flush(3_000)).toEqual({ delivered: 1, failed: [] });
    expect(outbox.size()).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("carries what it needs to send again: room, targets and the sealed envelope", async () => {
    const seen: Array<QueuedMessage<Env>> = [];
    const outbox = createOutbox<Env>((e) => { seen.push(e); return 0; });
    outbox.add(entry({ messageId: "m7", targets: ["peer-a"], toNames: ["Alice"] }));
    await outbox.flush(2_000);

    expect(seen[0]).toMatchObject({
      messageId: "m7",
      room: "alpha",
      targets: ["peer-a"],
      toNames: ["Alice"],
      envelope: { ciphertext: "Y3Q=" },
    });
  });

  it("queues each message once", () => {
    const outbox = createOutbox<Env>(() => 0);
    outbox.add(entry({ messageId: "m1" }));
    outbox.add(entry({ messageId: "m1" }));
    expect(outbox.size()).toBe(1);
    expect(outbox.has("m1")).toBe(true);
  });

  it("survives a sender that throws", async () => {
    const outbox = createOutbox<Env>(() => { throw new Error("channel gone"); });
    outbox.add(entry());
    await expect(outbox.flush(2_000)).resolves.toMatchObject({ delivered: 0, failed: ["m1"] });
    expect(outbox.size()).toBe(1);
  });
});

describe("what it gives up on", () => {
  it("drops a message once its own lifetime ran out", async () => {
    const outbox = createOutbox<Env>(() => 0);
    outbox.add(entry({ messageId: "ttl", expiresAt: 5_000 }));
    await outbox.flush(4_000);
    expect(outbox.size()).toBe(1);
    await outbox.flush(5_001);
    expect(outbox.size()).toBe(0);
  });

  it("stops after enough attempts", async () => {
    const outbox = createOutbox<Env>(() => 0, { ...OUTBOX_LIMITS, maxAttempts: 3 });
    outbox.add(entry());
    for (let i = 0; i < 3; i++) await outbox.flush(2_000);
    expect(outbox.size()).toBe(1);
    await outbox.flush(2_000);          // the fourth pass finds it spent
    expect(outbox.size()).toBe(0);
  });

  it("stops after a day, and prune reports what went", () => {
    const outbox = createOutbox<Env>(() => 0);
    outbox.add(entry({ messageId: "old", createdAt: 0 }));
    outbox.add(entry({ messageId: "fresh", createdAt: OUTBOX_LIMITS.maxAgeMs }));
    expect(outbox.prune(OUTBOX_LIMITS.maxAgeMs + 1)).toEqual(["old"]);
    expect(outbox.size()).toBe(1);
  });

  it("refuses to grow without limit", () => {
    const outbox = createOutbox<Env>(() => 0, { ...OUTBOX_LIMITS, maxMessages: 2 });
    expect(outbox.add(entry({ messageId: "a" }))).not.toBeNull();
    expect(outbox.add(entry({ messageId: "b" }))).not.toBeNull();
    expect(outbox.add(entry({ messageId: "c" }))).toBeNull();
    expect(outbox.size()).toBe(2);
  });

  it("forgets a message the user took back, and can be emptied", () => {
    const outbox = createOutbox<Env>(() => 0);
    outbox.add(entry({ messageId: "a" }));
    outbox.add(entry({ messageId: "b" }));
    expect(outbox.remove("a")).toBe(true);
    expect(outbox.remove("a")).toBe(false);
    outbox.clear();
    expect(outbox.size()).toBe(0);
  });
});
