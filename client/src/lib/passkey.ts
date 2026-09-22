// PassKey primitives: the WebAuthn ceremonies and the key they yield.
//
// The user's passkey does two jobs at once:
//   1. it proves who they are to the server — the server verifies the
//      signature over its own challenge (server/accounts/webauthn.ts);
//   2. it produces, through the WebAuthn PRF extension, a stable per-credential
//      secret that never leaves the device. HKDF turns that secret into an
//      AES-GCM key, and everything the server stores for the account (profile
//      and chat history) is sealed with it before it is uploaded.
//
// So the server authenticates the account but cannot read the account's data:
// it holds ciphertext keyed by an account id. Losing the passkey means losing
// the data — that is the point of the trade.
//
// PRF needs a recent browser and a platform authenticator; when it is absent
// we say so instead of silently falling back to something weaker.

import { toBase64, fromBase64 } from "./crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();
// Fresh copies are Uint8Array<ArrayBuffer>, which WebCrypto's BufferSource wants.
const PRF_SALT = new Uint8Array(enc.encode("m5cet:passkey:prf:v1"));
const HKDF_INFO = new Uint8Array(enc.encode("m5cet:profile:v1"));
// A second, independent key from the same PRF secret: this one opens the
// user's SQLCipher database on the server, so unlike the vault key it does
// leave the browser. Separate info string = neither key tells you the other.
const DB_INFO = new Uint8Array(enc.encode("m5cet:userdb:v1"));

type PrfExtension = { prf?: { eval?: { first: BufferSource } } };
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** The authenticator cannot produce a key, so there is nothing to encrypt
 *  with. Thrown rather than silently falling back to something weaker. */
export class PrfUnsupportedError extends Error {
  constructor() {
    super("This passkey cannot produce an encryption key (no WebAuthn PRF support). Use a passkey stored in the browser, iCloud Keychain or Google Password Manager, or a security key that supports the PRF / hmac-secret extension.");
    this.name = "PrfUnsupportedError";
  }
}

export function passkeySupported(): boolean {
  return typeof window !== "undefined"
    && typeof PublicKeyCredential !== "undefined"
    && typeof navigator !== "undefined"
    && Boolean(navigator.credentials);
}

export function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(value: string): Uint8Array {
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

/** Raw 32 bytes for the server-side database, derived from the same secret. */
async function deriveDatabaseKey(secret: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: PRF_SALT, info: DB_INFO }, base, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
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

/* --------------------------------------------------------- server options */

/** What POST /api/account/register/options answers (base64url challenge). */
export type ServerCreationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  timeout?: number;
};

/** What POST /api/account/signin/options answers. */
export type ServerRequestOptions = {
  challenge: string;
  rpId: string;
  userVerification?: UserVerificationRequirement;
  timeout?: number;
  allowCredentials?: Array<{ id: string; type: "public-key" }>;
};

export type RegistrationResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string };
};

export type AssertionResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null };
};

const prfInput = () => ({ prf: { eval: { first: PRF_SALT } } }) as AuthenticationExtensionsClientInputs & PrfExtension;

function prfSecret(credential: PublicKeyCredential): ArrayBuffer | null {
  const results = credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & PrfResults;
  return results?.prf?.results?.first ?? null;
}

/** Creates the passkey the server asked for, and derives the vault key.
 *  Most browsers do not hand out the PRF secret at creation time, so we
 *  immediately assert with the fresh credential to get it. */
export async function createPasskey(options: ServerCreationOptions): Promise<{ response: RegistrationResponseJSON; key: CryptoKey; databaseKey: string }> {
  if (!passkeySupported()) throw new Error("PassKeys are not supported in this browser.");
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: new Uint8Array(fromB64url(options.challenge)),
    rp: options.rp,
    user: {
      id: new Uint8Array(fromB64url(options.user.id)),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    authenticatorSelection: options.authenticatorSelection ?? { residentKey: "required", userVerification: "required" },
    attestation: options.attestation ?? "none",
    timeout: options.timeout ?? 60_000,
    extensions: prfInput(),
  };
  const credential = await navigator.credentials.create({ publicKey }) as PublicKeyCredential | null;
  if (!credential) throw new Error("PassKey creation was cancelled.");
  const attestation = credential.response as AuthenticatorAttestationResponse;
  const response: RegistrationResponseJSON = {
    id: credential.id,
    rawId: b64url(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      clientDataJSON: b64url(new Uint8Array(attestation.clientDataJSON)),
      attestationObject: b64url(new Uint8Array(attestation.attestationObject)),
    },
  };
  // Most browsers hand the PRF secret over at creation time; the ones that
  // do not need a second ceremony, which we run straight away — the click
  // that created the passkey still counts as the user's gesture.
  const direct = prfSecret(credential);
  const secret = direct ? new Uint8Array(direct) : await prfSecretFor(new Uint8Array(credential.rawId));
  return { response, key: await deriveKey(secret), databaseKey: await deriveDatabaseKey(secret) };
}

/** Signs the server's challenge and derives the same vault key. */
export async function assertPasskey(options: ServerRequestOptions): Promise<{ response: AssertionResponseJSON; key: CryptoKey; databaseKey: string }> {
  if (!passkeySupported()) throw new Error("PassKeys are not supported in this browser.");
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: new Uint8Array(fromB64url(options.challenge)),
    rpId: options.rpId,
    userVerification: options.userVerification ?? "required",
    timeout: options.timeout ?? 60_000,
    ...(options.allowCredentials?.length
      ? { allowCredentials: options.allowCredentials.map((c) => ({ id: new Uint8Array(fromB64url(c.id)), type: "public-key" as const })) }
      : {}),
    extensions: prfInput(),
  };
  const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
  if (!credential) throw new Error("PassKey sign-in was cancelled.");
  const assertion = credential.response as AuthenticatorAssertionResponse;
  const secret = prfSecret(credential);
  if (!secret) throw new PrfUnsupportedError();
  const bytes = new Uint8Array(secret);
  return {
    response: {
      id: credential.id,
      rawId: b64url(new Uint8Array(credential.rawId)),
      type: credential.type,
      response: {
        clientDataJSON: b64url(new Uint8Array(assertion.clientDataJSON)),
        authenticatorData: b64url(new Uint8Array(assertion.authenticatorData)),
        signature: b64url(new Uint8Array(assertion.signature)),
        userHandle: assertion.userHandle ? b64url(new Uint8Array(assertion.userHandle)) : null,
      },
    },
    key: await deriveKey(bytes),
    databaseKey: await deriveDatabaseKey(bytes),
  };
}

/** A PRF-only assertion (no server ceremony) — used right after creating a
 *  credential, when the browser withheld the secret. */
async function prfSecretFor(credentialId: Uint8Array): Promise<Uint8Array> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    userVerification: "required",
    timeout: 60_000,
    allowCredentials: [{ id: new Uint8Array(credentialId), type: "public-key" as const }],
    extensions: prfInput(),
  };
  const assertion = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
  const secret = assertion ? prfSecret(assertion) : null;
  if (!secret) throw new PrfUnsupportedError();
  return new Uint8Array(secret);
}

// Exposed for tests: derive a key from a raw secret without WebAuthn.
export const _deriveKeyForTest = deriveKey;
