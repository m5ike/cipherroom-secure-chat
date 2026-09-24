// @vitest-environment node
//
// The app's menu as data (4.0): client/src/lib/menu-config.ts validates what
// the console's Menu builder sends, server/menu-config.ts stores it and serves
// it to every client, and renders the builder's preview.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_MENU_CONFIG, MENU_LIMITS, nodeModule, sanitizeMenuConfig, sanitizeStyle, walkNodes, type MenuNode,
} from "../client/src/lib/menu-config";
import { MenuConfigStore, registerAdminMenuConfigRoutes, registerMenuConfigRoutes, renderPreview } from "../server/menu-config";
import { requireAdminToken } from "../server/admin-auth";
import { moduleOfPanel } from "../client/src/lib/modules";

let dir = "";
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "m5cet-menu-"));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_API_TOKEN = "owner-token-0123456789abcdef";
  process.env.ADMIN_TOKENS = "ann:auditor:auditor-token-0123456789ab";
});
afterEach(() => { process.env = { ...saved }; rmSync(dir, { recursive: true, force: true }); });

const ids = (nodes: MenuNode[]) => { const out: string[] = []; walkNodes(nodes, (n) => out.push(n.id)); return out; };

describe("sanitizeMenuConfig", () => {
  it("keeps the classic menu exactly as it is", () => {
    expect(sanitizeMenuConfig(DEFAULT_MENU_CONFIG)).toEqual(DEFAULT_MENU_CONFIG);
    expect(sanitizeMenuConfig(JSON.parse(JSON.stringify(DEFAULT_MENU_CONFIG)))).toEqual(DEFAULT_MENU_CONFIG);
    // Junk → the classic menu.
    expect(sanitizeMenuConfig(null)).toEqual(DEFAULT_MENU_CONFIG);
    expect(sanitizeMenuConfig("x")).toEqual(DEFAULT_MENU_CONFIG);
  });

  it("drops what the app cannot draw safely: unknown kinds, panels, functions, icons and links", () => {
    const c = sanitizeMenuConfig({
      items: [
        { kind: "script", id: "x" },
        { kind: "item", id: "a", icon: "not-an-icon", label: "A", action: { type: "url", href: "javascript:alert(1)" } },
        { kind: "item", id: "b", icon: "star", label: "B", action: { type: "panel", panel: "admin" } },
        { kind: "item", id: "c", icon: "star", label: "C", action: { type: "fn", fn: "eval" } },
        { kind: "item", id: "d", icon: "star", label: "D", action: { type: "url", href: "//evil.example/x" } },
        { kind: "item", id: "e", icon: "star", label: "E", action: { type: "url", href: "https://example.org/help", newTab: true } },
        { kind: "item", id: "f", icon: "star", label: "F", action: { type: "fn", fn: "setLang", param: "de" } },
        { kind: "special", id: "g", special: "self-destruct" },
      ],
    });
    expect(c.items.map((n) => n.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    const actions = c.items.map((n) => (n.kind === "item" ? n.action : null));
    expect(actions).toEqual([
      { type: "none" }, { type: "none" }, { type: "none" }, { type: "none" },
      { type: "url", href: "https://example.org/help", newTab: true },
      { type: "fn", fn: "setLang", param: "de" },
    ]);
    expect(c.items[0]).toMatchObject({ icon: "circle-alert" });
  });

  it("makes ids unique and valid, and keeps the nesting the app knows", () => {
    const c = sanitizeMenuConfig({
      items: [
        { kind: "section", id: "Room!", label: "R", children: [
          { kind: "section", id: "inner", label: "no sections in sections", children: [] },
          { kind: "row", id: "r", children: [{ kind: "row", id: "r2", children: [] }, { kind: "special", id: "t", special: "toneToggle" }] },
          { kind: "item", id: "dup", icon: "star", label: "1", action: { type: "none" } },
        ] },
        { kind: "item", id: "dup", icon: "star", label: "2", action: { type: "none" } },
      ],
    });
    const all = ids(c.items);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    const section = c.items[0];
    expect(section.kind).toBe("section");
    if (section.kind !== "section") return;
    expect(section.children.map((n) => n.kind)).toEqual(["row", "item"]);
    const row = section.children[0];
    if (row.kind === "row") expect(row.children.map((n) => n.kind)).toEqual(["special"]);
  });

  it("limits the size: nodes, text and the panel width", () => {
    const many = Array.from({ length: MENU_LIMITS.nodes + 50 }, (_, i) => ({ kind: "separator", id: `s${i}`, variant: "line" }));
    const c = sanitizeMenuConfig({ items: many, footer: [], panel: { width: 9999, title: "x".repeat(500) } });
    expect(c.items.length).toBe(MENU_LIMITS.nodes);
    expect(c.panel.width).toBe(MENU_LIMITS.width[1]);
    expect(c.panel.title.length).toBe(MENU_LIMITS.label);
    const html = sanitizeMenuConfig({ items: [{ kind: "html", id: "h", html: "y".repeat(MENU_LIMITS.html + 10) }] });
    expect(html.items[0].kind === "html" && html.items[0].html.length).toBe(MENU_LIMITS.html);
  });

  it("keeps a style's known values in range, and its states", () => {
    expect(sanitizeStyle({
      color: "#12ab34", background: "red", iconColor: "primary", borderColor: "url(x)", fontSize: 400, opacity: -1, scale: 3,
      fontFamily: "Comic Sans", fontWeight: "900", align: "center", wrap: "ellipsis", shadow: "glow",
      states: { hover: { background: "accent", scale: 1.05, color: "expression(alert(1))" }, bogus: { color: "#fff" }, focus: {} },
    })).toEqual({
      color: "#12ab34", iconColor: "primary", fontSize: 40, opacity: 0, scale: 1.2, align: "center", wrap: "ellipsis", shadow: "glow",
      states: { hover: { background: "accent", scale: 1.05 } },
    });
  });

  it("knows which module a node needs", () => {
    const panelItem: MenuNode = { kind: "item", id: "x", icon: "star", label: "", action: { type: "panel", panel: "ai" } };
    expect(nodeModule(panelItem, moduleOfPanel)).toBe("ai");
    expect(nodeModule({ ...panelItem, module: "files" }, moduleOfPanel)).toBe("files");
    expect(nodeModule({ kind: "special", id: "e", special: "editMode" }, moduleOfPanel)).toBe("editMode");
    expect(nodeModule({ kind: "separator", id: "s", variant: "line" }, moduleOfPanel)).toBe("");
  });
});

describe("the store", () => {
  it("returns the classic menu, saves sanitized and private, and sees another instance's write", () => {
    const store = new MenuConfigStore();
    expect(store.get()).toEqual(DEFAULT_MENU_CONFIG);
    const r = store.set({ ...DEFAULT_MENU_CONFIG, trigger: { icon: "rocket", text: "Go", showText: true } }, 4321);
    expect(r).toMatchObject({ ok: true, config: { updatedAt: 4321, trigger: { icon: "rocket", text: "Go", showText: true } } });
    expect(statSync(join(dir, "menu-config.json")).mode & 0o077).toBe(0);
    writeFileSync(join(dir, "menu-config.json"), JSON.stringify({ trigger: { icon: "star" } }));
    expect(store.get().trigger.icon).toBe("star");
    writeFileSync(join(dir, "menu-config.json"), "{not json");
    expect(store.get()).toEqual(DEFAULT_MENU_CONFIG);
  });
});

async function server() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerMenuConfigRoutes(app);
  app.use("/api/admin", requireAdminToken());
  registerAdminMenuConfigRoutes(app);
  const http = app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => http.close(r)) };
}

describe("the routes", () => {
  it("serve the menu to every client; an operator changes it, an auditor reads it", async () => {
    const s = await server();
    const auth = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    try {
      const pub = await (await fetch(`${s.base}/api/menu-config`)).json();
      expect(Object.keys(pub)).toEqual(["ok", "config"]);
      expect(pub.config).toEqual(DEFAULT_MENU_CONFIG);

      const next = { ...DEFAULT_MENU_CONFIG, items: [...DEFAULT_MENU_CONFIG.items].reverse() };
      const put = (token: string) => fetch(`${s.base}/api/admin/menu-config`, { method: "PUT", headers: auth(token), body: JSON.stringify({ config: next }) });
      expect((await put("auditor-token-0123456789ab")).status).toBe(403);
      expect((await put("owner-token-0123456789abcdef")).status).toBe(200);
      const after = await (await fetch(`${s.base}/api/menu-config`)).json();
      expect(after.config.items.map((n: MenuNode) => n.id)).toEqual(["app", "tools", "talk", "room", "quick", "user"]);

      const admin = await (await fetch(`${s.base}/api/admin/menu-config`, { headers: auth("auditor-token-0123456789ab") })).json();
      expect(admin.defaults).toEqual(DEFAULT_MENU_CONFIG);
      expect(Object.keys(admin.catalog.icons).length).toBeGreaterThan(100);
      expect(admin.catalog.template.variables.map((v: { path: string }) => v.path)).toContain("$session.current_username");
      expect(admin.catalog.fns.map((f: { id: string }) => f.id)).toContain("toggleTone");
    } finally {
      await s.close();
    }
  });

  it("render the builder's preview: labels translated, HTML as a safe tree", async () => {
    const s = await server();
    try {
      const config = {
        ...DEFAULT_MENU_CONFIG,
        items: [
          { kind: "section", id: "sec", label: "@menu.group.room", children: [
            { kind: "item", id: "it", icon: "star", label: "Hi {$user.nickname|upper}", action: { type: "none" } },
            { kind: "html", id: "h", html: "<b onclick=\"x()\">{$session.room}</b><script>alert(1)</script><a href=\"javascript:x\">l</a>" },
          ] },
        ],
      };
      const r = await (await fetch(`${s.base}/api/admin/menu-config/render`, {
        method: "POST", headers: { Authorization: "Bearer owner-token-0123456789abcdef", "Content-Type": "application/json" },
        body: JSON.stringify({ config, lang: "en" }),
      })).json();
      expect(r.labels).toMatchObject({ sec: "Room & security", it: "Hi ALICE" });
      expect(r.strings["menu.clearQuit"]).toBeTruthy();
      const text = JSON.stringify(r.html.h);
      expect(text).toContain("tym-brno");
      expect(text).not.toMatch(/script|onclick|javascript:/i);
    } finally {
      await s.close();
    }
  });

  it("renders the classic menu's preview in every language", () => {
    for (const lang of ["cs", "en", "de"] as const) {
      const p = renderPreview(DEFAULT_MENU_CONFIG, lang);
      expect(Object.keys(p.labels).length).toBeGreaterThanOrEqual(24);
      for (const value of Object.values(p.labels)) expect(value).not.toMatch(/^@|^menu\./);
    }
  });
});
