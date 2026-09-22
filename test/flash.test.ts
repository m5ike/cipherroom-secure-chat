// The flash-message queue (client/src/lib/flash.ts): one notice on screen
// at a time, the rest waiting, a click bringing the next one up at once.

import { describe, it, expect, vi } from "vitest";
import { createFlashQueue, kindForText, FLASH_LIMITS, type FlashMessage } from "../client/src/lib/flash";

function harness(durationMs = 10_000) {
  let clock = 1_000;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  const queue = createFlashQueue({
    durationMs,
    now: () => clock,
    schedule: (fn, ms) => { const id = next++; timers.set(id, { fn, at: clock + ms }); return id; },
    cancel: (id) => { timers.delete(id); },
  });
  const seen: Array<{ current: string | null; queued: number }> = [];
  queue.subscribe((current, queued) => seen.push({ current: current?.text ?? null, queued }));
  const tick = (ms: number) => {
    clock += ms;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= clock) { timers.delete(id); entry.fn(); }
    }
  };
  return { queue, seen, tick, pending: () => timers.size };
}

describe("one at a time", () => {
  it("shows the first message and keeps the rest waiting", () => {
    const { queue } = harness();
    queue.push({ text: "první", kind: "system" });
    queue.push({ text: "druhá", kind: "system" });
    queue.push({ text: "třetí", kind: "system" });

    expect(queue.current()?.text).toBe("první");
    expect(queue.pending()).toBe(2);
  });

  it("moves on by itself after the configured time", () => {
    const { queue, tick } = harness(10_000);
    queue.push({ text: "první" });
    queue.push({ text: "druhá" });

    tick(9_000);
    expect(queue.current()?.text).toBe("první");
    tick(1_000);
    expect(queue.current()?.text).toBe("druhá");
    tick(10_000);
    expect(queue.current()).toBeNull();
    expect(queue.pending()).toBe(0);
  });

  it("a click takes the current one away and shows the next at once", () => {
    const { queue, tick } = harness();
    queue.push({ text: "první" });
    queue.push({ text: "druhá" });

    queue.dismiss();
    expect(queue.current()?.text).toBe("druhá");
    // …and the new one gets its full time, not what was left of the old.
    tick(9_500);
    expect(queue.current()?.text).toBe("druhá");
    tick(500);
    expect(queue.current()).toBeNull();
  });

  it("dismissing one that is still waiting just drops it", () => {
    const { queue } = harness();
    queue.push({ text: "první" });
    const second = queue.push({ text: "druhá" })!;
    queue.push({ text: "třetí" });

    queue.dismiss(second.id);
    expect(queue.current()?.text).toBe("první");
    expect(queue.pending()).toBe(1);
    queue.dismiss();
    expect(queue.current()?.text).toBe("třetí");
  });

  it("honours a per-message duration", () => {
    const { queue, tick } = harness(10_000);
    queue.push({ text: "krátká", durationMs: 2_000 });
    tick(2_000);
    expect(queue.current()).toBeNull();
  });
});

describe("what it refuses", () => {
  it("ignores an empty message and trims a long one", () => {
    const { queue } = harness();
    expect(queue.push({ text: "   " })).toBeNull();
    const long = queue.push({ text: "x".repeat(FLASH_LIMITS.maxTextChars + 50), detail: "y".repeat(500) })!;
    expect(long.text).toHaveLength(FLASH_LIMITS.maxTextChars);
    expect(long.detail).toHaveLength(FLASH_LIMITS.maxDetailChars);
  });

  it("keeps the newest when a backlog piles up", () => {
    const { queue } = harness();
    for (let i = 0; i < FLASH_LIMITS.maxQueue + 10; i++) queue.push({ text: `zpráva ${i}` });
    expect(queue.pending()).toBe(FLASH_LIMITS.maxQueue);
    // The first one is on screen and the queue holds the tail: of the 29
    // that piled up behind it, the oldest 9 went.
    queue.dismiss();
    expect(queue.current()?.text).toBe("zpráva 10");
  });
});

describe("subscribers", () => {
  it("hear the current message and how many are waiting", () => {
    const { queue, seen } = harness();
    expect(seen).toEqual([{ current: null, queued: 0 }]);
    queue.push({ text: "první" });
    queue.push({ text: "druhá" });
    expect(seen.at(-1)).toEqual({ current: "první", queued: 1 });
    queue.dismiss();
    expect(seen.at(-1)).toEqual({ current: "druhá", queued: 0 });
  });

  it("can unsubscribe, and stop clears everything", () => {
    const { queue } = harness();
    const listener = vi.fn();
    const off = queue.subscribe(listener);
    off();
    queue.push({ text: "první" });
    expect(listener).toHaveBeenCalledTimes(1); // only the initial call

    queue.stop();
    expect(queue.current()).toBeNull();
    expect(queue.push({ text: "po zastavení" })).toBeNull();
  });
});

describe("colouring a notice by what it says", () => {
  it("picks a kind from the words, in Czech and English", () => {
    expect(kindForText("Přenos selhal: chybí části")).toBe("error");
    expect(kindForText("A message could not be decrypted")).toBe("error");
    expect(kindForText("Spojení offline — auto-reconnect")).toBe("warning");
    expect(kindForText("Soubor doručen")).toBe("success");
    expect(kindForText("Něco úplně jiného")).toBe("system");
  });
});
