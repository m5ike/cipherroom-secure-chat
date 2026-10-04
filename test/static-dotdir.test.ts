// @vitest-environment node
// Production static files from an install path with a dot-directory (6.7,
// audit S6). res.sendFile(<absolute path>) let `send` judge dotfiles on the
// whole path, so under ~/.m5cet or .claude/worktrees every precompressed
// asset and the index.html fallback answered 404 (a blank app, and 53 of 72
// E2E tests failing in agent worktrees). Now the files are sent relative to
// their root: the install path may contain dots, the requested part may not.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { brotliCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic } from "../server/static";

const root = mkdtempSync(join(tmpdir(), "m5static-"));
const dist = join(root, ".hidden-install", "dist", "public");
let server: Server;
let base = "";

beforeAll(async () => {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>M5cet</title>");
  writeFileSync(join(dist, "assets", "app-AbCdEf12.js"), "console.log('app')");
  writeFileSync(join(dist, "assets", "app-AbCdEf12.js.br"), brotliCompressSync(Buffer.from("console.log('app')")));
  writeFileSync(join(dist, "assets", ".secret.js"), "secret");
  writeFileSync(join(dist, "assets", ".secret.js.br"), brotliCompressSync(Buffer.from("secret")));
  const app = express();
  serveStatic(app, dist);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

describe("S6 — static files under a dot-directory", () => {
  it("serves a precompressed asset", async () => {
    const res = await fetch(`${base}/assets/app-AbCdEf12.js`, { headers: { "Accept-Encoding": "br" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(await res.text()).toBe("console.log('app')");
  });

  it("serves the index.html fallback for a deep link", async () => {
    const res = await fetch(`${base}/room/abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>M5cet</title>");
  });

  it("still refuses a dotfile that the URL asks for", async () => {
    const res = await fetch(`${base}/assets/.secret.js`, { headers: { "Accept-Encoding": "br" } });
    expect(await res.text()).not.toBe("secret");
    const traversal = await fetch(`${base}/assets/..%2f..%2fpublic%2findex.html`, { headers: { "Accept-Encoding": "br" } });
    expect(traversal.status).not.toBe(500);
  });
});
