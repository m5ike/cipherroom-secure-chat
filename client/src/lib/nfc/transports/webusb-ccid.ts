// WebUSB CCID transport. Speaks the USB CCID (Chip Card Interface Device,
// USB class 0x0B) bulk protocol directly, so it drives ACS ACR122U /
// ACR1252U and generic CCID PC/SC readers without a native middleware.
//
// CCID bulk-OUT messages (PC_to_RDR_*) and bulk-IN messages (RDR_to_PC_*)
// share a 10-byte header:
//   [0]    bMessageType
//   [1..4] dwLength (LE, payload length after the header)
//   [5]    bSlot
//   [6]    bSeq
//   [7..9] message-specific
// We implement: IccPowerOn (get ATR), IccPowerOff, GetSlotStatus,
// XfrBlock (APDU), and Escape (ACR122 direct PN532 access). Sequence
// numbers increment per command; RDR_to_PC status byte bmCommandStatus
// (bits 6-7 of byte 7) signals success (0) / failed (1) / time-extension
// (2), with bError in byte 8.
//
// ACR122 pseudo-APDUs (sent as normal XfrBlock APDUs):
//   FF CA 00 00 00                       — get UID
//   FF 00 00 00 <len> <PN532 payload>    — direct PN532 passthrough (raw / mifare)
//   FF 82 00 <slot> 06 <key6>            — load authentication key into a slot
//   FF 86 00 00 05 01 00 <blk> 60|61 <slot> — Mifare authenticate
//   FF B0 00 <blk> <len>                 — read binary block
//   FF D6 00 <blk> 10 <data16>           — update binary block
//
// The ACR122 "escape" quirk: some firmware requires PC_to_RDR_Escape
// (bMessageType 0x6B) for direct PN532 commands rather than wrapping them
// in FF 00 00 00. We expose escapePn532() for that path and use the
// pseudo-APDU (FF 00 00 00) form by default, which the ACR122U accepts.

import { NfcError, fromDomError, withTimeout } from "../errors";
import type { CardTransport, CardIdentity, WaitOpts, TransportCapabilities, RawOpts } from "../transport";
import { concat, u8, hex, splitResponse } from "../cards/apdu";

/* ---------- WebUSB typings (subset) ---------- */
type USBEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string; packetSize: number };
type USBAlternate = { alternateSetting: number; interfaceClass: number; endpoints: USBEndpoint[] };
type USBInterface = { interfaceNumber: number; alternate: USBAlternate; alternates: USBAlternate[]; claimed: boolean };
type USBConfiguration = { configurationValue: number; interfaces: USBInterface[] };
type USBInTransferResult = { data?: DataView; status: "ok" | "stall" | "babble" };
type USBOutTransferResult = { bytesWritten: number; status: "ok" | "stall" | "babble" };
type USBDeviceLike = {
  productName?: string;
  manufacturerName?: string;
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: USBConfiguration | null;
  configurations: USBConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(v: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  selectAlternateInterface(iface: number, alt: number): Promise<void>;
  transferIn(endpoint: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpoint: number, data: BufferSource): Promise<USBOutTransferResult>;
  addEventListener?: (t: string, cb: () => void) => void;
};
type USBLike = {
  requestDevice(opts: { filters: Array<{ classCode?: number; vendorId?: number }> }): Promise<USBDeviceLike>;
  getDevices(): Promise<USBDeviceLike[]>;
  addEventListener?: (t: string, cb: (e: { device: USBDeviceLike }) => void) => void;
};

const CCID_CLASS = 0x0b;
const MSG = {
  IccPowerOn: 0x62,
  IccPowerOff: 0x63,
  GetSlotStatus: 0x65,
  XfrBlock: 0x6f,
  Escape: 0x6b,
  DataBlock: 0x80,
  SlotStatus: 0x81,
} as const;

function usb(): USBLike | null {
  return typeof navigator !== "undefined" && "usb" in navigator ? (navigator as unknown as { usb: USBLike }).usb : null;
}

export class WebUsbCcidTransport implements CardTransport {
  readonly id = "webusb-ccid" as const;
  readonly label = "WebUSB CCID (ACR122U / PC-SC)";
  readonly capabilities: TransportCapabilities = { apdu: true, raw: true, mifareAuth: true, ndefOnly: false, emulate: false, write: true };

  private device: USBDeviceLike | null = null;
  private ifaceNum = 0;
  private epIn = 0;
  private epOut = 0;
  private epInSize = 64;
  private seq = 0;
  private connected = false;
  private lastAtr: Uint8Array | null = null;
  private disconnectCbs = new Set<() => void>();
  private traceCbs = new Set<(dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void>();
  private isAcr122 = false;

  isSupported(): boolean { return usb() !== null; }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    const u = usb();
    if (!u) throw new NfcError("unsupported", "WebUSB (navigator.usb) is not available");
    let device: USBDeviceLike;
    try {
      device = await u.requestDevice({ filters: [{ classCode: CCID_CLASS }, { vendorId: 0x072f }, { vendorId: 0x076b }] });
    } catch (err) {
      throw fromDomError(err, "no-device");
    }
    if (!device) throw new NfcError("no-device", "No CCID reader selected");
    this.device = device;
    this.isAcr122 = /ACR122|ACR1252|ACS/i.test(device.productName ?? device.manufacturerName ?? "");
    try {
      if (!device.opened) await device.open();
      if (!device.configuration) await device.selectConfiguration(device.configurations[0]?.configurationValue ?? 1);
      this.bindEndpoints();
      await device.claimInterface(this.ifaceNum);
      u.addEventListener?.("disconnect", (e) => { if (e.device === this.device) this.handleLost(); });
      device.addEventListener?.("disconnect", () => this.handleLost());
    } catch (err) {
      throw fromDomError(err, "protocol");
    }
    this.connected = true;
  }

  private bindEndpoints(): void {
    const dev = this.device!;
    const config = dev.configuration!;
    for (const iface of config.interfaces) {
      const alt = iface.alternate;
      // Prefer the CCID class interface; fall back to the first bulk pair.
      const isCcid = alt.interfaceClass === CCID_CLASS;
      const bulkIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
      const bulkOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (bulkIn && bulkOut && (isCcid || this.epOut === 0)) {
        this.ifaceNum = iface.interfaceNumber;
        this.epIn = bulkIn.endpointNumber;
        this.epOut = bulkOut.endpointNumber;
        this.epInSize = bulkIn.packetSize || 64;
        if (isCcid) return;
      }
    }
    if (this.epIn === 0 || this.epOut === 0) throw new NfcError("protocol", "No CCID bulk endpoints found on this device");
  }

  private handleLost(): void {
    if (!this.connected) return;
    this.connected = false;
    this.device = null;
    for (const cb of this.disconnectCbs) cb();
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    this.connected = false;
    this.device = null;
    if (!dev) return;
    try { await dev.releaseInterface(this.ifaceNum); } catch { /* ignore */ }
    try { if (dev.opened) await dev.close(); } catch { /* ignore */ }
  }

  /* ---------- CCID framing ---------- */

  private header(type: number, payloadLen: number, b7 = 0, b8 = 0, b9 = 0): Uint8Array {
    const seq = this.seq++ & 0xff;
    return u8(type, payloadLen & 0xff, (payloadLen >> 8) & 0xff, (payloadLen >> 16) & 0xff, (payloadLen >> 24) & 0xff, 0x00, seq, b7, b8, b9);
  }

  private async sendCcid(type: number, payload: Uint8Array, b7 = 0, b8 = 0, b9 = 0): Promise<Uint8Array> {
    if (!this.device) throw new NfcError("not-connected", "Reader not connected");
    const msg = concat(this.header(type, payload.length, b7, b8, b9), payload);
    this.trace("tx", msg);
    try {
      const w = await this.device.transferOut(this.epOut, bufferOf(msg));
      if (w.status !== "ok") throw new NfcError("protocol", `CCID bulk-out ${w.status}`);
    } catch (err) {
      throw fromDomError(err, "disconnected");
    }
    return this.readCcidResponse();
  }

  private async readCcidResponse(): Promise<Uint8Array> {
    const first = await this.readChunk();
    if (first.length < 10) throw new NfcError("protocol", `CCID response shorter than header (${first.length} B)`);
    const dwLength = first[1] | (first[2] << 8) | (first[3] << 16) | (first[4] << 24);
    const status = first[7];
    const error = first[8];
    let body: Uint8Array = first.slice(10);
    // Collect remaining bytes if the payload spans multiple bulk packets.
    let guard = 0;
    while (body.length < dwLength && guard++ < 512) {
      const more = await this.readChunk();
      body = concat(body, more);
    }
    body = body.slice(0, dwLength);
    // bmCommandStatus in bits 6-7 of byte 7: 0 success, 1 failed, 2 more time.
    const cmdStatus = (status >> 6) & 0x03;
    if (cmdStatus === 1) {
      // A "failed" with a card-absent error still returns a valid SlotStatus; surface it.
      throw new NfcError(error === 0xfe || error === 0xfb ? "no-card" : "card-error", `CCID command failed (status 0x${status.toString(16)}, error 0x${error.toString(16)})`, error.toString(16));
    }
    if (cmdStatus === 2) {
      // Time extension: read the follow-up response.
      return this.readCcidResponse();
    }
    return body;
  }

  private async readChunk(): Promise<Uint8Array> {
    if (!this.device) throw new NfcError("not-connected", "Reader not connected");
    let res: USBInTransferResult;
    try {
      res = await withTimeout(this.device.transferIn(this.epIn, Math.max(this.epInSize, 512)), 4000, undefined, "CCID bulk-in");
    } catch (err) {
      throw fromDomError(err, "disconnected");
    }
    if (res.status === "stall") throw new NfcError("protocol", "CCID endpoint stalled");
    const data = res.data ? new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength) : new Uint8Array(0);
    this.trace("rx", data);
    return data;
  }

  /* ---------- card presence / ATR ---------- */

  async powerOn(): Promise<Uint8Array> {
    const atr = await this.sendCcid(MSG.IccPowerOn, new Uint8Array(0), 0x00 /* power select: auto */);
    this.lastAtr = atr;
    return atr;
  }

  async powerOff(): Promise<void> { await this.sendCcid(MSG.IccPowerOff, new Uint8Array(0)); this.lastAtr = null; }

  /** Poll GetSlotStatus; bStatus bits 0-1: 0 present+active, 1 present+inactive, 2 absent. */
  private async slotStatus(): Promise<number> {
    if (!this.device) throw new NfcError("not-connected", "Reader not connected");
    const msg = concat(this.header(MSG.GetSlotStatus, 0));
    this.trace("tx", msg);
    await this.device.transferOut(this.epOut, bufferOf(msg));
    const first = await this.readChunk();
    if (first.length < 10) throw new NfcError("protocol", "Short SlotStatus");
    return first[7] & 0x03;
  }

  async waitForCard(opts: WaitOpts = {}): Promise<CardIdentity> {
    if (!this.connected) throw new NfcError("not-connected", "Reader not connected");
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      if (opts.signal?.aborted) throw new NfcError("aborted", "Aborted");
      let present = false;
      try { present = (await this.slotStatus()) !== 0x02; } catch { present = false; }
      if (present) {
        try {
          const atr = await this.powerOn();
          const uid = await this.tryGetUid();
          const atqaSak = parseAcrAtr(atr);
          return {
            uid: uid ?? new Uint8Array(0),
            atr,
            sak: atqaSak?.sak,
            atqa: atqaSak?.atqa,
            tech: "iso14443a",
            isoDep: !!atqaSak && (atqaSak.sak & 0x20) !== 0,
            hints: ["ccid", this.isAcr122 ? "acr122" : "generic-ccid"],
          };
        } catch (err) {
          if (NfcError.is(err, "no-card")) { /* card left between poll and power-on */ }
          else throw err;
        }
      }
      if (Date.now() >= deadline) throw new NfcError("timeout", "No card presented");
      await sleep(250, opts.signal);
    }
  }

  private async tryGetUid(): Promise<Uint8Array | null> {
    try {
      const r = splitResponse(await this.transmit(u8(0xff, 0xca, 0x00, 0x00, 0x00)));
      return r.sw === 0x9000 ? r.data : null;
    } catch { return null; }
  }

  /* ---------- APDU ---------- */

  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    if (!this.connected) throw new NfcError("not-connected", "Reader not connected");
    this.trace("tx", apdu, "apdu");
    const resp = await this.sendCcid(MSG.XfrBlock, apdu, 0x00, 0x00, 0x00);
    this.trace("rx", resp, "apdu");
    return resp;
  }

  async transceiveRaw(frame: Uint8Array, _opts?: RawOpts): Promise<Uint8Array> {
    // ACR122: wrap the raw ISO 14443-3 frame in a PN532 InCommunicateThru
    // (0x42) via the FF 00 00 00 direct-transmit pseudo-APDU.
    const pn532 = concat(u8(0xd4, 0x42), frame);
    const pseudo = concat(u8(0xff, 0x00, 0x00, 0x00, pn532.length), pn532);
    const r = splitResponse(await this.transmit(pseudo));
    // Response: D5 43 <status> <data...>; strip the PN532 header + status.
    if (r.data.length >= 3 && r.data[0] === 0xd5 && r.data[1] === 0x43) {
      const status = r.data[2];
      if (status !== 0x00) throw new NfcError("card-error", `InCommunicateThru status 0x${status.toString(16)}`);
      return r.data.slice(3);
    }
    if (r.sw !== 0x9000) throw new NfcError("card-error", `Raw transceive SW ${hex([r.sw >> 8, r.sw & 0xff])}`);
    return r.data;
  }

  /** Direct PN532 command via CCID Escape (the ACR122 "escape" quirk path). */
  async escapePn532(pn532Payload: Uint8Array): Promise<Uint8Array> {
    return this.sendCcid(MSG.Escape, concat(u8(0xd4), pn532Payload));
  }

  async mifareAuth(block: number, keyType: "A" | "B", key: Uint8Array, _uid: Uint8Array): Promise<boolean> {
    if (key.length !== 6) throw new NfcError("invalid-argument", "Mifare key must be 6 bytes");
    // Load key into slot 0: FF 82 00 00 06 <key>
    const load = splitResponse(await this.transmit(concat(u8(0xff, 0x82, 0x00, 0x00, 0x06), key)));
    if (load.sw !== 0x9000) throw new NfcError("card-error", `Load key failed SW ${hex([load.sw >> 8, load.sw & 0xff])}`);
    // Authenticate: FF 86 00 00 05 01 00 <blk> <60|61> <slot>
    const keyByte = keyType === "A" ? 0x60 : 0x61;
    const auth = splitResponse(await this.transmit(u8(0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, block & 0xff, keyByte, 0x00)));
    if (auth.sw === 0x9000) return true;
    if (auth.sw === 0x6300 || auth.sw === 0x6982) return false;
    throw new NfcError("card-error", `Auth SW ${hex([auth.sw >> 8, auth.sw & 0xff])}`);
  }

  /** Read a 16-byte block via FF B0. */
  async readBlock(block: number, len = 16): Promise<Uint8Array> {
    const r = splitResponse(await this.transmit(u8(0xff, 0xb0, 0x00, block & 0xff, len)));
    if (r.sw !== 0x9000) throw new NfcError("card-error", `Read block ${block} SW ${hex([r.sw >> 8, r.sw & 0xff])}`);
    return r.data;
  }

  /** Write a 16-byte block via FF D6. */
  async writeBlock(block: number, data: Uint8Array): Promise<void> {
    if (data.length !== 16) throw new NfcError("invalid-argument", "Mifare block write needs 16 bytes");
    const r = splitResponse(await this.transmit(concat(u8(0xff, 0xd6, 0x00, block & 0xff, 0x10), data)));
    if (r.sw !== 0x9000) throw new NfcError("card-error", `Write block ${block} SW ${hex([r.sw >> 8, r.sw & 0xff])}`);
  }

  async releaseCard(): Promise<void> { try { await this.powerOff(); } catch { /* ignore */ } }

  onDisconnect(cb: () => void): () => void { this.disconnectCbs.add(cb); return () => this.disconnectCbs.delete(cb); }
  onTrace(cb: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void): () => void { this.traceCbs.add(cb); return () => this.traceCbs.delete(cb); }
  private trace(dir: "tx" | "rx", bytes: Uint8Array, note?: string): void { for (const cb of this.traceCbs) cb(dir, bytes, note); }
}

/* ---------- helpers ---------- */

function bufferOf(a: Uint8Array): ArrayBuffer {
  return a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new NfcError("aborted", "Aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new NfcError("aborted", "Aborted")); }, { once: true });
  });
}

/**
 * ACS storage-card ATR carries ATQA/SAK in a proprietary layout:
 *   3B 8F 80 01 80 4F 0C A0 00 00 03 06 <SS> <NN NN> <..> TCK
 * where SS = card standard, NNNN = card name (~ SAK-derived). This maps
 * the common values; unknown ATRs return null and detection falls back to
 * the UID length.
 */
function parseAcrAtr(atr: Uint8Array): { sak: number; atqa: Uint8Array } | null {
  if (atr.length >= 15 && atr[0] === 0x3b && atr[4] === 0x80 && atr[5] === 0x4f) {
    const name = (atr[13] << 8) | atr[14];
    const map: Record<number, { sak: number; atqa: number }> = {
      0x0001: { sak: 0x08, atqa: 0x0004 }, // Mifare 1K
      0x0002: { sak: 0x18, atqa: 0x0002 }, // Mifare 4K
      0x0003: { sak: 0x00, atqa: 0x0044 }, // Ultralight
      0x0026: { sak: 0x09, atqa: 0x0004 }, // Mifare Mini
      0x003a: { sak: 0x00, atqa: 0x0044 }, // Ultralight C
      0x0036: { sak: 0x20, atqa: 0x0344 }, // DESFire-ish
    };
    const m = map[name];
    if (m) return { sak: m.sak, atqa: u8(m.atqa & 0xff, (m.atqa >> 8) & 0xff) };
  }
  return null;
}
