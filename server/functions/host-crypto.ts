// Full crypto for functions (4.15, stage 4), host-side: JWT/JWS and X.509 on
// node:crypto, OpenPGP via openpgp, and OpenSSH keys via sshpk. The small,
// synchronous primitives (hash, hmac, AES-GCM, random) stay inside the sandbox
// (host-pure.ts); these need libraries or Node APIs, so they run here and the
// sandbox reaches them with `await m5.crypto.<area>.<op>(...)`.

import { createHmac, createSign, createVerify, createPrivateKey, createPublicKey, X509Certificate, timingSafeEqual, type KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";

export class CryptoError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CryptoError"; }
}
const bad = (m: string): never => { throw new CryptoError("bad-argument", m); };

const b64url = (b: Buffer): string => b.toString("base64url");
const unb64url = (s: string): Buffer => Buffer.from(s, "base64url");
const bytesOf = (v: unknown): Buffer | null => (v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string" ? Buffer.from((v as { $b: string }).$b, "base64") : null);
const asText = (v: unknown, what: string): string => { const b = bytesOf(v); return b ? b.toString("utf8") : typeof v === "string" ? v : bad(`${what} must be a string or bytes`); };

/* -------------------------------------------------------------- JWT / JWS */

const HMAC = { HS256: "sha256", HS384: "sha384", HS512: "sha512" } as const;
const RSA = { RS256: "RSA-SHA256", RS384: "RSA-SHA384", RS512: "RSA-SHA512", PS256: "RSA-SHA256", PS384: "RSA-SHA384", PS512: "RSA-SHA512" } as const;
const EC = { ES256: "sha256", ES384: "sha384", ES512: "sha512" } as const;

function jwtSign(spec: Record<string, unknown>): string {
  const alg = String(spec.alg ?? "HS256").toUpperCase();
  const payload = (spec.payload && typeof spec.payload === "object" ? { ...(spec.payload as object) } : bad("payload must be an object")) as Record<string, unknown>;
  if (spec.expiresInSec) payload.exp = Math.floor(Date.now() / 1000) + Number(spec.expiresInSec);
  if (spec.notBeforeSec) payload.nbf = Math.floor(Date.now() / 1000) + Number(spec.notBeforeSec);
  if (spec.issuedAt !== false && payload.iat === undefined) payload.iat = Math.floor(Date.now() / 1000);
  const header = { alg, typ: "JWT", ...(spec.header && typeof spec.header === "object" ? spec.header : {}) };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  let sig: Buffer;
  if (alg in HMAC) { sig = createHmac(HMAC[alg as keyof typeof HMAC], asText(spec.secret ?? spec.key, "secret")).update(signingInput).digest(); }
  else if (alg in RSA) { const s = createSign(RSA[alg as keyof typeof RSA]); s.update(signingInput); sig = s.sign({ key: createPrivateKey(asText(spec.key, "key")), ...(alg.startsWith("PS") ? { padding: 6, saltLength: 32 } : {}) }); }
  else if (alg in EC) { const s = createSign(EC[alg as keyof typeof EC]); s.update(signingInput); sig = s.sign({ key: createPrivateKey(asText(spec.key, "key")), dsaEncoding: "ieee-p1363" }); }
  else return bad(`unsupported alg ${alg}`);
  return `${signingInput}.${b64url(sig)}`;
}

function jwtDecode(token: string): { header: unknown; payload: unknown; signature: string } {
  const parts = String(token).split(".");
  if (parts.length !== 3) bad("not a JWT");
  try { return { header: JSON.parse(unb64url(parts[0]).toString("utf8")), payload: JSON.parse(unb64url(parts[1]).toString("utf8")), signature: parts[2] }; }
  catch { return bad("the JWT is malformed"); }
}

/** The curve each ES algorithm is defined for (RFC 7518 §3.4). */
const EC_CURVE: Record<string, string> = { ES256: "prime256v1", ES384: "secp384r1", ES512: "secp521r1" };

/**
 * The algorithms a key may verify (6.7, audit S2). The token's header names
 * its algorithm, so the key decides which family is acceptable: a PEM key or
 * certificate never as an HMAC secret (otherwise a token "signed" with HS256
 * and the public key as the secret verifies), an RSA key for RS/PS, an EC key
 * for the ES algorithm of its curve, and anything else is a shared secret for
 * HS only.
 */
function jwtAlgorithmsFor(keyText: string): { key: KeyObject | null; algs: Set<string> } {
  if (!/-----BEGIN [A-Z0-9 ]+-----/.test(keyText)) return { key: null, algs: new Set(Object.keys(HMAC)) };
  let key: KeyObject;
  try { key = createPublicKey(keyText); } catch (err) { throw new CryptoError("bad-argument", `the key is not a usable public key: ${(err as Error).message}`); }
  const type = key.asymmetricKeyType;
  if (type === "rsa") return { key, algs: new Set(Object.keys(RSA)) };
  if (type === "rsa-pss") return { key, algs: new Set(["PS256", "PS384", "PS512"]) };
  if (type === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve ?? "";
    return { key, algs: new Set(Object.keys(EC).filter((a) => EC_CURVE[a] === curve)) };
  }
  return { key, algs: new Set() };
}

function jwtVerify(token: string, keyOrSecret: unknown, opts: Record<string, unknown> = {}): unknown {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new CryptoError("invalid", "not a JWT");
  const [h, p, s] = parts;
  let header: { alg?: string };
  try { header = JSON.parse(unb64url(h).toString("utf8")) as { alg?: string }; } catch { throw new CryptoError("invalid", "the JWT is malformed"); }
  const alg = String(header.alg ?? "").toUpperCase();
  // The caller's choice first (opts.alg, or a list in opts.algorithms) …
  const wanted = [opts.alg, ...(Array.isArray(opts.algorithms) ? opts.algorithms : [])].filter(Boolean).map((a) => String(a).toUpperCase());
  if (wanted.length && !wanted.includes(alg)) throw new CryptoError("invalid", `unexpected alg ${alg}`);
  // … and always the key's family: the header alone never picks HMAC for a public key.
  const keyText = asText(keyOrSecret, "key");
  const allowed = jwtAlgorithmsFor(keyText);
  if (!(alg in HMAC) && !(alg in RSA) && !(alg in EC)) throw new CryptoError("invalid", `unsupported alg ${alg}`);
  if (!allowed.algs.has(alg)) {
    throw new CryptoError("invalid", allowed.key ? `alg ${alg} cannot be verified with this ${allowed.key.asymmetricKeyType ?? ""} key` : `alg ${alg} needs a public key (PEM), not a shared secret`);
  }
  const signingInput = `${h}.${p}`;
  const sig = unb64url(s);
  let ok = false;
  if (alg in HMAC) { const mac = createHmac(HMAC[alg as keyof typeof HMAC], keyText).update(signingInput).digest(); ok = sig.length === mac.length && timingSafeEqual(sig, mac); }
  else if (alg in RSA) { const v = createVerify(RSA[alg as keyof typeof RSA]); v.update(signingInput); ok = v.verify({ key: allowed.key!, ...(alg.startsWith("PS") ? { padding: 6, saltLength: 32 } : {}) }, sig); }
  else { const v = createVerify(EC[alg as keyof typeof EC]); v.update(signingInput); ok = v.verify({ key: allowed.key!, dsaEncoding: "ieee-p1363" }, sig); }
  if (!ok) throw new CryptoError("invalid", "the signature does not verify");
  const payload = JSON.parse(unb64url(p).toString("utf8")) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  const skew = Number(opts.clockToleranceSec ?? 0);
  if (typeof payload.exp === "number" && now > payload.exp + skew) throw new CryptoError("expired", "the token has expired");
  if (typeof payload.nbf === "number" && now + skew < payload.nbf) throw new CryptoError("not-yet-valid", "the token is not valid yet");
  if (opts.issuer && payload.iss !== opts.issuer) throw new CryptoError("invalid", "wrong issuer");
  if (opts.audience && payload.aud !== opts.audience) throw new CryptoError("invalid", "wrong audience");
  return payload;
}

/* --------------------------------------------------------------- X.509 */

function x509Parse(pem: unknown): Record<string, unknown> {
  let cert: X509Certificate;
  try { cert = new X509Certificate(asText(pem, "certificate")); } catch (err) { throw new CryptoError("invalid", `not a certificate: ${(err as Error).message}`); }
  return {
    subject: cert.subject, issuer: cert.issuer, serialNumber: cert.serialNumber,
    validFrom: cert.validFrom, validTo: cert.validTo,
    validFromMs: Date.parse(cert.validFrom), validToMs: Date.parse(cert.validTo),
    fingerprint256: cert.fingerprint256, fingerprint: cert.fingerprint,
    subjectAltName: cert.subjectAltName ?? null, keyUsage: cert.keyUsage ?? null,
    ca: cert.ca, publicKey: cert.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function x509Verify(pem: unknown, issuerPem: unknown): boolean {
  try {
    const cert = new X509Certificate(asText(pem, "certificate"));
    const issuer = new X509Certificate(asText(issuerPem, "issuer certificate"));
    return cert.verify(issuer.publicKey) && cert.checkIssued(issuer);
  } catch { return false; }
}

/* ----------------------------------------------------------------- PGP */

type Openpgp = typeof import("openpgp");
let pgpLib: Openpgp | null = null;
async function pgp(): Promise<Openpgp> { pgpLib ??= await import("openpgp"); return pgpLib; }

async function pgpEncrypt(spec: Record<string, unknown>): Promise<string> {
  const o = await pgp();
  const message = await o.createMessage({ text: asText(spec.text, "text") });
  const encryptionKeys = spec.publicKey ? await o.readKey({ armoredKey: asText(spec.publicKey, "publicKey") }) : undefined;
  const passwords = spec.password ? [asText(spec.password, "password")] : undefined;
  if (!encryptionKeys && !passwords) bad("give a publicKey or a password");
  return await o.encrypt({ message, ...(encryptionKeys ? { encryptionKeys } : {}), ...(passwords ? { passwords } : {}), format: "armored" } as never) as string;
}

async function pgpDecrypt(spec: Record<string, unknown>): Promise<string> {
  const o = await pgp();
  const message = await o.readMessage({ armoredMessage: asText(spec.message, "message") });
  let decryptionKeys;
  if (spec.privateKey) {
    const key = await o.readPrivateKey({ armoredKey: asText(spec.privateKey, "privateKey") });
    decryptionKeys = spec.passphrase ? await o.decryptKey({ privateKey: key, passphrase: asText(spec.passphrase, "passphrase") }) : key;
  }
  const passwords = spec.password ? [asText(spec.password, "password")] : undefined;
  const { data } = await o.decrypt({ message, ...(decryptionKeys ? { decryptionKeys } : {}), ...(passwords ? { passwords } : {}) });
  return String(data);
}

async function pgpSign(spec: Record<string, unknown>): Promise<string> {
  const o = await pgp();
  const key = await o.readPrivateKey({ armoredKey: asText(spec.privateKey, "privateKey") });
  const signingKeys = spec.passphrase ? await o.decryptKey({ privateKey: key, passphrase: asText(spec.passphrase, "passphrase") }) : key;
  const message = await o.createCleartextMessage({ text: asText(spec.text, "text") });
  return await o.sign({ message, signingKeys, format: "armored" } as never) as string;
}

async function pgpVerify(spec: Record<string, unknown>): Promise<{ verified: boolean; text: string }> {
  const o = await pgp();
  const verificationKeys = await o.readKey({ armoredKey: asText(spec.publicKey, "publicKey") });
  const message = await o.readCleartextMessage({ cleartextMessage: asText(spec.message, "message") });
  const result = await o.verify({ message, verificationKeys });
  let verified = false;
  try { await result.signatures[0]?.verified; verified = true; } catch { verified = false; }
  return { verified, text: String(result.data) };
}

async function pgpGenerate(spec: Record<string, unknown>): Promise<{ publicKey: string; privateKey: string; revocationCertificate: string }> {
  const o = await pgp();
  const type = String(spec.type ?? "ecc") as "ecc" | "rsa";
  const r = await o.generateKey({
    type,
    ...(type === "rsa" ? { rsaBits: Number(spec.bits) || 3072 } : { curve: (spec.curve as "curve25519") || "curve25519" }),
    userIDs: [{ name: String(spec.name ?? "M5cet"), email: spec.email ? String(spec.email) : undefined }],
    ...(spec.passphrase ? { passphrase: asText(spec.passphrase, "passphrase") } : {}),
    format: "armored",
  } as never);
  return { publicKey: r.publicKey, privateKey: r.privateKey, revocationCertificate: r.revocationCertificate };
}

/* ----------------------------------------------------------------- SSH */

type Sshpk = typeof import("sshpk");
let sshLib: Sshpk | null = null;
async function ssh(): Promise<Sshpk> { sshLib ??= (await import("sshpk")).default ?? (await import("sshpk")); return sshLib; }

async function sshParse(spec: Record<string, unknown>): Promise<Record<string, unknown>> {
  const s = await ssh();
  const text = asText(spec.key, "key");
  const isPrivate = /PRIVATE KEY/.test(text);
  const key = isPrivate ? s.parsePrivateKey(text, "auto") : s.parseKey(text, "auto");
  const pub = isPrivate ? (key as import("sshpk").PrivateKey).toPublic() : (key as import("sshpk").Key);
  return {
    type: key.type, size: key.size, comment: (key as { comment?: string }).comment ?? "",
    private: isPrivate,
    fingerprintSha256: pub.fingerprint("sha256").toString(),
    fingerprintMd5: pub.fingerprint("md5").toString(),
    openssh: pub.toString("ssh"),
    pem: pub.toString("pkcs8"),
  };
}

async function sshFingerprint(spec: Record<string, unknown>): Promise<string> {
  const s = await ssh();
  const text = asText(spec.key, "key");
  const key = /PRIVATE KEY/.test(text) ? s.parsePrivateKey(text, "auto").toPublic() : s.parseKey(text, "auto");
  return key.fingerprint(String(spec.hash ?? "sha256") as never).toString();
}

/* --------------------------------------------------------------- dispatch */

/** Runs one host-side crypto call ("jwt.sign", "pgp.encrypt", "ssh.parse", …). */
export async function hostCrypto(op: string, args: unknown[]): Promise<unknown> {
  const a0 = (args[0] ?? {}) as Record<string, unknown>;
  switch (op) {
    case "jwt.sign": return jwtSign(a0);
    case "jwt.verify": return jwtVerify(String(args[0]), args[1], (args[2] ?? {}) as Record<string, unknown>);
    case "jwt.decode": return jwtDecode(String(args[0]));
    case "x509.parse": return x509Parse(args[0]);
    case "x509.verify": return x509Verify(args[0], args[1]);
    case "pgp.encrypt": return pgpEncrypt(a0);
    case "pgp.decrypt": return pgpDecrypt(a0);
    case "pgp.sign": return pgpSign(a0);
    case "pgp.verify": return pgpVerify(a0);
    case "pgp.generateKey": return pgpGenerate(a0);
    case "ssh.parse": return sshParse(a0);
    case "ssh.fingerprint": return sshFingerprint(a0);
    default: throw new CryptoError("unknown-call", `m5.crypto: no such call "${op.slice(0, 40)}"`);
  }
}

export const CRYPTO_OPS = ["jwt.sign", "jwt.verify", "jwt.decode", "x509.parse", "x509.verify", "pgp.encrypt", "pgp.decrypt", "pgp.sign", "pgp.verify", "pgp.generateKey", "ssh.parse", "ssh.fingerprint"] as const;
