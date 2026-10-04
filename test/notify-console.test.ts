// The console's Notifications page (admin-ui/public/notify-console.js, 6.7)
// on a stand-in for console.js: it draws the channels, templates, e-mail and
// log from /api/admin/notify, previews a template being edited through the
// server, and saves what was changed — the SMTP password only when typed.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TEMPLATES } from "../client/src/lib/notify-template";

const calls: Array<{ path: string; method: string; body?: any }> = [];
let route: [string, string, () => Promise<void>] | null = null;
let config: any;

function h(tag: string, attrs: Record<string, any> = {}, ...children: any[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path: string, opts: { method?: string; body?: any } = {}) {
  const method = opts.method ?? "GET";
  calls.push({ path, method, body: opts.body });
  if (path === "/api/admin/notify" && method === "GET") return overview();
  if (path === "/api/admin/notify" && method === "PUT") { config = { ...config, ...opts.body, email: { ...config.email, ...opts.body.email, hasPassword: true } }; return overview(); }
  if (path.startsWith("/api/admin/notify/log")) return { ok: true, entries: [{ id: 1, at: 1, kind: "message", account: "alice", room: "abcd", outcome: "sent", channel: "webpush", order: ["android", "webpush"], attempts: [{ channel: "android", ok: false, status: 404, gone: true }, { channel: "webpush", ok: true }] }] };
  if (path === "/api/admin/notify/preview") return { ok: true, title: "M5cet · Team", body: `${opts.body.vars.sender}: preview`, privacy: opts.body.privacy, visible: ["app", "sender", "room"] };
  if (path === "/api/admin/notify/test") return { ok: true, channel: "webpush", attempts: [{ channel: "webpush", target: "fcm.googleapis.com/…abc", ok: true, ms: 12 }] };
  throw new Error(`unexpected ${method} ${path}`);
}

const overview = () => ({
  ok: true, config: structuredClone(config), stats: { sent: 3, failed: 1, skipped: 7 }, store: { accounts: 2, devices: 1, emails: 1, confirmed: 1 },
  channels: [{ id: "android", ready: true, reason: "", on: true }, { id: "webpush", ready: false, reason: "VAPID keys are not set", on: true }, { id: "email", ready: false, reason: "no SMTP relay", on: false }],
});

beforeAll(async () => {
  config = {
    enabled: true, appName: "M5cet", channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: false }],
    templates: structuredClone(DEFAULT_TEMPLATES), limits: { perHour: 60, testsPerHour: 10, timeoutMs: 10000 },
    email: { host: "", port: 587, secure: "starttls", user: "", from: "", hasPassword: true }, rev: "r1", updatedAt: 1, updatedBy: "owner@1.2.3.4",
  };
  document.body.innerHTML = '<div id="notifyRoot"></div>';
  (window as any).M5Console = {
    h, api, toast: vi.fn(), can: () => true, applyRoleGates: () => undefined,
    clear: (el: Element) => { while (el.firstChild) el.firstChild.remove(); return el; },
    icon: () => document.createElement("span"),
    addRoute: (_name: string, entry: [string, string, () => Promise<void>]) => { route = entry; },
  };
  new Function(readFileSync(join(__dirname, "..", "admin-ui", "public", "notify-console.js"), "utf8"))();
  await route![2]();
});

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const tick = (ms = 0) => new Promise((ok) => setTimeout(ok, ms));

describe("the Notifications page", () => {
  it("registers its route and draws the channels with their readiness", () => {
    expect(route![0]).toBe("Notifications");
    expect($('[data-testid="notify-ch-android"]').textContent).toContain("ready");
    expect($('[data-testid="notify-ch-webpush"]').textContent).toContain("VAPID keys are not set");
    expect($("#notifyRoot").textContent).toContain("Sent3");
  });

  it("previews a template as it is typed, through the server", async () => {
    $('[data-testid="notify-tab-templates"]').click();
    $('[data-testid="notify-kind-mention"]').click();
    const body = $('[data-testid="notify-body-en"]') as HTMLInputElement;
    expect(body.value).toBe(DEFAULT_TEMPLATES.mention.body.en);
    body.value = "{sender} pinged you";
    body.dispatchEvent(new Event("input"));
    await tick(250);
    const preview = calls.filter((c) => c.path === "/api/admin/notify/preview").pop()!;
    expect(preview.body).toMatchObject({ kind: "mention", template: { body: { en: "{sender} pinged you" } } });
    expect($('[data-testid="notify-preview-title"]').textContent).toBe("M5cet · Team");
  });

  it("saves the whole draft, keeping the stored SMTP password when none was typed", async () => {
    $('[data-testid="notify-tab-channels"]').click();
    (document.querySelector('[data-testid="notify-ch-on-email"]') as HTMLInputElement).click();
    $('[data-testid="notify-save"]').click();
    await tick();
    const put = calls.filter((c) => c.method === "PUT").pop()!;
    expect(put.body.templates.mention.body.en).toBe("{sender} pinged you");
    expect(put.body.channels.find((c: { id: string }) => c.id === "email").on).toBe(true);
    expect("pass" in put.body.email).toBe(false);
  });

  it("tests an account and shows the log", async () => {
    $('[data-testid="notify-tab-test"]').click();
    await tick();
    ($('[data-testid="notify-test-user"]') as HTMLInputElement).value = "alice";
    const send = [...document.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
    send.click();
    await tick();
    expect(calls.filter((c) => c.path === "/api/admin/notify/test").pop()!.body).toMatchObject({ username: "alice", kind: "test" });
    expect($('[data-testid="notify-test-out"]').textContent).toContain("sent via webpush");
    await tick();
    expect($('[data-testid="notify-log"]').textContent).toContain("android:404†");
  });
});
