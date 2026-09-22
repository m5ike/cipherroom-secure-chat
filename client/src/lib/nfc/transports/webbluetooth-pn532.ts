// Web Bluetooth PN532 transport. A PN532 wired to a BLE transparent-UART
// bridge (Nordic UART Service, or an HM-10 FFE0/FFE1 module) carrying the
// same PN532 frames as the serial transport. The frame codec is shared
// (pn532.ts); only the byte pipe differs.
//
// BLE writes are MTU-limited (~20 bytes on classic modules), so outbound
// frames are chunked. Inbound notifications are reassembled by the
// FrameParser in Pn532, which already tolerates arbitrary chunking.

import { NfcError, fromDomError } from "../errors";
import type { CardTransport, CardIdentity, WaitOpts, TransportCapabilities, RawOpts } from "../transport";
import { u8 } from "../cards/apdu";
import {
  Pn532, getFirmwareVersion, samConfigure, listPassiveTargetTypeA,
  inDataExchange, inCommunicateThru, inRelease, type Duplex,
} from "./pn532";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write (host → device)
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify (device → host)
const HM10_SERVICE = 0xffe0;
const HM10_CHAR = 0xffe1;

/* ---------- Web Bluetooth typings (subset) ---------- */
type BleCharacteristic = {
  writeValueWithoutResponse?: (v: BufferSource) => Promise<void>;
  writeValue: (v: BufferSource) => Promise<void>;
  startNotifications: () => Promise<BleCharacteristic>;
  stopNotifications?: () => Promise<BleCharacteristic>;
  addEventListener: (t: string, cb: (e: Event) => void) => void;
  removeEventListener: (t: string, cb: (e: Event) => void) => void;
  value?: DataView;
  properties?: { writeWithoutResponse?: boolean; write?: boolean };
};
type BleService = { getCharacteristic: (uuid: string | number) => Promise<BleCharacteristic> };
type BleServer = { connect: () => Promise<BleServer>; disconnect: () => void; connected: boolean; getPrimaryService: (uuid: string | number) => Promise<BleService> };
type BleDevice = { name?: string; gatt?: BleServer; addEventListener: (t: string, cb: () => void) => void };
type BluetoothLike = { requestDevice: (opts: { filters?: Array<{ services: Array<string | number> }>; optionalServices?: Array<string | number>; acceptAllDevices?: boolean }) => Promise<BleDevice> };

function bluetooth(): BluetoothLike | null {
  return typeof navigator !== "undefined" && "bluetooth" in navigator ? (navigator as unknown as { bluetooth: BluetoothLike }).bluetooth : null;
}

/** Build a Duplex over a pair of BLE characteristics (write + notify). */
function bleDuplex(write: BleCharacteristic, notify: BleCharacteristic): Duplex {
  let queue: Uint8Array[] = [];
  let resolveNext: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  let done = false;
  const onNotify = (e: Event) => {
    const dv = (e.target as unknown as { value?: DataView }).value ?? notify.value;
    if (!dv) return;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (resolveNext) { resolveNext({ value: bytes, done: false }); resolveNext = null; }
    else queue.push(bytes);
  };
  notify.addEventListener("characteristicvaluechanged", onNotify);
  const canWriteNoResp = notify !== write && (write.properties?.writeWithoutResponse ?? true);
  return {
    async write(bytes: Uint8Array) {
      // Chunk to a conservative 20-byte ATT payload.
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.subarray(i, i + 20);
        const buf = chunk.slice();
        if (canWriteNoResp && write.writeValueWithoutResponse) await write.writeValueWithoutResponse(buf);
        else await write.writeValue(buf);
      }
    },
    read(): AsyncIterator<Uint8Array> {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
          return new Promise((resolve) => { resolveNext = resolve; });
        },
      };
    },
    async close() {
      done = true;
      notify.removeEventListener("characteristicvaluechanged", onNotify);
      try { await notify.stopNotifications?.(); } catch { /* ignore */ }
      if (resolveNext) { resolveNext({ value: undefined as unknown as Uint8Array, done: true }); resolveNext = null; }
      queue = [];
    },
  };
}

export class WebBluetoothPn532Transport implements CardTransport {
  readonly id = "webbluetooth-pn532" as const;
  readonly label = "Web Bluetooth PN532";
  readonly capabilities: TransportCapabilities = { apdu: true, raw: true, mifareAuth: false, ndefOnly: false, emulate: false, write: true };

  private device: BleDevice | null = null;
  private duplex: Duplex | null = null;
  private dev: Pn532 | null = null;
  private connected = false;
  private currentTg = 0x01;
  private disconnectCbs = new Set<() => void>();
  private traceCbs = new Set<(dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void>();

  isSupported(): boolean { return bluetooth() !== null; }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    const bt = bluetooth();
    if (!bt) throw new NfcError("unsupported", "Web Bluetooth (navigator.bluetooth) is not available");
    let device: BleDevice;
    try {
      device = await bt.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { services: [HM10_SERVICE] }],
        optionalServices: [NUS_SERVICE, HM10_SERVICE],
      });
    } catch (err) {
      throw fromDomError(err, "no-device");
    }
    if (!device?.gatt) throw new NfcError("no-device", "No Bluetooth device selected");
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => this.handleLost());
    try {
      const server = await device.gatt.connect();
      const { write, notify } = await this.resolveCharacteristics(server);
      await notify.startNotifications();
      this.duplex = bleDuplex(write, notify);
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

  private async resolveCharacteristics(server: BleServer): Promise<{ write: BleCharacteristic; notify: BleCharacteristic }> {
    // Try Nordic UART first, then HM-10 single characteristic.
    try {
      const svc = await server.getPrimaryService(NUS_SERVICE);
      const write = await svc.getCharacteristic(NUS_RX);
      const notify = await svc.getCharacteristic(NUS_TX);
      return { write, notify };
    } catch { /* fall through to HM-10 */ }
    const svc = await server.getPrimaryService(HM10_SERVICE);
    const ch = await svc.getCharacteristic(HM10_CHAR); // single read/write/notify characteristic
    return { write: ch, notify: ch };
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
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
    this.device = null;
  }

  private deviceOrThrow(): Pn532 {
    if (!this.dev || !this.connected) throw new NfcError("not-connected", "PN532 (BLE) not connected");
    return this.dev;
  }

  async waitForCard(opts: WaitOpts = {}): Promise<CardIdentity> {
    const dev = this.deviceOrThrow();
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      if (opts.signal?.aborted) throw new NfcError("aborted", "Aborted");
      const target = await listPassiveTargetTypeA(dev, { timeoutMs: 900, signal: opts.signal }).catch((e) => {
        if (NfcError.is(e, "timeout")) return null;
        throw e;
      });
      if (target) {
        this.currentTg = target.tg;
        const sak = target.selRes;
        return {
          uid: target.uid,
          atqa: target.sensRes.length >= 2 ? u8(target.sensRes[1], target.sensRes[0]) : undefined,
          sak,
          ats: target.ats,
          tech: "iso14443a",
          isoDep: (sak & 0x20) !== 0,
          hints: ["pn532", "web-bluetooth"],
        };
      }
      if (Date.now() >= deadline) throw new NfcError("timeout", "No card presented");
    }
  }

  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    return inDataExchange(this.deviceOrThrow(), this.currentTg, apdu);
  }

  async transceiveRaw(frame: Uint8Array, opts?: RawOpts): Promise<Uint8Array> {
    return inCommunicateThru(this.deviceOrThrow(), frame, { timeoutMs: opts?.timeoutMs });
  }

  async releaseCard(): Promise<void> { if (this.dev) await inRelease(this.dev, this.currentTg); }

  onDisconnect(cb: () => void): () => void { this.disconnectCbs.add(cb); return () => this.disconnectCbs.delete(cb); }
  onTrace(cb: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void): () => void { this.traceCbs.add(cb); return () => this.traceCbs.delete(cb); }
  private trace(dir: "tx" | "rx", bytes: Uint8Array, note?: string): void { for (const cb of this.traceCbs) cb(dir, bytes, note); }
}
