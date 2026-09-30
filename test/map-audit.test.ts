// @vitest-environment node
// 6.2: the map preview's policy and tile proxy, and hide/delete of a message
// recorded in the audit journal (category "message") — never its content.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "m5map-"));

const { sanitizeMapPreview, normalizeTileTemplate, DEFAULT_MAP_PREVIEW, sanitizeClientConfig } = await import("../client/src/lib/client-config");
const { sanitizeMessageAudit, registerMessageAuditRoutes } = await import("../server/message-audit");
const { registerMapTileRoutes, tileUrl } = await import("../server/map-tiles");
const { clientConfigStore } = await import("../server/client-config");
const { audit } = await import("../server/monitor/audit");

describe("map preview policy", () => {
  it("fills the defaults and keeps a valid provider", () => {
    expect(sanitizeMapPreview(undefined)).toEqual(DEFAULT_MAP_PREVIEW);
    expect(sanitizeClientConfig({}).map).toEqual(DEFAULT_MAP_PREVIEW);
    const m = sanitizeMapPreview({ tiles: "https://{s}.tiles.example/{z}/{x}/{y}.png", subdomains: "abc", zoom: 25, width: 10, height: 9999, pinColor: "#ABCDEF", accent: "", grayscale: true, attribution: "<b>© Me</b>" });
    expect(m.tiles).toBe("https://{s}.tiles.example/{z}/{x}/{y}.png");
    expect(m.subdomains).toBe("abc");
    expect([m.zoom, m.width, m.height]).toEqual([19, 160, 480]);
    expect(m.pinColor).toBe("#abcdef");
    expect(m.accent).toBe("");
    expect(m.grayscale).toBe(true);
    expect(m.attribution).toBe("b© Me/b");
  });

  it("refuses providers the server should not fetch", () => {
    expect(normalizeTileTemplate("http://tiles.example/{z}/{x}/{y}.png")).toBeNull();
    expect(normalizeTileTemplate("https://user:pw@tiles.example/{z}/{x}/{y}.png")).toBeNull();
    expect(normalizeTileTemplate("https://tiles.example/{z}/{x}.png")).toBeNull();
    expect(normalizeTileTemplate("ftp://tiles.example/{z}/{x}/{y}")).toBeNull();
    expect(normalizeTileTemplate("http://localhost:8080/{z}/{x}/{y}.png")).toBe("http://localhost:8080/{z}/{x}/{y}.png");
    expect(sanitizeMapPreview({ tiles: "javascript:alert(1)//{z}{x}{y}" }).tiles).toBe(DEFAULT_MAP_PREVIEW.tiles);
  });

  it("builds the upstream URL with a subdomain", () => {
    expect(tileUrl("https://{s}.t.example/{z}/{x}/{y}.png", "abc", 3, 1, 1)).toBe("https://c.t.example/3/1/1.png");
    expect(tileUrl("https://t.example/{z}/{x}/{y}.png", "", 16, 35412, 22190)).toBe("https://t.example/16/35412/22190.png");
  });
});

describe("message audit input", () => {
  it("keeps only what the journal may hold", () => {
    const now = Date.now();
    const a = sanitizeMessageAudit({ action: "hide", messageId: "msg-1a2b", room: "team", until: now + 3_600_000, kinds: ["text", "tap", "bogus"], mine: false, at: now, text: "secret body" });
    expect(a).toEqual({ action: "hide", messageId: "msg-1a2b", room: "team", until: now + 3_600_000, kinds: ["text", "tap"], mine: false, at: now });
    expect(a).not.toHaveProperty("text");
    expect(sanitizeMessageAudit({ action: "erase", messageId: "m", room: "r" })).toBeNull();
    expect(sanitizeMessageAudit({ action: "delete", messageId: "../x y", room: "r" })).toBeNull();
    expect(sanitizeMessageAudit({ action: "delete", messageId: "m1", room: "" })).toBeNull();
  });
});

describe("routes", () => {
  let server: Server;
  let base = "";
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerMessageAuditRoutes(app);
    registerMapTileRoutes(app);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); globalThis.fetch = realFetch; });

  it("records a delete in the journal without the message", async () => {
    const res = await realFetch(`${base}/api/chat/message-audit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", messageId: "msg-42", room: "Team Room", kinds: ["file"], mine: true, client: "c1", text: "never stored" }),
    });
    expect(res.status).toBe(200);
    const entry = audit.recent({ category: "message" }).find((e) => e.event === "message.delete");
    expect(entry).toBeTruthy();
    expect(entry!.actor).toBe("guest:c1");
    expect(entry!.roomHash).toBeTruthy();
    expect(entry!.roomHash).not.toContain("Team");
    expect(JSON.stringify(entry)).not.toContain("never stored");
    expect(entry!.detail).toMatchObject({ messageId: "msg-42", via: "web", mine: true, kinds: ["file"] });
  });

  it("records a batch of hides and refuses junk", async () => {
    const until = Date.now() + 900_000;
    const ok = await realFetch(`${base}/api/chat/message-audit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actions: [{ action: "hide", messageId: "a1", room: "r", until }, { action: "hide", messageId: "a2", room: "r", until: 0 }] }) });
    expect(await ok.json()).toMatchObject({ ok: true, recorded: 2 });
    const bad = await realFetch(`${base}/api/chat/message-audit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "nope" }) });
    expect(bad.status).toBe(400);
  });

  it("proxies a tile once, then serves it from the cache", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000", "hex");
    const upstream = vi.fn(async () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } }));
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => String(url).startsWith(base) ? realFetch(url, init) : upstream()) as typeof fetch;
    const first = await realFetch(`${base}/api/map/tile/16/35412/22190.png`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(png);
    const second = await realFetch(`${base}/api/map/tile/16/35412/22190`);
    expect(second.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("refuses tiles out of range, and all tiles when previews are off", async () => {
    expect((await realFetch(`${base}/api/map/tile/20/0/0`)).status).toBe(400);
    expect((await realFetch(`${base}/api/map/tile/2/4/0`)).status).toBe(400);
    expect((await realFetch(`${base}/api/map/tile/a/b/c`)).status).toBe(400);
    const saved = clientConfigStore.set({ ...clientConfigStore.get(), map: { ...clientConfigStore.get().map, enabled: false } });
    expect(saved.ok).toBe(true);
    expect((await realFetch(`${base}/api/map/tile/3/1/1`)).status).toBe(404);
    clientConfigStore.set({ ...clientConfigStore.get(), map: { ...clientConfigStore.get().map, enabled: true } });
  });
});
