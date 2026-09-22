// PassKey-backed encrypted profile.
//
// The user creates a PassKey (WebAuthn discoverable credential). Its WebAuthn
// PRF extension yields a stable per-credential secret that only that
// authenticator + user verification can reproduce. We derive an AES-GCM key
// from that secret and encrypt the profile (settings + identity) LOCALLY; the
// server only ever stores ciphertext, keyed by the opaque credential id. On
// "log out" the client drops the key and the server blob stays sealed —
// unreadable without the PassKey.
//
// Honesty: the server does not verify WebAuthn signatures (no attestation); it
// treats the credential id as an opaque storage key. The real protection is the
// PRF-derived key, which the server never sees. PRF requires a recent browser +
// platform authenticator; passkeySupported()/prf availability is checked and a
// clear error is surfaced when unavailable, never a silent fallback.

import { toBase64, fromBase64 } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();
// Fresh copies are Uint8Array<ArrayBuffer>, which WebCrypto's BufferSource wants.
const PRF_SALT = new Uint8Array(enc.encode("m5cet:passkey:prf:v1"));
const HKDF_INFO = new Uint8Array(enc.encode("m5cet:profile:v1"));

type PrfExtension = { prf?: { eval?: { first: BufferSource } } };
type PrfResults = { prf?: { results?: { first?: ArrayBuffer } } };

export function passkeySupported(): boolean {
  return typeof window !== "undefined"
    && typeof PublicKeyCredential !== "undefined"
    && typeof navigator !== "undefined"
    && Boolean(navigator.credentials);
}

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function deriveKey(secret: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: HKDF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealProfile<T>(profile: T, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(enc.encode(JSON.stringify(profile)))));
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return toBase64(combined);
}

export async function openProfile<T>(ciphertext: string, key: CryptoKey): Promise<T> {
  const combined = fromBase64(ciphertext);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(dec.decode(plain)) as T;
}

async function createCredential(userName: string): Promise<Uint8Array> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "M5cet", id: location.hostname },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: userName || "m5cet-user", displayName: userName || "M5cet user" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 60_000,
    attestation: "none",
    extensions: { prf: {} } as AuthenticationExtensionsClientInputs & PrfExtension,
  };
  const cred = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null;
  if (!cred) throw new Error("PassKey creation was cancelled.");
  return new Uint8Array(cred.rawId);
}

/** Run a WebAuthn assertion asking for the PRF secret. Returns the used
 *  credential id + the derived key. */
async function assertPrf(credentialId?: Uint8Array): Promise<{ credentialId: Uint8Array; key: CryptoKey }> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    userVerification: "required",
    timeout: 60_000,
    ...(credentialId ? { allowCredentials: [{ id: new Uint8Array(credentialId), type: "public-key" as const }] } : {}),
    extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs & PrfExtension,
  };
  const assertion = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
  if (!assertion) throw new Error("PassKey sign-in was cancelled.");
  const results = assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & PrfResults;
  const first = results?.prf?.results?.first;
  if (!first) throw new Error("This authenticator does not support the WebAuthn PRF extension; the encrypted profile cannot be unlocked here.");
  return { credentialId: new Uint8Array(assertion.rawId), key: await deriveKey(new Uint8Array(first)) };
}

async function putProfile(credentialId: string, ciphertext: string): Promise<void> {
  const res = await fetch("/api/passkey/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentialId, ciphertext }),
  });
  if (!res.ok) throw new Error(`Server refused to store the profile (${res.status}).`);
}

async function fetchProfile(credentialId: string): Promise<string | null> {
  const res = await fetch(`/api/passkey/profile?credentialId=${encodeURIComponent(credentialId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Server error ${res.status}.`);
  const json = await res.json() as { ok?: boolean; ciphertext?: string };
  return json.ciphertext || null;
}

/** Create a PassKey, encrypt `profile` under its PRF secret, store it. */
export async function registerProfileWithPasskey<T>(profile: T, userName: string): Promise<{ credentialId: string }> {
  if (!passkeySupported()) throw new Error("PassKeys are not supported in this browser.");
  const rawId = await createCredential(userName);
  const { credentialId, key } = await assertPrf(rawId);
  const ciphertext = await sealProfile(profile, key);
  const id = b64url(credentialId);
  await putProfile(id, ciphertext);
  return { credentialId: id };
}

/** Sign in with a PassKey and return the decrypted profile. */
export async function unlockProfileWithPasskey<T>(credentialId?: string): Promise<{ credentialId: string; profile: T }> {
  if (!passkeySupported()) throw new Error("PassKeys are not supported in this browser.");
  const { credentialId: rawId, key } = await assertPrf(credentialId ? fromB64url(credentialId) : undefined);
  const id = b64url(rawId);
  const ciphertext = await fetchProfile(id);
  if (!ciphertext) throw new Error("No stored profile for this PassKey.");
  const profile = await openProfile<T>(ciphertext, key);
  return { credentialId: id, profile };
}

/** Re-encrypt and store an updated profile for an existing PassKey. */
export async function saveProfileWithPasskey<T>(profile: T, credentialId?: string): Promise<{ credentialId: string }> {
  if (!passkeySupported()) throw new Error("PassKeys are not supported in this browser.");
  const { credentialId: rawId, key } = await assertPrf(credentialId ? fromB64url(credentialId) : undefined);
  const id = b64url(rawId);
  await putProfile(id, await sealProfile(profile, key));
  return { credentialId: id };
}

/** Lock (delete) the server-side profile. */
export async function lockServerProfile(credentialId: string): Promise<void> {
  await fetch("/api/passkey/profile", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentialId }),
  }).catch(() => undefined);
}

// Exposed for tests: derive a key from a raw secret without WebAuthn.
export const _deriveKeyForTest = deriveKey;
