// Does this browser run what the server deploys? (4.0)
//
// A single-page app keeps running the bundle it loaded: an old tab, a
// stale HTTP cache, a service worker from an earlier deploy or a chunk left
// in the cache can mix old code with a new server — and with end-to-end
// encryption, "mostly the same" is not good enough. The build writes
// dist/public/version-manifest.json (vite.config.ts): the version and build,
// the protocol, the service worker's build, every bundled library with its
// version and every file under /assets with its SHA-256. The check compares
//
//   app / build   this bundle's version and build id  ↔  the manifest's
//   protocol      the signaling protocol it speaks   ↔  the manifest's
//   library       each bundled library's version      ↔  the manifest's
//   file          every /assets file this page loaded ↔  the manifest's list
//   worker        the active service worker's build   ↔  the manifest's
//
// and the fix wipes this app's caches and data in the browser (service
// worker, Cache Storage, stored configuration, sessions; optionally keeping
// the look and language), asks the server to clear the HTTP cache
// (Clear-Site-Data) and loads everything fresh.
//
// 6.12 (F-02) — is it the DEVELOPER'S code? The version manifest above comes
// from the same server as the code, so it only says "what this server meant
// to serve". The release manifest (docs/protocol-v4.md § 15) is signed with
// the developer's Ed25519 release key, which never is on the server:
//
//   /release-web.json       ReleaseManifest — every served asset, its SHA-256
//   /release-web.json.sig   b64 Ed25519 over the exact bytes of the manifest
//   /release-signing.pub    the raw public key, b64 (what a first visit pins)
//
// `checkRelease` fetches them, hashes the scripts and styles this page
// actually loaded, compares, and verifies the signature with a PINNED key:
// one configured in the build (M5_RELEASE_KEY), else the key seen on the
// first visit to this origin (trust on first use, kept in localStorage). The
// security panel shows the outcome (signed by key X / unsigned / MODIFIED /
// key changed) and a red banner stays while the loaded code does not match a
// signed manifest or the key is not the pinned one.
//
// What this does NOT do — be honest about it:
//   * On a FIRST visit there is no pin: a malicious server can serve a page
//     with its own key (or none), and that page is what runs. The pin protects
//     returning visitors only.
//   * The check runs inside the code it checks. A server that replaces the
//     whole bundle can leave the check out as well. It catches a changed
//     chunk, a tampered cache or proxy, a stripped or broken signature and a
//     changed release key where the entry code itself is still the
//     developer's — not a server that rewrites everything. The real fix is a
//     verifier outside the page (an extension, a service worker that only
//     installs signed code, a native app) — F-02 stays a design gap.
//   * The bytes hashed are fetched again (from the HTTP cache when it still
//     has them); a server could answer that request differently from the one
//     the browser executed.

import { APP_BUILD, APP_LIBS, APP_PROTOCOL, APP_VERSION } from "./build-info";
import type { ReleaseManifest } from "./p4/contract";

export type MismatchKind = "app" | "build" | "protocol" | "lib" | "asset" | "sw";
export type Mismatch = { kind: MismatchKind; item: string; local: string; server: string };

export type VersionManifest = {
  app: string;
  version: string;
  build: string;
  builtAt?: string;
  protocol: number;
  serviceWorker?: string;
  libraries: Record<string, string>;
  assets: Array<{ file: string; bytes: number; sha256: string }>;
};

export type LocalState = {
  version: string;
  build: string;
  protocol: number;
  libraries: Record<string, string>;
  /** Paths under /assets/ this page has loaded. */
  assets: string[];
  /** The active service worker's build, "" when none answers. */
  serviceWorker: string;
};

/** Compares what runs here with the manifest. Pure. */
export function compare(local: LocalState, manifest: VersionManifest): Mismatch[] {
  const out: Mismatch[] = [];
  if (local.version !== manifest.version) out.push({ kind: "app", item: "M5cet", local: local.version, server: manifest.version });
  if (local.build !== manifest.build) out.push({ kind: "build", item: "build", local: local.build, server: manifest.build });
  if (local.protocol !== manifest.protocol) out.push({ kind: "protocol", item: "signaling", local: String(local.protocol), server: String(manifest.protocol) });
  for (const name of new Set([...Object.keys(local.libraries), ...Object.keys(manifest.libraries)])) {
    const a = local.libraries[name] ?? "";
    const b = manifest.libraries[name] ?? "";
    if (a !== b) out.push({ kind: "lib", item: name, local: a || "—", server: b || "—" });
  }
  const known = new Set(manifest.assets.map((a) => `/${a.file}`));
  for (const path of local.assets) if (!known.has(path)) out.push({ kind: "asset", item: path.replace(/^\/assets\//, ""), local: "✓", server: "" });
  if (local.serviceWorker && manifest.serviceWorker && local.serviceWorker !== manifest.serviceWorker) {
    out.push({ kind: "sw", item: "sw.js", local: local.serviceWorker, server: manifest.serviceWorker });
  }
  return out;
}

export async function fetchManifest(timeoutMs = 8000): Promise<VersionManifest | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/version-manifest.json?ts=${Date.now()}`, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const m = await res.json() as Partial<VersionManifest>;
    if (typeof m.build !== "string" || !Array.isArray(m.assets)) return null;
    return {
      app: String(m.app ?? "m5cet"), version: String(m.version ?? ""), build: m.build, builtAt: m.builtAt,
      protocol: Number(m.protocol) || 0, serviceWorker: m.serviceWorker, libraries: m.libraries ?? {}, assets: m.assets,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every /assets path this page loaded: scripts, styles, preloads, fetched chunks. */
export function loadedAssets(): string[] {
  const paths = new Set<string>();
  const add = (url: string | null | undefined) => {
    if (!url) return;
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin && u.pathname.startsWith("/assets/") && !/\.(br|gz)$/.test(u.pathname)) paths.add(u.pathname);
    } catch { /* not a URL */ }
  };
  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((el) => add(el.src));
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"], link[rel="modulepreload"]').forEach((el) => add(el.href));
  try { for (const e of performance.getEntriesByType("resource")) add(e.name); } catch { /* no Resource Timing */ }
  return [...paths].sort();
}

/** The active service worker's build (asks it over a MessageChannel). */
export async function serviceWorkerBuild(timeoutMs = 1500): Promise<string> {
  const controller = typeof navigator !== "undefined" ? navigator.serviceWorker?.controller : null;
  if (!controller) return "";
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(""), timeoutMs);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(String((event.data as { build?: unknown })?.build ?? "")); };
    try { controller.postMessage({ type: "version" }, [channel.port2]); } catch { clearTimeout(timer); resolve(""); }
  });
}

export async function localState(): Promise<LocalState> {
  return { version: APP_VERSION, build: APP_BUILD, protocol: APP_PROTOCOL, libraries: APP_LIBS, assets: loadedAssets(), serviceWorker: await serviceWorkerBuild() };
}

/** Runs the whole check. A dev build (no manifest) is never out of step. */
export async function checkIntegrity(): Promise<{ manifest: VersionManifest | null; mismatches: Mismatch[] }> {
  if (APP_BUILD === "dev") return { manifest: null, mismatches: [] };
  const manifest = await fetchManifest();
  if (!manifest) return { manifest: null, mismatches: [] };
  return { manifest, mismatches: compare(await localState(), manifest) };
}

/** The storage keys that are only look and language (kept on request). */
const PREFS_KEY = "m5cet:prefs:v2";
const KEEP_FIELDS = ["theme", "themeTone", "themeSet", "iconStyle", "accent", "layout", "lang", "font", "fontSize", "menuDisplay", "timezone"];

/**
 * Wipes what this app keeps in the browser and loads everything fresh.
 * The device's identity key stays (peers would otherwise see a new device).
 */
export async function repairAndReload(opts: { keepPrefs: boolean } = { keepPrefs: true }): Promise<void> {
  let kept: Record<string, unknown> | null = null;
  if (opts.keepPrefs) {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
      kept = Object.fromEntries(KEEP_FIELDS.filter((k) => k in prefs).map((k) => [k, prefs[k]]));
    } catch { kept = null; }
  }
  // Service workers and their caches.
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    await Promise.all((regs ?? []).map((r) => r.unregister()));
  } catch { /* none */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* no Cache Storage */ }
  // Stored configuration and sessions. 6.12: the release key's pin stays —
  // "Fix" must not be a way to make this browser forget which key it trusts.
  let pin: string | null = null;
  try { pin = localStorage.getItem(RELEASE_PIN_STORE); } catch { /* denied */ }
  try { localStorage.clear(); } catch { /* denied */ }
  try { sessionStorage.clear(); } catch { /* denied */ }
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(dbs.map((d) => d.name && d.name !== "m5cet-identity" ? new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(d.name!);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    }) : Promise.resolve()));
  } catch { /* IndexedDB listing unsupported: the account key is re-derived at sign-in anyway */ }
  if (kept) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(kept)); } catch { /* ignore */ } }
  if (pin) { try { localStorage.setItem(RELEASE_PIN_STORE, pin); } catch { /* ignore */ } }
  // The HTTP cache, including cross-origin libraries (web fonts).
  try { await fetch("/api/clear-site-data", { method: "POST", cache: "no-store" }); } catch { /* offline */ }
  // A fresh document: the query defeats any cached index.html on the way.
  const url = new URL(location.href);
  url.searchParams.set("refresh", Date.now().toString(36));
  url.hash = "";
  location.replace(url.toString());
}

/* ===================================================== 6.12 (F-02): signed releases */

export const RELEASE_MANIFEST_PATH = "/release-web.json";
export const RELEASE_SIG_PATH = "/release-web.json.sig";
export const RELEASE_KEY_PATH = "/release-signing.pub";
/** localStorage: { [origin]: { key, pinnedAt } } — the release key trusted on first use. */
export const RELEASE_PIN_STORE = "m5cet:release-pin:v1";

declare const __M5_RELEASE_KEY__: string;
/** A release key configured in the build (M5_RELEASE_KEY, raw 32 bytes b64): it is the pin, no first use needed. */
export const BUILD_RELEASE_KEY: string = typeof __M5_RELEASE_KEY__ !== "undefined" ? __M5_RELEASE_KEY__ : "";

export type ReleaseMismatch = { kind: "changed" | "unlisted"; path: string; expected?: string; actual: string };
export type ReleasePin = { key: string; pinnedAt: number; source: "build" | "first-use" };

export type ReleaseState =
  /** No release manifest here (a development build, an older server). */
  | { state: "unavailable" }
  /** A manifest without a signature — or no key to check one with. `mismatches` still say what differs from it. */
  | { state: "unsigned"; manifest: ReleaseManifest; mismatches: ReleaseMismatch[] }
  /** Signed by the pinned key, and every loaded script and style is in it with the same hash. */
  | { state: "signed"; manifest: ReleaseManifest; keyId: string; pin: ReleasePin; checked: number; firstUse: boolean }
  /** NOT what the developer signed: loaded code differs, the signature does not verify, or a signed origin stopped signing. */
  | { state: "modified"; reason: "assets" | "bad-signature" | "unsigned"; manifest: ReleaseManifest | null; keyId: string; mismatches: ReleaseMismatch[] }
  /** The server presents another release key than the one pinned. */
  | { state: "key-changed"; pinnedId: string; servedId: string; served: string }
  /** This browser cannot check Ed25519 signatures (WebCrypto without Ed25519). */
  | { state: "unverifiable"; manifest: ReleaseManifest };

const HEX64 = /^[0-9a-f]{64}$/;

/** The manifest's bytes as a ReleaseManifest (§ 15), or null when they are not one. */
export function parseReleaseManifest(bytes: Uint8Array): ReleaseManifest | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ReleaseManifest>;
    if (m.format !== "m5cet-release/1" || !Array.isArray(m.files)) return null;
    const files = m.files.filter((f) => f && typeof f.path === "string" && typeof f.sha256 === "string" && HEX64.test(f.sha256) && Number.isFinite(f.size));
    if (files.length !== m.files.length) return null;
    return { format: "m5cet-release/1", name: String(m.name ?? ""), version: String(m.version ?? ""), commit: String(m.commit ?? ""), created: String(m.created ?? ""), files };
  } catch { return null; }
}

/** What the loaded assets (path without the leading "/", SHA-256 hex) say against the manifest. */
export function compareRelease(manifest: ReleaseManifest, loaded: ReadonlyArray<{ path: string; sha256: string }>): ReleaseMismatch[] {
  const byPath = new Map(manifest.files.map((f) => [f.path.replace(/^\/+/, ""), f.sha256.toLowerCase()]));
  const out: ReleaseMismatch[] = [];
  for (const a of loaded) {
    const path = a.path.replace(/^\/+/, "");
    const expected = byPath.get(path);
    if (expected === undefined) out.push({ kind: "unlisted", path, actual: a.sha256 });
    else if (expected !== a.sha256.toLowerCase()) out.push({ kind: "changed", path, expected, actual: a.sha256 });
  }
  return out;
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64.trim().replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

/** A release key's short name: the first 8 bytes of SHA-256(raw key), "AB12 CD34 EF56 7890". */
export async function releaseKeyId(keyB64: string): Promise<string> {
  const raw = b64ToBytes(keyB64);
  if (!raw) return "?";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", raw)).slice(0, 8);
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase().match(/.{4}/g)!.join(" ");
}

/** Ed25519 over the exact bytes. null: this browser has no Ed25519 in WebCrypto. */
export async function verifyRelease(bytes: Uint8Array<ArrayBuffer>, sigB64: string, keyB64: string): Promise<boolean | null> {
  const key = b64ToBytes(keyB64);
  const sig = b64ToBytes(sigB64);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  let imported: CryptoKey;
  try { imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]); } catch { return null; }
  try { return await crypto.subtle.verify({ name: "Ed25519" }, imported, sig, bytes); } catch { return false; }
}

/** The pin for `origin`: the build's key, else the one stored on first use. */
export function loadReleasePin(origin: string, storage: Storage | null, buildKey = BUILD_RELEASE_KEY): ReleasePin | null {
  if (buildKey) return { key: buildKey, pinnedAt: 0, source: "build" };
  try {
    const all = JSON.parse(storage?.getItem(RELEASE_PIN_STORE) ?? "{}") as Record<string, { key?: unknown; pinnedAt?: unknown }>;
    const p = all[origin];
    return p && typeof p.key === "string" && p.key ? { key: p.key, pinnedAt: Number(p.pinnedAt) || 0, source: "first-use" } : null;
  } catch { return null; }
}

export function saveReleasePin(origin: string, key: string, storage: Storage | null, now = Date.now()): void {
  try {
    const all = JSON.parse(storage?.getItem(RELEASE_PIN_STORE) ?? "{}") as Record<string, unknown>;
    all[origin] = { key, pinnedAt: now };
    storage?.setItem(RELEASE_PIN_STORE, JSON.stringify(all));
  } catch { /* storage denied: no pin, the next visit is a first visit again */ }
}

export type ReleaseInput = {
  /** The manifest's exact bytes (null: not served). */
  manifest: Uint8Array<ArrayBuffer> | null;
  /** The detached signature, b64 (null: not served). */
  signature: string | null;
  /** The key the server presents, b64 (null: not served). */
  servedKey: string | null;
  pin: ReleasePin | null;
  /** Loaded scripts and styles: path (no leading "/") and SHA-256 hex. */
  assets: ReadonlyArray<{ path: string; sha256: string }>;
  now?: number;
  verify?: typeof verifyRelease;
};

/**
 * The decision, pure (the fetching is `checkRelease`). `pinNow` is the key to
 * pin when this was a first use that verified.
 */
export async function decideRelease(input: ReleaseInput): Promise<{ state: ReleaseState; pinNow: string | null }> {
  const verify = input.verify ?? verifyRelease;
  if (!input.manifest) return { state: { state: "unavailable" }, pinNow: null };
  const manifest = parseReleaseManifest(input.manifest);
  if (!manifest) return { state: { state: "unavailable" }, pinNow: null };
  const mismatches = compareRelease(manifest, input.assets);
  const pin = input.pin;
  const servedKey = input.servedKey?.trim() || null;
  if (pin && servedKey && servedKey !== pin.key) {
    return { state: { state: "key-changed", pinnedId: await releaseKeyId(pin.key), servedId: await releaseKeyId(servedKey), served: servedKey }, pinNow: null };
  }
  const signature = input.signature?.trim() || null;
  if (!signature) {
    // An origin that signed before and stopped: someone else's build is running.
    if (pin) return { state: { state: "modified", reason: "unsigned", manifest, keyId: await releaseKeyId(pin.key), mismatches }, pinNow: null };
    return { state: { state: "unsigned", manifest, mismatches }, pinNow: null };
  }
  const key = pin?.key ?? servedKey;
  if (!key) return { state: { state: "unsigned", manifest, mismatches }, pinNow: null };
  const ok = await verify(input.manifest, signature, key);
  if (ok === null) return { state: { state: "unverifiable", manifest }, pinNow: null };
  const keyId = await releaseKeyId(key);
  if (!ok) return { state: { state: "modified", reason: "bad-signature", manifest, keyId, mismatches }, pinNow: null };
  if (mismatches.length) return { state: { state: "modified", reason: "assets", manifest, keyId, mismatches }, pinNow: null };
  const now = input.now ?? Date.now();
  const firstUse = !pin;
  return {
    state: { state: "signed", manifest, keyId, pin: pin ?? { key, pinnedAt: now, source: "first-use" }, checked: now, firstUse },
    pinNow: firstUse ? key : null,
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The scripts and styles this page loaded, hashed (fetched again — from the HTTP cache when it has them). */
export async function hashLoadedCode(paths = loadedAssets(), fetcher: typeof fetch = fetch): Promise<Array<{ path: string; sha256: string }>> {
  const code = paths.filter((p) => /\.(m?js|css)$/.test(p));
  const out: Array<{ path: string; sha256: string }> = [];
  for (const path of code) {
    try {
      const res = await fetcher(path, { cache: "force-cache" });
      if (!res.ok) { out.push({ path: path.replace(/^\/+/, ""), sha256: `http-${res.status}` }); continue; }
      out.push({ path: path.replace(/^\/+/, ""), sha256: await sha256Hex(await res.arrayBuffer()) });
    } catch { /* offline: not counted either way */ }
  }
  return out;
}

async function fetchBytes(fetcher: typeof fetch, path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const res = await fetcher(`${path}?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
}
async function fetchText(fetcher: typeof fetch, path: string): Promise<string | null> {
  const b = await fetchBytes(fetcher, path);
  if (!b) return null;
  const s = new TextDecoder().decode(b).trim();
  // An SPA fallback answers unknown paths with index.html — that is not a key or a signature.
  return /^[A-Za-z0-9+/=_-]{16,200}$/.test(s) ? s : null;
}

/** Fetches the release manifest, its signature and key, hashes the loaded code and decides; pins on a verified first use. */
export async function checkRelease(env: { fetcher?: typeof fetch; storage?: Storage | null; origin?: string; assets?: Array<{ path: string; sha256: string }>; now?: number } = {}): Promise<ReleaseState> {
  const fetcher = env.fetcher ?? fetch;
  const origin = env.origin ?? (typeof location !== "undefined" ? location.origin : "");
  let storage: Storage | null = null;
  try { storage = env.storage !== undefined ? env.storage : (typeof localStorage !== "undefined" ? localStorage : null); } catch { storage = null; }
  const manifest = await fetchBytes(fetcher, RELEASE_MANIFEST_PATH);
  if (!manifest || !parseReleaseManifest(manifest)) return { state: "unavailable" };
  const [signature, servedKey] = await Promise.all([fetchText(fetcher, RELEASE_SIG_PATH), fetchText(fetcher, RELEASE_KEY_PATH)]);
  const assets = env.assets ?? await hashLoadedCode(undefined, fetcher);
  const { state, pinNow } = await decideRelease({ manifest, signature, servedKey, pin: loadReleasePin(origin, storage), assets, now: env.now });
  if (pinNow) saveReleasePin(origin, pinNow, storage, env.now);
  return state;
}

/** The user trusts the key the server presents now (a key rotation the developer announced). */
export function acceptServedReleaseKey(key: string, env: { storage?: Storage | null; origin?: string; now?: number } = {}): void {
  const origin = env.origin ?? (typeof location !== "undefined" ? location.origin : "");
  let storage: Storage | null = null;
  try { storage = env.storage !== undefined ? env.storage : localStorage; } catch { storage = null; }
  saveReleasePin(origin, key, storage, env.now);
}

/* ---- the page's one release state (the banner and the security panel share it) ---- */

let current: ReleaseState | null = null;
let running: Promise<ReleaseState> | null = null;
let lastRun = 0;
const listeners = new Set<(s: ReleaseState | null) => void>();

export function currentReleaseState(): ReleaseState | null { return current; }

export function onReleaseState(fn: (s: ReleaseState | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Runs the check (at most once a minute unless `force`); a development build has no release. */
export function runReleaseCheck(force = false): Promise<ReleaseState> {
  if (APP_BUILD === "dev" && !force) {
    current = { state: "unavailable" };
    return Promise.resolve(current);
  }
  if (running) return running;
  if (!force && current && Date.now() - lastRun < 60_000) return Promise.resolve(current);
  lastRun = Date.now();
  running = checkRelease().catch((): ReleaseState => ({ state: "unavailable" })).then((s) => {
    current = s;
    for (const fn of listeners) fn(s);
    return s;
  }).finally(() => { running = null; });
  return running;
}

/** Test seam. */
export function _resetReleaseStateForTests(): void { current = null; running = null; lastRun = 0; listeners.clear(); }
