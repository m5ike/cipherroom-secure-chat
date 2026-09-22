// PN532 UART frame codec + command layer, shared by the Web Serial and
// Web Bluetooth transports. The two transports differ only in how they
// move bytes; both hand this module a `Duplex` (write + a byte stream).
//
// Normal information frame:
//   00 00 FF LEN LCS TFI PD0..PDn DCS 00
//   LEN = len(TFI + data), LCS = -(LEN) & 0xFF (so LEN+LCS = 0)
//   TFI = 0xD4 host→PN532, 0xD5 PN532→host
//   DCS = -(TFI + PD0..PDn) & 0xFF
// ACK frame:   00 00 FF 00 FF 00
// NACK frame:  00 00 FF FF 00 00
// Extended frames (LEN 0xFF 0xFF LENh LENl LCS) are supported on parse.

import { NfcError, withTimeout } from "../errors";
import { hex, concat, u8 } from "../cards/apdu";

export const PN532 = {
  Diagnose: 0x00,
  GetFirmwareVersion: 0x02,
  ReadRegister: 0x06,
  WriteRegister: 0x08,
  SAMConfiguration: 0x14,
  RFConfiguration: 0x32,
  InListPassiveTarget: 0x4a,
  InDataExchange: 0x40,
  InCommunicateThru: 0x42,
  InRelease: 0x52,
  InAutoPoll: 0x60,
  TgInitAsTarget: 0x8c,
  TgGetData: 0x86,
  TgSetData: 0x8e,
  TgGetInitiatorCommand: 0x88,
} as const;

const PREAMBLE = u8(0x00, 0x00, 0xff);
export const ACK = u8(0x00, 0x00, 0xff, 0x00, 0xff, 0x00);
export const NACK = u8(0x00, 0x00, 0xff, 0xff, 0x00, 0x00);

/** The byte pipe a transport provides to the codec. */
export interface Duplex {
  write(bytes: Uint8Array): Promise<void>;
  /** Async iterator of inbound chunks (any framing). */
  read(): AsyncIterator<Uint8Array>;
  close(): Promise<void>;
}

export function buildFrame(tfiData: Uint8Array): Uint8Array {
  const len = tfiData.length;
  if (len > 0xff) {
    // extended frame
    const lenh = (len >> 8) & 0xff;
    const lenl = len & 0xff;
    const lcs = (-(lenh + lenl)) & 0xff;
    let sum = 0;
    for (const b of tfiData) sum += b;
    const dcs = (-sum) & 0xff;
    return concat(PREAMBLE, u8(0xff, 0xff, lenh, lenl, lcs), tfiData, u8(dcs, 0x00));
  }
  const lcs = (-len) & 0xff;
  let sum = 0;
  for (const b of tfiData) sum += b;
  const dcs = (-sum) & 0xff;
  return concat(PREAMBLE, u8(len, lcs), tfiData, u8(dcs, 0x00));
}

/** Frame a host command: TFI D4 + command + params. */
export function buildCommand(command: number, params: Uint8Array = new Uint8Array(0)): Uint8Array {
  return buildFrame(concat(u8(0xd4, command), params));
}

export type ParsedFrame =
  | { kind: "ack" }
  | { kind: "nack" }
  | { kind: "error" }
  | { kind: "data"; tfi: number; payload: Uint8Array };

/** A running byte buffer that yields parsed frames. Handles chunk boundaries. */
export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): void {
    this.buf = concat(this.buf, chunk);
  }

  /** Try to pull one frame (ACK/NACK/error/data). Returns null if more bytes are needed. */
  next(): ParsedFrame | null {
    // Find preamble 00 00 FF.
    let i = 0;
    while (i + 2 < this.buf.length && !(this.buf[i] === 0x00 && this.buf[i + 1] === 0x00 && this.buf[i + 2] === 0xff)) i++;
    if (i + 2 >= this.buf.length) { if (this.buf.length > 4096) this.buf = this.buf.slice(-3); return null; }
    const start = i;
    let p = start + 3;
    if (p + 1 >= this.buf.length) return null;
    const b0 = this.buf[p];
    const b1 = this.buf[p + 1];
    // ACK 00 FF
    if (b0 === 0x00 && b1 === 0xff) { this.buf = this.buf.slice(p + 2); return { kind: "ack" }; }
    // NACK FF 00
    if (b0 === 0xff && b1 === 0x00) { this.buf = this.buf.slice(p + 2); return { kind: "nack" }; }
    // Error frame 01 FF
    if (b0 === 0x01 && b1 === 0xff) { this.buf = this.buf.slice(p + 2); return { kind: "error" }; }

    let len: number;
    let dataStart: number;
    if (b0 === 0xff && b1 === 0xff) {
      // extended
      if (p + 4 >= this.buf.length) return null;
      len = (this.buf[p + 2] << 8) | this.buf[p + 3];
      const lcs = this.buf[p + 4];
      if (((this.buf[p + 2] + this.buf[p + 3] + lcs) & 0xff) !== 0) { this.buf = this.buf.slice(start + 3); return this.next(); }
      dataStart = p + 5;
    } else {
      len = b0;
      const lcs = b1;
      if (((len + lcs) & 0xff) !== 0) { this.buf = this.buf.slice(start + 3); return this.next(); }
      dataStart = p + 2;
    }
    const frameEnd = dataStart + len + 1; // + DCS (postamble optional)
    if (frameEnd > this.buf.length) return null;
    const tfi = this.buf[dataStart];
    const payload = this.buf.slice(dataStart + 1, dataStart + len);
    const dcs = this.buf[dataStart + len];
    let sum = 0;
    for (let k = dataStart; k < dataStart + len; k++) sum += this.buf[k];
    if (((sum + dcs) & 0xff) !== 0) { this.buf = this.buf.slice(dataStart); return this.next(); }
    // consume optional postamble 0x00
    let consumed = frameEnd;
    if (consumed < this.buf.length && this.buf[consumed] === 0x00) consumed++;
    this.buf = this.buf.slice(consumed);
    return { kind: "data", tfi, payload };
  }
}

/**
 * The command/response engine over a Duplex. One command in flight at a
 * time (the PN532 is half-duplex): send frame, await ACK, await response.
 */
export class Pn532 {
  private parser = new FrameParser();
  private pending: Array<(f: ParsedFrame | null) => void> = [];
  private reading = false;
  private closed = false;
  private iterator?: AsyncIterator<Uint8Array>;
  onTrace?: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void;

  constructor(private duplex: Duplex) {}

  start(): void {
    if (this.reading) return;
    this.reading = true;
    this.iterator = this.duplex.read();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (!this.closed && this.iterator) {
        const { value, done } = await this.iterator.next();
        if (done) break;
        if (!value || value.length === 0) continue;
        this.onTrace?.("rx", value);
        this.parser.push(value);
        this.drain();
      }
    } catch (err) {
      if (!this.closed) this.rejectAll(new NfcError("disconnected", `PN532 stream ended: ${(err as Error).message}`));
    }
  }

  private drain(): void {
    let f: ParsedFrame | null;
    while ((f = this.parser.next()) !== null) {
      const waiter = this.pending.shift();
      if (waiter) waiter(f);
    }
  }

  private rejectAll(_err: NfcError): void {
    this.pending = [];
  }

  private awaitFrame(timeoutMs: number, signal?: AbortSignal): Promise<ParsedFrame> {
    const wait = new Promise<ParsedFrame>((resolve) => {
      this.pending.push((f) => { if (f) resolve(f); });
      this.drain();
    });
    return withTimeout(wait, timeoutMs, signal, "PN532 frame");
  }

  /** Send a command, wait for ACK, then wait for and return the response payload (after the response code byte). */
  async command(cmd: number, params: Uint8Array = new Uint8Array(0), opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (this.closed) throw new NfcError("not-connected", "PN532 closed");
    const timeoutMs = opts.timeoutMs ?? 1500;
    const frame = buildCommand(cmd, params);
    this.onTrace?.("tx", frame, `cmd ${cmd.toString(16)}`);
    await this.duplex.write(frame);
    // Await ACK (skip stray frames).
    const deadline = Date.now() + timeoutMs;
    let acked = false;
    while (!acked) {
      const f = await this.awaitFrame(Math.max(50, deadline - Date.now()), opts.signal);
      if (f.kind === "ack") acked = true;
      else if (f.kind === "nack") throw new NfcError("protocol", "PN532 replied NACK");
      else if (f.kind === "error") throw new NfcError("protocol", "PN532 error frame");
      else if (f.kind === "data") { return this.checkResponse(cmd, f); } // some stacks skip ACK
    }
    // Await response frame.
    for (;;) {
      const f = await this.awaitFrame(Math.max(50, deadline - Date.now() + timeoutMs), opts.signal);
      if (f.kind === "data") return this.checkResponse(cmd, f);
      if (f.kind === "error") throw new NfcError("protocol", "PN532 error frame");
      // ignore stray ack/nack
    }
  }

  private checkResponse(cmd: number, f: { tfi: number; payload: Uint8Array }): Uint8Array {
    if (f.tfi !== 0xd5) throw new NfcError("protocol", `PN532 unexpected TFI ${f.tfi.toString(16)}`);
    const respCode = f.payload[0];
    if (respCode !== ((cmd + 1) & 0xff)) {
      throw new NfcError("protocol", `PN532 response code ${respCode.toString(16)} != ${(cmd + 1).toString(16)}`);
    }
    return f.payload.slice(1);
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.duplex.close(); } catch { /* ignore */ }
  }
}

/* ---------- high-level helpers built on Pn532 ---------- */

export type FirmwareVersion = { ic: number; ver: number; rev: number; support: number; text: string };

export async function getFirmwareVersion(dev: Pn532): Promise<FirmwareVersion> {
  const r = await dev.command(PN532.GetFirmwareVersion);
  if (r.length < 4) throw new NfcError("protocol", "GetFirmwareVersion short response");
  return { ic: r[0], ver: r[1], rev: r[2], support: r[3], text: `PN5${r[0].toString(16)} v${r[1]}.${r[2]}` };
}

/** Normal mode SAM configuration (mode 0x01, no timeout, no IRQ). Required before RF ops on many boards. */
export async function samConfigure(dev: Pn532): Promise<void> {
  await dev.command(PN532.SAMConfiguration, u8(0x01, 0x00, 0x01));
}

export type PassiveTarget = { tg: number; sensRes: Uint8Array; selRes: number; uid: Uint8Array; ats?: Uint8Array };

/** InListPassiveTarget for 106 kbps Type A (BrTy 0x00), one target. */
export async function listPassiveTargetTypeA(dev: Pn532, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PassiveTarget | null> {
  const r = await dev.command(PN532.InListPassiveTarget, u8(0x01, 0x00), opts);
  if (r.length < 1 || r[0] < 1) return null;
  // NbTg, then per target: Tg, SENS_RES(2), SEL_RES(1), NFCIDLength, NFCID[], [ATSLen, ATS[]]
  let p = 1;
  const tg = r[p++];
  const sensRes = r.slice(p, p + 2); p += 2;
  const selRes = r[p++];
  const idLen = r[p++];
  const uid = r.slice(p, p + idLen); p += idLen;
  let ats: Uint8Array | undefined;
  if (p < r.length) {
    const atsLen = r[p++];
    if (atsLen > 0) ats = r.slice(p, p + atsLen - 1 + 1); // ATS length byte counts itself; keep raw bytes
  }
  return { tg, sensRes, selRes, uid, ats };
}

/** InDataExchange: send an APDU / native command to the active target, return the data (status byte stripped). */
export async function inDataExchange(dev: Pn532, tg: number, data: Uint8Array, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const r = await dev.command(PN532.InDataExchange, concat(u8(tg), data), { timeoutMs: opts.timeoutMs ?? 2000, signal: opts.signal });
  const status = r[0];
  if ((status & 0x3f) !== 0x00) throw new NfcError("card-error", `InDataExchange status ${status.toString(16)}`, status.toString(16));
  return r.slice(1);
}

/** InCommunicateThru: raw ISO 14443-3 frame exchange (no chaining), return data (status byte stripped). */
export async function inCommunicateThru(dev: Pn532, data: Uint8Array, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const r = await dev.command(PN532.InCommunicateThru, data, { timeoutMs: opts.timeoutMs ?? 2000, signal: opts.signal });
  const status = r[0];
  if (status !== 0x00) throw new NfcError("card-error", `InCommunicateThru status ${status.toString(16)}`, status.toString(16));
  return r.slice(1);
}

export async function inRelease(dev: Pn532, tg = 0x00): Promise<void> {
  try { await dev.command(PN532.InRelease, u8(tg)); } catch { /* card already gone */ }
}

export { hex };
