// @vitest-environment node
// Full crypto and codes (4.15, stage 4): JWT, OpenPGP, OpenSSH keys and 2D/bar
// codes, exercised through a real sandbox run (the libraries run host-side).

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_DB_FILE = join(mkdtempSync(join(tmpdir(), "m5cc-")), "functions.db");
process.env.FUNCTIONS_WARM = "0";

const { runAdhoc, closeRunner } = await import("../server/functions/runner");
const { functionsStore } = await import("../server/functions/store");
const { hostCrypto } = await import("../server/functions/host-crypto");
const { hostCode } = await import("../server/functions/host-codes");

const SSH_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFSwOFJKH1JERgOEx34Hf4EW83WUgRszhDRto/w49E3I fixture@m5cet";
const caller = { kind: "console" as const, account: "", name: "t", groups: [], room: null, client: "c", lang: "cs", tz: "UTC" };

afterAll(() => closeRunner());

describe("host-crypto directly", () => {
  it("JWT HS256 signs, verifies and rejects a wrong secret", async () => {
    const tok = await hostCrypto("jwt.sign", [{ payload: { sub: "1" }, secret: "k", alg: "HS256" }]) as string;
    expect(tok.split(".").length).toBe(3);
    expect((await hostCrypto("jwt.verify", [tok, "k"]) as { sub: string }).sub).toBe("1");
    await expect(hostCrypto("jwt.verify", [tok, "wrong"])).rejects.toThrow();
  });
  it("SSH fingerprints an OpenSSH public key", async () => {
    const fp = await hostCrypto("ssh.fingerprint", [{ key: SSH_PUB }]) as string;
    expect(fp).toMatch(/^SHA256:/);
    const parsed = await hostCrypto("ssh.parse", [{ key: SSH_PUB }]) as { type: string; fingerprintSha256: string };
    expect(parsed.type).toBe("ed25519");
  });
  it("renders a QR and a Data Matrix as SVG", async () => {
    const qr = await hostCode({ type: "qr", text: "hi" });
    expect(String(qr.svg)).toMatch(/^<svg/);
    const dm = await hostCode({ type: "datamatrix", text: "M5" });
    expect(String(dm.svg)).toMatch(/^<svg/);
  });
});

describe("through the sandbox", () => {
  it("does a PGP roundtrip and a JWT from a function", async () => {
    const code = `
export async function execute() {
  const kp = await m5.crypto.pgp.generateKey({ name: 'T', email: 't@x.cz' });
  const enc = await m5.crypto.pgp.encrypt({ text: 'secret', publicKey: kp.publicKey });
  const dec = await m5.crypto.pgp.decrypt({ message: enc, privateKey: kp.privateKey });
  const tok = await m5.crypto.jwt.sign({ payload: { a: 1 }, secret: 's' });
  const back = await m5.crypto.jwt.verify(tok, 's');
  const qr = await m5.codes.qr('x');
  return m5.out.json({ pgp: dec === 'secret', armored: enc.startsWith('-----BEGIN PGP MESSAGE-----'), jwt: back.a, qr: qr.svg.startsWith('<svg') });
}`;
    const r = await runAdhoc({ lang: "js", files: { "index.js": code }, entry: { file: "index.js", fn: "execute" }, inputs: {}, limits: { wallMs: 15000 } }, caller);
    expect(r.run.status).toBe("done");
    expect((r.value as { value: { pgp: boolean; armored: boolean; jwt: number; qr: boolean } }).value).toEqual({ pgp: true, armored: true, jwt: 1, qr: true });
  }, 30_000);
});
