// What an uploaded APK is (6.0), read without the Android SDK:
//   - its SHA-256,
//   - the certificate it is signed with (APK Signature Scheme v3 or v2 block,
//     the first signer's first certificate → SHA-256 of its DER),
//   - package, versionCode, versionName and minSdkVersion from the binary
//     AndroidManifest.xml.
// The console fills a release from it and refuses an APK of another package
// or signed with another certificate than the releases before it.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export type ApkInfo = { sha256: string; size: number; certSha256: string; packageName: string; versionCode: number; versionName: string; minSdk: number };

const SIG_V2 = 0x7109871a;
const SIG_V3 = 0xf05368c0;

function eocd(buf: Buffer): { cdOffset: number; cdSize: number; entries: number } {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return { entries: buf.readUInt16LE(i + 10), cdSize: buf.readUInt32LE(i + 12), cdOffset: buf.readUInt32LE(i + 16) };
  }
  throw new Error("not a ZIP / APK file");
}

/** A length-prefixed (u32 LE) block at `at`: [start, end) of its content. */
function lp(buf: Buffer, at: number, end: number): [number, number] {
  if (at + 4 > end) throw new Error("truncated signing block");
  const len = buf.readUInt32LE(at);
  if (at + 4 + len > end) throw new Error("truncated signing block");
  return [at + 4, at + 4 + len];
}

export function apkCertificate(buf: Buffer): Buffer {
  const { cdOffset } = eocd(buf);
  if (cdOffset < 32 || buf.subarray(cdOffset - 16, cdOffset).toString("latin1") !== "APK Sig Block 42") throw new Error("the APK has no v2/v3 signature (sign it with apksigner)");
  const size = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - size - 8;
  if (start < 0) throw new Error("bad APK signing block");
  let at = start + 8;
  const end = cdOffset - 24;
  const found: Record<number, [number, number]> = {};
  while (at + 12 <= end) {
    const len = Number(buf.readBigUInt64LE(at));
    const id = buf.readUInt32LE(at + 8);
    found[id] = [at + 12, at + 8 + len];
    at += 8 + len;
  }
  const block = found[SIG_V3] ?? found[SIG_V2];
  if (!block) throw new Error("the APK has no v2/v3 signature (sign it with apksigner)");
  const [sStart, sEnd] = lp(buf, block[0], block[1]); // signers
  const [signerStart, signerEnd] = lp(buf, sStart, sEnd); // first signer
  const [sdStart, sdEnd] = lp(buf, signerStart, signerEnd); // signed data
  const [, digestsEnd] = lp(buf, sdStart, sdEnd); // digests
  const [certsStart, certsEnd] = lp(buf, digestsEnd, sdEnd); // certificates
  const [certStart, certEnd] = lp(buf, certsStart, certsEnd); // first certificate
  return buf.subarray(certStart, certEnd);
}

function zipEntry(buf: Buffer, name: string): Buffer {
  const { cdOffset, entries } = eocd(buf);
  let at = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad ZIP central directory");
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const entryName = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (entryName === name) {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("bad ZIP local header");
      const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(dataAt, dataAt + compSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 });
      throw new Error(`unsupported ZIP method ${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`the APK has no ${name}`);
}

/** The attributes of <manifest> and <uses-sdk> from Android's binary XML. */
export function manifestInfo(axml: Buffer): { packageName: string; versionCode: number; versionName: string; minSdk: number } {
  if (axml.readUInt16LE(0) !== 0x0003) throw new Error("not a binary AndroidManifest.xml");
  let strings: string[] = [];
  const out = { packageName: "", versionCode: 0, versionName: "", minSdk: 0 };
  let at = axml.readUInt16LE(2);
  while (at + 8 <= axml.length) {
    const type = axml.readUInt16LE(at);
    const headerSize = axml.readUInt16LE(at + 2);
    const size = axml.readUInt32LE(at + 4);
    if (size < 8 || at + size > axml.length) break;
    if (type === 0x0001) {
      const count = axml.readUInt32LE(at + 8);
      const flags = axml.readUInt32LE(at + 16);
      const stringsStart = axml.readUInt32LE(at + 20);
      const utf8 = (flags & 0x100) !== 0;
      strings = [];
      for (let i = 0; i < count; i++) {
        let p = at + stringsStart + axml.readUInt32LE(at + headerSize + i * 4);
        if (utf8) {
          const skip = (axml[p] & 0x80) ? 2 : 1; p += skip; // UTF-16 length
          let len = axml[p]; if (len & 0x80) { len = ((len & 0x7f) << 8) | axml[p + 1]; p += 2; } else p += 1;
          strings.push(axml.subarray(p, p + len).toString("utf8"));
        } else {
          let len = axml.readUInt16LE(p); if (len & 0x8000) { len = ((len & 0x7fff) << 16) | axml.readUInt16LE(p + 2); p += 4; } else p += 2;
          strings.push(axml.subarray(p, p + len * 2).toString("utf16le"));
        }
      }
    } else if (type === 0x0102) {
      const name = strings[axml.readUInt32LE(at + 20)] ?? "";
      const attrStart = axml.readUInt16LE(at + 24);
      const attrSize = axml.readUInt16LE(at + 26);
      const attrCount = axml.readUInt16LE(at + 28);
      for (let i = 0; i < attrCount; i++) {
        const a = at + 16 + attrStart + i * attrSize;
        const attr = strings[axml.readUInt32LE(a + 4)] ?? "";
        const raw = axml.readUInt32LE(a + 8);
        const dataType = axml[a + 15];
        const data = axml.readUInt32LE(a + 16);
        const text = raw !== 0xffffffff ? strings[raw] ?? "" : dataType === 0x03 ? strings[data] ?? "" : "";
        const int = dataType >= 0x10 && dataType <= 0x1f ? data | 0 : Number(text) || 0;
        if (name === "manifest") {
          if (attr === "package") out.packageName = text;
          else if (attr === "versionCode") out.versionCode = int;
          else if (attr === "versionName") out.versionName = text;
        } else if (name === "uses-sdk" && attr === "minSdkVersion") out.minSdk = int;
      }
    }
    at += size;
  }
  if (!out.packageName) throw new Error("AndroidManifest.xml without a package name");
  return out;
}

export function readApk(buf: Buffer): ApkInfo {
  const cert = apkCertificate(buf);
  const manifest = manifestInfo(zipEntry(buf, "AndroidManifest.xml"));
  return {
    sha256: createHash("sha256").update(buf).digest("hex"),
    size: buf.length,
    certSha256: createHash("sha256").update(cert).digest("hex"),
    ...manifest,
  };
}
