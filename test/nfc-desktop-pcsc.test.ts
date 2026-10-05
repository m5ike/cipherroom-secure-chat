// 6.13.1 — the page's side of the system smart-card reader (M5cet Desktop):
// transports/desktop-pcsc.ts over a fake `window.m5desktop.pcsc` bridge.
// The app's side (permission, chooser, limits) is test/desktop-pcsc.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopPcscTransport, pcscCodeOf } from "../client/src/lib/nfc/transports/desktop-pcsc";
import { listTransports, createTransport } from "../client/src/lib/nfc/index";
import { createWebExecutor } from "../client/src/lib/nfc/web-executor";
import { readerErrorText } from "../client/src/lib/nfc/reader-guide";
import { NfcError } from "../client/src/lib/nfc/errors";
import { hex, unhex } from "../client/src/lib/nfc/cards/apdu";
import type { PcscBridge, PcscReader, PcscErrorCode } from "../client/src/lib/nfc/pcsc-bridge";

const PICC = "ACS ACR1281 1S Dual Reader(2)";
const ICC = "ACS ACR1281 1S Dual Reader(1)";
const SAM = "ACS ACR1281 1S Dual Reader(3)";
const ISO_DEP_ATR = unhex("3b8f80013101f1564011001900000000000000d1");
const CONTACT_ATR = unhex("3BFF9600008131FE4380318065B0846566FB120FFC829000");
const MIFARE_1K_ATR = unhex("3B8F8001804F0CA000000306030001000000006A");

/** A simulated app: three ACR1281 slots, a card that can be put in and taken out. */
function fakeBridge(opts: { card?: string | null; atr?: Uint8Array; fail?: PcscErrorCode; pick?: string } = {}) {
  const cards = new Map<string, Uint8Array>();
  if (opts.card !== null) cards.set(opts.card ?? PICC, opts.atr ?? ISO_DEP_ATR);
  const listeners = new Set<(r: PcscReader[]) => void>();
  const sent: string[] = [];
  const handles = new Map<string, string>();
  let n = 0;
  let readers = [ICC, PICC, SAM];
  const view = (): PcscReader[] => readers.map((name) => ({ name, slot: name === PICC ? "contactless" : name === ICC ? "contact" : "sam", card: cards.has(name) }));
  const emit = () => { for (const l of listeners) l(view()); };
  const bridge: PcscBridge & { sent: string[]; insert(r: string, atr?: Uint8Array): void; remove(r: string): void; unplug(): void; connects: Array<string | null | undefined> } = {
    sent,
    connects: [],
    async listReaders() { return { ok: true, readers: view() }; },
    async connect(reader) {
      bridge.connects.push(reader);
      if (opts.fail) return { ok: false, code: opts.fail, message: opts.fail };
      const name = reader ?? opts.pick ?? [...cards.keys()][0] ?? PICC;
      if (!readers.includes(name)) return { ok: false, code: "no-reader", message: "gone" };
      const atr = cards.get(name);
      if (!atr) return { ok: false, code: "no-card", message: "no card", reader: name };
      const handle = `h${(n += 1)}`;
      handles.set(handle, name);
      return { ok: true, handle, reader: name, slot: name === PICC ? "contactless" : "contact", atr, protocol: "T=1" };
    },
    async transmit(handle, apdu) {
      const r = handles.get(handle);
      if (!r) return { ok: false, code: "bad-handle", message: "no such connection" };
      if (!cards.has(r)) return { ok: false, code: "removed", message: "removed" };
      const h = hex(apdu);
      sent.push(h);
      if (h === "FFCA000000") return { ok: true, response: unhex("0201be4925a0009000") };
      if (h.startsWith("FF82") || h.startsWith("FF86")) return { ok: true, response: unhex("9000") };
      if (h.startsWith("FFB0")) return { ok: true, response: unhex("00112233445566778899AABBCCDDEEFF9000") };
      return { ok: true, response: unhex("9000") };
    },
    async disconnect(handle) { handles.delete(handle); return { ok: true }; },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    insert(r, atr = ISO_DEP_ATR) { cards.set(r, atr); emit(); },
    remove(r) { cards.delete(r); for (const [h, x] of handles) if (x === r) handles.delete(h); emit(); },
    unplug() { readers = []; cards.clear(); emit(); },
  };
  return bridge;
}

afterEach(() => { delete (window as unknown as { m5desktop?: unknown }).m5desktop; });

describe("the system reader transport (M5cet Desktop)", () => {
  it("exists only inside the desktop app, and comes first there", () => {
    expect(new DesktopPcscTransport(null).isSupported()).toBe(false);
    expect(listTransports().map((x) => x.id)).not.toContain("desktop-pcsc");
    (window as unknown as { m5desktop: unknown }).m5desktop = { isDesktop: true, pcsc: fakeBridge() };
    const list = listTransports();
    expect(list[0]).toMatchObject({ id: "desktop-pcsc", label: "System reader (PC/SC)", supported: true });
    expect(createTransport("desktop-pcsc").id).toBe("desktop-pcsc");
  });

  it("is honest about what it can do: APDUs and MIFARE Classic via the PC/SC pseudo-APDUs; no raw frames, no emulation", () => {
    expect(new DesktopPcscTransport(fakeBridge()).capabilities).toEqual({ apdu: true, raw: false, mifareAuth: true, ndefOnly: false, emulate: false, write: true });
  });

  it("connects (the app asks and picks), identifies the card from the ATR and GET UID, exchanges APDUs", async () => {
    const b = fakeBridge();
    const t = new DesktopPcscTransport(b);
    const trace: string[] = [];
    t.onTrace((dir, bytes) => trace.push(`${dir} ${hex(bytes)}`));
    await t.connect();
    expect(b.connects).toEqual([null]);
    expect(t.isConnected()).toBe(true);
    expect(t.pickedReader).toEqual({ name: PICC, slot: "contactless" });
    const id = await t.waitForCard({ timeoutMs: 1000 });
    expect(hex(id.uid)).toBe("0201BE4925A000");
    expect(hex(id.atr!)).toBe(hex(ISO_DEP_ATR));
    expect(id).toMatchObject({ tech: "iso14443a", isoDep: true });
    expect(id.hints).toContain("pcsc");
    const r = await t.transmit(unhex("00A4040007A0000002471001"));
    expect(hex(r)).toBe("9000");
    expect(trace).toContain("tx 00A4040007A0000002471001");
    // The same card: no second connect, the identity is kept.
    await t.waitForCard({ timeoutMs: 1000 });
    expect(b.connects).toEqual([null]);
    await t.disconnect();
    expect(t.isConnected()).toBe(false);
  });

  it("never sends the reader's GET UID to a contact card (there CLA FF would reach the card)", async () => {
    const b = fakeBridge({ card: ICC, atr: CONTACT_ATR });
    const t = new DesktopPcscTransport(b);
    await t.connect();
    const id = await t.waitForCard({ timeoutMs: 1000 });
    expect(b.sent).toEqual([]);
    expect(id.uid.length).toBe(0);
    expect(id.hints).toContain("contact");
    expect(id.isoDep).toBe(true);
  });

  it("a storage card (MIFARE Classic 1K) carries its SAK, and blocks are read through FF 82 / FF 86 / FF B0", async () => {
    const b = fakeBridge({ atr: MIFARE_1K_ATR });
    const t = new DesktopPcscTransport(b);
    await t.connect();
    const id = await t.waitForCard({ timeoutMs: 1000 });
    expect(id).toMatchObject({ sak: 0x08, isoDep: false });
    const block = await t.mifareReadBlock(4, "A", unhex("FFFFFFFFFFFF"), id.uid);
    expect(hex(block)).toBe("00112233445566778899AABBCCDDEEFF");
    expect(b.sent.slice(1)).toEqual(["FF82000006FFFFFFFFFFFF", "FF860000050100046000", "FFB0000410"]);
  });

  it("an empty reader the user picked: waitForCard waits for the card to be put in", async () => {
    const b = fakeBridge({ card: null, pick: PICC });
    const t = new DesktopPcscTransport(b);
    await t.connect();
    expect(t.pickedReader?.name).toBe(PICC);
    const waiting = t.waitForCard({ timeoutMs: 3000 });
    setTimeout(() => b.insert(PICC), 30);
    const id = await waiting;
    expect(hex(id.uid)).toBe("0201BE4925A000");
    expect(b.connects).toEqual([null, PICC]);
  });

  it("after releaseCard the next read waits for another card (taken away, put back)", async () => {
    const b = fakeBridge();
    const t = new DesktopPcscTransport(b);
    await t.connect();
    await t.waitForCard({ timeoutMs: 1000 });
    await t.releaseCard();
    let done = false;
    const next = t.waitForCard({ timeoutMs: 3000 }).then((x) => { done = true; return x; });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false);
    b.remove(PICC);
    await new Promise((r) => setTimeout(r, 10));
    b.insert(PICC);
    await next;
    expect(done).toBe(true);
  });

  it("a card taken out mid-read: the transmit fails as no-card and the next read connects again", async () => {
    const b = fakeBridge();
    const t = new DesktopPcscTransport(b);
    await t.connect();
    await t.waitForCard({ timeoutMs: 1000 });
    b.remove(PICC);
    const err = await t.transmit(unhex("00B0000010")).catch((e) => e);
    expect(NfcError.is(err)).toBe(true);
    b.insert(PICC);
    const id = await t.waitForCard({ timeoutMs: 1000 });
    expect(id.uid.length).toBe(7);
  });

  it("the reader unplugged: the device-lost callback fires", async () => {
    const b = fakeBridge();
    const t = new DesktopPcscTransport(b);
    const lost = vi.fn();
    t.onDisconnect(lost);
    await t.connect();
    b.unplug();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(t.isConnected()).toBe(false);
  });

  it("the app's refusals become NfcErrors the workbench explains", async () => {
    const cases: Array<[PcscErrorCode, string, string | null]> = [
      ["denied", "permission-denied", "nfc.pcsc.denied"],
      ["cancelled", "no-device", "nfc.cancelled"],
      ["no-reader", "no-device", "nfc.pcsc.noReader"],
      ["busy", "busy", "nfc.pcsc.busy"],
      ["unavailable", "unsupported", "nfc.pcsc.unavailable"],
      ["locked", "permission-denied", "nfc.pcsc.locked"],
    ];
    for (const [code, nfc, key] of cases) {
      const err = await new DesktopPcscTransport(fakeBridge({ fail: code })).connect().catch((e) => e);
      expect(NfcError.is(err, nfc as never), code).toBe(true);
      expect(pcscCodeOf(err)).toBe(code);
      expect(readerErrorText(err, { os: "mac", desktop: true })?.key ?? null).toBe(key);
    }
  });

  it("G-18 applies here too: a model's raw APDU only reads — a write (00 D6) or a reader pseudo-write (FF D6) never reaches the card", async () => {
    const b = fakeBridge();
    const t = new DesktopPcscTransport(b);
    await t.connect();
    const exec = createWebExecutor({ getTransport: () => t });
    expect((await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "00A4040007A0000002471001" } })).status).toBe("ok");
    const write = await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "00D6000004DEADBEEF" } });
    expect(write.status).toBe("denied");
    const pseudo = await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "FFD6000410" + "00".repeat(16) } });
    expect(pseudo.status).toBe("denied");
    const verify = await exec({ op: "raw-apdu", tech: "iso-dep", args: { apdu: "0020008008241234FFFFFFFFFF" } });
    expect(verify.status).toBe("denied");
    expect(b.sent.filter((x) => x.startsWith("00D6") || x.startsWith("FFD6") || x.startsWith("0020"))).toEqual([]);
    const tpl = await exec({ op: "app-template", args: { template: { label: "w", steps: [{ apdu: "00D6000004DEADBEEF" }] } } });
    expect(tpl.status).toBe("denied");
  });
});
