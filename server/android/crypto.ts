// The Android framework's cryptography (6.0), server side. The formats are
// specified in docs/android-architecture.md §1 and mirrored byte for byte by
// the app (android/app/src/main/java/cz/m5cet/app/security/Wire.java).
//
//   P1363 signatures   ECDSA P-256 / SHA-256, r‖s (64 bytes), base64 — the
//                      same shape WebCrypto produces for the chat.
//   ECIES              an ephemeral P-256 key, ECDH with the device's key,
//                      HKDF-SHA256, AES-256-GCM with the purpose as AAD.
//   M5PK               the plain container of a build (path → bytes).
//   M5AB               the encrypted, signed bundle a device installs:
//                      256 KiB AES-256-GCM segments, a signed header, and a
//                      wrapped content key per recipient device.

import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign as nodeSign, verify as nodeVerify, type KeyObject,
} from "node:crypto";

export const ECIES_LABEL = "m5cet/android/ecies/1";
export const BUNDLE_MAGIC = Buffer.from("M5AB", "ascii");
export const CONTAINER_MAGIC = Buffer.from("M5PK", "ascii");
export const SEGMENT = 256 * 1024;

const utf8 = (s: string) => Buffer.from(s, "utf8");
export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
export const unb64 = (s: string) => Buffer.from(s, "base64");
export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

/* ------------------------------------------------------------------ keys */

/** A P-256 public key from its SPKI (base64). Throws on anything else. */
export function publicKeyOf(spkiB64: string): KeyObject {
  const key = createPublicKey({ key: unb64(spkiB64), format: "der", type: "spki" });
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "ec" || details?.namedCurve !== "prime256v1") throw new Error("not a P-256 key");
  return key;
}

export const spkiOf = (key: KeyObject): string => b64(key.export({ format: "der", type: "spki" }) as Buffer);

/** Short stable id of a public key: base64url(SHA-256(SPKI)), 16 characters (as identity.ts keyId). */
export const kidOf = (spkiB64: string): string => b64url(sha256(unb64(spkiB64))).slice(0, 16);

/** Grouped hex of the key hash, for a person to compare (as identity.ts keyFingerprint). */
export function fingerprintOf(spkiB64: string): string {
  return sha256(unb64(spkiB64)).subarray(0, 16).toString("hex").toUpperCase().match(/.{4}/g)!.join(" ");
}

export function newP256(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

export const privateKeyFromPem = (pem: string): KeyObject => createPrivateKey(pem);

/* ------------------------------------------------------------ signatures */

export function signP1363(privateKey: KeyObject, data: Uint8Array | string): string {
  return b64(nodeSign("sha256", typeof data === "string" ? utf8(data) : data, { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

export function verifyP1363(publicKey: KeyObject | string, data: Uint8Array | string, signatureB64: string): boolean {
  try {
    const key = typeof publicKey === "string" ? publicKeyOf(publicKey) : publicKey;
    const sig = unb64(signatureB64);
    if (sig.length !== 64) return false;
    return nodeVerify("sha256", typeof data === "string" ? utf8(data) : data, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- ECIES */

export type EciesWire = { e: string; iv: string; ct: string };

function eciesKey(shared: Buffer, purpose: string, deviceId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, utf8(ECIES_LABEL), utf8(`${purpose}|${deviceId}`), 32));
}

/** Encrypts for one device: only the holder of its encryption key opens it. */
export function eciesSeal(deviceEncKey: string, deviceId: string, purpose: string, plaintext: Uint8Array): EciesWire {
  const recipient = publicKeyOf(deviceEncKey);
  const eph = newP256();
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = eciesKey(shared, purpose, deviceId);
  shared.fill(0);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(utf8(`${ECIES_LABEL}|${purpose}|${deviceId}`));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  key.fill(0);
  return { e: spkiOf(eph.publicKey), iv: b64(iv), ct: b64(ct) };
}

/** The device's side (the app does this in Java); here for tests and tools. */
export function eciesOpen(devicePrivateKey: KeyObject, deviceId: string, purpose: string, wire: EciesWire): Buffer {
  const shared = diffieHellman({ privateKey: devicePrivateKey, publicKey: publicKeyOf(wire.e) });
  const key = eciesKey(shared, purpose, deviceId);
  shared.fill(0);
  return gcmOpen(key, unb64(wire.iv), unb64(wire.ct), utf8(`${ECIES_LABEL}|${purpose}|${deviceId}`));
}

function gcmOpen(key: Buffer, iv: Buffer, ctAndTag: Buffer, aad: Buffer): Buffer {
  if (ctAndTag.length < 16) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16));
  return Buffer.concat([decipher.update(ctAndTag.subarray(0, ctAndTag.length - 16)), decipher.final()]);
}

/* ------------------------------------------------------------- container */

export type ContainerEntry = [path: string, data: Buffer];

/** "M5PK" | u8 1 | u32 count | (u16 pathLen | path | u32 len | data)* */
export function packContainer(entries: ContainerEntry[]): Buffer {
  const parts: Buffer[] = [CONTAINER_MAGIC, Buffer.from([1])];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length);
  parts.push(count);
  const seen = new Set<string>();
  for (const [path, data] of entries) {
    if (!/^[A-Za-z0-9._\-/]{1,200}$/.test(path) || path.includes("..") || path.startsWith("/")) throw new Error(`bad path in the container: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate path in the container: ${path}`);
    seen.add(path);
    const p = utf8(path);
    const head = Buffer.alloc(2 + p.length + 4);
    head.writeUInt16BE(p.length, 0);
    p.copy(head, 2);
    head.writeUInt32BE(data.length, 2 + p.length);
    parts.push(head, data);
  }
  return Buffer.concat(parts);
}

export function unpackContainer(buf: Buffer): ContainerEntry[] {
  if (buf.length < 9 || !buf.subarray(0, 4).equals(CONTAINER_MAGIC) || buf[4] !== 1) throw new Error("not an M5PK container");
  const count = buf.readUInt32BE(5);
  const out: ContainerEntry[] = [];
  let at = 9;
  for (let i = 0; i < count; i++) {
    if (at + 2 > buf.length) throw new Error("truncated container");
    const pl = buf.readUInt16BE(at); at += 2;
    const path = buf.subarray(at, at + pl).toString("utf8"); at += pl;
    if (at + 4 > buf.length) throw new Error("truncated container");
    const len = buf.readUInt32BE(at); at += 4;
    if (at + len > buf.length) throw new Error("truncated container");
    out.push([path, Buffer.from(buf.subarray(at, at + len))]);
    at += len;
  }
  if (at !== buf.length) throw new Error("trailing bytes in the container");
  return out;
}

/* ---------------------------------------------------------------- bundle */

export type BundleMeta = { id: string; number: number; version: string; channel: string; created: number; minAppCode: number };
export type BundleRecipient = { device: string } & EciesWire;
export type BundleHeader = BundleMeta & {
  size: number; sha256: string; seg: number; segments: number; ctSha256: string; kid: string; sig: string; recipients: BundleRecipient[];
};

export function bundleSignedString(h: Omit<BundleHeader, "sig" | "recipients" | "kid">): string {
  return ["m5bundle/1", h.id, h.number, h.version, h.channel, h.created, h.minAppCode, h.size, h.sha256, h.seg, h.segments, h.ctSha256].join("|");
}

const segmentAad = (id: string, i: number, last: boolean) => utf8(`m5bundle/1|${id}|${i}|${last ? "1" : "0"}`);

/** Encrypts and signs a build. The content key comes back to be kept
 *  (sealed) by the server: it is wrapped for each device on download. */
export function sealBundle(meta: BundleMeta, plaintext: Buffer, signer: { privateKey: KeyObject; kid: string }, seg = SEGMENT): { header: BundleHeader; body: Buffer; cek: Buffer } {
  const cek = randomBytes(32);
  const segments = Math.max(1, Math.ceil(plaintext.length / seg));
  const parts: Buffer[] = [];
  for (let i = 0; i < segments; i++) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", cek, iv);
    cipher.setAAD(segmentAad(meta.id, i, i === segments - 1));
    parts.push(iv, cipher.update(plaintext.subarray(i * seg, (i + 1) * seg)), cipher.final(), cipher.getAuthTag());
  }
  const body = Buffer.concat(parts);
  const unsigned = { ...meta, size: plaintext.length, sha256: b64(sha256(plaintext)), seg, segments, ctSha256: b64(sha256(body)) };
  const header: BundleHeader = { ...unsigned, kid: signer.kid, sig: signP1363(signer.privateKey, bundleSignedString(unsigned)), recipients: [] };
  return { header, body, cek };
}

/** The file a device downloads: magic, header (with its recipients), segments. */
export function bundleFile(header: BundleHeader, body: Buffer): Buffer {
  const json = utf8(JSON.stringify(header));
  const lead = Buffer.alloc(9);
  BUNDLE_MAGIC.copy(lead, 0);
  lead[4] = 1;
  lead.writeUInt32BE(json.length, 5);
  return Buffer.concat([lead, json, body]);
}

export function parseBundleFile(buf: Buffer): { header: BundleHeader; body: Buffer } {
  if (buf.length < 9 || !buf.subarray(0, 4).equals(BUNDLE_MAGIC) || buf[4] !== 1) throw new Error("not an M5AB bundle");
  const n = buf.readUInt32BE(5);
  if (n > 4 * 1024 * 1024 || 9 + n > buf.length) throw new Error("bad bundle header");
  const header = JSON.parse(buf.subarray(9, 9 + n).toString("utf8")) as BundleHeader;
  return { header, body: buf.subarray(9 + n) };
}

export function wrapBundleKey(cek: Buffer, header: Pick<BundleHeader, "id">, device: { id: string; encKey: string }): BundleRecipient {
  return { device: device.id, ...eciesSeal(device.encKey, device.id, `bundle|${header.id}`, cek) };
}

export function verifyBundleHeader(header: BundleHeader, serverKey: KeyObject | string): boolean {
  return verifyP1363(serverKey, bundleSignedString(header), header.sig);
}

/** Decrypts the segments with the content key, checking every hash on the way. */
export function openBundleBody(header: BundleHeader, body: Buffer, cek: Buffer): Buffer {
  if (!sha256(body).equals(unb64(header.ctSha256))) throw new Error("bundle ciphertext hash mismatch");
  const out: Buffer[] = [];
  let at = 0;
  for (let i = 0; i < header.segments; i++) {
    const last = i === header.segments - 1;
    const plainLen = last ? header.size - header.seg * (header.segments - 1) : header.seg;
    if (plainLen < 0) throw new Error("bad bundle segmentation");
    const iv = body.subarray(at, at + 12);
    const ct = body.subarray(at + 12, at + 12 + plainLen + 16);
    at += 12 + plainLen + 16;
    out.push(gcmOpen(cek, iv, ct, segmentAad(header.id, i, last)));
  }
  if (at !== body.length) throw new Error("bundle has trailing bytes");
  const plain = Buffer.concat(out);
  if (!sha256(plain).equals(unb64(header.sha256))) throw new Error("bundle content hash mismatch");
  return plain;
}

/** What a device does: verify, unwrap its key, decrypt. */
export function openBundleFile(file: Buffer, device: { id: string; privateKey: KeyObject }, serverKey: KeyObject | string): { header: BundleHeader; plaintext: Buffer } {
  const { header, body } = parseBundleFile(file);
  if (!verifyBundleHeader(header, serverKey)) throw new Error("bundle signature is not valid");
  const mine = header.recipients.find((r) => r.device === device.id);
  if (!mine) throw new Error("bundle is not encrypted for this device");
  const cek = eciesOpen(device.privateKey, device.id, `bundle|${header.id}`, mine);
  try {
    return { header, plaintext: openBundleBody(header, body, cek) };
  } finally {
    cek.fill(0);
  }
}

/* --------------------------------------------------------------- releases */

export type ReleaseSigned = { id: string; versionCode: number; versionName: string; packageName: string; apkSha256: string; certSha256: string; size: number };

export const releaseSignedString = (r: ReleaseSigned): string =>
  ["m5release/1", r.id, r.versionCode, r.versionName, r.packageName, r.apkSha256, r.certSha256, r.size].join("|");

/* ------------------------------------------------------- device requests */

export const requestSignedString = (method: string, pathAndQuery: string, time: string, nonce: string, body: Uint8Array): string =>
  ["m5android/1", method.toUpperCase(), pathAndQuery, time, nonce, b64(sha256(body))].join("|");

export const enrollSignedString = (signKey: string, encKey: string, time: number | string): string =>
  ["m5android/enroll/1", signKey, encKey, time].join("|");

export const pushSignedString = (deviceId: string, id: string, w: EciesWire): string =>
  ["m5push/1", deviceId, id, w.e, w.iv, w.ct].join("|");
