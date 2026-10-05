// M5cet Desktop (6.13): the sign-in of client/src/lib/account.ts when the
// page runs inside the desktop app — the passkey ceremony in the system
// browser, the result back encrypted to the app, then the same steps as on
// the web (key proof, database, vault). And the fallback: an in-app passkey
// without PRF offers the browser.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _deriveKeyForTest, b64url, PrfUnsupportedError } from "../client/src/lib/passkey";
import { sealForApp, type HandoffPayload } from "../client/src/lib/desktop-auth";

const mode = vi.hoisted(() => ({ prf: true }));
vi.mock("../client/src/lib/passkey", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/lib/passkey")>();
  return {
    ...actual,
    passkeySupported: () => true,
    assertPasskey: vi.fn(async () => {
      if (!mode.prf) throw new actual.PrfUnsupportedError();
      return { response: { id: "cred", rawId: "cred", type: "public-key", response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" } }, key: await actual._deriveKeyForTest(new Uint8Array(32).fill(9)), databaseKey: "a".repeat(64), secret: new Uint8Array(32).fill(9) };
    }),
  };
});

import { _resetAccountForTests, currentAccount, isSignedIn, signInWithPasskey, type AccountSummary } from "../client/src/lib/account";

const ORIGIN = window.location.origin;
const ID = "AbCdEfGhIjKlMnOpQrStUv12";
const SUMMARY = { id: "acc-0000000000000000001", credentialId: "cred", alg: -7, userName: "Alice", createdAt: 1, lastLoginAt: 2, loginCount: 3 } as unknown as AccountSummary;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
let calls: Call[];
let polls: number;
let opened: Array<{ url: string; code: string }>;
let ended: number;
let offered: number;

function installDesktop(passkeys: "app" | "browser", acceptBrowser = true) {
  (window as unknown as { m5desktop?: unknown }).m5desktop = {
    isDesktop: true, version: "6.13.0", platform: "darwin", codeSource: "app",
    notify: () => "", closeNotification: () => undefined, onNotificationClick: () => () => undefined, setBadge: () => undefined,
    openExternal: async () => false,
    auth: {
      mode: async () => passkeys,
      begin: (url: string, code: string) => { opened.push({ url, code }); return new Promise<"cancel" | "done">(() => undefined); },
      end: () => { ended += 1; },
      offerBrowser: async () => { offered += 1; return acceptBrowser; },
      onCallback: () => () => undefined,
    },
  };
}

beforeEach(() => {
  calls = []; polls = 0; opened = []; ended = 0; offered = 0; mode.prf = true;
  _resetAccountForTests(new Map());
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, method: init.method ?? "GET", body, auth: headers.Authorization ?? null });
    if (url === "/api/desktop-auth/start") {
      startBody = body;
      return reply({ ok: true, id: ID, expiresAt: Date.now() + 300_000 }, 201);
    }
    if (url === `/api/desktop-auth/${ID}/result`) {
      polls += 1;
      if (polls < 2) return reply({ ok: true, state: "pending" });
      // What the browser would have sealed: the session token and the account root (the passkey's PRF secret).
      const payload: HandoffPayload = { v: 1, token: "browser-session-token-xyz", accountId: SUMMARY.id, root: b64url(new Uint8Array(32).fill(9)), username: "alice", origin: ORIGIN, at: Date.now() };
      return reply({ ok: true, state: "done", sealed: await sealForApp(String(startBody!.appKey), ID, ORIGIN, payload) });
    }
    if (url === "/api/account/me") return reply({ ok: true, account: SUMMARY, locked: true });
    if (url === "/api/account/unlock") return reply({ ok: true, account: SUMMARY });
    if (url.endsWith("/options")) return reply({ ok: true, publicKey: { challenge: "chal", rpId: "chat.example" } });
    if (url.endsWith("/verify")) return reply({ ok: true, token: "app-session-token", account: SUMMARY });
    if (url === "/api/account/vault") return reply({ ok: true, profile: null, chat: null });
    return reply({ ok: true });
  }));
});
let startBody: Record<string, unknown> | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { m5desktop?: unknown }).m5desktop;
  _resetAccountForTests(null);
  sessionStorage.clear();
});

describe("desktop sign-in through the browser", () => {
  it("runs the ceremony in the browser and finishes like the web, with the same key proof", async () => {
    // The proof the in-app passkey (same PRF secret) gives, for comparison.
    installDesktop("app");
    await signInWithPasskey();
    const webProof = calls.find((c) => c.url === "/api/account/unlock")!.body!.keyProof;
    _resetAccountForTests(new Map());
    sessionStorage.clear();
    calls = [];

    installDesktop("browser");
    const steps: string[] = [];
    await signInWithPasskey((step, state) => steps.push(`${step}:${state}`));
    const u = calls.map((c) => `${c.method} ${c.url}`);
    expect(u).not.toContain("POST /api/account/signin/options");
    expect(u.slice(0, 2)).toEqual(["POST /api/desktop-auth/start", `POST /api/desktop-auth/${ID}/result`]);
    expect(opened).toHaveLength(1);
    expect(opened[0].url).toBe(`${ORIGIN}/desktop-signin?id=${ID}#k=${startBody!.appKey}`);
    expect(opened[0].code).toMatch(/^\d{4} \d{4}$/);
    // The poll secret goes only in a POST body, never in a URL.
    expect(calls.every((c) => !c.url.includes(String(calls[1].body!.poll)))).toBe(true);
    const unlock = calls.find((c) => c.url === "/api/account/unlock")!;
    expect(unlock.auth).toBe("Bearer browser-session-token-xyz");
    expect(unlock.body!.keyProof).toBe(webProof);
    expect(isSignedIn()).toBe(true);
    expect(currentAccount()?.id).toBe(SUMMARY.id);
    expect(ended).toBe(1);
    expect(steps).toEqual(["passkey:run", "passkey:ok", "key:run", "key:ok", "database:run", "database:ok", "vault:run", "vault:ok"]);
  });

  it("an in-app passkey without PRF offers the browser (and takes it when the user agrees)", async () => {
    installDesktop("app", true);
    mode.prf = false;
    await signInWithPasskey();
    expect(offered).toBe(1);
    expect(calls.map((c) => c.url)).toContain("/api/desktop-auth/start");
    expect(isSignedIn()).toBe(true);
  });

  it("declining the browser leaves the PRF error as it is", async () => {
    installDesktop("app", false);
    mode.prf = false;
    const err = await signInWithPasskey().catch((e) => e);
    expect(offered).toBe(1);
    expect(err).toMatchObject({ code: "no-prf" });
    expect(calls.map((c) => c.url)).not.toContain("/api/desktop-auth/start");
  });

  it("in a browser (no desktop bridge) nothing changes", async () => {
    await signInWithPasskey();
    expect(calls[0].url).toBe("/api/account/signin/options");
    expect(PrfUnsupportedError).toBeDefined();
  });
});
