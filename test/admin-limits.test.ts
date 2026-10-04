// @vitest-environment node
// The main service's /api/admin limits and large bodies (6.7, audit S4).
// Before: the 8 MB design and 1 MB menu parsers ran before any limit or token
// check, and a bearer that merely started with "m5f1." skipped both console
// limiters (bucketed by the unverified model name in its payload).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FUNCTIONS_ADM_KEY_FILE = join(mkdtempSync(join(tmpdir(), "m5adm-lim-")), "functions-adm.key");
process.env.ADMIN_API_TOKEN = "admin-limits-test-token-0123456789";

const { mountAdminRequestGuards, functionClaimsOf } = await import("../server/admin-limits");
const { mintAdmToken } = await import("../server/functions/adm-token");

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.set("trust proxy", false);
  mountAdminRequestGuards(app);
  // Stands in for the real routes: says whether the body was parsed.
  app.use("/api/admin", (req, res) => {
    const claims = functionClaimsOf(req);
    if (!claims && req.header("authorization") !== `Bearer ${process.env.ADMIN_API_TOKEN}`) return res.status(401).json({ ok: false });
    res.json({ ok: true, parsed: req.body !== undefined, fn: claims?.model ?? null });
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

describe("S4 — large admin bodies are read only after the guard", () => {
  it("an unauthenticated design upload is refused before its body is parsed", async () => {
    // Malformed JSON: a parser that ran first would answer 400, not 401.
    const res = await fetch(`${base}/api/admin/android/design`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: `{"screens": ${"x".repeat(2 * 1024 * 1024)}` });
    expect(res.status).toBe(401);
    const menu = await fetch(`${base}/api/admin/menu-config`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer m5f1.forged.payload" }, body: "{not json" });
    expect(menu.status).toBe(401);
  });

  it("an administrator's body is parsed as before", async () => {
    const res = await fetch(`${base}/api/admin/android/design`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}` }, body: JSON.stringify({ blob: "y".repeat(2 * 1024 * 1024) }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ parsed: true });
  });
});

describe("S4 — a token prefix does not skip the limits", () => {
  it("forged m5f1. bearers with rotating model names hit the refused-request limit", async () => {
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const fake = `m5f1.${Buffer.from(JSON.stringify({ m: `model-${i}` })).toString("base64url")}.sig`;
      const res = await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${fake}` } });
      if (res.status === 429) limited++;
      else expect(res.status).toBe(401);
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("a verified function token still gets its own bucket, keyed by its signed model", async () => {
    const token = mintAdmToken({ role: "auditor", areas: ["overview"] }, { model: "real-model", caller: "t" }, 60_000);
    const res = await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${token}` } });
    // The console's refused bucket is spent (previous test) — a real function is not in it.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fn: "real-model" });
  });
});
