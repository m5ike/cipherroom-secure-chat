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

import { APP_BUILD, APP_LIBS, APP_PROTOCOL, APP_VERSION } from "./build-info";

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
  // Stored configuration and sessions.
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
  // The HTTP cache, including cross-origin libraries (web fonts).
  try { await fetch("/api/clear-site-data", { method: "POST", cache: "no-store" }); } catch { /* offline */ }
  // A fresh document: the query defeats any cached index.html on the way.
  const url = new URL(location.href);
  url.searchParams.set("refresh", Date.now().toString(36));
  url.hash = "";
  location.replace(url.toString());
}
