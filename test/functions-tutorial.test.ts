// @vitest-environment node
// The console tutorial (server/functions/tutorial.ts, 5.0): each self-contained
// lesson's sample actually runs and produces what it promises. Lessons that need
// the network (http), the AI module or an interactive caller (prompt) are left
// out here — those are covered by their own tests.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5tut-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { LESSONS } = await import("../server/functions/tutorial");
const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");

const SELF_CONTAINED = new Set(["hello", "inputs", "log", "session-cache", "codes", "python", "results", "buttons", "forms", "model", "browser", "results-py"]);
const caller = { kind: "console" as const, account: "", name: "t", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

describe("5.3 lessons: the entry points of a lesson work (a click, a reply, an error)", () => {
  const run = (id: string, fn: string, inputs: Record<string, unknown>, chainId?: string) => {
    const l = LESSONS.find((x) => x.id === id)!;
    const file = l.lang === "py" ? "main.py" : "index.js";
    return runAdhoc({ lang: l.lang, files: { [file]: l.sample }, entry: { file, fn }, inputs, chainId }, caller);
  };
  it("buttons: a click counts in the session", async () => {
    const r = await run("buttons", "execute", {});
    const b1 = await run("buttons", "button", { name: "count", data: { by: 1 } }, r.chain);
    const b2 = await run("buttons", "button", { name: "count", data: { by: 1 } }, r.chain);
    expect((b1.values[0] as { text: string }).text).toMatch(/Clicked \*\*1×\*\*/);
    expect((b2.values[0] as { text: string }).text).toMatch(/Clicked \*\*2×\*\* — this is call 2 \(the first was execute\)/);
  }, 60_000);
  it("model: a reply sees the first call", async () => {
    const r = await run("model", "execute", { topic: "DNS" });
    const a = await run("model", "response", { text: "tell me", message: { text: "", call: 0 } }, r.chain);
    expect((a.values[0] as { value: unknown }).value).toEqual({ youSaid: "tell me", firstTopic: "DNS", calls: ["execute", "response"] });
  }, 60_000);
  it("errors: the error function answers the failure", async () => {
    const r = await run("errors", "execute", {});
    expect(r.run.status).toBe("failed");
    expect(r.handled?.outputs[0]).toMatchObject({ type: "flash", text: "Sorry — the database is asleep. Try again later." });
  }, 60_000);
});

describe("tutorial lessons run", () => {
  for (const lesson of LESSONS.filter((l) => SELF_CONTAINED.has(l.id))) {
    it(`"${lesson.title}" runs and meets its check`, async () => {
      const file = lesson.lang === "py" ? "main.py" : "index.js";
      const r = await runAdhoc({ lang: lesson.lang, files: { [file]: lesson.sample }, entry: { file, fn: "execute" }, inputs: lesson.inputs ?? {}, limits: { wallMs: 20000 } }, caller);
      expect(r.run.status).toBe("done");
      expect(r.values.length).toBeGreaterThan(0);
      if (lesson.expect) {
        const text = r.outputs.map((o) => (o as { text?: string; value?: unknown }).text ?? ((o as { value?: unknown }).value !== undefined ? JSON.stringify((o as { value: unknown }).value) : "")).join(" ");
        expect(text).toContain(lesson.expect);
      }
    }, 30_000);
  }
});
