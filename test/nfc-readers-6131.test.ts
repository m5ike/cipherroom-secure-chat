// @vitest-environment node
//
// 6.13.1 — the reader connections that did not work on the reporter's Mac:
//   * Web Serial: Bluetooth SPP ports are offered (service class + filter),
//     "all serial ports" is a choice, the first contact wakes the PN532 and
//     retries while a Bluetooth link comes up, a silent reader is "no-answer"
//   * WebUSB: a reader the OS smart-card stack holds is "reader-owned-by-os"
//     with a platform explanation, never only the raw DOMException
//   * PC/SC ATRs: storage cards by name, ISO-DEP cards no longer taken for an Ultralight

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSerialPn532Transport, SPP_SERVICE_CLASS, USB_SERIAL_VENDORS, serialRequestOptions, isWirelessPort,
  type SerialPortLike, type SerialPortInfo, type SerialRequestOptions,
} from "../client/src/lib/nfc/transports/webserial-pn532";
import { WebUsbCcidTransport, mapUsbOpenError } from "../client/src/lib/nfc/transports/webusb-ccid";
import { buildFrame, FrameParser, WAKEUP } from "../client/src/lib/nfc/transports/pn532";
import { NfcError } from "../client/src/lib/nfc/errors";
import { parsePcscAtr } from "../client/src/lib/nfc/pcsc-atr";
import { slotOfReader } from "../client/src/lib/nfc/pcsc-bridge";
import { detectCard } from "../client/src/lib/nfc/cards/detect";
import { unhex } from "../client/src/lib/nfc/cards/apdu";
import { osFamily, readerErrorText } from "../client/src/lib/nfc/reader-guide";
import { EXTRA_I18N } from "../client/src/lib/i18n-extra";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FAST = { wired: { attempts: 2, answerMs: 60, gapMs: 10 }, wireless: { attempts: 3, answerMs: 60, gapMs: 20 } };

/** A PN532 behind a serial port: answers SAMConfiguration and GetFirmwareVersion like a v1.6 chip. */
class FakePn532Port implements SerialPortLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  readonly commands: number[] = [];
  wakeups = 0;
  closed = false;
  opened = false;
  private ctrl!: ReadableStreamDefaultController<Uint8Array>;
  private parser = new FrameParser();

  constructor(private readonly opts: {
    info: SerialPortInfo;
    /** Commands to leave unanswered first (a Bluetooth link still coming up). */
    ignoreFirst?: number;
    /** Never answer (switched off). */
    dead?: boolean;
    /** Answer the first command this late (ms). */
    firstDelayMs?: number;
    openError?: { name: string; message: string };
  }) {
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { this.ctrl = c; } });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => this.onBytes(chunk) });
  }

  getInfo(): SerialPortInfo { return this.opts.info; }
  async open(): Promise<void> {
    if (this.opts.openError) throw Object.assign(new Error(this.opts.openError.message), { name: this.opts.openError.name });
    this.opened = true;
  }
  async close(): Promise<void> { this.closed = true; try { this.ctrl.close(); } catch { /* closed */ } }

  private onBytes(chunk: Uint8Array): void {
    if (chunk.length >= 2 && chunk[0] === 0x55 && chunk[1] === 0x55) { this.wakeups++; return; }
    this.parser.push(chunk);
    let f;
    while ((f = this.parser.next()) !== null) {
      if (f.kind !== "data" || f.tfi !== 0xd4) continue;
      const cmd = f.payload[0];
      const n = this.commands.push(cmd);
      if (this.opts.dead || n <= (this.opts.ignoreFirst ?? 0)) continue;
      const data = cmd === 0x02 ? [0x32, 0x01, 0x06, 0x07] : [];
      const answer = () => {
        if (this.closed) return;
        this.ctrl.enqueue(Uint8Array.of(0x00, 0x00, 0xff, 0x00, 0xff, 0x00));
        this.ctrl.enqueue(buildFrame(Uint8Array.of(0xd5, cmd + 1, ...data)));
      };
      if (n === 1 && this.opts.firstDelayMs) setTimeout(answer, this.opts.firstDelayMs);
      else setTimeout(answer, 1);
    }
  }
}

function fakeSerial(port: SerialPortLike, opts: { rejectBluetoothFilter?: boolean } = {}) {
  const calls: SerialRequestOptions[] = [];
  const serial = {
    async requestPort(o?: SerialRequestOptions) {
      calls.push(o ?? {});
      if (opts.rejectBluetoothFilter && o?.filters?.some((f) => f.bluetoothServiceClassId)) throw Object.assign(new TypeError("A filter must provide a property to filter by"), { name: "TypeError" });
      return port;
    },
    async getPorts() { return [port]; },
  };
  vi.stubGlobal("navigator", { serial });
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Web Serial: Bluetooth SPP ports and all ports", () => {
  it("the chooser offers the USB-UART bridges and Bluetooth SPP (service class allowed + filter)", () => {
    const o = serialRequestOptions(false);
    expect(o.allowedBluetoothServiceClassIds).toEqual([SPP_SERVICE_CLASS]);
    expect(o.filters).toEqual([...USB_SERIAL_VENDORS.map((usbVendorId) => ({ usbVendorId })), { bluetoothServiceClassId: SPP_SERVICE_CLASS }]);
    expect(SPP_SERVICE_CLASS).toBe("00001101-0000-1000-8000-00805f9b34fb");
  });

  it("\"all serial ports\" asks without filters (other adapters, /dev/cu.PN532_SPP), Bluetooth still allowed", () => {
    expect(serialRequestOptions(true)).toEqual({ allowedBluetoothServiceClassIds: [SPP_SERVICE_CLASS] });
  });

  it("a Bluetooth port, or one without USB ids, is a slow (wireless) link", () => {
    expect(isWirelessPort({ bluetoothServiceClassId: SPP_SERVICE_CLASS })).toBe(true);
    expect(isWirelessPort({})).toBe(true);
    expect(isWirelessPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe(false);
  });

  it("a USB-UART PN532 connects at the first round: wake-up, SAMConfiguration, GetFirmwareVersion", async () => {
    const port = new FakePn532Port({ info: { usbVendorId: 0x0403 } });
    const calls = fakeSerial(port);
    const t = new WebSerialPn532Transport({ timing: FAST });
    await t.connect();
    expect(t.isConnected()).toBe(true);
    expect(t.wireless).toBe(false);
    expect(t.firmware).toBe("PN532 v1.6");
    expect(port.wakeups).toBe(1);
    expect(port.commands).toEqual([0x14, 0x02]);
    expect(calls[0].filters?.some((f) => f.bluetoothServiceClassId === SPP_SERVICE_CLASS)).toBe(true);
    await t.disconnect();
    expect(port.closed).toBe(true);
  });

  it("a Bluetooth SPP PN532 whose link answers only on the third round still connects", async () => {
    const port = new FakePn532Port({ info: { bluetoothServiceClassId: SPP_SERVICE_CLASS }, ignoreFirst: 2 });
    fakeSerial(port);
    const t = new WebSerialPn532Transport({ timing: FAST });
    await t.connect();
    expect(t.isConnected()).toBe(true);
    expect(t.wireless).toBe(true);
    expect(port.wakeups).toBe(3);
    expect(port.commands).toEqual([0x14, 0x14, 0x14, 0x02]);
    await t.disconnect();
  });

  it("a late answer to the first round does not wedge the codec (waiters time out cleanly, a retry flushes)", async () => {
    const port = new FakePn532Port({ info: { bluetoothServiceClassId: SPP_SERVICE_CLASS }, firstDelayMs: 90 });
    fakeSerial(port);
    const t = new WebSerialPn532Transport({ timing: FAST });
    await t.connect();
    expect(t.isConnected()).toBe(true);
    expect(t.firmware).toBe("PN532 v1.6");
    await t.disconnect();
  });

  it("a reader that never answers is \"no-answer\" after the retries (switched on? paired?), and the port is closed", async () => {
    const port = new FakePn532Port({ info: { bluetoothServiceClassId: SPP_SERVICE_CLASS }, dead: true });
    fakeSerial(port);
    const t = new WebSerialPn532Transport({ timing: FAST });
    const err = await t.connect().catch((e) => e);
    expect(NfcError.is(err, "no-answer")).toBe(true);
    expect(err.message).toMatch(/switched on/);
    expect(port.wakeups).toBe(3);
    expect(port.closed).toBe(true);
    expect(t.isConnected()).toBe(false);
    expect(readerErrorText(err, { os: "mac", desktop: false })).toEqual({ key: "nfc.err.noAnswer" });
  });

  it("a Bluetooth port that cannot open is \"no-answer\"; a busy USB port is \"busy\"", async () => {
    fakeSerial(new FakePn532Port({ info: { bluetoothServiceClassId: SPP_SERVICE_CLASS }, openError: { name: "NetworkError", message: "Failed to open serial port." } }));
    const bt = await new WebSerialPn532Transport({ timing: FAST }).connect().catch((e) => e);
    expect(NfcError.is(bt, "no-answer")).toBe(true);
    expect(bt.detail).toMatch(/NetworkError/);
    fakeSerial(new FakePn532Port({ info: { usbVendorId: 0x10c4 }, openError: { name: "NetworkError", message: "Failed to open serial port." } }));
    const usb = await new WebSerialPn532Transport({ timing: FAST }).connect().catch((e) => e);
    expect(NfcError.is(usb, "busy")).toBe(true);
    expect(readerErrorText(usb, { os: "win", desktop: false })).toEqual({ key: "nfc.err.portBusy" });
  });

  it("an older browser that rejects the Bluetooth filter gets the USB filters alone", async () => {
    const port = new FakePn532Port({ info: { usbVendorId: 0x067b } });
    const calls = fakeSerial(port, { rejectBluetoothFilter: true });
    const t = new WebSerialPn532Transport({ timing: FAST });
    await t.connect();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ filters: USB_SERIAL_VENDORS.map((usbVendorId) => ({ usbVendorId })) });
    await t.disconnect();
  });

  it("the wake-up is the HSU preamble 55 55 + zeros", () => {
    expect(Array.from(WAKEUP.slice(0, 3))).toEqual([0x55, 0x55, 0x00]);
    expect(WAKEUP.length).toBe(16);
  });
});

describe("WebUSB: a reader the system holds", () => {
  it("maps claimInterface / open failures to reader-owned-by-os and keeps the browser's words in detail", () => {
    const claim = mapUsbOpenError({ name: "NetworkError", message: "Unable to claim interface." });
    expect(claim.code).toBe("reader-owned-by-os");
    expect(claim.detail).toBe("NetworkError: Unable to claim interface.");
    expect(mapUsbOpenError({ name: "SecurityError", message: "Access denied." }).code).toBe("reader-owned-by-os");
    expect(mapUsbOpenError({ name: "InvalidStateError", message: "The device is in use." }).code).toBe("reader-owned-by-os");
    expect(mapUsbOpenError({ name: "NotFoundError", message: "The device was disconnected." }).code).toBe("disconnected");
    expect(mapUsbOpenError({ name: "NotAllowedError", message: "" }).code).toBe("permission-denied");
  });

  it("the transport closes the device and says why (the claimInterface of the reporter's ACR1281)", async () => {
    const device = {
      productName: "ACR1281 1S Dual Reader", vendorId: 0x072f, productId: 0x2224, opened: false,
      configuration: { configurationValue: 1, interfaces: [{ interfaceNumber: 0, claimed: false, alternates: [], alternate: { alternateSetting: 0, interfaceClass: 0x0b, endpoints: [{ endpointNumber: 1, direction: "in", type: "bulk", packetSize: 64 }, { endpointNumber: 2, direction: "out", type: "bulk", packetSize: 64 }] } }] },
      configurations: [],
      open: vi.fn(async () => { device.opened = true; }),
      close: vi.fn(async () => { device.opened = false; }),
      selectConfiguration: vi.fn(), releaseInterface: vi.fn(), selectAlternateInterface: vi.fn(), transferIn: vi.fn(), transferOut: vi.fn(),
      claimInterface: vi.fn(async () => { throw Object.assign(new Error("Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface."), { name: "NetworkError" }); }),
    };
    vi.stubGlobal("navigator", { usb: { requestDevice: async () => device, getDevices: async () => [device] } });
    const t = new WebUsbCcidTransport();
    const err = await t.connect().catch((e) => e);
    expect(NfcError.is(err, "reader-owned-by-os")).toBe(true);
    expect(device.close).toHaveBeenCalled();
    expect(t.isConnected()).toBe(false);
  });

  it("explains it per platform — and points to the system reader inside M5cet Desktop", () => {
    const err = new NfcError("reader-owned-by-os", "x", "NetworkError: Unable to claim interface.");
    expect(readerErrorText(err, { os: "mac", desktop: false })).toEqual({ key: "nfc.err.osOwned.mac" });
    expect(readerErrorText(err, { os: "win", desktop: false })).toEqual({ key: "nfc.err.osOwned.win" });
    expect(readerErrorText(err, { os: "linux", desktop: false })).toEqual({ key: "nfc.err.osOwned.linux" });
    expect(readerErrorText(err, { os: "other", desktop: false })).toEqual({ key: "nfc.err.osOwned.other" });
    expect(readerErrorText(err, { os: "mac", desktop: true })).toEqual({ key: "nfc.err.osOwned.mac", also: "nfc.err.osOwned.desktop" });
  });

  it("knows the OS from the navigator", () => {
    expect(osFamily({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("mac");
    expect(osFamily({ userAgentData: { platform: "Windows" } })).toBe("win");
    expect(osFamily({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
    expect(osFamily({ userAgent: "Mozilla/5.0 (Linux; Android 15; SM-F956B)" })).toBe("android");
  });
});

describe("the 6.13.1 texts exist in all nine languages", () => {
  const keys = Object.keys(EXTRA_I18N.en).filter((k) => /^nfc\.(reader\.(system|help|guide)|serial\.allPorts|err\.|pcsc\.)/.test(k));
  it("en / cs / de in the code, es / it / fr / sk / sl / fi in web-extra.json", () => {
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const k of keys) {
      expect(EXTRA_I18N.cs[k], `cs ${k}`).toBeTruthy();
      expect(EXTRA_I18N.de[k], `de ${k}`).toBeTruthy();
    }
    for (const lang of ["es", "it", "fr", "sk", "sl", "fi"]) {
      const file = JSON.parse(readFileSync(join(__dirname, "..", "i18n", "locales", lang, "web-extra.json"), "utf8")) as Record<string, string>;
      for (const k of keys) expect(file[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});

describe("PC/SC ATRs", () => {
  // The reporter's card in the ACR1281's contactless slot.
  const ISO_DEP = unhex("3b8f80013101f1564011001900000000000000d1");
  const MIFARE_1K = unhex("3B8F8001804F0CA000000306030001000000006A");
  const ULTRALIGHT = unhex("3B8F8001804F0CA0000003060300030000000068");
  const CONTACT = unhex("3BFF9600008131FE4380318065B0846566FB120FFC829000");

  it("reads the PC/SC Part 3 layout: storage cards by name, ISO-DEP by its historical bytes, contact cards as such", () => {
    expect(parsePcscAtr(ISO_DEP)).toMatchObject({ contactless: true, storage: false, apdu: true, tech: "iso14443a" });
    expect(parsePcscAtr(ISO_DEP)?.historical.length).toBe(15);
    expect(parsePcscAtr(MIFARE_1K)).toMatchObject({ contactless: true, storage: true, apdu: false, cardName: 1, sak: 0x08, tech: "iso14443a" });
    expect(parsePcscAtr(ULTRALIGHT)).toMatchObject({ storage: true, cardName: 3, sak: 0x00 });
    expect(parsePcscAtr(CONTACT)).toMatchObject({ contactless: false, storage: false, apdu: true });
    expect(parsePcscAtr(unhex("00"))).toBeNull();
  });

  it("an ISO-DEP card's ATR is no longer detected as an Ultralight", () => {
    const top = detectCard({ uid: unhex("0201be4925a000"), atr: ISO_DEP, tech: "iso14443a", isoDep: true, hints: [] })[0];
    expect(top.type).toBe("iso-dep-generic");
    expect(detectCard({ uid: new Uint8Array(4), atr: ULTRALIGHT, tech: "iso14443a", isoDep: false, hints: [] })[0].type).toBe("mifare-ultralight");
  });

  it("labels the slots of a dual reader on macOS, Windows and Linux", () => {
    expect(slotOfReader("ACS ACR1281 1S Dual Reader(1)")).toBe("contact");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader(2)")).toBe("contactless");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader(3)")).toBe("sam");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader PICC 0")).toBe("contactless");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader ICC 0")).toBe("contact");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader SAM 0")).toBe("sam");
    expect(slotOfReader("ACS ACR1281 1S Dual Reader [ACR1281 1S Dual Reader PICC] 01 00")).toBe("contactless");
    expect(slotOfReader("ACS ACR122U PICC Interface")).toBe("contactless");
    expect(slotOfReader("Generic Smart Card Reader Interface")).toBe("unknown");
    expect(slotOfReader("Generic Smart Card Reader Interface", ISO_DEP)).toBe("contactless");
  });
});
