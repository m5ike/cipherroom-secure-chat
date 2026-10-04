// @vitest-environment node
// A run that read a card is not kept for a month (6.7, F-18). functions.db
// is not encrypted and keeps runs — inputs, outputs, logs — for
// FUNCTIONS_RUNS_DAYS (30): an e-ID read (name, birth date, photo) or an
// EMV report sat there in plaintext. Such a run is now marked sensitive and
// pruned after FUNCTIONS_NFC_RUN_HOURS (24); other runs are unchanged.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5nfcret-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { runAdhoc, closeRunner, runEvents, answerRun } = await import("../server/functions/runner");
const { functionsStore, nfcRunKeepMs } = await import("../server/functions/store");

const caller = { kind: "console" as const, account: "", name: "tester", groups: [], room: "r", client: "c", lang: "cs", tz: "UTC" };

beforeAll(() => functionsStore.ready());
afterAll(() => closeRunner());

function withDevice(answer: unknown): () => void {
  const onRun = (ev: { type?: string; runId?: string; interaction?: { id: string; kind: string } }) => {
    if (ev.type === "interaction" && ev.interaction?.kind === "nfc" && ev.runId) setTimeout(() => answerRun(ev.runId!, ev.interaction!.id, answer), 10);
  };
  runEvents.on("run", onRun);
  return () => runEvents.off("run", onRun);
}

describe("F-18 — runs that read a card are kept only briefly", () => {
  it("marks a run that read a card, prunes it after FUNCTIONS_NFC_RUN_HOURS, keeps an ordinary run", async () => {
    const off = withDevice({ status: "ok", card: { uid: "04A1B2C3", tech: "ntag21x", label: "NTAG 215" } });
    let cardRun = "";
    try {
      const r = await runAdhoc({ lang: "js", files: { "index.js": "export async function execute(){ const r = await m5.nfc.scan({ timeout: 5 }); m5.log.info('read', { uid: r.card.uid }); return m5.out.json(r); }" }, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 4000 } }, caller);
      expect(r.run.error).toBeNull();
      cardRun = r.run.id;
    } finally { off(); }
    const plain = await runAdhoc({ lang: "js", files: { "index.js": "export async function execute(){ return m5.out.text('hi'); }" }, entry: { file: "index.js", fn: "execute" }, inputs: {} }, caller);

    expect(functionsStore.run(cardRun)?.sensitive).toBe(true);
    expect(functionsStore.run(plain.run.id)?.sensitive).toBeUndefined();

    // A day later (the default 24 h): the card run and its logs are gone, the other stays.
    const now = Date.now() + nfcRunKeepMs() + 60_000;
    functionsStore.prune(now - 30 * 86_400_000, now);
    expect(functionsStore.run(cardRun)).toBeNull();
    expect(functionsStore.logs(cardRun, -1)).toEqual([]);
    expect(functionsStore.run(plain.run.id)).not.toBeNull();
  }, 30_000);

  it("FUNCTIONS_NFC_RUN_HOURS sets the window", () => {
    process.env.FUNCTIONS_NFC_RUN_HOURS = "2";
    try { expect(nfcRunKeepMs()).toBe(2 * 3_600_000); } finally { delete process.env.FUNCTIONS_NFC_RUN_HOURS; }
    expect(nfcRunKeepMs()).toBe(24 * 3_600_000);
  });
});
