// The server's signing key for the mobile apps (Android 6.0, iOS 6.14): an
// ECDSA P-256 key that signs bundles, releases, device policies and control
// messages. signing.key (PKCS#8 PEM, 0600) in the Android folder, created on
// first use; ANDROID_SIGNING_KEY_FILE moves it. iOS uses the SAME key — the
// operator compares one fingerprint, whatever the phone — and every signed
// string names its device or build, so nothing signed for one platform's
// device verifies as another's (device ids are and_… and ios_…).

import { createPublicKey, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fingerprintOf, kidOf, newP256, privateKeyFromPem, spkiOf } from "./crypto";

export type MobileSigner = { privateKey: KeyObject; publicKey: string; kid: string; fingerprint: string };

let signer: MobileSigner | null = null;

/** Where the key lives: ANDROID_SIGNING_KEY_FILE, else signing.key in the Android data folder. */
export function mobileSigningKeyFile(): string {
  const explicit = process.env.ANDROID_SIGNING_KEY_FILE?.trim();
  if (explicit) return resolve(explicit);
  const dir = process.env.ANDROID_DATA_DIR?.trim()
    ? resolve(process.env.ANDROID_DATA_DIR.trim())
    : process.env.DATA_DIR?.trim() ? resolve(process.env.DATA_DIR.trim(), "android") : resolve(process.cwd(), ".m5cet", "android");
  return join(dir, "signing.key");
}

export function mobileSigningKey(): MobileSigner {
  if (signer) return signer;
  const file = mobileSigningKeyFile();
  let privateKey: KeyObject;
  try {
    privateKey = privateKeyFromPem(readFileSync(file, "utf8"));
  } catch {
    privateKey = newP256().privateKey;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    } catch {
      // Another process wrote it first: use theirs.
      privateKey = privateKeyFromPem(readFileSync(file, "utf8"));
    }
  }
  const publicKey = spkiOf(createPublicKey(privateKey));
  signer = { privateKey, publicKey, kid: kidOf(publicKey), fingerprint: fingerprintOf(publicKey) };
  return signer;
}

/** Tests: read the key file again next time. */
export function forgetMobileSigningKey(): void { signer = null; }
