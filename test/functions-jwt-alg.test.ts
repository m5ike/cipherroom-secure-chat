// @vitest-environment node
// m5.crypto.jwt.verify and algorithm confusion (6.7, audit S2). The token's
// header picked the algorithm; with "HS256" the PEM public key became the
// HMAC secret, so anyone holding the public key forged tokens that a model
// verifying RS256/ES256 (without opts.alg) accepted. The key now decides the
// family: a PEM key never verifies HS*, an EC key only its curve's ES*, and
// a shared secret only HS*.

import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { hostCrypto } from "../server/functions/host-crypto";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPub = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;
const rsaPriv = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecPub = ec.publicKey.export({ type: "spki", format: "pem" }) as string;
const ecPriv = ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/** A token "signed" with HS256 using the public key text as the secret. */
function forgeHs(alg: "HS256" | "HS512", secret: string, payload: Record<string, unknown>): string {
  const input = `${b64({ alg, typ: "JWT" })}.${b64(payload)}`;
  return `${input}.${createHmac(alg === "HS256" ? "sha256" : "sha512", secret).update(input).digest("base64url")}`;
}

describe("S2 — JWT verification is bound to the key's algorithm family", () => {
  it("refuses an HS256 token forged with the RSA public key as the secret", async () => {
    const forged = forgeHs("HS256", rsaPub, { sub: "admin" });
    await expect(hostCrypto("jwt.verify", [forged, rsaPub])).rejects.toThrow(/cannot be verified with this rsa key/);
    await expect(hostCrypto("jwt.verify", [forged, rsaPub, {}])).rejects.toThrow();
    // The same with an EC key, and with HS512.
    await expect(hostCrypto("jwt.verify", [forgeHs("HS512", ecPub, { sub: "admin" }), ecPub])).rejects.toThrow(/ec key/);
  });

  it("still verifies RS256, PS256 and ES256 with the matching public key", async () => {
    for (const alg of ["RS256", "PS256"]) {
      const tok = await hostCrypto("jwt.sign", [{ payload: { sub: alg }, key: rsaPriv, alg }]) as string;
      expect((await hostCrypto("jwt.verify", [tok, rsaPub]) as { sub: string }).sub).toBe(alg);
    }
    const es = await hostCrypto("jwt.sign", [{ payload: { sub: "ec" }, key: ecPriv, alg: "ES256" }]) as string;
    expect((await hostCrypto("jwt.verify", [es, ecPub]) as { sub: string }).sub).toBe("ec");
  });

  it("an EC key verifies only its curve's ES algorithm", async () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const tok = await hostCrypto("jwt.sign", [{ payload: { a: 1 }, key: p384.privateKey.export({ type: "pkcs8", format: "pem" }), alg: "ES384" }]) as string;
    expect(await hostCrypto("jwt.verify", [tok, p384.publicKey.export({ type: "spki", format: "pem" })])).toMatchObject({ a: 1 });
    // A header claiming ES256 over a P-384 key is refused before verifying.
    const [, p, s] = tok.split(".");
    await expect(hostCrypto("jwt.verify", [`${b64({ alg: "ES256" })}.${p}.${s}`, p384.publicKey.export({ type: "spki", format: "pem" })])).rejects.toThrow(/ES256/);
  });

  it("a shared secret verifies HS only, and opts.alg / opts.algorithms still pin", async () => {
    const tok = await hostCrypto("jwt.sign", [{ payload: { sub: "1" }, secret: "k", alg: "HS256" }]) as string;
    expect((await hostCrypto("jwt.verify", [tok, "k"]) as { sub: string }).sub).toBe("1");
    expect((await hostCrypto("jwt.verify", [tok, "k", { algorithms: ["HS256", "HS512"] }]) as { sub: string }).sub).toBe("1");
    await expect(hostCrypto("jwt.verify", [tok, "k", { alg: "HS512" }])).rejects.toThrow(/unexpected alg/);
    const rs = await hostCrypto("jwt.sign", [{ payload: { sub: "1" }, key: rsaPriv, alg: "RS256" }]) as string;
    await expect(hostCrypto("jwt.verify", [rs, "a-shared-secret"])).rejects.toThrow(/needs a public key/);
    await expect(hostCrypto("jwt.verify", [`${b64({ alg: "none" })}.${b64({ a: 1 })}.`, "k"])).rejects.toThrow(/unsupported alg/);
  });
});
