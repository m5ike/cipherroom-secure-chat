// The signed-in user in the browser (client/src/lib/account.ts): the
// ceremonies talk to the server, but everything stored is sealed with the
// passkey's PRF key first. These tests stand in for the authenticator and
// assert what actually leaves the tab.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _deriveKeyForTest, openProfile } from "../client/src/lib/passkey";

const passkeyKey = vi.hoisted(() => ({ current: null as CryptoKey | null }));
/** The second key a passkey derives: it opens the database on the server. */
const DB_KEY = vi.hoisted(() => "a".repeat(64));

vi.mock("../client/src/lib/passkey", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/src/lib/passkey")>();
  return {
    ...actual,
    passkeySupported: () => true,
    createPasskey: vi.fn(async () => ({ response: { id: "cred", rawId: "cred", type: "public-key", response: { clientDataJSON: "c", attestationObject: "a" } }, key: passkeyKey.current!, databaseKey: DB_KEY })),
    assertPasskey: vi.fn(async () => ({ response: { id: "cred", rawId: "cred", type: "public-key", response: { clientDataJSON: "c", authenticatorData: "a", signature: "s" } }, key: passkeyKey.current!, databaseKey: DB_KEY })),
  };
});

import {
  _resetAccountForTests, accountStatus, currentAccount, deleteAccount, isSignedIn, linkPushSubscription,
  loadVault, logAccountEvent, registerAccount, restoreSession, saveVault, signInWithPasskey, signOutAccount,
  type AccountSummary,
} from "../client/src/lib/account";

const SUMMARY: AccountSummary = {
  id: "acc-0000000000000000001",
  credentialId: "cred",
  alg: -7,
  userName: "Alice",
  createdAt: 1,
  lastLoginAt: 2,
  loginCount: 3,
  vault: { profileBytes: 0, profileUpdatedAt: 0, chatBytes: 0, chatUpdatedAt: 0, messages: 0, messageBytes: 0, rooms: 0 },
  mailbox: { pending: 0, bytes: 0 },
  away: [],
  pushDevices: 0,
  audit: [],
};

type Call = { url: string; method: string; body: Record<string, unknown> | null; auth: string | null };
let calls: Call[] = [];
let vault: { profile: { ct: string } | null; chat: { ct: string } | null } = { profile: null, chat: null };
let keys: Map<string, CryptoKey>;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
  passkeyKey.current = await _deriveKeyForTest(new Uint8Array(32).fill(9));
  keys = new Map();
  calls = [];
  vault = { profile: null, chat: null };
  _resetAccountForTests(keys);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
      auth: headers.Authorization ?? null,
    });
    if (url === "/api/account/status") return reply({ ok: true, available: true, persistent: true, rpId: "chat.example", accounts: 2, limits: {} });
    if (url.endsWith("/options")) return reply({ ok: true, publicKey: { challenge: "chal", rp: { id: "chat.example", name: "M5cet" }, user: { id: "dXNlcg", name: "Alice", displayName: "Alice" }, pubKeyCredParams: [], rpId: "chat.example" } });
    if (url.endsWith("/verify")) return reply({ ok: true, token: "session-token-abcdefghijkl", account: SUMMARY });
    if (url === "/api/account/me") return reply({ ok: true, account: { ...SUMMARY, loginCount: 4 } });
    if (url === "/api/account/vault" && (init.method ?? "GET") === "GET") return reply({ ok: true, ...vault });
    if (url === "/api/account/vault") {
      const body = JSON.parse(String(init.body)) as { profile?: string; chat?: { ct: string } };
      if (body.profile) vault.profile = { ct: body.profile };
      if (body.chat) vault.chat = { ct: body.chat.ct };
      return reply({ ok: true, account: SUMMARY });
    }
    return reply({ ok: true });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetAccountForTests(null);
  sessionStorage.clear();
});

const urls = () => calls.map((c) => `${c.method} ${c.url}`);

describe("registration and sign-in", () => {
  it("registers, keeps the session for this tab and reports the account", async () => {
    const account = await registerAccount("Alice");
    expect(account.userName).toBe("Alice");
    expect(isSignedIn()).toBe(true);
    expect(currentAccount()?.id).toBe(SUMMARY.id);
    // Registration also opens the user's database on the server, with the
    // key the passkey derived — never with the vault key.
    expect(urls()).toEqual(["POST /api/account/register/options", "POST /api/account/register/verify", "POST /api/storage/open"]);
    expect(calls.at(-1)).toMatchObject({ body: { key: DB_KEY }, auth: "Bearer session-token-abcdefghijkl" });
    expect(sessionStorage.getItem("m5cet:account:v1")).toContain("session-token-abcdefghijkl");
    expect(keys.get(SUMMARY.id)).toBeDefined();
  });

  it("signs in with an existing passkey", async () => {
    await signInWithPasskey();
    expect(urls()).toEqual(["POST /api/account/signin/options", "POST /api/account/signin/verify", "POST /api/storage/open"]);
    expect(isSignedIn()).toBe(true);
  });

  it("reports what the server offers", async () => {
    expect(await accountStatus()).toMatchObject({ available: true, persistent: true, rpId: "chat.example" });
  });
});

describe("restoring a session", () => {
  it("comes back after a reload without another passkey prompt", async () => {
    await registerAccount("Alice");
    _resetAccountForTests(keys); // a reload: module state gone, storage kept
    sessionStorage.setItem("m5cet:account:v1", JSON.stringify({ token: "session-token-abcdefghijkl", accountId: SUMMARY.id }));

    const restored = await restoreSession();
    expect(restored?.loginCount).toBe(4);
    expect(isSignedIn()).toBe(true);
    expect(calls.map((c) => c.url)).toContain("/api/account/me");
    // …and the database key this tab kept goes back to the server, in case
    // it restarted and forgot it.
    expect(calls.at(-1)).toMatchObject({ url: "/api/storage/open", body: { key: DB_KEY } });
  });

  it("gives up quietly when the key or the token is gone", async () => {
    sessionStorage.setItem("m5cet:account:v1", JSON.stringify({ token: "orphan-token-aaaaaaaaaaaa", accountId: "acc-unknown" }));
    expect(await restoreSession()).toBeNull();
    expect(sessionStorage.getItem("m5cet:account:v1")).toBeNull();
    expect(await restoreSession()).toBeNull();
  });
});

describe("the vault", () => {
  it("uploads sealed blobs only, and reads them back", async () => {
    await registerAccount("Alice");
    const chat = { messages: [{ id: "m1", text: "a secret sentence" }], rooms: ["alpha"], savedAt: 1 };
    await saveVault({ profile: { name: "Alice", theme: "midnight" }, chat });

    const put = calls.find((c) => c.method === "PUT")!;
    const raw = JSON.stringify(put.body);
    expect(raw).not.toContain("a secret sentence");
    expect(raw).not.toContain("midnight");
    expect(put.body).toMatchObject({ chat: { messages: 1, rooms: 1 } });
    expect(put.auth).toBe("Bearer session-token-abcdefghijkl");
    // The server's copy is readable only with the passkey key.
    expect(await openProfile(String((put.body!.chat as { ct: string }).ct), passkeyKey.current!)).toMatchObject({ rooms: ["alpha"] });

    const back = await loadVault<{ name: string }>();
    expect(back.profile?.name).toBe("Alice");
    expect(back.chat?.messages).toHaveLength(1);
  });

  it("refuses to work when nobody is signed in", async () => {
    await expect(loadVault()).rejects.toThrow(/not signed in/i);
    expect(await saveVault({ profile: { a: 1 } })).toBeNull();
  });

  it("logs only the allowlisted events, and never without a session", async () => {
    await logAccountEvent("decrypt-ok");
    expect(urls()).toEqual([]);
    await registerAccount("Alice");
    await logAccountEvent("decrypt-ok", { messages: 3 });
    expect(calls.at(-1)).toMatchObject({ url: "/api/account/event", body: { kind: "decrypt-ok", meta: { messages: 3 } } });
  });
});

describe("push and ending the session", () => {
  it("links this device for the away wake-up", async () => {
    await registerAccount("Alice");
    const ok = await linkPushSubscription({ endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } } as PushSubscriptionJSON);
    expect(ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ url: "/api/account/push", body: { subscription: { endpoint: "https://push.example/x" } } });
  });

  it("signing out drops the token and the local key", async () => {
    await registerAccount("Alice");
    await signOutAccount();
    expect(isSignedIn()).toBe(false);
    expect(sessionStorage.getItem("m5cet:account:v1")).toBeNull();
    expect(keys.size).toBe(0);
    expect(calls.at(-1)).toMatchObject({ url: "/api/account/signout" });
  });

  it("deleting the account asks the server and forgets everything here", async () => {
    await registerAccount("Alice");
    await deleteAccount();
    expect(calls.at(-1)).toMatchObject({ url: "/api/account", method: "DELETE" });
    expect(isSignedIn()).toBe(false);
    expect(keys.size).toBe(0);
  });
});
