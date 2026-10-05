// @vitest-environment node
//
// 6.12 review S02 — the upgrade path of the offline speech models: models
// that 6.11 installed (no manifest, no marker) keep working after the first
// 6.12 start with no operator action — recorded once as they are (trust on
// first use, audited) and a marker set in the storage directory, outside the
// models folder — while a manifest deleted later is refused as before.

import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "m5speechupg-"));
process.env.DATA_DIR = DATA;
process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 29).toString("hex");

const L = await import("../server/ai/local-speech");
const I = await import("../server/ai/speech-integrity");
const { audit } = await import("../server/monitor/audit");
const ROOT = join(DATA, "ai", "speech-models");
const ID = "piper-cs_CZ-jirka-medium";
const OTHER = "whisper-tiny";

afterAll(() => { rmSync(DATA, { recursive: true, force: true }); });

/** A model folder as 6.11 left it: unpacked files, no manifest anywhere. */
function installedBy611(id: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(ROOT, id, rel, ".."), { recursive: true });
    writeFileSync(join(ROOT, id, rel), text);
  }
}

describe("models installed by 6.11", () => {
  it("work after the first 6.12 start — recorded once, audited, the marker outside the models folder", async () => {
    installedBy611(ID, { "cs_CZ-test.onnx": "GRAPH-611", "tokens.txt": "a 1\n", "espeak-ng-data/phontab": "p" });
    installedBy611(OTHER, { "tiny-encoder.int8.onnx": "E", "tiny-decoder.int8.onnx": "D", "tiny-tokens.txt": "t" });
    expect(existsSync(I.manifestPath(ROOT))).toBe(false);
    expect(I.integrityInitialised(ROOT)).toBe(false);

    expect(await L.verifyModel(ID)).toBe("recorded");
    expect(I.integrityInitialised(ROOT)).toBe(true);
    expect(I.markerPath(ROOT).startsWith(join(DATA, "storage"))).toBe(true);
    const manifest = I.readManifest(ROOT);
    expect(manifest[ID]).toMatchObject({ source: "first-load", archive: "" });
    expect(manifest[OTHER]).toMatchObject({ source: "first-load" }); // every installed model at once
    expect(audit.recent({ event: "speech.integrity-initialised", limit: 5 })[0]).toMatchObject({ detail: { models: expect.arrayContaining([ID, OTHER]), trust: "first-use" } });

    // Loads after it are plain verifications; the console shows how they are vouched for.
    expect(await L.verifyModel(ID)).toBe("verified");
    expect(await L.verifyModel(OTHER)).toBe("verified");
    const st = await L.status();
    expect(st.models.find((m) => m.id === ID)?.integrity).toMatchObject({ source: "first-load", files: 3 });
    // A later start does not record anything again (the marker is there).
    expect(await I.initialiseIntegrity(ROOT, [{ id: ID, url: "x" }])).toBeNull();
  });

  it("a manifest deleted later is refused — deleting files in the models folder does not reset the marker", async () => {
    rmSync(I.manifestPath(ROOT));
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/no recorded hashes/) });
    expect(() => I.checkArchive(ROOT, ID, "d".repeat(64))).toThrow(/missing although models are installed/);
    expect(await I.initialiseIntegrity(ROOT, [{ id: ID, url: "x" }])).toBeNull();
    // Swapped as well: still refused; the operator's explicit action brings it back.
    writeFileSync(join(ROOT, ID, "cs_CZ-test.onnx"), "GRAPH-SWAPPED");
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity" });
    expect(await L.trustModel(ID)).toEqual({ files: 3 });
    expect(await L.verifyModel(ID)).toBe("verified");
  });
});

describe("a fresh server (no models)", () => {
  it("sets the marker at its first start: later downloads are first downloads, a lost manifest is noticed", async () => {
    const fresh = join(DATA, "other-root");
    expect(await I.initialiseIntegrity(fresh, [{ id: ID, url: "x" }])).toEqual({ recorded: [] });
    expect(I.integrityInitialised(fresh)).toBe(true);
    expect(I.checkArchive(fresh, ID, "e".repeat(64))).toBe("first-download");
  });
});
