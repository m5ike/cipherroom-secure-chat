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

const SELF_CONTAINED = new Set(["hello", "inputs", "log", "session-cache", "codes", "python"]);
const caller = { kind: "console" as const, account: "", name: "t", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

describe("tutorial lessons run", () => {
  for (const lesson of LESSONS.filter((l) => SELF_CONTAINED.has(l.id))) {
    it(`"${lesson.title}" runs and meets its check`, async () => {
      const file = lesson.lang === "py" ? "main.py" : "index.js";
      const r = await runAdhoc({ lang: lesson.lang, files: { [file]: lesson.sample }, entry: { file, fn: "execute" }, inputs: lesson.inputs ?? {}, limits: { wallMs: 20000 } }, caller);
      expect(r.run.status).toBe("done");
      if (lesson.expect) {
        const text = r.outputs.map((o) => (o as { text?: string; value?: unknown }).text ?? ((o as { value?: unknown }).value !== undefined ? JSON.stringify((o as { value: unknown }).value) : "")).join(" ");
        expect(text).toContain(lesson.expect);
      }
    }, 30_000);
  }
});
