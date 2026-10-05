// The system smart-card reader (6.13.1) — M5cet Desktop only.
//
// A USB CCID reader (ACR122U, ACR1252U, ACR1281 …) belongs to the operating
// system's smart-card service (macOS CryptoTokenKit, Windows' smart-card
// service, Linux pcscd): a browser cannot claim it over WebUSB. The desktop
// app talks to it through PC/SC instead (desktop/src/pcsc.ts with
// pcsc-mini) and hands the page a narrow bridge, `window.m5desktop.pcsc`
// (pcsc-bridge.ts): the app asks the user once per server, the user picks the
// reader, and the page exchanges APDUs with the card in it.
//
// What this transport can do — honestly:
//   apdu        yes: ISO 14443-4 cards on a contactless slot, any contact card
//   raw         no: PC/SC has no standard raw ISO 14443-3 channel (and the
//               reader's escape commands are not exposed)
//   mifareAuth  through the PC/SC Part 3 pseudo-APDUs the readers implement
//               (FF 82 load key, FF 86 authenticate, FF B0 / FF D6 read / update
//               binary) — the same commands the WebUSB CCID path sends
//   emulate     no
// A multi-slot reader (the ACR1281: contact, contactless, SAM) is several
// readers; the picker labels each slot. The G-18 read-only rules for models
// and templates (apdu-templates.ts) apply here as on every transport: they
// sit in the executor and the template runner, before transmit().

import { NfcError, type NfcErrorCode } from "../errors";
import type { CardTransport, CardIdentity, WaitOpts, TransportCapabilities } from "../transport";
import { concat, hex, splitResponse, u8 } from "../cards/apdu";
import { parsePcscAtr } from "../pcsc-atr";
import { desktopPcsc } from "../../desktop-bridge";
import type { PcscBridge, PcscErrorCode, PcscFail, PcscReader, PcscSlot } from "../pcsc-bridge";

const CODE: Record<PcscErrorCode, NfcErrorCode> = {
  unavailable: "unsupported",
  denied: "permission-denied",
  cancelled: "no-device",
  "no-reader": "no-device",
  "no-card": "no-card",
  removed: "no-card",
  reset: "card-error",
  busy: "busy",
  "card-error": "card-error",
  timeout: "timeout",
  "too-large": "invalid-argument",
  "bad-request": "invalid-argument",
  "bad-handle": "not-connected",
  "rate-limited": "busy",
  "not-allowed": "permission-denied",
  locked: "permission-denied",
  failed: "protocol",
};

/** A bridge failure as an NfcError; `detail` is "pcsc:<code>" so the workbench can say exactly what happened. */
export function pcscError(f: Pick<PcscFail, "code" | "message">): NfcError {
  const code = CODE[f.code] ?? "protocol";
  return new NfcError(code, f.message || f.code, `pcsc:${f.code}`);
}

/** The PC/SC code an NfcError came from, if it came from this transport. */
export function pcscCodeOf(err: unknown): PcscErrorCode | null {
  return NfcError.is(err) && typeof err.detail === "string" && err.detail.startsWith("pcsc:") ? (err.detail.slice(5) as PcscErrorCode) : null;
}

const GET_UID = u8(0xff, 0xca, 0x00, 0x00, 0x00);

export class DesktopPcscTransport implements CardTransport {
  readonly id = "desktop-pcsc" as const;
  readonly label = "System reader (PC/SC)";
  readonly capabilities: TransportCapabilities = { apdu: true, raw: false, mifareAuth: true, ndefOnly: false, emulate: false, write: true };

  private connected = false;
  private reader: string | null = null;
  private slot: PcscSlot = "unknown";
  private handle: string | null = null;
  private atr: Uint8Array | null = null;
  private identity: CardIdentity | null = null;
  /** A card is in the picked reader (from the app's change events). */
  private present = false;
  /** Bumps on every card insertion into the picked reader. */
  private generation = 0;
  private handleGeneration = -1;
  /** After releaseCard(): the next waitForCard() wants another card (removed, then inserted). */
  private needFresh = false;
  private sawAbsent = false;
  private unsubscribe: (() => void) | null = null;
  private wake = new Set<() => void>();
  private disconnectCbs = new Set<() => void>();
  private traceCbs = new Set<(dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void>();

  constructor(private readonly bridge: PcscBridge | null = desktopPcsc()) {}

  isSupported(): boolean { return this.bridge !== null; }
  isConnected(): boolean { return this.connected; }
  /** The reader the user picked, and its slot ("contactless" …). */
  get pickedReader(): { name: string; slot: PcscSlot } | null { return this.reader ? { name: this.reader, slot: this.slot } : null; }

  private need(): PcscBridge {
    if (!this.bridge) throw new NfcError("unsupported", "The system reader exists only in M5cet Desktop");
    return this.bridge;
  }

  /** The app asks (once per server) whether readers may be used, then which reader — unless one holds a card. */
  async connect(): Promise<void> {
    const b = this.need();
    await this.disconnect();
    this.unsubscribe = b.onChange((list) => this.onReaders(list));
    const r = await b.connect(null);
    if (r.ok) {
      this.reader = r.reader;
      this.slot = r.slot;
      this.present = true;
      this.adopt(r.handle, r.atr);
    } else if (r.code === "no-card" && r.reader) {
      // The user picked an empty reader: waitForCard() waits for a card there.
      this.reader = r.reader;
      this.present = false;
    } else {
      this.unsubscribe?.();
      this.unsubscribe = null;
      throw pcscError(r);
    }
    this.connected = true;
    const list = await b.listReaders().catch(() => null);
    if (list?.ok) {
      const me = list.readers.find((x) => x.name === this.reader);
      if (me) this.slot = me.slot;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.dropHandle();
    this.reader = null;
    this.present = false;
    this.needFresh = false;
    for (const w of this.wake) w();
  }

  private adopt(handle: string, atr: Uint8Array): void {
    this.handle = handle;
    this.atr = atr instanceof Uint8Array ? atr : new Uint8Array(atr ?? []);
    this.identity = null;
    this.handleGeneration = this.generation;
  }

  private async dropHandle(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    this.identity = null;
    this.atr = null;
    if (h && this.bridge) await this.bridge.disconnect(h).catch(() => undefined);
  }

  private onReaders(list: PcscReader[]): void {
    if (!this.reader) return;
    const me = list.find((x) => x.name === this.reader);
    if (!me) {
      // The reader was unplugged.
      const was = this.connected;
      this.connected = false;
      this.present = false;
      this.handle = null;
      this.identity = null;
      for (const w of this.wake) w();
      if (was) for (const cb of this.disconnectCbs) cb();
      return;
    }
    this.slot = me.slot;
    const before = this.present;
    this.present = me.card;
    if (!me.card) {
      this.sawAbsent = true;
      void this.dropHandle();
    } else if (!before) {
      this.generation++;
    }
    for (const w of this.wake) w();
  }

  /** Resolves on the next reader event (or after `ms` — a poll in case an event was missed). */
  private nextEvent(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new NfcError("aborted", "Aborted"));
      const done = () => { clearTimeout(t); this.wake.delete(done); signal?.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => { clearTimeout(t); this.wake.delete(done); reject(new NfcError("aborted", "Aborted")); };
      const t = setTimeout(done, ms);
      this.wake.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async refresh(): Promise<void> {
    const list = await this.bridge?.listReaders().catch(() => null);
    if (list?.ok) this.onReaders(list.readers);
  }

  async waitForCard(opts: WaitOpts = {}): Promise<CardIdentity> {
    const b = this.need();
    if (!this.connected || !this.reader) throw new NfcError("not-connected", "No reader chosen");
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    for (;;) {
      if (opts.signal?.aborted) throw new NfcError("aborted", "Aborted");
      if (!this.connected || !this.reader) throw new NfcError("disconnected", "The reader was disconnected");
      if (this.needFresh && this.sawAbsent && this.present) this.needFresh = false;
      if (!this.needFresh) {
        if (this.handle && this.handleGeneration === this.generation) {
          if (!this.identity) this.identity = await this.identify();
          return this.identity;
        }
        if (this.present) {
          const r = await b.connect(this.reader);
          if (r.ok) {
            this.adopt(r.handle, r.atr);
            this.identity = await this.identify();
            return this.identity;
          }
          if (r.code === "no-card" || r.code === "removed") this.present = false;
          else throw pcscError(r);
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new NfcError("timeout", "No card presented");
      await this.nextEvent(Math.min(2000, left), opts.signal);
      // Events can be missed (sleep, a reader re-enumerating): look again now and then.
      if (!this.present || this.needFresh) await this.refresh();
    }
  }

  /** The card's identity from its ATR and — on a contactless slot — the reader's GET UID (FF CA 00 00 00). */
  private async identify(): Promise<CardIdentity> {
    const atr = this.atr ?? new Uint8Array(0);
    const info = parsePcscAtr(atr);
    const contactless = info?.contactless === true || this.slot === "contactless";
    let uid: Uint8Array = new Uint8Array(0);
    if (contactless) {
      // Never sent to a contact card: there CLA FF would go to the card itself.
      try {
        const r = splitResponse(await this.transmit(GET_UID));
        if (r.sw === 0x9000) uid = r.data;
      } catch (e) { if (!NfcError.is(e, "card-error")) throw e; }
    }
    return {
      uid,
      atr,
      sak: info?.sak,
      atqa: info?.atqa,
      tech: contactless && info ? info.tech : "unknown",
      isoDep: info ? info.apdu : true,
      hints: ["pcsc", "desktop", this.slot, ...(info?.storage ? ["storage-card"] : []), ...(contactless ? [] : ["contact"])],
    };
  }

  async transmit(apdu: Uint8Array): Promise<Uint8Array> {
    const b = this.need();
    if (!this.handle) throw new NfcError("not-connected", "No card connected");
    this.trace("tx", apdu, "apdu");
    const r = await b.transmit(this.handle, apdu);
    if (!r.ok) {
      if (r.code === "removed" || r.code === "reset" || r.code === "bad-handle") {
        // The connection is gone; the next waitForCard() connects again.
        this.handle = null;
        this.identity = null;
        if (r.code !== "removed") this.generation++;
      }
      throw pcscError(r);
    }
    const resp = r.response instanceof Uint8Array ? r.response : new Uint8Array(r.response ?? []);
    this.trace("rx", resp, "apdu");
    return resp;
  }

  /* ---------- MIFARE Classic through PC/SC Part 3 pseudo-APDUs ---------- */

  async mifareAuth(block: number, keyType: "A" | "B", key: Uint8Array, _uid: Uint8Array): Promise<boolean> {
    if (key.length !== 6) throw new NfcError("invalid-argument", "Mifare key must be 6 bytes");
    // Load the key into the reader's volatile slot 0: FF 82 00 00 06 <key>.
    const load = splitResponse(await this.transmit(concat(u8(0xff, 0x82, 0x00, 0x00, 0x06), key)));
    if (load.sw !== 0x9000) throw new NfcError("card-error", `Load key failed SW ${hex([load.sw >> 8, load.sw & 0xff])}`);
    // General Authenticate: FF 86 00 00 05 01 00 <block> <60|61> <slot 0>.
    const auth = splitResponse(await this.transmit(u8(0xff, 0x86, 0x00, 0x00, 0x05, 0x01, 0x00, block & 0xff, keyType === "A" ? 0x60 : 0x61, 0x00)));
    if (auth.sw === 0x9000) return true;
    if (auth.sw === 0x6300 || auth.sw === 0x6982) return false;
    throw new NfcError("card-error", `Auth SW ${hex([auth.sw >> 8, auth.sw & 0xff])}`);
  }

  async mifareReadBlock(block: number, keyType: "A" | "B", key: Uint8Array, uid: Uint8Array): Promise<Uint8Array> {
    if (!(await this.mifareAuth(block, keyType, key, uid))) throw new NfcError("auth-failed", `Key ${keyType} did not open block ${block}`);
    const r = splitResponse(await this.transmit(u8(0xff, 0xb0, 0x00, block & 0xff, 0x10)));
    if (r.sw !== 0x9000 || r.data.length < 16) throw new NfcError("card-error", `Read block ${block} SW ${hex([r.sw >> 8, r.sw & 0xff])}`);
    return r.data.slice(0, 16);
  }

  async mifareWriteBlock(block: number, data: Uint8Array, keyType: "A" | "B", key: Uint8Array, uid: Uint8Array): Promise<void> {
    if (data.length !== 16) throw new NfcError("invalid-argument", "A Mifare block is 16 bytes");
    if (!(await this.mifareAuth(block, keyType, key, uid))) throw new NfcError("auth-failed", `Key ${keyType} did not open block ${block}`);
    const r = splitResponse(await this.transmit(concat(u8(0xff, 0xd6, 0x00, block & 0xff, 0x10), data)));
    if (r.sw !== 0x9000) throw new NfcError("card-error", `Write block ${block} SW ${hex([r.sw >> 8, r.sw & 0xff])}`);
  }

  /** Lets go of the card; the next waitForCard() waits for a card to be taken away and put back. */
  async releaseCard(): Promise<void> {
    await this.dropHandle();
    this.needFresh = true;
    this.sawAbsent = !this.present;
  }

  onDisconnect(cb: () => void): () => void { this.disconnectCbs.add(cb); return () => this.disconnectCbs.delete(cb); }
  onTrace(cb: (dir: "tx" | "rx", bytes: Uint8Array, note?: string) => void): () => void { this.traceCbs.add(cb); return () => this.traceCbs.delete(cb); }
  private trace(dir: "tx" | "rx", bytes: Uint8Array, note?: string): void { for (const cb of this.traceCbs) cb(dir, bytes, note); }
}
