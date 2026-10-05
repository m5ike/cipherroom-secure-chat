// The interception of the server origin (Electron glue around router.ts).
//
// protocol.handle("https") on the page's own session partition sees every
// http(s) request of the page — documents, scripts, workers, the service
// worker script, fetch() — but not WebSockets. For the chosen server the
// router decides: the client's files from the bundle inside the app (with the
// server's security headers), everything else to the network unchanged
// (session.fetch with bypassCustomProtocolHandlers — same cookies, same
// proxy, same certificate checks). Other origins pass straight through.
//
// A second guard on webRequest (it knows the resource type, which the
// protocol handler does not) cancels any request that would execute code of
// the server origin from the network: a document, frame, script, style or
// worker that the router did not answer from the bundle (the sandboxed
// /fn-sandbox.html frame excepted).

import type { Session } from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asarHashesFromHeader, asarHeaderLength, type AsarHashes } from "./asar-integrity";
import { answerBundled } from "./bundle";
import { guardNetworkDocument, mayLoadExecutable, route, safePath, type RouteMode } from "./router";

export type WebIndex = {
  app: string;
  version: string;
  build: string;
  files: Record<string, { size: number; sha256: string }>;
};

export type WebBundle = {
  /** The directory with the client's files (inside app.asar). */
  root: string;
  index: WebIndex;
  files: ReadonlySet<string>;
  /** The bundled /version-manifest.json, parsed (the version check compares it). */
  versionManifest: Record<string, unknown>;
  /** SHA-256 of each file from the (Electron-verified) app.asar header; null when not packaged. */
  hashes: AsarHashes | null;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The hashes of the asar the app runs from (read raw, past Electron's asar layer), or null when unpackaged. */
async function readAsarHashes(asarPath: string): Promise<AsarHashes | null> {
  if (!asarPath.endsWith(".asar")) return null;
  // original-fs: Node's fs without Electron's asar redirection — the archive's own bytes.
  const ofs = (await import("original-fs")) as unknown as typeof import("node:fs");
  const fd = ofs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    ofs.readSync(fd, head, 0, 16, 0);
    const len = asarHeaderLength(head);
    const json = Buffer.alloc(len);
    ofs.readSync(fd, json, 0, len, 16);
    return asarHashesFromHeader(json.toString("utf8"));
  } finally {
    ofs.closeSync(fd);
  }
}

/**
 * Loads the bundle's index. `asarPath`: app.getAppPath() — in a packaged app
 * the archive, whose header gives every file's hash: the index itself and each
 * served file are checked against it (a tampered byte is refused, not served).
 */
export async function loadBundle(root: string, asarPath = ""): Promise<WebBundle> {
  const raw = await readFile(join(root, "..", "web-index.json"));
  const hashes = await readAsarHashes(asarPath);
  if (hashes && hashes.get("web-index.json") !== sha256(raw)) throw new Error("web-index.json does not match the app's signed archive");
  const index = JSON.parse(raw.toString("utf8")) as WebIndex;
  const files = new Set(Object.keys(index.files));
  if (!files.has("/index.html")) throw new Error("the bundled client has no index.html");
  if (hashes) for (const f of files) if (!hashes.has(`web${f}`)) throw new Error(`bundled file not in the archive: ${f}`);
  let versionManifest: Record<string, unknown> = {};
  try { versionManifest = JSON.parse(await readFile(join(root, "version-manifest.json"), "utf8")) as Record<string, unknown>; } catch { /* a development build has none */ }
  return { root, index, files, versionManifest, hashes };
}

export type Target = { origin: string; mode: RouteMode };

const lower = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => { out[name.toLowerCase()] = value; });
  return out;
};

export class Interceptor {
  private target: Target | null = null;
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  /** What was refused (for the log; never bodies). */
  readonly refused: Array<{ at: number; url: string; reason: string }> = [];
  /** How many requests each way went (the self-test reports them). */
  readonly stats = { bundled: 0, network: 0, blocked: 0, passthrough: 0 };

  constructor(
    private readonly ses: Session,
    private readonly bundle: WebBundle,
    private readonly securityHeaders: (target: Target) => Record<string, string>,
  ) {}

  setTarget(target: Target | null): void {
    this.target = target;
  }

  getTarget(): Target | null {
    return this.target;
  }

  install(): void {
    const handler = (req: Request) => this.handle(req);
    this.ses.protocol.handle("https", handler);
    // http only matters for a loopback development server (M5CET_ALLOW_LOOPBACK); other http passes through.
    this.ses.protocol.handle("http", handler);
    this.ses.webRequest.onBeforeRequest({ urls: ["https://*/*", "http://*/*"] }, (details, callback) => {
      const t = this.target;
      if (!t || t.mode !== "bundled") return callback({});
      let url: URL;
      try { url = new URL(details.url); } catch { return callback({ cancel: true }); }
      if (url.origin !== t.origin) return callback({});
      const document = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      const decision = route({ url: details.url, method: details.method, headers: document ? { accept: "text/html" } : {} }, { origin: t.origin, mode: t.mode, files: this.bundle.files });
      const path = safePath(url.pathname) ?? url.pathname;
      if (!mayLoadExecutable(details.resourceType, decision, path)) {
        this.note(details.url, `executable:${details.resourceType}`);
        return callback({ cancel: true });
      }
      return callback({});
    });
  }

  private note(url: string, reason: string): void {
    // The path only — a query may carry an id.
    let shown = url;
    try { const u = new URL(url); shown = `${u.origin}${u.pathname}`; } catch { /* keep */ }
    this.refused.push({ at: Date.now(), url: shown, reason });
    if (this.refused.length > 200) this.refused.shift();
    console.warn(`[m5cet] refused ${shown} (${reason})`);
  }

  /**
   * To the network, unchanged. A redirect answered by the SERVER (bundled mode)
   * is refused instead of followed: Electron's fetch would follow it here and
   * hand the page the target's content under the original URL — another
   * route than the router decided. M5cet's API never redirects. Other origins
   * (tiles, fonts) and a server whose web code the user chose follow
   * redirects as a browser does.
   */
  private pass(req: Request, serverOrigin = false): Promise<Response> {
    return this.ses.fetch(req, { bypassCustomProtocolHandlers: true, redirect: serverOrigin ? "error" : "follow" } as RequestInit & { bypassCustomProtocolHandlers: boolean });
  }

  async handle(req: Request): Promise<Response> {
    const t = this.target;
    if (!t) { this.stats.passthrough += 1; return this.pass(req); }
    const headers = lower(req.headers);
    const decision = route({ url: req.url, method: req.method, headers }, { origin: t.origin, mode: t.mode, files: this.bundle.files });
    if (decision.kind === "bundle") { this.stats.bundled += 1; return this.serve(decision.file, req.method, headers.range, t); }
    if (decision.kind === "block") {
      this.stats.blocked += 1;
      this.note(req.url, decision.reason);
      return new Response(decision.status === 404 ? "Not found" : "Refused by M5cet Desktop", {
        status: decision.status,
        headers: { ...this.securityHeaders(t), "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    this.stats.network += 1;
    let sameOrigin = false;
    try { sameOrigin = new URL(req.url).origin === t.origin; } catch { /* not a URL: the router refused it */ }
    const res = await this.pass(req, sameOrigin && t.mode === "bundled");
    if (decision.document && t.mode === "bundled") {
      let path = "/";
      try { path = safePath(new URL(req.url).pathname) ?? "/"; } catch { /* keep "/" */ }
      if (sameOrigin) {
        const guard = guardNetworkDocument(path, res.status, lower(res.headers));
        if (!guard.ok) {
          try { await res.body?.cancel(); } catch { /* already closed */ }
          this.note(req.url, `document:${guard.reason}`);
          return new Response("This page is not part of the M5cet app.", {
            status: 403,
            headers: { ...this.securityHeaders(t), "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      }
    }
    return res;
  }

  private async read(file: string): Promise<Buffer> {
    const hit = this.cache.get(file);
    if (hit) return hit;
    // `file` is a key of the bundle's index (router.ts checked membership) — never a path from the request.
    const body = await readFile(join(this.bundle.root, ...file.split("/").filter(Boolean)));
    const expected = this.bundle.hashes?.get(`web${file}`) ?? this.bundle.index.files[file]?.sha256;
    if (!expected || sha256(body) !== expected) {
      this.note(file, "integrity");
      throw new Error(`bundled file does not match the signed archive: ${file}`);
    }
    if (body.length < 4 * 1024 * 1024 && this.cacheBytes + body.length < 64 * 1024 * 1024) {
      this.cache.set(file, body);
      this.cacheBytes += body.length;
    }
    return body;
  }

  private async serve(file: string, method: string, range: string | undefined, t: Target): Promise<Response> {
    let body: Buffer;
    try { body = await this.read(file); } catch (err) {
      console.error(`[m5cet] bundled file unreadable: ${file}`, (err as Error).message);
      return new Response("Bundled file unavailable", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const answer = answerBundled(file, body.length, method, range, this.securityHeaders(t));
    const slice = answer.slice ? (body.buffer.slice(body.byteOffset + answer.slice.start, body.byteOffset + answer.slice.end + 1) as ArrayBuffer) : null;
    return new Response(slice, { status: answer.status, headers: answer.headers });
  }
}
