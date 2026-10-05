// 6.12 — the web client's open findings of docs/security-analysis.md that do not
// need protocol 4: F-08 (another member's model message), F-22 (names, quotes,
// operator notices), F-25 (misleading security UI), F-26 (vault slots, "Delete
// all", the session cache's idle clock), F-15 (hide my IP address), F-27 (the
// dev server's address). F-04 is in passphrase-strength.test.tsx, F-12 in
// nfc-tag-v2.test.ts, F-02 in release-integrity.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FnHostContext, FnOutputs, _resetPeerConsentsForTests, type FnHost } from "../client/src/components/fn/FnOutputs";
import { STRICT_SANDBOX_URL, sandboxUrl } from "../client/src/components/fn/FnSandbox";
import type { FnOutput } from "../client/src/lib/fn-outputs";
import { MessageBubble } from "../client/src/components/MessageBubble";
import { hasMixedScripts, nameSkeleton, nameWarning, nameWarningsFor, normalizeDisplayName, normalizeFrameNames, noticeSender } from "../client/src/lib/names";
import { forwardIndex, validatePayload, verifyForward, verifyQuote } from "../client/src/lib/validate";
import { roomKeyFingerprint, ROOM_FINGERPRINT_LABEL } from "../client/src/lib/fingerprint";
import { deriveRoomKeys } from "../client/src/lib/envelope";
import { t } from "../client/src/lib/i18n";
import { DEFAULT_LAYOUTS } from "../client/src/lib/layouts";
import { _deriveKeyForTest, isLegacySlot, openSlot, sealProfile, sealSlot } from "../client/src/lib/passkey";
import { noteSlotRevision, onVaultRollback, migrateVaultSlots } from "../client/src/lib/account";
import { createMemoryVault, createSessionCache, SESSION_IDLE_LIMIT_MS } from "../client/src/lib/session-cache";
import { wipeEverything } from "../client/src/lib/wipe";
import { loadPreferences } from "../client/src/lib/preferences";
import { TrustPanel } from "../client/src/components/panels";

type Interceptor = { beforeAsyncRequest: (c: { request: Request }) => Promise<Response | void> };
const happyDOM = (window as unknown as { happyDOM?: { settings: { fetch: { interceptor: Interceptor | null } } } }).happyDOM;
if (happyDOM) happyDOM.settings.fetch.interceptor = { beforeAsyncRequest: async ({ request }) => (new URL(request.url).pathname === "/fn-sandbox.html" ? new Response("<!doctype html><title>sandbox</title>", { headers: { "Content-Type": "text/html" } }) : undefined) };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/* ------------------------------------------------------------------ F-08 */

describe("F-08: another member's model message", () => {
  const host = (over: Partial<FnHost> = {}): FnHost => ({ lang: "en", event: vi.fn(async () => true), report: vi.fn(), flash: vi.fn(), openWindow: vi.fn(() => true), tone: () => "light", ...over });
  const meta = { keyword: "shop", name: "Shop", chain: "chn_abc123def", call: 2, events: ["button", "form"] };
  const show = (outputs: FnOutput[], h: FnHost, from?: { name: string }, m: Record<string, unknown> = meta) =>
    render(<FnHostContext.Provider value={h}><FnOutputs outputs={outputs} meta={m as never} fresh from={from} /></FnHostContext.Provider>);
  afterEach(() => _resetPeerConsentsForTests());

  it("browser code from another member runs in the strict sandbox (?origin=peer); the viewer's own does not", () => {
    expect(sandboxUrl(true)).toBe(STRICT_SANDBOX_URL);
    expect(STRICT_SANDBOX_URL).toBe("/fn-sandbox.html?origin=peer");
    const theirs = show([{ type: "js", code: "x()" }], host(), { name: "Mallory" });
    fireEvent.click(theirs.getByTestId("fn-peer-run"));
    expect(theirs.container.querySelector("iframe")!.getAttribute("src")).toBe(STRICT_SANDBOX_URL);
    cleanup();
    const mine = show([{ type: "js", code: "x()" }], host());
    expect(mine.container.querySelector("iframe")!.getAttribute("src")).toBe("/fn-sandbox.html");
  });

  it("a button in a member's model message asks first — naming the model and the member — once per message", async () => {
    const h = host();
    const r = show([{ type: "button", name: "buy", title: "Buy" }, { type: "button", name: "cancel", title: "Cancel" }], h, { name: "Mallory" });
    fireEvent.click(r.getByText("Buy"));
    const ask = await r.findByTestId("fn-peer-consent");
    expect(ask.textContent).toMatch(/Shop \(\/shop\)/);
    expect(ask.textContent).toMatch(/Mallory/);
    expect(h.event).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId("fn-peer-consent-no"));
    await waitFor(() => expect(r.queryByTestId("fn-peer-consent")).toBeNull());
    expect(h.event).not.toHaveBeenCalled();
    fireEvent.click(r.getByText("Buy"));
    fireEvent.click(await r.findByTestId("fn-peer-consent-yes"));
    await waitFor(() => expect(h.event).toHaveBeenCalledWith(meta, { type: "button", name: "buy", data: undefined }));
    // The answer holds for the message: the next button goes at once.
    fireEvent.click(r.getByText("Cancel"));
    await waitFor(() => expect(h.event).toHaveBeenCalledTimes(2));
    expect(r.queryByTestId("fn-peer-consent")).toBeNull();
  });

  it("a form in a member's model message asks too; the viewer's own model messages never ask", async () => {
    const h = host();
    const form: FnOutput = { type: "form", name: "pay", fields: [{ name: "card", type: "text" }], submit: "Pay" } as FnOutput;
    const r = show([form], h, { name: "Mallory" });
    fireEvent.submit(r.container.querySelector("form")!);
    expect(await r.findByTestId("fn-peer-consent")).toBeTruthy();
    expect(h.event).not.toHaveBeenCalled();
    cleanup();
    const mine = show([{ type: "button", name: "buy", title: "Buy" }], h);
    fireEvent.click(mine.getByText("Buy"));
    await waitFor(() => expect(h.event).toHaveBeenCalledTimes(1));
    expect(mine.queryByTestId("fn-peer-consent")).toBeNull();
  });

  it("starting a member's browser code is the answer for its message (the card says so)", () => {
    const r = show([{ type: "js", code: "m5.send('x')" }, { type: "button", name: "go", title: "Go" }], host(), { name: "Mallory" });
    expect(r.getByTestId("fn-peer-model-note").textContent).toMatch(/Shop.*Mallory/);
    fireEvent.click(r.getByTestId("fn-peer-run"));
    fireEvent.click(r.getByText("Go"));
    expect(r.queryByTestId("fn-peer-consent")).toBeNull();
  });
});

/* ------------------------------------------------------------------ F-22 */

describe("F-22: names", () => {
  it("normalizes: bidi controls and other format characters out, NFKC, one space, a cap", () => {
    expect(normalizeDisplayName("\u202Eecila\u202C")).toBe("ecila");
    expect(normalizeDisplayName("Al\u200Bi\u200Dce\uFEFF")).toBe("Alice");
    expect(normalizeDisplayName("Ａｌｉｃｅ")).toBe("Alice"); // full-width
    expect(normalizeDisplayName("  Bob \u00A0\u2003 Smith\n")).toBe("Bob Smith");
    expect(normalizeDisplayName("\u3164\u3164")).toBe(""); // Hangul fillers: an "empty" name
    expect(normalizeDisplayName("q\u0301\u0302\u0303\u0304\u0305")).toBe("q\u0301\u0302"); // "Zalgo": at most two marks in a row
    expect([...normalizeDisplayName("x".repeat(100))]).toHaveLength(48);
    expect(normalizeDisplayName(42)).toBe("");
  });

  it("a payload's names are normalized; an empty one becomes the peer-… fallback", () => {
    const p = validatePayload({ id: "m1", senderId: "p-abcd", senderName: "\u202EAlice", text: "x", replyTo: { id: "m0", senderName: "B\u200Bob", text: "q" }, forwardedFrom: "\u2066Eve\u2069", to: ["Ａnn"] }, { transportSender: "p-abcd", myId: "me" }) as { senderName: string; replyTo: { senderName: string }; forwardedFrom: string; to: string[] };
    expect(p.senderName).toBe("Alice");
    expect(p.replyTo.senderName).toBe("Bob");
    expect(p.forwardedFrom).toBe("Eve");
    expect(p.to).toEqual(["Ann"]);
    expect((validatePayload({ id: "m2", senderId: "p-abcd", senderName: "\u200B", text: "x" }, { transportSender: "p-abcd" }) as { senderName: string }).senderName).toBe("peer-abcd");
  });

  it("look-alikes: Cyrillic / Greek letters, digits, accents share a skeleton; mixed scripts are seen", () => {
    expect(nameSkeleton("Аlice")).toBe(nameSkeleton("Alice")); // Cyrillic А
    expect(nameSkeleton("ΑLICE")).toBe(nameSkeleton("alice")); // Greek Α
    expect(nameSkeleton("A1ice")).toBe(nameSkeleton("Alice"));
    expect(nameSkeleton("Alíce")).toBe(nameSkeleton("Alice"));
    expect(nameSkeleton("rnartin")).toBe(nameSkeleton("martin"));
    expect(nameSkeleton("Bob")).not.toBe(nameSkeleton("Alice"));
    expect(hasMixedScripts("Аlice")).toBe(true);
    expect(hasMixedScripts("Алиса")).toBe(false);
    expect(hasMixedScripts("Žluťoučký kůň")).toBe(false);
  });

  it("flags a name next to a member who was here first — not the first one", () => {
    const members = [{ id: "me", name: "Michal" }, { id: "p1", name: "Alice" }, { id: "p2", name: "Аlice" }, { id: "p3", name: "Alice" }, { id: "p4", name: "Bob" }];
    expect(nameWarning("Alice", "p1", members)).toBeNull();
    expect(nameWarning("Аlice", "p2", members)).toEqual({ kind: "confusable", like: "Alice" });
    expect(nameWarning("Alice", "p3", members)).toEqual({ kind: "duplicate", like: "Alice" });
    expect(nameWarning("Bob", "p4", members)).toBeNull();
    expect(nameWarning("Mіchal", "px", members)).toEqual({ kind: "confusable", like: "Michal" }); // Ukrainian і, not listed: the newest
    // The same name from a sender no longer here is that member before a reconnect — not a duplicate.
    expect(nameWarning("Alice", "p-old", members)).toBeNull();
    expect(nameWarning("Bоb", "p9", [{ id: "me", name: "Zed" }])).toEqual({ kind: "mixed" });
    const cached = nameWarningsFor(members);
    expect(cached("p2", "Аlice")).toBe(cached("p2", "Аlice")); // the same object: memoized rows stay
  });

  it("signaling frames: the names in them are fixed in place", () => {
    const frame = { type: "joined", peers: [{ peerId: "a", name: "\u202Eevil" }], away: [{ name: "Ｂob" }] };
    normalizeFrameNames(frame);
    expect(frame.peers[0].name).toBe("evil");
    expect(frame.away[0].name).toBe("Bob");
    const notice = { type: "peer-joined", name: "A\u200Bnn" };
    normalizeFrameNames(notice);
    expect(notice.name).toBe("Ann");
  });

  it("operator notices are always the operator's, whatever `from` claims", () => {
    expect(noticeSender("Alice", t("en", "notice.operator"))).toBe("operator");
    expect(noticeSender(undefined, "operátor")).toBe("operátor");
  });
});

describe("F-22: quotes and forwards", () => {
  const stored = { id: "m0", senderName: "Bob", text: "the real text", mine: false };
  it("a quote shows the real message's sender and text, not what the reply claims", () => {
    expect(verifyQuote({ id: "m0", senderName: "Alice", text: "I owe you 1000 €" }, stored)).toEqual({ id: "m0", senderName: "Bob", text: "the real text", missing: false });
    expect(verifyQuote({ id: "m0", senderName: "Bob", text: "x" }, { ...stored, flags: { sealed: {} } })).toMatchObject({ text: "🔒", sealed: true });
    expect(verifyQuote({ id: "m0", senderName: "Bob", text: "x" }, { ...stored, text: "", attachment: { name: "a.pdf" } })).toMatchObject({ text: "📎 a.pdf" });
  });

  it("an unknown quoted message is 'not found' — the claimed text is never shown as the original", () => {
    expect(verifyQuote({ id: "m-x", senderName: "Alice", text: "fake" }, null)).toEqual({ id: "m-x", senderName: "", text: "", missing: true });
    const r = render(<MessageBubble id="r1" senderId="p-mal" senderName="Mallory" mine={false} isSystem={false} secure createdAt={0} timeLabel="" text="reply" onVanish={() => undefined} lang="en" renderText={(s) => <span>{s}</span>} formatSize={(n) => `${n}`} badge={<b>Mallory</b>}
      replyTo={verifyQuote({ id: "m-x", senderName: "Alice", text: "I owe you 1000 €" }, null)} />);
    const quote = r.getByTestId("msg-quote-r1");
    expect(quote.textContent).toMatch(/not here/);
    expect(quote.textContent).not.toMatch(/1000/);
    expect(quote.textContent).not.toMatch(/Alice/);
  });

  it("'forwarded from X' checks out only against a message of X with the same text", () => {
    const index = forwardIndex([{ senderName: "Bob", text: "hello" }, { senderName: "Eve", text: "fwd", forwardedFrom: "Bob" }]);
    expect(verifyForward("Bob", "hello", index)).toBe(true);
    expect(verifyForward("Bob", "something else", index)).toBe(false);
    expect(verifyForward("Alice", "hello", index)).toBe(false);
    expect(verifyForward("/shop", "x", index)).toBeUndefined();
    expect(verifyForward("NFC", "x", index)).toBeUndefined();
    expect(verifyForward(undefined, "x", index)).toBeUndefined();
    const r = render(<MessageBubble id="f1" senderId="p-mal" senderName="Mallory" mine={false} isSystem={false} secure createdAt={0} timeLabel="" text="hello" onVanish={() => undefined} lang="en" renderText={(s) => <span>{s}</span>} formatSize={(n) => `${n}`} badge={<b>Mallory</b>}
      forwardedFrom="Alice" forwardVerified={false} />);
    expect(r.container.textContent).toMatch(/Alice \(not verified\)/);
  });

  it("the bubble flags a sender whose name looks like another member's", () => {
    const r = render(<MessageBubble id="w1" senderId="p2" senderName="Аlice" mine={false} isSystem={false} secure createdAt={0} timeLabel="" text="hi" onVanish={() => undefined} lang="en" renderText={(s) => <span>{s}</span>} formatSize={(n) => `${n}`} badge={<b>Аlice</b>}
      nameWarning={{ kind: "confusable", like: "Alice" }} />);
    const chip = r.getByTestId("msg-name-warning");
    expect(chip.textContent).toMatch(/Looks like Alice/);
    expect(chip.getAttribute("data-kind")).toBe("confusable");
  });
});

/* ------------------------------------------------------------------ F-25 */

describe("F-25: what the security UI says", () => {
  it("no 'PBKDF2 250 000' any more — the real Argon2id parameters, in every language", () => {
    for (const lang of ["cs", "en", "de"] as const) {
      const body = t(lang, "encryption.kdf.body");
      expect(body).not.toMatch(/PBKDF2|250/);
      expect(body).toMatch(/Argon2id/);
      expect(body).toMatch(/64 MiB/);
      expect(body).toMatch(/m5cet:room:v3:/);
      expect(t(lang, "encryption.kdf.label")).toMatch(/Argon2id/);
    }
    expect(JSON.stringify(DEFAULT_LAYOUTS["panel.encryption"])).not.toMatch(/PBKDF2/);
    const settings = readFileSync(path.resolve("client/src/lib/layouts/settings.ts"), "utf8");
    expect(settings).not.toMatch(/PBKDF2/);
  });

  it("the room fingerprint comes from the room KEY (HKDF), not from the name", async () => {
    const cost = { memoryKiB: 64, passes: 1 };
    const a = await deriveRoomKeys("rodina", "Kq7xVm-2PnRt4-Wz9cLd", cost);
    const b = await deriveRoomKeys("rodina", "another key entirely 42", cost);
    const fa = await roomKeyFingerprint(a);
    expect(fa).toMatch(/^[0-9a-f]{32}$/);
    expect(await roomKeyFingerprint(b)).not.toBe(fa); // same name, other key → other fingerprint
    expect(await roomKeyFingerprint(await deriveRoomKeys("rodina", "Kq7xVm-2PnRt4-Wz9cLd", cost))).toBe(fa);
    const raw = await a.derive(ROOM_FINGERPRINT_LABEL, 128);
    expect(fa).toBe(Array.from(raw, (x) => x.toString(16).padStart(2, "0")).join(""));
    expect(await roomKeyFingerprint(null)).toBeNull();
  });

  it("DTLS fingerprints are labelled by the member and their device key — not by the random peer id", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pk = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))));
    const r = render(<TrustPanel open onClose={() => undefined} prefs={loadPreferences()} setPrefs={() => undefined} lang="en"
      peerFingerprints={{ "peer-random-1234567890": { digest: "ab".repeat(32), firstSeenAt: "2026-10-05T00:00:00Z", lastSeenAt: "2026-10-05T00:00:00Z" }, "peer-other-0000": { digest: "cd".repeat(32), firstSeenAt: "2026-10-05T00:00:00Z", lastSeenAt: "2026-10-05T00:00:00Z" } }}
      describePeer={(id) => (id === "peer-random-1234567890" ? { name: "Alice", deviceKey: pk, verified: true } : { name: "Bob", verified: false })} />);
    await waitFor(() => expect(r.getAllByTestId("trust-peer")[0].textContent).toMatch(/^Alice · device [0-9A-F]{4} [0-9A-F]{4}.* · verified$/));
    expect(r.getAllByTestId("trust-peer")[1].textContent).toBe("Bob · device key not known yet");
    expect(r.container.textContent).not.toMatch(/1234567890/);
    expect(r.container.textContent).toMatch(/new DTLS certificate for every connection/);
  });
});

/* ------------------------------------------------------------------ F-26 */

describe("F-26: vault slots, Delete all, the idle clock", () => {
  const key = () => _deriveKeyForTest(new Uint8Array(32).fill(7));

  it("a v2 slot opens only as itself: another slot's ciphertext, or a changed revision, fails; it stays plain base64", async () => {
    const k = await key();
    const ct = await sealSlot({ a: 1 }, k, "profile", 1_800_000_000_000);
    expect(ct).toMatch(/^[A-Za-z0-9+/=]+$/); // server/accounts/store.ts accepts only base64 in a slot
    expect(atob(ct).slice(0, 4)).toBe("M5V2");
    expect(isLegacySlot(ct)).toBe(false);
    expect(await openSlot(ct, k, "profile")).toEqual({ value: { a: 1 }, rev: 1_800_000_000_000, legacy: false });
    await expect(openSlot(ct, k, "connections")).rejects.toBeTruthy(); // swapped by the server
    const bytes = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    bytes[11] ^= 1; // another revision in the header
    await expect(openSlot(btoa(String.fromCharCode(...bytes)), k, "profile")).rejects.toBeTruthy();
  });

  it("a v1 slot (no AAD) still opens and says it is legacy — nothing is lost", async () => {
    const k = await key();
    const old = await sealProfile({ rooms: ["a"] }, k);
    expect(isLegacySlot(old)).toBe(true);
    expect(await openSlot(old, k, "chat")).toEqual({ value: { rooms: ["a"] }, rev: 0, legacy: true });
  });

  it("an older revision than one seen is noticed (rollback), the data still opens", () => {
    const seen: unknown[] = [];
    const off = onVaultRollback((...a) => seen.push(a));
    expect(noteSlotRevision("acc-1", "profile", 2000)).toBe(true);
    expect(noteSlotRevision("acc-1", "profile", 3000)).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(noteSlotRevision("acc-1", "profile", 2500)).toBe(false);
    warn.mockRestore();
    expect(seen[0]).toEqual(["profile", 3000, 2500]);
    expect(noteSlotRevision("acc-2", "profile", 1)).toBe(true); // per account
    // A v1 copy (no revision) after a v2 one was seen: an old copy, too.
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(noteSlotRevision("acc-1", "profile", 0)).toBe(false);
    warn2.mockRestore();
    expect(noteSlotRevision("acc-3", "chat", 0)).toBe(true);
    off();
  });

  it("migration at sign-in: v1 slots are rewritten as v2 (counts kept), v2 ones and the card are left", async () => {
    const k = await key();
    const chat = { messages: [{ id: "m" }], rooms: ["a", "b"], savedAt: 1 };
    const vault = { profile: { ct: await sealProfile({ lang: "cs" }, k) }, chat: { ct: await sealProfile(chat, k) }, connections: { ct: await sealSlot({ profiles: [1] }, k, "connections") }, registration: null };
    const puts: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, ...vault }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const moved = await migrateVaultSlots("tok", "acc-m", k, vault);
    expect(moved).toEqual(["profile", "chat"]);
    expect(puts).toHaveLength(1);
    const body = puts[0] as { profile: string; chat: { ct: string; messages: number; rooms: number }; connections?: unknown };
    expect((await openSlot(body.profile, k, "profile")).value).toEqual({ lang: "cs" });
    expect(body.chat).toMatchObject({ messages: 1, rooms: 2 });
    expect((await openSlot(body.chat.ct, k, "chat")).value).toEqual(chat);
    expect(body.connections).toBeUndefined();
  });

  it("'Delete all' revokes the account's token first, then wipes", async () => {
    const order: string[] = [];
    const report = await wipeEverything({ revoke: async () => { order.push("revoke"); }, fetcher: (async () => { order.push("server"); return new Response("{}"); }) as unknown as typeof fetch, deviceId: "dev-1" });
    expect(order).toEqual(["revoke", "server"]);
    expect(report.account).toBe("ok");
    expect((await wipeEverything({})).account).toBe("skipped");
    expect((await wipeEverything({ revoke: async () => { throw new Error("offline"); } })).account).toBe("failed");
  });

  const memoryStorage = (): Storage => {
    const m = new Map<string, string>();
    return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, String(v)); } };
  };
  const DATA = { name: "Alice", room: "brno", passphrase: "k", desired: "connected" as const };

  it("the session's idle clock is inside the AEAD: editing touchedAt in storage does not keep a session alive", async () => {
    let now = 1_000_000;
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault, now: () => now });
    await cache.save(DATA);
    const rec = JSON.parse(storage.getItem("m5cet:session:v1")!);
    expect(rec.v).toBe(2);
    expect(rec.ts).toMatchObject({ iv: expect.any(String), ct: expect.any(String) });
    now += SESSION_IDLE_LIMIT_MS + 60_000;
    // A forger moves the plain clock forward…
    const forged = JSON.parse(storage.getItem("m5cet:session:v1")!);
    forged.touchedAt = now;
    storage.setItem("m5cet:session:v1", JSON.stringify(forged));
    // …the sealed one still says an hour has passed.
    expect(await createSessionCache({ storage, vault, now: () => now }).load()).toBeNull();
    expect(storage.getItem("m5cet:session:v1")).toBeNull();
  });

  it("a record of 6.11 (v1, plain clock) is still read once — and rewritten as v2 on the next save", async () => {
    const storage = memoryStorage(); const vault = createMemoryVault();
    const cache = createSessionCache({ storage, vault });
    await cache.save(DATA);
    const rec = JSON.parse(storage.getItem("m5cet:session:v1")!);
    delete rec.ts; rec.v = 1;
    storage.setItem("m5cet:session:v1", JSON.stringify(rec));
    expect(await createSessionCache({ storage, vault }).load()).toEqual(DATA);
    await cache.save(DATA);
    expect(JSON.parse(storage.getItem("m5cet:session:v1")!).v).toBe(2);
    // A v2 record whose sealed clock is gone is refused, not trusted.
    const broken = JSON.parse(storage.getItem("m5cet:session:v1")!);
    delete broken.ts;
    storage.setItem("m5cet:session:v1", JSON.stringify(broken));
    expect(await createSessionCache({ storage, vault }).load()).toBeNull();
  });
});

/* ------------------------------------------------------------------ F-15 */

describe("F-15: hide my IP address (the setting; rtc.ts in hide-ip-612.test.ts)", () => {
  it("the preference is off by default and survives a reload; the privacy panel has the switch", () => {
    expect(loadPreferences().hideIp).toBe(false);
    const tree = JSON.stringify(DEFAULT_LAYOUTS["panel.privacy"]);
    expect(tree).toContain("check-hide-ip");
    expect(tree).toContain("privacy.hideIp.noTurn");
    for (const lang of ["cs", "en", "de"] as const) expect(t(lang, "privacy.hideIp.body")).toMatch(/TURN/);
  });
});

/* ------------------------------------------------------------------ F-27 */

describe("F-27: the development server listens on loopback", () => {
  it("vite's dev server and the app's dev branch default to 127.0.0.1; HOST still overrides; production unchanged", async () => {
    const { resolveConfig } = await import("vite");
    const old = process.env.HOST;
    delete process.env.HOST;
    try {
      const config = await resolveConfig({ configFile: path.resolve("vite.config.ts"), logLevel: "silent" }, "serve");
      expect(config.server.host).toBe("127.0.0.1");
    } finally { if (old !== undefined) process.env.HOST = old; }
    const index = readFileSync(path.resolve("server/index.ts"), "utf8");
    expect(index).toMatch(/process\.env\.HOST\?\.trim\(\) \|\| \(process\.env\.NODE_ENV === "production" \? "0\.0\.0\.0" : "127\.0\.0\.1"\)/);
  });
});
