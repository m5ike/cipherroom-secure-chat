// @vitest-environment node
//
// The operator's client configuration on the server (server/client-config.ts):
// stored atomically, re-read when another instance writes it, served to
// every client without secrets, changed only by an operator — and the vault
// part that holds a user's saved connections.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ClientConfigStore, registerAdminClientConfigRoutes, registerClientConfigRoutes } from "../server/client-config";
import { requireAdminToken } from "../server/admin-auth";
import { AccountStore } from "../server/accounts/store";

let dir = "";
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-cc-"));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_API_TOKEN = "owner-token-0123456789abcdef";
  process.env.ADMIN_TOKENS = "ann:auditor:auditor-token-0123456789ab";
});
afterEach(() => { process.env = { ...saved }; rmSync(dir, { recursive: true, force: true }); });

describe("the store", () => {
  it("returns the defaults, saves sanitized, and sees a write by another process", () => {
    const store = new ClientConfigStore();
    expect(store.get().connections.enabled).toBe(true);
    const r = store.set({ connections: { enabled: false, servers: [{ url: "ws://evil.example" }] }, appearance: { defaultTheme: "windows" } }, 1234);
    expect(r).toMatchObject({ ok: true, config: { updatedAt: 1234, connections: { enabled: false, servers: [] }, appearance: { defaultTheme: "windows" } } });
    expect(statSync(join(dir, "client-config.json")).mode & 0o077).toBe(0);
    // Another instance rewrites the file: the next read notices.
    writeFileSync(join(dir, "client-config.json"), JSON.stringify({ appearance: { defaultTheme: "ios" } }));
    expect(store.get().appearance.defaultTheme).toBe("ios");
  });
});

async function server() {
  const app = express();
  app.use(express.json());
  registerClientConfigRoutes(app);
  app.use("/api/admin", requireAdminToken());
  registerAdminClientConfigRoutes(app, () => ({ accounts: 3, withConnections: 1, savedConnections: 4 }));
  const http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => http.close(r)) };
}

describe("the routes", () => {
  it("serve the config publicly and let only an operator change it", async () => {
    const s = await server();
    try {
      const pub = await (await fetch(`${s.base}/api/client-config`)).json();
      expect(pub.config.appearance.defaultTheme).toBe("motorsport");
      expect(Object.keys(pub)).toEqual(["ok", "config"]); // no usage, no file path

      const put = (token: string) => fetch(`${s.base}/api/admin/client-config`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: { appearance: { themes: ["ios"], defaultTheme: "ios", lockTheme: true } } }),
      });
      expect((await put("auditor-token-0123456789ab")).status).toBe(403);
      const ok = await put("owner-token-0123456789abcdef");
      expect(ok.status).toBe(200);
      const admin = await (await fetch(`${s.base}/api/admin/client-config`, { headers: { Authorization: "Bearer auditor-token-0123456789ab" } })).json();
      expect(admin).toMatchObject({ config: { appearance: { lockTheme: true } }, usage: { savedConnections: 4 } });
      expect(admin.catalog.themes.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["ios", "windows", "aurora"]));
    } finally {
      await s.close();
    }
  });
});

describe("the vault part for saved connections", () => {
  it("stores sealed text and a count, refuses junk and oversize", () => {
    const store = new AccountStore(join(dir, "accounts"));
    const r = store.create({ credentialId: "cred-cx-000000000001", publicKeyJwk: { kty: "EC" }, alg: -7, signCount: 0 }, "Alice");
    if (!r.ok) throw new Error(r.reason);
    const id = r.account.id;
    expect(store.putVault(id, { connections: { ct: "not base64 !!", count: 1 } })).toMatchObject({ ok: false });
    expect(store.putVault(id, { connections: { ct: "A".repeat(1_600_000), count: 1 } })).toMatchObject({ ok: false });
    expect(store.putVault(id, { connections: { ct: Buffer.from("sealed").toString("base64"), count: 7 } })).toEqual({ ok: true });
    expect(store.getVault(id).connections?.ct).toBe(Buffer.from("sealed").toString("base64"));
    expect(store.summary(id)).toMatchObject({ vault: { connections: 7, connectionsBytes: 8 } });
  });
});
