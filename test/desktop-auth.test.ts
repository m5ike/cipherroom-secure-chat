// @vitest-environment node
//
// M5cet Desktop (6.13): the passkey sign-in through the system browser.
// The server is a short-lived mailbox (server/desktop-auth.ts); the session
// token and the account root travel ENCRYPTED to the app's ephemeral key
// (client/src/lib/desktop-auth.ts). What must hold:
//   * the result opens only with the app's private key, only for this id and
//     this origin, only once, only within the time limit;
//   * only whoever knows the poll secret gets the result; guessing ends it;
//   * a second completion (replay) is refused; nothing secret is in a URL.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { DesktopAuthStore, MAX_PENDING_PER_ADDRESS, MAX_POLL_FAILURES, registerDesktopAuthRoutes } from "../server/desktop-auth";
import {
  appCallbackUrl, completeHandoff, createAppKey, createPollSecret, fetchHandoffInfo, handoffUrl, HandoffError, isAppKey, openForApp,
  parseHandoffUrl, sealForApp, signInThroughBrowser, verificationCode, type HandoffPayload,
} from "../client/src/lib/desktop-auth";
import { b64url } from "../client/src/lib/passkey";

const ORIGIN = "https://chat.example.org";
const payload = (over: Partial<HandoffPayload> = {}): HandoffPayload => ({
  v: 1, token: "session-token-abc", accountId: "acc_123", root: b64url(new Uint8Array(32).fill(7)), username: "alice", origin: ORIGIN, at: Date.now(), ...over,
});

describe("desktop-auth crypto", () => {
  it("seals to the app's key and opens only with it, for this id and origin", async () => {
    const key = await createAppKey();
    expect(isAppKey(key.publicKey)).toBe(true);
    const sealed = await sealForApp(key.publicKey, "id-0123456789abcdefghij", ORIGIN, payload());
    expect(JSON.stringify(sealed)).not.toContain("session-token-abc");
    const opened = await openForApp(key, "id-0123456789abcdefghij", ORIGIN, sealed);
    expect(opened).toMatchObject({ token: "session-token-abc", accountId: "acc_123", username: "alice" });

    const other = await createAppKey();
    await expect(openForApp(other, "id-0123456789abcdefghij", ORIGIN, sealed)).rejects.toMatchObject({ code: "decrypt" });
    await expect(openForApp(key, "id-other-0123456789abcdef", ORIGIN, sealed)).rejects.toMatchObject({ code: "decrypt" });
    await expect(openForApp(key, "id-0123456789abcdefghij", "https://evil.example", sealed)).rejects.toMatchObject({ code: "decrypt" });
  });

  it("refuses a tampered, malformed, foreign-origin or stale result", async () => {
    const key = await createAppKey();
    const id = "id-0123456789abcdefghij";
    const sealed = await sealForApp(key.publicKey, id, ORIGIN, payload());
    const flipped = sealed.ct.slice(0, -2) + (sealed.ct.endsWith("AA") ? "BB" : "AA");
    await expect(openForApp(key, id, ORIGIN, { ...sealed, ct: flipped })).rejects.toBeInstanceOf(HandoffError);
    await expect(openForApp(key, id, ORIGIN, { ...sealed, iv: "short" })).rejects.toMatchObject({ code: "format" });
    await expect(openForApp(key, id, ORIGIN, { epk: "x", iv: sealed.iv, ct: sealed.ct })).rejects.toMatchObject({ code: "format" });
    // The payload names another server than the one it was sealed for (the AAD matches, the content does not).
    const foreign = await sealForApp(key.publicKey, id, ORIGIN, payload({ origin: "https://evil.example" }));
    await expect(openForApp(key, id, ORIGIN, foreign)).rejects.toMatchObject({ code: "origin" });
    const old = await sealForApp(key.publicKey, id, ORIGIN, payload({ at: Date.now() - 60 * 60_000 }));
    await expect(openForApp(key, id, ORIGIN, old)).rejects.toMatchObject({ code: "expired" });
    const bad = await sealForApp(key.publicKey, id, ORIGIN, payload({ root: "too-short" }));
    await expect(openForApp(key, id, ORIGIN, bad)).rejects.toMatchObject({ code: "payload" });
  });

  it("the page URL carries the id and the PUBLIC key only (in the fragment); the callback only the id", async () => {
    const key = await createAppKey();
    const url = handoffUrl(ORIGIN, "AbCdEfGhIjKlMnOpQrStUv12", key.publicKey);
    expect(url).toBe(`${ORIGIN}/desktop-signin?id=AbCdEfGhIjKlMnOpQrStUv12#k=${key.publicKey}`);
    expect(parseHandoffUrl(url)).toEqual({ id: "AbCdEfGhIjKlMnOpQrStUv12", appKey: key.publicKey });
    expect(parseHandoffUrl(`${ORIGIN}/desktop-signin?id=AbCdEfGhIjKlMnOpQrStUv12#k=nope`)).toBeNull();
    expect(parseHandoffUrl(`${ORIGIN}/elsewhere?id=AbCdEfGhIjKlMnOpQrStUv12#k=${key.publicKey}`)).toBeNull();
    expect(appCallbackUrl("AbCdEfGhIjKlMnOpQrStUv12")).toBe("m5cet://auth/callback?id=AbCdEfGhIjKlMnOpQrStUv12");
    const code = await verificationCode(key.publicKey);
    expect(code).toMatch(/^\d{4} \d{4}$/);
    expect(await verificationCode(key.publicKey)).toBe(code);
    expect(await verificationCode((await createAppKey()).publicKey)).not.toBe(code);
  });
});

describe("desktop-auth store (server)", () => {
  let now = 1_000_000;
  const clock = () => now;

  it("start → info → complete once → result once (with the poll secret)", async () => {
    const store = new DesktopAuthStore(clock);
    const key = await createAppKey();
    const poll = await createPollSecret();
    const r = store.start(key.publicKey, poll.hash, "1.2.3.0/24");
    if (!r.ok) throw new Error("start");
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(store.info(r.id, "1.2.3.0/24")).toMatchObject({ appKey: key.publicKey, state: "waiting", sameNetwork: true });
    expect(store.info(r.id, "9.9.9.0/24")).toMatchObject({ sameNetwork: false });
    expect(store.take(r.id, poll.secret)).toEqual({ ok: true, state: "pending" });
    const sealed = await sealForApp(key.publicKey, r.id, ORIGIN, payload());
    expect(store.complete(r.id, sealed)).toEqual({ ok: true });
    expect(store.complete(r.id, sealed)).toMatchObject({ ok: false, status: 409 });
    expect(store.take(r.id, "wrong")).toMatchObject({ ok: false, status: 403 });
    const got = store.take(r.id, poll.secret);
    expect(got).toMatchObject({ ok: true, state: "done" });
    // Once: the request is gone.
    expect(store.take(r.id, poll.secret)).toMatchObject({ ok: false, status: 404 });
    expect(store.info(r.id, "1.2.3.0/24")).toBeNull();
  });

  it("expires after five minutes", async () => {
    const store = new DesktopAuthStore(clock);
    const key = await createAppKey();
    const poll = await createPollSecret();
    const r = store.start(key.publicKey, poll.hash, "a");
    if (!r.ok) throw new Error("start");
    now += 5 * 60_000 + 1;
    expect(store.info(r.id, "a")).toBeNull();
    expect(store.complete(r.id, await sealForApp(key.publicKey, r.id, ORIGIN, payload()))).toMatchObject({ status: 404 });
    expect(store.take(r.id, poll.secret)).toMatchObject({ status: 404 });
    expect(store.size).toBe(0);
  });

  it("guessing the poll secret ends the request", async () => {
    const store = new DesktopAuthStore(clock);
    const key = await createAppKey();
    const poll = await createPollSecret();
    const r = store.start(key.publicKey, poll.hash, "a");
    if (!r.ok) throw new Error("start");
    for (let i = 0; i < MAX_POLL_FAILURES; i++) expect(store.take(r.id, `guess-${i}`)).toMatchObject({ status: 403 });
    expect(store.take(r.id, poll.secret)).toMatchObject({ status: 404 });
  });

  it("validates its inputs and caps pending requests per address", async () => {
    const store = new DesktopAuthStore(clock);
    const key = await createAppKey();
    const poll = await createPollSecret();
    expect(store.start("not-a-key", poll.hash, "a")).toMatchObject({ ok: false, status: 400 });
    expect(store.start(key.publicKey, "short", "a")).toMatchObject({ ok: false, status: 400 });
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) expect(store.start(key.publicKey, poll.hash, "busy").ok).toBe(true);
    expect(store.start(key.publicKey, poll.hash, "busy")).toMatchObject({ ok: false, status: 429 });
    expect(store.start(key.publicKey, poll.hash, "other").ok).toBe(true);
    const r = store.start(key.publicKey, poll.hash, "x");
    if (!r.ok) throw new Error("start");
    expect(store.complete(r.id, { epk: "x", iv: "y", ct: "z" })).toMatchObject({ status: 400 });
    expect(store.complete("../../etc", {})).toMatchObject({ status: 404 });
    expect(store.cancel(r.id, "wrong")).toBe(false);
    expect(store.cancel(r.id, poll.secret)).toBe(true);
    expect(store.info(r.id, "x")).toBeNull();
  });
});

describe("desktop-auth over HTTP: the whole handoff", () => {
  let server: Server;
  let base = "";
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => fetch(`${base}${String(input)}`, init)) as typeof fetch;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    registerDesktopAuthRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  it("app starts, the browser completes, the app collects and opens the result — once", async () => {
    const opened: string[] = [];
    let codeShownByApp = "";
    let replay: { id: string; appKey: string } | null = null;
    const result = await signInThroughBrowser({
      origin: ORIGIN,
      fetcher,
      pollMs: 25,
      open: async (url, code) => {
        opened.push(url);
        codeShownByApp = code;
        // The browser page: reads the request, shows the code, signs in (simulated), seals, completes.
        const parsed = parseHandoffUrl(url)!;
        replay = parsed;
        const info = await fetchHandoffInfo(parsed.id, fetcher);
        expect(info).toMatchObject({ appKey: parsed.appKey, state: "waiting", sameNetwork: true });
        expect(await verificationCode(parsed.appKey)).toBe(code);
        setTimeout(() => void completeHandoff(parsed.id, parsed.appKey, ORIGIN, payload(), fetcher), 60);
      },
    });
    expect(result).toMatchObject({ token: "session-token-abc", accountId: "acc_123", origin: ORIGIN });
    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toContain("session-token");
    expect(codeShownByApp).toMatch(/^\d{4} \d{4}$/);
    // Replay: the request is gone after the app collected it.
    expect(await completeHandoff(replay!.id, replay!.appKey, ORIGIN, payload(), fetcher)).toBe(false);
    expect(await fetchHandoffInfo(replay!.id, fetcher)).toBeNull();
  });

  it("the deep link wakes the app at once (no waiting for the next poll)", async () => {
    let poke: (() => void) | null = null;
    const started = Date.now();
    const result = await signInThroughBrowser({
      origin: ORIGIN, fetcher, pollMs: 60_000,
      wake: (_id, p) => { poke = p; return () => { poke = null; }; },
      open: async (url) => {
        const parsed = parseHandoffUrl(url)!;
        setTimeout(async () => { await completeHandoff(parsed.id, parsed.appKey, ORIGIN, payload(), fetcher); poke?.(); }, 50);
      },
    });
    expect(result.token).toBe("session-token-abc");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("cancelling in the app cancels on the server", async () => {
    const ctrl = new AbortController();
    let id = "";
    const p = signInThroughBrowser({ origin: ORIGIN, fetcher, pollMs: 20, signal: ctrl.signal, open: (url) => { id = parseHandoffUrl(url)!.id; setTimeout(() => ctrl.abort(), 30); } });
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    expect(await fetchHandoffInfo(id, fetcher)).toBeNull();
  });

  it("someone who only knows the id gets nothing", async () => {
    const key = await createAppKey();
    const poll = await createPollSecret();
    const start = await fetcher("/api/desktop-auth/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: key.publicKey, pollHash: poll.hash }) });
    expect(start.status).toBe(201);
    const { id } = await start.json() as { id: string };
    await completeHandoff(id, key.publicKey, ORIGIN, payload(), fetcher);
    const stolen = await fetcher(`/api/desktop-auth/${id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poll: "guess" }) });
    expect(stolen.status).toBe(403);
    const body = await stolen.text();
    expect(body).not.toContain("ct");
    expect(start.headers.get("cache-control")).toBe("no-store");
    const real = await fetcher(`/api/desktop-auth/${id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poll: poll.secret }) });
    const got = await real.json() as { state: string; sealed: { ct: string } };
    expect(got.state).toBe("done");
    expect(JSON.stringify(got)).not.toContain("session-token-abc");
    expect((await openForApp(key, id, ORIGIN, got.sealed as never)).token).toBe("session-token-abc");
  });

  it("refuses malformed requests", async () => {
    const r1 = await fetcher("/api/desktop-auth/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: "x", pollHash: "y" }) });
    expect(r1.status).toBe(400);
    const r2 = await fetcher("/api/desktop-auth/AbCdEfGhIjKlMnOpQrStUv12");
    expect(r2.status).toBe(404);
    const r3 = await fetcher("/api/desktop-auth/AbCdEfGhIjKlMnOpQrStUv12/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sealed: { epk: 1 } }) });
    expect(r3.status).toBe(404);
  });
});
