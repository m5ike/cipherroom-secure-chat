// Web Serial PN532 transport. A PN532 breakout on a USB-UART bridge
// (FTDI / CP2102 / CH340) exposed through the Web Serial API. Shares the
// frame codec in pn532.ts. This is the ONLY browser transport that can
// emulate a tag: emulateNdef() runs the PN532 as an ISO 7816 NDEF Type 4
// target so a phone can read an emulated tag.

import { NfcError, fromDomError } from "../errors";
import type { CardTransport, CardIdentity, WaitOpts, TransportCapabilities, RawOpts, EmulationEvent } from "../transport";
import { concat, u8, splitResponse, apdu as buildApdu, bytesEqual, hex } from "../cards/apdu";
import { encodeNdefMessage, buildT4NdefFile, T4T, type NdefRecord } from "../cards/ndef";
import {
  Pn532, PN532, getFirmwareVersion, samConfigure, listPassiveTargetTypeA,
  inDataExchange, inCommunicateThru, inRelease, type Duplex,
} from "./pn532";

/* ---------- Web Serial typings (subset) ---------- */
type SerialOptions = { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; bufferSize?: number; flowControl?: string };
type SerialPortLike = {
  open(opts: SerialOptions): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
  addEventListener?: (t: string, cb: () => void) => void;
};
type SerialLike = {
  requestPort(opts?: { filters?: Array<{ usbVendorId?: number }> }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener?: (t: string, cb: () => void) => void;
};

function serial(): SerialLike | null {
  return typeof navigator !== "undefined" && "serial" in navigator ? (navigator as unknown as { serial: SerialLike }).serial : null;
}

/** Build a Duplex over a Web Serial port. */
function serialDuplex(port: SerialPortLike): Duplex & { detachReader(): void } {
  const writer = port.writable?.getWriter();
  const reader = port.readable?.getReader();
  if (!writer || !reader) throw new NfcError("protocol", "Serial port has no readable/writable stream");
  return {
    async write(bytes: Uint8Array) { await writer.write(bytes); },
    read(): AsyncIterator<Uint8Array> {
      return {
        async next() {
          const { value, done } = await reader.read();
          return done ? { value: undefined as unknown as Uint8Array, done: true } : { value: value as Uint8Array, done: false };
        },
      };
    },
    async close() {
      try { await reader.cancel(); } catch { /* ignore */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
      try { await writer.close(); } catch { /* ignore */ }
      try { writer.releaseLock(); } catch { /* ignore */ }
    },
    detachReader() { try { reader.releaseLock(); } catch { /* ignore */ } },
  };
}

export class WebSerialPn532Transport implements CardTransport {
  readonly id = "webserial-pn532" as const;
  readonly label = "Web Serial PN532";
  readonly capabilities: TransportCapabilities = { apdu: true, raw: true, mifareAuth: false, ndefOnly: false, emulate: true, write: true };

  private port: SerialPortLike | null = null;
  private duplex: (Duplex & { detachReader(): void }) | null = null;
  private dev: Pn532 | null = null;
  private connected = false;
  private currentTg = 0x01;
  private disconnectCbs = new Set<() => void>();
  private traceCbs = new Set<(dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void>();

  isSupported(): boolean { return serial() !== null; }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    const s = serial();
    if (!s) throw new NfcError("unsupported", "Web Serial (navigator.serial) is not available");
    let port: SerialPortLike;
    try {
      port = await s.requestPort({ filters: [{ usbVendorId: 0x0403 }, { usbVendorId: 0x10c4 }, { usbVendorId: 0x1a86 }, { usbVendorId: 0x067b }] });
    } catch (err) {
      throw fromDomError(err, "no-device");
    }
    if (!port) throw new NfcError("no-device", "No serial port selected");
    this.port = port;
    try {
      await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
      port.addEventListener?.("disconnect", () => this.handleLost());
      this.duplex = serialDuplex(port);
      this.dev = new Pn532(this.duplex);
      this.dev.onTrace = (dir, bytes, note) => this.trace(dir, bytes, note);
      this.dev.start();
      await getFirmwareVersion(this.dev);
      await samConfigure(this.dev);
    } catch (err) {
      await this.disconnect();
      throw err instanceof NfcError ? err : fromDomError(err, "protocol");
    }
    this.connected = true;
  }

  private handleLost(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const cb of this.disconnectCbs) cb();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try { if (this.dev) await this.dev.close(); } catch { /* ignore */ }
    this.dev = null;
    this.duplex = null;
    try { if (this.port) await this.port.close(); } catch { /* ignore */ }
    this.port = null;
  }

  private device(): Pn532 {
    if (!this.dev || !this.connected) throw new NfcError("not-connected", "PN532 not connected");
    return this.dev;
  }

  async waitForCard(opts: WaitOpts = {}): Promise<CardIdentity> {
    const dev = this.device();
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      if (opts.signal?.aborted) throw new NfcError("aborted", "Aborted");
      const target = await listPassiveTargetTypeA(dev, { timeoutMs: 700, signal: opts.signal }).catch((e) => {
        if (NfcError.is(e, "timeout")) return null;
        throw e;
      });
      if (target) {
        this.currentTg = target.tg;
        const sak = target.selRes;
        const isoDep = (sak & 0x20) !== 0;
        return {
          uid: target.uid,
          atqa: target.sensRes.length >= 2 ? u8(target.sensRes[1], target.sensRes[0]) : undefined,
          sak,
          ats: target.ats,
          tech: "iso14443a",
          isoDep,
          hints: ["pn532", "web-serial"],
        };
      }
      if (Date.now() >= deadline) throw new NfcError("timeout", "No card presented");
    }
  }

  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    return inDataExchange(this.device(), this.currentTg, apdu);
  }

  async transceiveRaw(frame: Uint8Array, opts?: RawOpts): Promise<Uint8Array> {
    return inCommunicateThru(this.device(), frame, { timeoutMs: opts?.timeoutMs });
  }

  async releaseCard(): Promise<void> { if (this.dev) await inRelease(this.dev, this.currentTg); }

  /**
   * Emulate an NDEF Type 4 Tag until `signal` aborts. Initialises the
   * PN532 as a target (TgInitAsTarget) advertising the NFC Forum Type 4
   * application, then services the reader's SELECT / READ BINARY APDUs
   * from an in-memory CC file + NDEF file. Requires a PN532 board — no
   * other browser transport can emulate a card.
   */
  async emulateNdef(records: NdefRecord[], opts: { signal: AbortSignal; onEvent?: (e: EmulationEvent) => void }): Promise<void> {
    const dev = this.device();
    const emit = opts.onEvent ?? (() => {});
    const ndef = encodeNdefMessage(records);
    const ndefFile = buildT4NdefFile(ndef);
    const ccFile = T4T.ccBytes(0x00ff, 0x00ff, Math.max(0x000f, ndefFile.length));

    // TgInitAsTarget: passive 106 kbps, Mifare + ISO-DEP params, no FeliCa.
    const mifareParams = u8(0x04, 0x00, 0x12, 0x34, 0x56, 0x20); // SENS_RES, NFCID1, SEL_RES(0x20 = ISO-DEP)
    const felicaParams = new Uint8Array(18); // unused but required
    felicaParams.set(u8(0x01, 0xfe, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7), 0);
    const nfcid3t = new Uint8Array(10);
    const initParams = concat(
      u8(0x05), // MODE: PICC only + passive only
      mifareParams,
      felicaParams,
      nfcid3t,
      u8(0x00), // LENgt (general bytes)
      u8(0x00), // LENtk (historical bytes)
    );

    let selectedFile: "cc" | "ndef" | null = null;
    try {
      // Block until an initiator activates us (long timeout, aborts on signal).
      const activation = await dev.command(PN532.TgInitAsTarget, initParams, { timeoutMs: 3_600_000, signal: opts.signal });
      emit({ type: "activated", initiator: activation.slice(1) });

      while (!opts.signal.aborted) {
        // TgGetData: fetch the reader's command APDU.
        let cmd: Uint8Array;
        try {
          const raw = await dev.command(PN532.TgGetData, new Uint8Array(0), { timeoutMs: 5000, signal: opts.signal });
          const status = raw[0];
          if (status & 0x3f) { // DEP released / error
            emit({ type: "released" });
            break;
          }
          cmd = raw.slice(1);
        } catch (e) {
          if (NfcError.is(e, "aborted")) break;
          if (NfcError.is(e, "timeout")) continue;
          throw e;
        }
        const resp = this.serviceType4Apdu(cmd, ccFile, ndefFile, (f) => { selectedFile = f; }, () => selectedFile);
        emit({ type: "apdu", command: cmd, response: resp, note: describeT4Apdu(cmd) });
        await dev.command(PN532.TgSetData, resp, { timeoutMs: 3000, signal: opts.signal });
      }
    } catch (err) {
      if (!NfcError.is(err, "aborted")) { emit({ type: "error", message: (err as Error).message }); throw err; }
    } finally {
      try { await inRelease(dev, 0x00); } catch { /* ignore */ }
      emit({ type: "released" });
    }
  }

  /** ISO 7816 Type 4 tag command handler. Returns the response APDU (with SW). */
  private serviceType4Apdu(cmd: Uint8Array, ccFile: Uint8Array, ndefFile: Uint8Array, setFile: (f: "cc" | "ndef") => void, getFile: () => "cc" | "ndef" | null): Uint8Array {
    const OK = u8(0x90, 0x00);
    const NOT_FOUND = u8(0x6a, 0x82);
    const WRONG_LEN = u8(0x67, 0x00);
    if (cmd.length < 4) return u8(0x6f, 0x00);
    const [cla, ins, p1, p2] = cmd;
    // SELECT
    if (cla === 0x00 && ins === 0xa4) {
      const lc = cmd[4] ?? 0;
      const data = cmd.slice(5, 5 + lc);
      if (p1 === 0x04) { // by name (AID)
        return bytesEqual(data, T4T.AID) ? OK : NOT_FOUND;
      }
      if (p1 === 0x00) { // by file id
        const fid = (data[0] << 8) | data[1];
        if (fid === T4T.CC_FID) { setFile("cc"); return OK; }
        if (fid === T4T.NDEF_FID) { setFile("ndef"); return OK; }
        return NOT_FOUND;
      }
      return NOT_FOUND;
    }
    // READ BINARY
    if (cla === 0x00 && ins === 0xb0) {
      const file = getFile() === "ndef" ? ndefFile : getFile() === "cc" ? ccFile : null;
      if (!file) return u8(0x69, 0x86); // no current EF
      const offset = ((p1 & 0x7f) << 8) | p2;
      const le = cmd[cmd.length - 1] || 0x00;
      const want = le === 0 ? 256 : le;
      if (offset > file.length) return WRONG_LEN;
      const slice = file.slice(offset, Math.min(file.length, offset + want));
      return concat(slice, OK);
    }
    // UPDATE BINARY (accepted but ignored — emulated tag is read-only here).
    if (cla === 0x00 && ins === 0xd6) return OK;
    return u8(0x6d, 0x00); // INS not supported
  }

  async writeNdef(): Promise<void> {
    throw new NfcError("not-supported-by-transport", "Writing tags over PN532 uses card drivers, not this shortcut");
  }

  onDisconnect(cb: () => void): () => void { this.disconnectCbs.add(cb); return () => this.disconnectCbs.delete(cb); }
  onTrace(cb: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void): () => void { this.traceCbs.add(cb); return () => this.traceCbs.delete(cb); }
  private trace(dir: "tx" | "rx", bytes: Uint8Array, note?: string): void { for (const cb of this.traceCbs) cb(dir, bytes, note); }
}

function describeT4Apdu(cmd: Uint8Array): string {
  if (cmd.length < 2) return "short";
  const [, ins, p1] = cmd;
  if (ins === 0xa4) return p1 === 0x04 ? "SELECT AID" : "SELECT file";
  if (ins === 0xb0) return "READ BINARY";
  if (ins === 0xd6) return "UPDATE BINARY";
  return `INS ${hex([ins])}`;
}

export { buildApdu };
