// Notifications (6.7), the browser: the user's settings (a guest's in this
// browser, an account's on the server — order, privacy, kinds, quiet hours,
// the test), the page's own notifications by the template, "@name" mention
// hints, and the service worker rendering a push with what only the device
// knows (the room's name) — never content.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { NotifySettings } from "../client/src/components/NotifySettings";
import { DEFAULT_POLICY, localNotification, mentionedAway, loadGuestNotify, setCurrentNotifyPrefs } from "../client/src/lib/notify-client";
import { DEFAULT_TEMPLATES, DEFAULT_USER_PREFS } from "../client/src/lib/notify-template";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { cleanup(); localStorage.clear(); setCurrentNotifyPrefs(null); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the page's own notifications", () => {
  const n = { kind: "message" as const, room: "Team", sender: "Bob", text: "Hello there" };

  it("show the decrypted text until the user picks a level; a push preview does not", () => {
    expect(localNotification(n, { prefs: DEFAULT_USER_PREFS, policy: DEFAULT_POLICY, lang: "en" })).toMatchObject({ title: "M5cet · Team", options: { body: "Bob: Hello there" } });
    expect(localNotification(n, { prefs: DEFAULT_USER_PREFS, policy: DEFAULT_POLICY, lang: "en", asPush: true })!.options.body).toBe("New message");
    expect(localNotification(n, { prefs: { ...DEFAULT_USER_PREFS, privacy: "sender" }, policy: DEFAULT_POLICY, lang: "cs" })).toMatchObject({ title: "M5cet", options: { body: "Bob: Nová zpráva" } });
  });

  it("stay within the operator's maximum, and follow the template's sound", () => {
    const policy = { ...DEFAULT_POLICY, templates: { ...DEFAULT_TEMPLATES, message: { ...DEFAULT_TEMPLATES.message, maxPrivacy: "sender" as const, sound: false } } };
    const shown = localNotification(n, { prefs: { ...DEFAULT_USER_PREFS, privacy: "content" }, policy, lang: "en" })!;
    expect(shown.options.body).toBe("Bob: New message");
    expect(shown.options.silent).toBe(true);
    expect(shown.options.vibrate).toBeUndefined(); // a silent notification with a pattern is refused
  });

  it("are not shown for a kind switched off, with everything off, or in quiet hours", () => {
    expect(localNotification(n, { prefs: { ...DEFAULT_USER_PREFS, kinds: { message: false } }, policy: DEFAULT_POLICY })).toBeNull();
    expect(localNotification(n, { prefs: { ...DEFAULT_USER_PREFS, on: false }, policy: DEFAULT_POLICY })).toBeNull();
    const quiet = { ...DEFAULT_USER_PREFS, quiet: { on: true, from: "00:00", to: "23:59", tz: "UTC" } };
    expect(localNotification(n, { prefs: quiet, policy: DEFAULT_POLICY, now: Date.UTC(2026, 0, 1, 12) })).toBeNull();
    expect(localNotification({ kind: "test" }, { prefs: quiet, policy: DEFAULT_POLICY, now: Date.UTC(2026, 0, 1, 12) })).not.toBeNull();
  });
});

describe("mention hints", () => {
  const away = [{ accountId: "ref-a", name: "Alice" }, { accountId: "ref-b", name: "Bob K" }, { accountId: "ref-c", name: "Al" }];
  it("find @name as a word, in any case, and nothing else", () => {
    expect(mentionedAway("hi @alice, and @Bob K!", away)).toEqual(["ref-a", "ref-b"]);
    expect(mentionedAway("mail alice@example.org", away)).toEqual([]);
    expect(mentionedAway("@Alicex", away)).toEqual([]);
    expect(mentionedAway("@al?", away)).toEqual(["ref-c"]);
    expect(mentionedAway(undefined, away)).toEqual([]);
  });
});

describe("the settings, signed out", () => {
  it("are kept in this browser and say the server needs a sign-in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true, ...DEFAULT_POLICY })));
    render(<NotifySettings lang="en" signedIn={false} />);
    expect(screen.getByTestId("notify-guest")).toBeTruthy();
    expect(screen.queryByTestId("notify-channel-android")).toBeNull();
    fireEvent.click(screen.getByTestId("notify-kind-mention"));
    fireEvent.change(screen.getByTestId("notify-privacy"), { target: { value: "sender" } });
    fireEvent.click(screen.getByTestId("notify-save"));
    await waitFor(() => expect(screen.getByTestId("notify-msg").textContent).toBe("Saved in this browser."));
    expect(loadGuestNotify()).toMatchObject({ privacy: "sender", kinds: { mention: false } });
  });

  it("the preview follows the chosen level", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true, ...DEFAULT_POLICY })));
    render(<NotifySettings lang="en" signedIn={false} offline />);
    expect(screen.getByTestId("notify-preview-body").textContent).toBe("New message (2)");
    fireEvent.change(screen.getByTestId("notify-privacy"), { target: { value: "room" } });
    expect(screen.getByTestId("notify-preview-title").textContent).toBe("M5cet · Team");
    expect(screen.getByTestId("notify-preview-body").textContent).toBe("Bob: New message (2)");
    fireEvent.change(screen.getByTestId("notify-privacy"), { target: { value: "content" } });
    expect(screen.getByTestId("notify-preview-body").textContent).toBe("Bob: Hi, got a minute? (2)");
  });
});

describe("the settings, signed in", () => {
  const server = () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let prefs = { ...DEFAULT_USER_PREFS };
    const policy = { ...DEFAULT_POLICY, channels: [{ id: "android", on: true }, { id: "webpush", on: true }, { id: "email", on: true }], templates: { ...DEFAULT_TEMPLATES, call: { ...DEFAULT_TEMPLATES.call, maxPrivacy: "sender" } } };
    const endpoints = {
      android: [{ id: "and_1", name: "Fold", model: "SM-F956B", lastSeen: 1, fcm: true, linkedAt: 1 }], webpush: 2, email: null,
      ready: { android: { ready: true, reason: "", on: true }, webpush: { ready: true, reason: "", on: true }, email: { ready: false, reason: "no SMTP relay", on: true } },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url === "/api/account/notify" && method === "GET") return json({ ok: true, prefs, saved: false, policy, endpoints });
      if (url === "/api/account/notify" && method === "PUT") { prefs = { ...prefs, ...body }; return json({ ok: true, prefs }); }
      if (url === "/api/account/notify/test") return json({ ok: true, channel: "android", skipped: null, order: ["android", "webpush"], attempts: [] });
      return json({ ok: false }, 404);
    }));
    return calls;
  };

  it("shows each channel with what the account has there, and saves the order chosen", async () => {
    const calls = server();
    render(<NotifySettings lang="en" signedIn />);
    await waitFor(() => expect(screen.getByTestId("notify-status-android").textContent).toBe("1 devices"));
    expect(screen.getByTestId("notify-status-webpush").textContent).toBe("2 browsers");
    expect(screen.getByTestId("notify-status-email").textContent).toBe("the server cannot: no SMTP relay");
    // Web push first, e-mail not used.
    fireEvent.click(screen.getByTestId("notify-up-webpush"));
    fireEvent.click(screen.getByTestId("notify-use-email"));
    fireEvent.change(screen.getByTestId("notify-privacy"), { target: { value: "content" } });
    expect(screen.getByTestId("notify-capped-call").textContent).toContain("Who writes");
    fireEvent.click(screen.getByTestId("notify-quiet"));
    fireEvent.click(screen.getByTestId("notify-save"));
    await waitFor(() => expect(screen.getByTestId("notify-msg").textContent).toBe("Saved."));
    const put = calls.find((c) => c.method === "PUT")!.body as Record<string, any>;
    expect(put.order).toEqual(["webpush", "android"]);
    expect(put.privacy).toBe("content");
    expect(put.quiet.on).toBe(true);
    expect(put.lang).toBe("en");
  });

  it("the test says which channel took it", async () => {
    server();
    render(<NotifySettings lang="en" signedIn />);
    await waitFor(() => expect(screen.getByTestId("notify-status-android").textContent).toBe("1 devices"));
    fireEvent.click(screen.getByTestId("notify-test"));
    await waitFor(() => expect(screen.getByTestId("notify-msg").textContent).toBe("Sent through The Android app."));
  });
});

/* ---------------------------------------------------------- service worker */

type Shown = { title: string; options: Record<string, any> };

function loadWorker() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
    registration: { showNotification: async (title: string, options: Record<string, any>) => { shown.push({ title, options }); } },
    navigator: { language: "cs-CZ" },
    location: { origin: "https://chat.example.org" },
    clients: { claim: async () => undefined, matchAll: async () => [] },
    skipWaiting: () => undefined,
  };
  const src = readFileSync(join(__dirname, "..", "client", "public", "sw.js"), "utf8");
  const ctx: Record<string, unknown> = { self, URL, Map, Date, Object, String, Number, JSON, Math, Boolean };
  runInNewContext(src, ctx);
  const push = async (data: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.push({ data: { json: () => data }, waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    return shown[shown.length - 1];
  };
  const message = (data: unknown) => handlers.message({ data, ports: [] });
  return { push, message, ctx };
}

const PUSH = {
  v: 1, id: "x", kind: "message", title: "M5cet", body: "New message", privacy: "room", room: "r3.abc",
  tpl: { title: "{app}[ · {room}]", body: "[{sender}: ]{preview|Nová zpráva}" }, vars: { app: "M5cet", sender: "Bob" },
  tag: "m5-abc", group: "room", icon: "message-square", accent: "", sound: true, vibrate: true, sticky: false, actions: true, url: "/signin", lang: "cs", at: 1,
};

describe("the service worker", () => {
  it("renders a push by its template, naming the room only from what the page told it", async () => {
    const sw = loadWorker();
    expect(await sw.push(PUSH)).toMatchObject({ title: "M5cet", options: { body: "Bob: Nová zpráva", tag: "m5-abc", renotify: true, silent: false, data: { url: "/signin", kind: "message", room: "r3.abc" } } });
    sw.message({ type: "notify-rooms", rooms: { "r3.abc": "Tým\u202e evil" } });
    expect((await sw.push(PUSH)).title).toBe("M5cet · Tým evil");
    // At "sender" the room stays out even when the worker knows it.
    expect((await sw.push({ ...PUSH, privacy: "sender" })).title).toBe("M5cet");
    sw.message({ type: "notify-forget" });
    expect((await sw.push(PUSH)).title).toBe("M5cet");
  });

  it("never shows a preview a push claims to carry, and keeps clicks on this site", async () => {
    const sw = loadWorker();
    const shown = await sw.push({ ...PUSH, privacy: "content", vars: { ...PUSH.vars, preview: "planted text" }, url: "https://evil.example/x", sound: false, sticky: true });
    expect(shown.options.body).toBe("Bob: Nová zpráva");
    expect(shown.options).toMatchObject({ silent: true, requireInteraction: true, data: { url: "/" } });
    expect(shown.options.vibrate).toBeUndefined();
  });

  it("falls back to the server's text without a template, and keeps the old relay wording", async () => {
    const sw = loadWorker();
    expect((await sw.push({ ...PUSH, tpl: undefined, title: "Firma", body: "New message" })).options.body).toBe("New message");
    expect((await sw.push({ title: "M5cet", body: "", kind: "relay", url: "/signin" })).options.body).toBe("Máte novou zprávu. Otevřete M5cet a přihlaste se.");
  });

  it("its template rules match the app's", async () => {
    const { renderTemplate, visibleVars } = await import("../client/src/lib/notify-template");
    const sw = loadWorker();
    const render = sw.ctx.renderTpl as (t: string, v: Record<string, string>, max?: number) => string;
    const cases: Array<[string, Record<string, string>]> = [
      ["{app}[ · {room}]", { app: "M5cet" }],
      ["[{sender}: ]{preview|New \\{x\\}}[ ({count})]", { sender: "Bob", count: "3" }],
      ["{sender|Někdo} vám volá \\[ok\\] [x {nope}]", {}],
      ["{app", { app: "A" }],
      ["a [b {room|r} c] d", {}],
    ];
    for (const [tpl, vars] of cases) {
      const v = visibleVars(vars, "content");
      expect(render(tpl, (sw.ctx.visibleVars as (v: unknown, p: string) => Record<string, string>)(vars, "content")), tpl).toBe(renderTemplate(tpl, v));
    }
  });
});
