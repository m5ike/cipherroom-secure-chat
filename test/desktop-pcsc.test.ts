// @vitest-environment node
//
// 6.13.1 — M5cet Desktop's system smart-card reader (desktop/src/pcsc.ts) with
// a fake PC/SC library (instead of pcsc-mini) and a fake host (instead of the
// native dialogs): who may ask, the question per server, the reader chooser,
// APDUs and their limits, reader events, lock / navigation / withdrawal — and
// Web Bluetooth's chooser (bluetooth.ts), the settings and the packaging.

import { describe, expect, it, vi } from "vitest";
import { PcscService, senderPage, pcscErrorCode, type PcscBackend, type PcscCard, type PcscHost, type ReaderState, type SenderFacts } from "../desktop/src/pcsc";
import { BluetoothPicker } from "../desktop/src/bluetooth";
import { addServer, defaultSettings, pcscAllowed, removeServer, sanitizeSettings, setPcscAllowed } from "../desktop/src/settings";
import { STRINGS } from "../desktop/src/i18n";
import { APP_FILES, builderConfig, PCSC_EXCLUDE, PCSC_MAC_ARCH_FILES, PCSC_UNPACK } from "../desktop/scripts/builder-config.mjs";
import { PCSC_PREBUILDS } from "../desktop/scripts/pcsc-prebuilds.mjs";
import { machoInfo, makeSignable } from "../desktop/scripts/macho-signable.mjs";
import { PCSC_MAX_APDU, type PcscReader } from "../client/src/lib/nfc/pcsc-bridge";

const ORIGIN = "https://chat.example.org";
const PAGE = { id: 7, origin: ORIGIN };
const PICC = "ACS ACR1281 1S Dual Reader(2)";
const ICC = "ACS ACR1281 1S Dual Reader(1)";
const SAM = "ACS ACR1281 1S Dual Reader(3)";
const ATR = Uint8Array.from([0x3b, 0x8f, 0x80, 0x01, 0x31, 0x01, 0xf1, 0x56, 0x40, 0x11, 0x00, 0x19, 0, 0, 0, 0, 0, 0, 0, 0xd1]);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A fake PC/SC library: readers, cards, a log of what reached the cards. */
function fakeBackend(init: Record<string, boolean> = { [ICC]: false, [PICC]: true, [SAM]: false }) {
  let events: Parameters<PcscBackend["start"]>[0] | null = null;
  const state = new Map(Object.entries(init));
  const sent: string[] = [];
  const open = new Set<string>();
  let stopped = 0;
  let failConnect: Error | null = null;
  let failTransmit: Error | null = null;
  const st = (present: boolean): ReaderState => ({ present, mute: false, exclusive: false, atr: present ? ATR : new Uint8Array(0) });
  const backend: PcscBackend = {
    start(ev) {
      events = ev;
      for (const [name, present] of state) ev.change(name, st(present));
    },
    stop() { stopped++; },
    async connect(reader) {
      if (failConnect) throw failConnect;
      if (!state.get(reader)) throw Object.assign(new Error("no card"), { code: "NoSmartCard" });
      const id = `${reader}#${open.size}`;
      open.add(id);
      const card: PcscCard = {
        atr: ATR,
        protocol: "T=1",
        async transmit(apdu, max) {
          if (failTransmit) throw failTransmit;
          expect(max).toBe(65_538);
          sent.push(hex(apdu));
          return hex(apdu) === "ffca000000" ? Uint8Array.from([2, 1, 0xbe, 0x49, 0x25, 0xa0, 0, 0x90, 0]) : Uint8Array.of(0x90, 0x00);
        },
        async disconnect() { open.delete(id); },
      };
      return card;
    },
  };
  return {
    backend, sent, open,
    get stopped() { return stopped; },
    insert(name: string) { state.set(name, true); events?.change(name, st(true)); },
    remove(name: string) { state.set(name, false); events?.change(name, st(false)); },
    unplug(name: string) { state.delete(name); events?.gone(name); },
    failConnect(e: Error | null) { failConnect = e; },
    failTransmit(e: Error | null) { failTransmit = e; },
  };
}

function fakeHost(opts: { answer?: boolean; choose?: string | null } = {}) {
  const allowed = new Set<string>();
  const notified: Array<{ pageId: number; readers: PcscReader[] }> = [];
  const host: PcscHost & { asked: number; chosen: number; notified: typeof notified; allowed: Set<string>; offered: PcscReader[][] } = {
    asked: 0, chosen: 0, notified, allowed, offered: [],
    isAllowed: (o) => allowed.has(o),
    askAllow: vi.fn(async () => { host.asked++; await new Promise((r) => setTimeout(r, 5)); return opts.answer ?? true; }),
    allow: (o) => { allowed.add(o); },
    chooseReader: vi.fn(async (_o: string, readers: PcscReader[]) => { host.chosen++; host.offered.push(readers); return opts.choose === undefined ? PICC : opts.choose; }),
    notify: (pageId, readers) => { notified.push({ pageId, readers }); },
  };
  return host;
}

function service(b = fakeBackend(), h = fakeHost(), limits = {}) {
  return { b, h, s: new PcscService(() => b.backend, h, { limits }) };
}

describe("who may use the readers", () => {
  const facts = (over: Partial<SenderFacts> = {}): SenderFacts => ({ isPage: true, isMainFrame: true, frameUrl: `${ORIGIN}/r/abc`, serverOrigin: ORIGIN, pageId: 7, ...over });
  it("only the app window's page, its main frame, on the chosen server's origin", () => {
    expect(senderPage(facts())).toEqual({ id: 7, origin: ORIGIN });
    expect(senderPage(facts({ isPage: false }))).toBeNull();
    expect(senderPage(facts({ isMainFrame: false }))).toBeNull();
    expect(senderPage(facts({ frameUrl: "https://evil.example/" }))).toBeNull();
    expect(senderPage(facts({ frameUrl: "about:blank" }))).toBeNull();
    expect(senderPage(facts({ frameUrl: null }))).toBeNull();
    expect(senderPage(facts({ serverOrigin: null }))).toBeNull();
    expect(senderPage(facts({ serverOrigin: "null", frameUrl: "data:text/html,x" }))).toBeNull();
  });

  it("anything else gets not-allowed and never reaches PC/SC", async () => {
    const { s, h, b } = service();
    expect(await s.list(null)).toMatchObject({ ok: false, code: "not-allowed" });
    expect(await s.connect(null, null)).toMatchObject({ ok: false, code: "not-allowed" });
    expect(await s.transmit(null, "h", Uint8Array.of(0, 0xa4, 4, 0))).toMatchObject({ ok: false, code: "not-allowed" });
    expect(h.asked).toBe(0);
    expect(b.sent).toEqual([]);
  });
});

describe("the question per server", () => {
  it("asks once, remembers \"allow\", and concurrent calls share the one question", async () => {
    const { s, h } = service();
    const [a, c] = await Promise.all([s.list(PAGE), s.list(PAGE)]);
    expect(a).toMatchObject({ ok: true });
    expect(c).toMatchObject({ ok: true });
    expect(h.asked).toBe(1);
    expect(h.allowed.has(ORIGIN)).toBe(true);
    await s.list(PAGE);
    expect(h.asked).toBe(1);
  });

  it("\"don't allow\" holds for the page load (no prompt storm), a new load may ask again", async () => {
    const { s, h } = service(undefined, fakeHost({ answer: false }));
    expect(await s.list(PAGE)).toMatchObject({ ok: false, code: "denied" });
    expect(await s.connect(PAGE, null)).toMatchObject({ ok: false, code: "denied" });
    expect(h.asked).toBe(1);
    s.releasePage(PAGE.id);
    await s.list(PAGE);
    expect(h.asked).toBe(2);
  });

  it("no PC/SC on this computer: \"unavailable\" without asking", async () => {
    const h = fakeHost();
    const s = new PcscService(() => { throw new Error("Required addon dependency not found"); }, h);
    expect(await s.list(PAGE)).toMatchObject({ ok: false, code: "unavailable" });
    expect(h.asked).toBe(0);
  });
});

describe("the reader", () => {
  it("lists the three slots of the ACR1281, labelled", async () => {
    const { s } = service();
    const r = await s.list(PAGE);
    expect(r).toMatchObject({ ok: true });
    expect((r as { readers: PcscReader[] }).readers).toEqual([
      { name: ICC, slot: "contact", card: false },
      { name: PICC, slot: "contactless", card: true },
      { name: SAM, slot: "sam", card: false },
    ]);
  });

  it("one reader holds a card: it is taken without a chooser; GET UID through it", async () => {
    const { s, h, b } = service();
    const c = await s.connect(PAGE, null);
    expect(c).toMatchObject({ ok: true, reader: PICC, slot: "contactless", protocol: "T=1" });
    expect(h.chosen).toBe(0);
    const ok = c as { handle: string; atr: Uint8Array };
    expect(hex(ok.atr)).toBe(hex(ATR));
    const r = await s.transmit(PAGE, ok.handle, Uint8Array.of(0xff, 0xca, 0, 0, 0));
    expect(r).toMatchObject({ ok: true });
    expect(hex((r as { response: Uint8Array }).response)).toBe("0201be4925a0009000");
    expect(b.sent).toEqual(["ffca000000"]);
    expect(await s.disconnect(PAGE, ok.handle)).toEqual({ ok: true });
    expect(b.open.size).toBe(0);
  });

  it("several readers with cards (or a name the user has not picked): the user chooses; cancelling is \"cancelled\"", async () => {
    const b = fakeBackend({ [ICC]: true, [PICC]: true, [SAM]: false });
    const { s, h } = service(b, fakeHost({ choose: ICC }));
    const c = await s.connect(PAGE, null);
    expect(c).toMatchObject({ ok: true, reader: ICC });
    expect(h.chosen).toBe(1);
    expect(h.offered[0].map((r) => r.name)).toEqual([ICC, PICC, SAM]);
    // The picked reader is not asked for again on this page load …
    await s.connect(PAGE, ICC);
    expect(h.chosen).toBe(1);
    // … but a page cannot name another reader silently.
    await s.connect(PAGE, PICC);
    expect(h.chosen).toBe(2);
    const { s: s2 } = service(fakeBackend({ [ICC]: true, [PICC]: true }), fakeHost({ choose: null }));
    expect(await s2.connect(PAGE, null)).toMatchObject({ ok: false, code: "cancelled" });
  });

  it("an empty reader the user picked: \"no-card\" names it, so the page can wait for a card there", async () => {
    const b = fakeBackend({ [ICC]: false, [PICC]: false });
    const { s } = service(b, fakeHost({ choose: PICC }));
    expect(await s.connect(PAGE, null)).toMatchObject({ ok: false, code: "no-card", reader: PICC });
    b.insert(PICC);
    expect(await s.connect(PAGE, PICC)).toMatchObject({ ok: true, reader: PICC });
  });

  it("no reader at all is \"no-reader\"", async () => {
    const { s } = service(fakeBackend({}));
    expect(await s.connect(PAGE, null)).toMatchObject({ ok: false, code: "no-reader" });
  });

  it("refuses bad arguments, unknown handles and APDUs over the size cap", async () => {
    const { s, b } = service();
    expect(await s.connect(PAGE, 42)).toMatchObject({ ok: false, code: "bad-request" });
    expect(await s.connect(PAGE, "x".repeat(300))).toMatchObject({ ok: false, code: "bad-request" });
    const c = (await s.connect(PAGE, null)) as { handle: string };
    expect(await s.transmit(PAGE, "nope", Uint8Array.of(0, 0xa4, 4, 0))).toMatchObject({ ok: false, code: "bad-handle" });
    expect(await s.transmit(PAGE, c.handle, "00a40400")).toMatchObject({ ok: false, code: "bad-request" });
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xa4))).toMatchObject({ ok: false, code: "bad-request" });
    expect(await s.transmit(PAGE, c.handle, new Uint8Array(PCSC_MAX_APDU + 1))).toMatchObject({ ok: false, code: "too-large" });
    // An extended APDU at the cap goes through.
    expect(await s.transmit(PAGE, c.handle, new Uint8Array(PCSC_MAX_APDU))).toMatchObject({ ok: true });
    // Another page cannot use this page's handle.
    expect(await s.transmit({ id: 8, origin: ORIGIN }, c.handle, Uint8Array.of(0, 0xa4, 4, 0))).toMatchObject({ ok: false, code: "bad-handle" });
    expect(b.sent).toHaveLength(1);
  });

  it("rate limits: APDUs and calls beyond the burst are refused", async () => {
    let now = 1_000_000;
    const b = fakeBackend();
    const h = fakeHost();
    const s = new PcscService(() => b.backend, h, { limits: { apduBurst: 3, apduPerSecond: 1, callBurst: 4, callPerSecond: 1 }, now: () => now });
    const c = (await s.connect(PAGE, null)) as { handle: string };
    const apdu = Uint8Array.of(0, 0xb0, 0, 0, 0);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await s.transmit(PAGE, c.handle, apdu)).ok);
    expect(codes).toEqual([true, true, true, false, false]);
    expect(await s.transmit(PAGE, c.handle, apdu)).toMatchObject({ code: "rate-limited" });
    now += 2000;
    expect(await s.transmit(PAGE, c.handle, apdu)).toMatchObject({ ok: true });
    for (let i = 0; i < 4; i++) await s.list(PAGE);
    expect(await s.list(PAGE)).toMatchObject({ ok: false, code: "rate-limited" });
  });

  it("maps PC/SC errors to stable codes and ends a connection whose card left", async () => {
    expect(pcscErrorCode({ code: "RemovedCard" })).toBe("removed");
    expect(pcscErrorCode({ code: "SharingViolation" })).toBe("busy");
    expect(pcscErrorCode({ code: "NoService" })).toBe("unavailable");
    expect(pcscErrorCode({ code: "UnresponsiveCard" })).toBe("card-error");
    expect(pcscErrorCode({ code: "Timeout" })).toBe("timeout");
    expect(pcscErrorCode(new Error("x"))).toBe("failed");
    const { s, b } = service();
    const c = (await s.connect(PAGE, null)) as { handle: string };
    b.failTransmit(Object.assign(new Error("Card removed"), { code: "RemovedCard" }));
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xb0, 0, 0, 0))).toMatchObject({ ok: false, code: "removed", reader: PICC });
    b.failTransmit(null);
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xb0, 0, 0, 0))).toMatchObject({ ok: false, code: "bad-handle" });
    b.failConnect(Object.assign(new Error("in use"), { code: "SharingViolation" }));
    expect(await s.connect(PAGE, null)).toMatchObject({ ok: false, code: "busy" });
  });

  it("a hung card times out instead of blocking the page", async () => {
    const b = fakeBackend();
    const s = new PcscService(() => b.backend, fakeHost(), { limits: { transmitTimeoutMs: 30 } });
    const c = (await s.connect(PAGE, null)) as { handle: string };
    // The card stops answering.
    const entry = (s as unknown as { pages: Map<number, { handles: Map<string, { card: PcscCard }> }> }).pages.get(PAGE.id)!.handles.get(c.handle)!;
    entry.card = { ...entry.card, transmit: () => new Promise(() => undefined) };
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xb0, 0, 0, 0))).toMatchObject({ ok: false, code: "timeout" });
    // … and its connection is over.
    expect(s.openHandles()).toBe(0);
  });
});

describe("events and the end of access", () => {
  it("tells a page that uses readers about attach / detach / insert / remove — only what changed, only when allowed", async () => {
    const { s, h, b } = service();
    b.insert(ICC); // before the page uses readers: nothing sent
    expect(h.notified).toEqual([]);
    await s.list(PAGE);
    b.remove(PICC);
    b.remove(PICC); // no change: not sent again
    b.unplug(SAM);
    expect(h.notified).toHaveLength(2);
    expect(h.notified[0].readers.find((r) => r.name === PICC)?.card).toBe(false);
    expect(h.notified[1].readers.map((r) => r.name)).toEqual([ICC, PICC]);
    expect(h.notified.every((n) => n.pageId === PAGE.id)).toBe(true);
  });

  it("a card taken out closes the page's connection to it", async () => {
    const { s, b } = service();
    const c = (await s.connect(PAGE, null)) as { handle: string };
    expect(s.openHandles()).toBe(1);
    b.remove(PICC);
    expect(s.openHandles()).toBe(0);
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xb0, 0, 0, 0))).toMatchObject({ code: "bad-handle" });
  });

  it("navigation / closing the page closes its connections; withdrawing access stops events and connections", async () => {
    const { s, h, b } = service();
    await s.connect(PAGE, null);
    s.releasePage(PAGE.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.open.size).toBe(0);
    await s.connect(PAGE, null);
    h.allowed.delete(ORIGIN);
    s.revoke(ORIGIN);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.open.size).toBe(0);
    const before = h.notified.length;
    b.remove(PICC);
    expect(h.notified.length).toBe(before);
  });

  it("nothing while the screen is locked; connections close when it locks", async () => {
    const { s, b } = service();
    const c = (await s.connect(PAGE, null)) as { handle: string };
    s.setLocked(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(b.open.size).toBe(0);
    expect(await s.list(PAGE)).toMatchObject({ ok: false, code: "locked" });
    expect(await s.transmit(PAGE, c.handle, Uint8Array.of(0, 0xb0, 0, 0, 0))).toMatchObject({ ok: false, code: "locked" });
    s.setLocked(false);
    expect(await s.connect(PAGE, null)).toMatchObject({ ok: true });
  });

  it("quitting closes everything and stops PC/SC", async () => {
    const { s, b } = service();
    await s.connect(PAGE, null);
    s.shutdown();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.open.size).toBe(0);
    expect(b.stopped).toBe(1);
  });

  it("the self-test reads the ATR and — on the contactless slot only — GET UID", async () => {
    const b = fakeBackend({ [ICC]: true, [PICC]: true, [SAM]: false });
    const s = new PcscService(() => b.backend, fakeHost());
    const r = await s.selfTest(10);
    expect(r.ok).toBe(true);
    expect(r.readers.find((x) => x.name === PICC)).toMatchObject({ card: true, atr: hex(ATR), uid: "0201be4925a000", sw: "9000" });
    expect(r.readers.find((x) => x.name === ICC)).toMatchObject({ card: true, atr: hex(ATR) });
    expect(r.readers.find((x) => x.name === ICC)?.uid).toBeUndefined();
    expect(b.sent).toEqual(["ffca000000"]);
    expect(b.open.size).toBe(0);
  });
});

describe("settings: the answer per server", () => {
  it("is kept only for servers in the list, written as the origin, removed with the server", () => {
    let s = (addServer(defaultSettings(), ORIGIN, 1) as { settings: ReturnType<typeof defaultSettings> }).settings;
    expect(pcscAllowed(s, ORIGIN)).toBe(false);
    s = setPcscAllowed(s, ORIGIN, true);
    expect(pcscAllowed(s, ORIGIN)).toBe(true);
    expect(setPcscAllowed(s, "https://other.example", true).pcsc).toEqual([ORIGIN]);
    expect(sanitizeSettings({ ...s, pcsc: [ORIGIN, "https://not-a-server.example", 5, ORIGIN] }).pcsc).toEqual([ORIGIN]);
    expect(pcscAllowed(setPcscAllowed(s, ORIGIN, false), ORIGIN)).toBe(false);
    expect(removeServer(s, ORIGIN).pcsc).toEqual([]);
  });
});

describe("Web Bluetooth chooser", () => {
  it("collects the scan's devices, then lets the user pick one", async () => {
    const choose = vi.fn(async (d: Array<{ deviceId: string }>) => d[1].deviceId);
    const nothing = vi.fn();
    const p = new BluetoothPicker(choose, nothing, { collectMs: 20, timeoutMs: 200, pollMs: 10 });
    const cb = vi.fn();
    p.onEvent([{ deviceId: "a", deviceName: "PN532-BLE" }], cb);
    p.onEvent([{ deviceId: "a", deviceName: "PN532-BLE" }, { deviceId: "b", deviceName: "HMSoft" }], cb);
    await new Promise((r) => setTimeout(r, 60));
    expect(choose).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("b");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(p.names.get("b")).toBe("HMSoft");
    expect(p.pending).toBe(false);
  });

  it("nothing found within the timeout cancels the request and says so", async () => {
    const nothing = vi.fn();
    const p = new BluetoothPicker(async () => null, nothing, { collectMs: 10, timeoutMs: 40, pollMs: 10 });
    const cb = vi.fn();
    p.onEvent([], cb);
    await new Promise((r) => setTimeout(r, 90));
    expect(cb).toHaveBeenCalledWith("");
    expect(nothing).toHaveBeenCalledTimes(1);
  });

  it("the page navigating away cancels a pending request; a closed chooser is a cancel", async () => {
    const p = new BluetoothPicker(async () => null, () => undefined, { collectMs: 10, timeoutMs: 100, pollMs: 10 });
    const cb = vi.fn();
    p.onEvent([{ deviceId: "a", deviceName: "x" }], cb);
    p.cancel();
    expect(cb).toHaveBeenCalledWith("");
    const cb2 = vi.fn();
    p.onEvent([{ deviceId: "a", deviceName: "x" }], cb2);
    await new Promise((r) => setTimeout(r, 40));
    expect(cb2).toHaveBeenCalledWith("");
  });
});

/** A minimal thin x86_64 dylib: a __TEXT segment whose __text starts right after the load commands. */
function fakeDylib(opts: { signed?: boolean; padding?: number; sourceVersion?: boolean } = {}): Buffer {
  const cmds: Buffer[] = [];
  const seg = Buffer.alloc(72 + 80);
  seg.writeUInt32LE(0x19, 0); seg.writeUInt32LE(seg.length, 4); seg.write("__TEXT", 8); seg.writeUInt32LE(1, 64);
  seg.write("__text", 72); seg.write("__TEXT", 88);
  cmds.push(seg);
  if (opts.sourceVersion !== false) { const sv = Buffer.alloc(16); sv.writeUInt32LE(0x2a, 0); sv.writeUInt32LE(16, 4); sv.writeUInt32LE(0x1234, 8); cmds.push(sv); }
  const uuid = Buffer.alloc(24); uuid.writeUInt32LE(0x1b, 0); uuid.writeUInt32LE(24, 4); uuid.fill(0xab, 8); cmds.push(uuid);
  if (opts.signed) { const cs = Buffer.alloc(16); cs.writeUInt32LE(0x1d, 0); cs.writeUInt32LE(16, 4); cmds.push(cs); }
  const sizeofcmds = cmds.reduce((n, c) => n + c.length, 0);
  const textAt = 32 + sizeofcmds + (opts.padding ?? 0);
  seg.writeUInt32LE(textAt, 72 + 48);
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xfeedfacf, 0); head.writeUInt32LE(0x01000007, 4); head.writeUInt32LE(6, 12); head.writeUInt32LE(cmds.length, 16); head.writeUInt32LE(sizeofcmds, 20);
  return Buffer.concat([head, ...cmds, Buffer.alloc(opts.padding ?? 0), Buffer.from([0x55, 0x48, 0x89, 0xe5, 0xc3])]);
}

describe("the x86_64 PC/SC binary survives codesign", () => {
  it("drops LC_SOURCE_VERSION when the load commands leave no room for LC_CODE_SIGNATURE — the code does not move", () => {
    const b = fakeDylib();
    const code = b.subarray(b.length - 5).toString("hex");
    expect(machoInfo(b)).toMatchObject({ signed: false, padding: 0 });
    expect(makeSignable(b)).toBe(true);
    expect(machoInfo(b)).toMatchObject({ ncmds: 2, padding: 16, sourceVersion: -1 });
    expect(b.subarray(b.length - 5).toString("hex")).toBe(code);
    // The UUID command moved up intact.
    expect(b.readUInt32LE(32 + 152)).toBe(0x1b);
    expect(b.subarray(32 + 152 + 8, 32 + 152 + 24).every((x) => x === 0xab)).toBe(true);
    expect(makeSignable(b)).toBe(false);
  });

  it("leaves signed files, files with room and other formats alone", () => {
    expect(makeSignable(fakeDylib({ signed: true }))).toBe(false);
    expect(makeSignable(fakeDylib({ padding: 32 }))).toBe(false);
    expect(makeSignable(Buffer.from("MZ not a mach-o file at all, really"))).toBe(false);
    expect(() => makeSignable(fakeDylib({ sourceVersion: false }))).toThrow(/no room/);
  });
});

describe("texts and packaging", () => {
  it("the new native texts exist in all nine languages", () => {
    for (const key of ["menu.pcsc", "dlg.pcsc.title", "dlg.pcsc.body", "dlg.pcscReader.title", "dlg.pcscReader.body", "btn.allow", "btn.dontAllow", "pcsc.slot.contactless", "pcsc.card", "dlg.btPair.pin", "dlg.bt.unnamed"] as const) {
      for (const text of Object.values(STRINGS[key])) expect(text, key).toBeTruthy();
    }
  });

  it("the native module is unpacked, both macOS binaries are merged into the universal app, each OS gets only its own", () => {
    const c = builderConfig({});
    expect(c.asarUnpack).toEqual([PCSC_UNPACK]);
    expect(c.mac.x64ArchFiles).toBe(PCSC_MAC_ARCH_FILES);
    // A platform's `files` replaces the root list in electron-builder: it repeats it (else "**/*" — sources — would be packed).
    expect(c.files).toEqual(APP_FILES);
    expect(c.mac.files).toEqual([...APP_FILES, ...PCSC_EXCLUDE.mac]);
    expect(c.win.files).toEqual([...APP_FILES, ...PCSC_EXCLUDE.win]);
    expect(c.mac.files.filter((p: string) => !p.startsWith("!"))).toEqual(["dist/**/*", "web/**/*", "web-index.json", "package.json"]);
    expect(PCSC_EXCLUDE.mac.join(" ")).toMatch(/windows-\*/);
    expect(PCSC_EXCLUDE.win.join(" ")).toMatch(/macos-\*/);
    expect(PCSC_EXCLUDE.win.join(" ")).toMatch(/windows-\*-node/);
    expect(PCSC_PREBUILDS.mac).toEqual(["@pcsc-mini/macos-aarch64", "@pcsc-mini/macos-x86_64"]);
    expect(PCSC_PREBUILDS.win).toEqual(["@pcsc-mini/windows-x86_64-electron", "@pcsc-mini/windows-aarch64-electron"]);
  });
});
