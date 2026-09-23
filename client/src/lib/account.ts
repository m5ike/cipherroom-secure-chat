// The signed-in user, client side.
//
// Register or sign in with a passkey (/api/account/*), keep the session
// token for this tab, and keep the PRF-derived vault key as a
// NON-EXTRACTABLE CryptoKey in IndexedDB so a reload — or arriving on
// /signin from a push notification — can open the vault without another
// prompt. Everything uploaded (profile, chat history) is sealed with that
// key first: the server stores ciphertext and metadata, never plaintext.
//
// What the server logs, and what the user sees in the account window: sign
// in, vault load and save, decryption results, away / relay activity.
//
// 3.1: an account can have several passkeys and a recovery code. The keys
// come from the account root (see passkey.ts); any passkey or the code opens
// it. At sign-in the account also certifies this device's signing key
// (identity.ts), so peers recognise the account on every device.

import {
  assertPasskey, confirmWithPasskey, createPasskey, deriveAccountKeys, openProfile, openRoot, passkeySupported, sealProfile, sealRoot,
  WRAP_INFO, type SealedRoot, type ServerCreationOptions, type ServerRequestOptions,
} from "./passkey";
import { accountSigningKey, certifyDevice, ed25519Supported, loadIdentity, saveAttestation } from "./identity";
import { generateRecoveryCode, recoveryMaterial } from "./recovery";
import {
  forgetDatabaseKey, openUserDatabase, promoteSessionToAccount, recallDatabaseKey,
  rememberDatabaseKey, setStorageToken, storageSessionId,
} from "./storage-client";

export type AccountAudit = { at: number; kind: string; meta?: Record<string, string | number | boolean> };

export type AccountSummary = {
  id: string;
  credentialId: string;
  alg: number;
  userName: string;
  createdAt: number;
  lastLoginAt: number;
  loginCount: number;
  vault: { profileBytes: number; profileUpdatedAt: number; chatBytes: number; chatUpdatedAt: number; messages: number; messageBytes: number; rooms: number };
  mailbox: { pending: number; bytes: number };
  away: Array<{ room: string; name: string; since: number }>;
  pushDevices: number;
  audit: AccountAudit[];
  /** 3.1: every passkey of the account ("primary" = the first one). */
  passkeys?: Array<{ credentialId: string; alg: number; createdAt: number; lastUsedAt: number; label: string; primary: boolean }>;
  recovery?: { set: boolean; createdAt?: number };
  identity?: { publicKey: string; updatedAt: number } | null;
  /** Signed-in devices; `current` is this one. */
  sessions?: Array<{ id: string; createdAt: number; lastUsedAt: number; expiresAt: number; client: string; ip: string; current: boolean }>;
};

export type AccountStatus = {
  available: boolean;
  persistent: boolean;
  rpId: string;
  accounts: number;
  limits: { profileChars: number; chatChars: number; mailboxItems: number };
};

export type ChatVaultPayload = { messages: unknown[]; rooms: string[]; savedAt: number };

const TOKEN_KEY = "m5cet:account:v1";
const DB_NAME = "m5cet-account";
const STORE = "keys";

let session: { token: string; accountId: string; key: CryptoKey; account: AccountSummary } | null = null;

/* --------------------------------------------------------------- storage */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

/** Replaces IndexedDB in tests and in browsers that deny it. */
let keyStore: Map<string, CryptoKey> | null = null;

async function rememberKey(accountId: string, key: CryptoKey): Promise<void> {
  if (keyStore) { keyStore.set(accountId, key); return; }
  try { await tx("readwrite", (s) => s.put({ id: accountId, key, at: Date.now() })); } catch { /* private mode: this tab only */ }
}

async function recallKey(accountId: string): Promise<CryptoKey | null> {
  if (keyStore) return keyStore.get(accountId) ?? null;
  try {
    const row = await tx<{ id: string; key: CryptoKey }>("readonly", (s) => s.get(accountId));
    return (row as { key?: CryptoKey } | undefined)?.key ?? null;
  } catch { return null; }
}

async function forgetKey(accountId: string): Promise<void> {
  if (keyStore) { keyStore.delete(accountId); return; }
  try { await tx("readwrite", (s) => s.delete(accountId)); } catch { /* ignore */ }
}

function readToken(): { token: string; accountId: string } | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { token?: unknown; accountId?: unknown };
    return typeof v.token === "string" && typeof v.accountId === "string" ? { token: v.token, accountId: v.accountId } : null;
  } catch { return null; }
}

function writeToken(token: string, accountId: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, accountId })); } catch { /* ignore */ }
}

function dropToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ http */

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!res.ok) throw new Error(typeof json.message === "string" ? json.message : `Server error ${res.status}.`);
  return json as T;
}

/* -------------------------------------------------------------- lifecycle */

export function accountSupported(): boolean {
  return passkeySupported();
}

export async function accountStatus(): Promise<AccountStatus | null> {
  try { return await api<AccountStatus>("/api/account/status"); } catch { return null; }
}

export function currentAccount(): AccountSummary | null {
  return session?.account ?? null;
}

export function accountToken(): string | null {
  return session?.token ?? null;
}

export function isSignedIn(): boolean {
  return session !== null;
}

/** Creates a passkey account on this server and signs in with it.
 *
 *  The passkey has to produce an encryption key (WebAuthn PRF) before the
 *  account is created: an account whose data nobody could ever decrypt is
 *  worse than none, and this way a device without PRF leaves nothing
 *  behind on the server. */
export async function registerAccount(userName: string): Promise<AccountSummary> {
  const options = await api<{ publicKey: ServerCreationOptions }>("/api/account/register/options", {
    method: "POST",
    body: JSON.stringify({ userName }),
  });
  const { response, key, databaseKey, secret } = await createPasskey(options.publicKey);
  const result = await api<{ token: string; account: AccountSummary }>("/api/account/register/verify", {
    method: "POST",
    body: JSON.stringify({ credential: response }),
  });
  await adopt(result.token, result.account, key);
  // The first passkey's PRF output is the account root.
  await attestDevice(secret);
  // Whatever this browser stored as an anonymous session becomes theirs.
  const hadSession = Boolean(storageSessionId());
  await rememberDatabaseKey(databaseKey, key);
  if (hadSession) await promoteSessionToAccount(databaseKey);
  else await openUserDatabase(databaseKey);
  return result.account;
}

/** Signs in with an existing passkey (the browser picks the credential). */
export async function signInWithPasskey(): Promise<AccountSummary> {
  const options = await api<{ publicKey: ServerRequestOptions }>("/api/account/signin/options", { method: "POST", body: JSON.stringify({}) });
  const signed = await assertPasskey(options.publicKey);
  const result = await api<{ token: string; account: AccountSummary; wrapped?: SealedRoot | null }>("/api/account/signin/verify", {
    method: "POST",
    body: JSON.stringify({ credential: signed.response }),
  });
  // A passkey added later brings the root sealed for it; the first one IS it.
  const root = result.wrapped ? await openRoot(result.wrapped, signed.secret, WRAP_INFO.passkey) : signed.secret;
  const { key, databaseKey } = result.wrapped ? await deriveAccountKeys(root) : { key: signed.key, databaseKey: signed.databaseKey };
  await adopt(result.token, result.account, key);
  await attestDevice(root);
  await rememberDatabaseKey(databaseKey, key);
  // The key opens the SQLCipher database on the server for this session.
  if (storageSessionId()) await promoteSessionToAccount(databaseKey);
  else await openUserDatabase(databaseKey);
  return result.account;
}

/** The account certifies this device's signing key (and tells the server
 *  its public key). Best effort: a browser without Ed25519 simply signs as
 *  a device, as before. */
async function attestDevice(root: Uint8Array): Promise<void> {
  try {
    if (!(await ed25519Supported())) return;
    const account = await accountSigningKey(root);
    const device = await loadIdentity();
    await saveAttestation(await certifyDevice(account.privateKey, account.publicKey, device.publicKey));
    if (session) await api("/api/account/identity", { method: "PUT", body: JSON.stringify({ publicKey: account.publicKey }) }, session.token).catch(() => undefined);
  } catch { /* signing as a device still works */ }
}

/** The account root, confirmed with one of the account's passkeys: needed to
 *  seal it for a new passkey or a recovery code. */
async function confirmRoot(): Promise<Uint8Array> {
  if (!session) throw new Error("Not signed in.");
  const ids = (session.account.passkeys ?? []).map((p) => p.credentialId);
  const confirmed = await confirmWithPasskey(ids.length ? ids : [session.account.credentialId]);
  const primary = session.account.passkeys?.find((p) => p.primary)?.credentialId ?? session.account.credentialId;
  if (confirmed.credentialId === primary) return confirmed.secret;
  const sealed = await api<{ wrapped: SealedRoot | null }>(`/api/account/passkeys/${encodeURIComponent(confirmed.credentialId)}/wrapped`, {}, session.token);
  if (!sealed.wrapped) throw new Error("This passkey cannot open the account key.");
  return openRoot(sealed.wrapped, confirmed.secret, WRAP_INFO.passkey);
}

/** Adds another passkey (another device, a security key) to the account. */
export async function addPasskey(label: string): Promise<AccountSummary> {
  if (!session) throw new Error("Not signed in.");
  const root = await confirmRoot();
  const options = await api<{ publicKey: ServerCreationOptions }>("/api/account/passkeys/options", { method: "POST", body: "{}" }, session.token);
  const created = await createPasskey(options.publicKey);
  const wrapped = await sealRoot(root, created.secret, WRAP_INFO.passkey);
  root.fill(0);
  const r = await api<{ account: AccountSummary }>("/api/account/passkeys/verify", {
    method: "POST",
    body: JSON.stringify({ credential: created.response, wrapped, label: label.slice(0, 40) }),
  }, session.token);
  session.account = r.account;
  return r.account;
}

export async function removePasskey(credentialId: string): Promise<AccountSummary> {
  if (!session) throw new Error("Not signed in.");
  const r = await api<{ account: AccountSummary }>(`/api/account/passkeys/${encodeURIComponent(credentialId)}`, { method: "DELETE" }, session.token);
  session.account = r.account;
  return r.account;
}

/** Creates (or replaces) the recovery code. Returns the code — the only time it is shown. */
export async function createRecoveryCode(): Promise<{ code: string; account: AccountSummary }> {
  if (!session) throw new Error("Not signed in.");
  const root = await confirmRoot();
  const code = generateRecoveryCode();
  const material = await recoveryMaterial(code);
  const wrapped = await sealRoot(root, material.secret, WRAP_INFO.recovery);
  root.fill(0);
  const r = await api<{ account: AccountSummary }>("/api/account/recovery", {
    method: "PUT",
    body: JSON.stringify({ id: material.id, verifier: material.verifier, wrapped }),
  }, session.token);
  session.account = r.account;
  return { code, account: r.account };
}

export async function removeRecoveryCode(): Promise<AccountSummary> {
  if (!session) throw new Error("Not signed in.");
  const r = await api<{ account: AccountSummary }>("/api/account/recovery", { method: "DELETE" }, session.token);
  session.account = r.account;
  return r.account;
}

/** Every passkey is gone: the recovery code opens the account root, a new
 *  passkey is registered for it, and this becomes a normal sign-in. */
export async function recoverWithCode(code: string, label = "recovered"): Promise<AccountSummary> {
  const material = await recoveryMaterial(code);
  const started = await api<{ ticket: string; wrapped: SealedRoot | null; publicKey: ServerCreationOptions }>("/api/account/recovery/start", {
    method: "POST",
    body: JSON.stringify({ id: material.id, proof: material.proof }),
  });
  if (!started.wrapped) throw new Error("The account has no key sealed for this code.");
  const root = await openRoot(started.wrapped, material.secret, WRAP_INFO.recovery);
  const created = await createPasskey(started.publicKey);
  const wrapped = await sealRoot(root, created.secret, WRAP_INFO.passkey);
  const result = await api<{ token: string; account: AccountSummary }>("/api/account/recovery/finish", {
    method: "POST",
    body: JSON.stringify({ ticket: started.ticket, credential: created.response, wrapped, label }),
  });
  const { key, databaseKey } = await deriveAccountKeys(root);
  await adopt(result.token, result.account, key);
  await attestDevice(root);
  root.fill(0);
  await rememberDatabaseKey(databaseKey, key);
  await openUserDatabase(databaseKey);
  return result.account;
}

/** Ends one of the account's sessions (another device). */
export async function endSession(id: string): Promise<AccountSummary | null> {
  if (!session) return null;
  await api(`/api/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, session.token);
  return refreshAccount();
}

async function adopt(token: string, account: AccountSummary, key: CryptoKey): Promise<void> {
  session = { token, accountId: account.id, key, account };
  writeToken(token, account.id);
  setStorageToken(token);
  await rememberKey(account.id, key);
}

/** Brings back the session of this tab after a reload, without a prompt.
 *  Returns null when there is nothing to restore (then sign in normally). */
export async function restoreSession(): Promise<AccountSummary | null> {
  if (session) return session.account;
  const stored = readToken();
  if (!stored) return null;
  const key = await recallKey(stored.accountId);
  if (!key) { dropToken(); return null; }
  try {
    const me = await api<{ account: AccountSummary }>("/api/account/me", {}, stored.token);
    session = { token: stored.token, accountId: stored.accountId, key, account: me.account };
    setStorageToken(stored.token);
    // The server keeps database keys in memory only, so after a restart it
    // needs ours again — this tab kept it wrapped with the vault key.
    const databaseKey = await recallDatabaseKey(key);
    if (databaseKey) await openUserDatabase(databaseKey);
    return me.account;
  } catch {
    dropToken();
    return null;
  }
}

/** Fresh counters, sizes and audit lines for the account window. */
export async function refreshAccount(): Promise<AccountSummary | null> {
  if (!session) return null;
  try {
    const me = await api<{ account: AccountSummary }>("/api/account/me", {}, session.token);
    session.account = me.account;
    return me.account;
  } catch { return null; }
}

/* ----------------------------------------------------------------- vault */

/** Opens the server-side vault. `profile` and `chat` are null when empty;
 *  a blob that does not decrypt throws (wrong passkey, corrupted upload). */
export async function loadVault<P>(): Promise<{ profile: P | null; chat: ChatVaultPayload | null }> {
  if (!session) throw new Error("Not signed in.");
  const raw = await api<{ profile: { ct: string } | null; chat: { ct: string } | null }>("/api/account/vault", {}, session.token);
  const out: { profile: P | null; chat: ChatVaultPayload | null } = { profile: null, chat: null };
  if (raw.profile?.ct) out.profile = await openProfile<P>(raw.profile.ct, session.key);
  if (raw.chat?.ct) out.chat = await openProfile<ChatVaultPayload>(raw.chat.ct, session.key);
  return out;
}

/** Seals and uploads what changed. Returns the refreshed account summary. */
export async function saveVault(patch: { profile?: unknown; chat?: ChatVaultPayload }): Promise<AccountSummary | null> {
  if (!session) return null;
  const body: Record<string, unknown> = {};
  if (patch.profile !== undefined) body.profile = await sealProfile(patch.profile, session.key);
  if (patch.chat !== undefined) {
    const ct = await sealProfile(patch.chat, session.key);
    body.chat = {
      ct,
      messages: patch.chat.messages.length,
      messageBytes: JSON.stringify(patch.chat.messages).length,
      rooms: patch.chat.rooms.length,
    };
  }
  if (Object.keys(body).length === 0) return session.account;
  const r = await api<{ account: AccountSummary }>("/api/account/vault", { method: "PUT", body: JSON.stringify(body) }, session.token);
  session.account = r.account;
  return r.account;
}

/** Records what happened with the data on the server's audit trail. */
export async function logAccountEvent(kind: "decrypt-ok" | "decrypt-failed" | "data-loaded" | "data-cleared" | "chat-restored", meta?: Record<string, string | number | boolean>): Promise<void> {
  if (!session) return;
  try { await api("/api/account/event", { method: "POST", body: JSON.stringify({ kind, meta }) }, session.token); } catch { /* best effort */ }
}

/** Links this device's Web Push subscription so the server can wake it while
 *  the user is away. */
export async function linkPushSubscription(subscription: PushSubscriptionJSON | PushSubscription): Promise<boolean> {
  if (!session) return false;
  const json = "toJSON" in subscription ? (subscription as PushSubscription).toJSON() : subscription;
  if (!json.endpoint) return false;
  try {
    await api("/api/account/push", {
      method: "POST",
      body: JSON.stringify({ subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } } }),
    }, session.token);
    return true;
  } catch { return false; }
}

/* ----------------------------------------------------------- end of session */

/** Signs out. The vault stays on the server, sealed. */
export async function signOutAccount(everywhere = false): Promise<void> {
  const current = session;
  session = null;
  dropToken();
  setStorageToken(null);
  forgetDatabaseKey();
  await saveAttestation(null).catch(() => undefined);
  if (!current) return;
  await forgetKey(current.accountId);
  try { await api("/api/account/signout", { method: "POST", body: JSON.stringify({ everywhere }) }, current.token); } catch { /* already gone */ }
}

/** Deletes the account, its vault and its mailbox on the server. */
export async function deleteAccount(): Promise<void> {
  const current = session;
  if (!current) return;
  session = null;
  dropToken();
  forgetDatabaseKey();
  await saveAttestation(null).catch(() => undefined);
  await forgetKey(current.accountId);
  await api("/api/account", { method: "DELETE" }, current.token);
  setStorageToken(null);
}

/** Test seam: drop the in-memory session and keep keys in a plain map. */
export function _resetAccountForTests(keys: Map<string, CryptoKey> | null = null): void {
  session = null;
  keyStore = keys;
  setStorageToken(null);
  dropToken();
}

/** The vault key of the current session, for wrapping the database key. */
export function vaultKey(): CryptoKey | null {
  return session?.key ?? null;
}
