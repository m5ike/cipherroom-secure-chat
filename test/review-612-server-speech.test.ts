// @vitest-environment node
//
// REVIEW 6.12 (server) — F-29, integrity of the offline speech models
// (ai/speech-integrity.ts). The stated attacker: "whoever can swap a model
// file cannot simply rewrite the manifest too" (it is MACed with a master-key
// subkey). That attacker can DELETE the manifest, though — and a model with
// no entry is trusted on first load. Secure behaviour asserted; failing tests
// are `it.skip` with a REVIEW-612 note.

import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "m5-review-speech-"));
process.env.DATA_DIR = DATA;
process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 23).toString("hex");

const I = await import("../server/ai/speech-integrity");
const ROOT = join(DATA, "speech-models");
const ID = "piper-test-voice";

afterAll(() => { rmSync(DATA, { recursive: true, force: true }); });

function installModel(onnx: string): void {
  rmSync(join(ROOT, ID), { recursive: true, force: true });
  mkdirSync(join(ROOT, ID), { recursive: true });
  writeFileSync(join(ROOT, ID, "voice.onnx"), onnx);
  writeFileSync(join(ROOT, ID, "tokens.txt"), "a 1\n");
}

describe("F-29 against someone who can write the models directory", () => {
  it("(baseline) a swapped model file is refused while the manifest exists", async () => {
    installModel("GENUINE-GRAPH");
    await I.recordInstall(ROOT, ID, "https://example.invalid/v1.tar.bz2", "a".repeat(64), 10, "first-download");
    writeFileSync(join(ROOT, ID, "voice.onnx"), "MALICIOUS-GRAPH");
    await expect(I.verifyInstalled(ROOT, ID, "https://example.invalid/v1.tar.bz2")).rejects.toThrow(/does not match/);
  });

  // REVIEW-612 S02 (fixed): delete manifest.json (same directory as the model files) → readManifest() returns {} → verifyInstalled()
  // records the swapped files as "first-load" and the engine parses them. The MAC only stops EDITS of the manifest.
  it("a swapped model file is still refused after the attacker deletes manifest.json", async () => {
    installModel("GENUINE-GRAPH");
    await I.recordInstall(ROOT, ID, "https://example.invalid/v1.tar.bz2", "a".repeat(64), 10, "first-download");
    writeFileSync(join(ROOT, ID, "voice.onnx"), "MALICIOUS-GRAPH");
    rmSync(I.manifestPath(ROOT));
    await expect(I.verifyInstalled(ROOT, ID, "https://example.invalid/v1.tar.bz2")).rejects.toThrow();
  });

  // REVIEW-612 S02 (download side, fixed): the "same as the first download" rule also lives only in that file.
  it("a re-download with another archive hash is refused after manifest.json was deleted", async () => {
    installModel("GENUINE-GRAPH");
    await I.recordInstall(ROOT, ID, "https://example.invalid/v1.tar.bz2", "a".repeat(64), 10, "first-download");
    rmSync(I.manifestPath(ROOT));
    expect(() => I.checkArchive(ROOT, ID, "b".repeat(64))).toThrow();
  });
});
