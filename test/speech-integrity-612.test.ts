// @vitest-environment node
// 6.12 (F-29): offline speech models are native files the engine parses in
// the server process. A download must match an operator pin
// (SPEECH_MODEL_PINS) or, without one, the hash recorded at the first
// download; every load re-hashes the files against the (MACed) manifest.
// Served from a local HTTP server — no internet.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

const DATA = mkdtempSync(join(tmpdir(), "m5speechint-"));
process.env.DATA_DIR = DATA;
process.env.STORAGE_MASTER_KEY = Buffer.alloc(32, 21).toString("hex");

const L = await import("../server/ai/local-speech");
const I = await import("../server/ai/speech-integrity");
const ID = "piper-cs_CZ-jirka-medium";
const ROOT = join(DATA, "ai", "speech-models");

let server: Server;
let base = "";
const archives: Record<string, Buffer> = {};

/** A release archive shaped like sherpa-onnx's Piper voices (one top folder). */
function makeArchive(name: string, onnx: string): Buffer {
  const work = mkdtempSync(join(tmpdir(), "m5speechrel-"));
  const top = join(work, "vits-piper-test");
  mkdirSync(join(top, "espeak-ng-data", "voices"), { recursive: true });
  writeFileSync(join(top, "cs_CZ-test.onnx"), onnx);
  writeFileSync(join(top, "tokens.txt"), "a 1\nb 2\n");
  writeFileSync(join(top, "espeak-ng-data", "phontab"), "phonemes");
  writeFileSync(join(top, "espeak-ng-data", "voices", "cs"), "voice");
  execFileSync("tar", ["-cjf", join(work, name), "-C", work, "vits-piper-test"]);
  return readFileSync(join(work, name));
}

beforeAll(async () => {
  archives["v1.tar.bz2"] = makeArchive("v1.tar.bz2", "ONNX-GRAPH-ONE");
  archives["v2.tar.bz2"] = makeArchive("v2.tar.bz2", "ONNX-GRAPH-TWO");
  server = createServer((req, res) => {
    const body = archives[(req.url ?? "").slice(1)];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { server?.close(); delete process.env.SPEECH_MODEL_PINS; rmSync(DATA, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.SPEECH_MODEL_PINS; });

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function install(file: string): Promise<{ state: string; error?: string }> {
  const def = L.LOCAL_MODEL.get(ID)! as { url: string };
  const real = def.url;
  def.url = `${base}/${file}`;
  try {
    const job = L.install(ID);
    for (let i = 0; i < 200 && job.state !== "done" && job.state !== "failed"; i++) await new Promise((r) => setTimeout(r, 25));
    return job;
  } finally { def.url = real; }
}

describe("offline speech model integrity", () => {
  it("records the archive and every file at the first download, and verifies them on load", async () => {
    const job = await install("v1.tar.bz2");
    expect(job.error ?? null).toBeNull();
    expect(job.state).toBe("done");
    const rec = I.readManifest(ROOT)[ID];
    expect(rec).toMatchObject({ archive: sha(archives["v1.tar.bz2"]), source: "first-download" });
    expect(Object.keys(rec.files).sort()).toEqual(["cs_CZ-test.onnx", "espeak-ng-data/phontab", "espeak-ng-data/voices/cs", "tokens.txt"]);
    expect(await L.verifyModel(ID)).toBe("verified");
    const st = await L.status();
    expect(st.models.find((m) => m.id === ID)?.integrity).toMatchObject({ source: "first-download", files: 4 });
  });

  it("refuses a model whose file was changed, or that got an extra file", async () => {
    const onnx = join(ROOT, ID, "cs_CZ-test.onnx");
    const good = readFileSync(onnx);
    appendFileSync(onnx, "-PATCHED");
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/cs_CZ-test\.onnx changed/) });
    writeFileSync(onnx, good);
    writeFileSync(join(ROOT, ID, "espeak-ng-data", "evil.so"), "x");
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/evil\.so added/) });
    rmSync(join(ROOT, ID, "espeak-ng-data", "evil.so"));
    expect(await L.verifyModel(ID)).toBe("verified");
  });

  it("a manifest edited outside the server (without the master key) is refused", async () => {
    const file = I.manifestPath(ROOT);
    const saved = readFileSync(file, "utf8");
    const m = JSON.parse(saved) as { models: Record<string, { files: Record<string, string> }> };
    m.models[ID].files["cs_CZ-test.onnx"] = "0".repeat(64);
    writeFileSync(file, JSON.stringify(m));
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/does not verify against the storage master key/) });
    writeFileSync(file, saved);
    expect(await L.verifyModel(ID)).toBe("verified");
  });

  it("a later download that differs from the first one is refused (trust on first download)", async () => {
    L.uninstall(ID);
    const job = await install("v2.tar.bz2");
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/differs from the one recorded at its first download/);
    // The same release again is fine.
    const again = await install("v1.tar.bz2");
    expect(again.state).toBe("done");
  });

  it("an operator pin wins: a matching archive installs as pinned, another is refused", async () => {
    L.uninstall(ID);
    process.env.SPEECH_MODEL_PINS = `${ID}=${sha(archives["v2.tar.bz2"])}`;
    const refused = await install("v1.tar.bz2");
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/does not match its pinned SHA-256/);
    const ok = await install("v2.tar.bz2");
    expect(ok.state).toBe("done");
    expect(I.readManifest(ROOT)[ID].source).toBe("pinned");
  });

  // 6.12 review S02: after the first start (the marker is set — models installed before 6.12 were recorded then,
  // test/speech-upgrade-612.test.ts), files without recorded hashes are no longer recorded at their next load (a
  // deleted manifest looked exactly like a model installed before 6.12) — the operator trusts them, or pins them.
  it("a model whose manifest was lost is refused until the operator trusts it", async () => {
    expect(I.integrityInitialised(ROOT)).toBe(true);
    rmSync(I.manifestPath(ROOT));
    expect(existsSync(join(ROOT, ID))).toBe(true);
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/no recorded hashes/) });
    expect(existsSync(I.manifestPath(ROOT))).toBe(false);
    // While models are installed and the manifest is gone, no download is trusted on first use either.
    expect(() => I.checkArchive(ROOT, "whisper-small", "c".repeat(64))).toThrow(/missing although models are installed/);
    // The console's "Trust installed files" (owner).
    expect(await L.trustModel(ID)).toEqual({ files: 4 });
    expect(I.readManifest(ROOT)[ID]).toMatchObject({ source: "operator", archive: "" });
    expect(await L.verifyModel(ID)).toBe("verified");
  });

  it("an operator pin of the files (SPEECH_MODEL_PINS id=files:<digest>) vouches for them at every load", async () => {
    const files = await I.hashTree(join(ROOT, ID));
    const digest = I.treeDigest(files);
    rmSync(I.manifestPath(ROOT));
    process.env.SPEECH_MODEL_PINS = `${ID}=files:${digest}`;
    expect(I.pinnedFilesDigest(ID)).toBe(digest);
    expect(I.pinnedArchiveHash(ID)).toBeNull();
    expect(await L.verifyModel(ID)).toBe("recorded");
    expect(I.readManifest(ROOT)[ID]).toMatchObject({ source: "pinned-files" });
    expect(await L.verifyModel(ID)).toBe("verified");
    // A changed file fails the pin even though the manifest could be rewritten to match.
    const onnx = join(ROOT, ID, "cs_CZ-test.onnx");
    const good = readFileSync(onnx);
    appendFileSync(onnx, "-PATCHED");
    await expect(L.verifyModel(ID)).rejects.toMatchObject({ code: "integrity", message: expect.stringMatching(/operator pin/) });
    writeFileSync(onnx, good);
    expect(await L.verifyModel(ID)).toBe("verified");
  });
});
