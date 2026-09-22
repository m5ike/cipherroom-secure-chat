// Web NFC transport (Android Chrome). NDEF read/write only: the browser
// exposes no APDU or raw-frame channel, so transmit() / transceiveRaw()
// throw. This is honest by design — we never fake an APDU path.

import { NfcError, fromDomError } from "../errors";
import type { CardTransport, CardIdentity, WaitOpts, TransportCapabilities } from "../transport";
import { decodeRecord, TNF, type NdefRecord, type DecodedRecord } from "../cards/ndef";
import { unhex } from "../cards/apdu";

type NdefRecordInit = { recordType: string; mediaType?: string; id?: string; encoding?: string; lang?: string; data?: unknown };
type NDEFReaderLike = {
  scan: (opts?: { signal?: AbortSignal }) => Promise<void>;
  write: (msg: { records: NdefRecordInit[] }, opts?: { signal?: AbortSignal; overwrite?: boolean }) => Promise<void>;
  addEventListener: (type: string, cb: (ev: unknown) => void) => void;
  removeEventListener: (type: string, cb: (ev: unknown) => void) => void;
};
type ReadingEvent = { serialNumber?: string; message?: { records?: Array<{ recordType: string; mediaType?: string; id?: string; encoding?: string; lang?: string; data?: DataView | ArrayBuffer }> } };

function hasWebNfc(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

/** Map a browser NDEFRecord (already decoded by the platform) back to our raw NdefRecord shape. */
function toRawRecord(r: NonNullable<NonNullable<ReadingEvent["message"]>["records"]>[number]): NdefRecord {
  const enc = new TextEncoder();
  const data = r.data instanceof DataView ? new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)
    : r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : new Uint8Array(0);
  switch (r.recordType) {
    case "text": {
      const lang = r.lang ?? "en";
      const langBytes = enc.encode(lang);
      const status = (r.encoding === "utf-16" ? 0x80 : 0x00) | langBytes.length;
      return { tnf: TNF.WELL_KNOWN, type: enc.encode("T"), payload: Uint8Array.from([status, ...langBytes, ...data]) };
    }
    case "url":
    case "absolute-url":
      return { tnf: r.recordType === "url" ? TNF.WELL_KNOWN : TNF.ABSOLUTE_URI, type: enc.encode(r.recordType === "url" ? "U" : new TextDecoder().decode(data)), payload: r.recordType === "url" ? Uint8Array.from([0x00, ...enc.encode(new TextDecoder().decode(data))]) : new Uint8Array(0) };
    case "mime":
      return { tnf: TNF.MIME, type: enc.encode(r.mediaType ?? "application/octet-stream"), payload: data };
    case "empty":
      return { tnf: TNF.EMPTY, type: new Uint8Array(0), payload: new Uint8Array(0) };
    default:
      // external type or smart-poster: recordType carries the type string.
      return { tnf: r.recordType.includes(":") ? TNF.EXTERNAL : TNF.UNKNOWN, type: enc.encode(r.recordType), payload: data };
  }
}

/** Convert our NdefRecord into a browser NDEFRecordInit for write(). */
function toWriteRecord(r: NdefRecord): NdefRecordInit {
  const dec = new TextDecoder();
  const type = dec.decode(r.type);
  const d = decodeRecord(r);
  return writeRecordFor(d, type, r);
}

function writeRecordFor(d: DecodedRecord, type: string, r: NdefRecord): NdefRecordInit {
  switch (d.kind) {
    case "text": return { recordType: "text", lang: d.lang || "en", data: d.text };
    case "uri": return { recordType: "url", data: d.uri };
    case "absolute-uri": return { recordType: "absolute-url", data: d.uri };
    case "mime": return { recordType: "mime", mediaType: d.mime, data: d.payload };
    case "external": return { recordType: type, data: d.payload };
    case "empty": return { recordType: "empty" };
    default: return { recordType: "unknown", data: r.payload };
  }
}

export class WebNfcTransport implements CardTransport {
  readonly id = "webnfc" as const;
  readonly label = "Web NFC (Android Chrome)";
  readonly capabilities: TransportCapabilities = { apdu: false, raw: false, mifareAuth: false, ndefOnly: true, emulate: false, write: true };

  private reader: NDEFReaderLike | null = null;
  private scanAbort: AbortController | null = null;
  private connected = false;
  private disconnectCbs = new Set<() => void>();

  isSupported(): boolean { return hasWebNfc(); }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    if (!hasWebNfc()) throw new NfcError("unsupported", "Web NFC (NDEFReader) is not available in this browser");
    const Ctor = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
    this.reader = new Ctor();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.scanAbort?.abort();
    this.scanAbort = null;
    this.reader = null;
    this.connected = false;
  }

  async waitForCard(opts: WaitOpts = {}): Promise<CardIdentity> {
    if (!this.reader) throw new NfcError("not-connected", "Call connect() first");
    const reader = this.reader;
    const ac = new AbortController();
    this.scanAbort = ac;
    const onExternalAbort = () => ac.abort();
    opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : null;
    try {
      await reader.scan({ signal: ac.signal });
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      throw fromDomError(err, "protocol");
    }
    return new Promise<CardIdentity>((resolve, reject) => {
      const onReading = (ev: unknown) => {
        if (timeout) clearTimeout(timeout);
        const e = ev as ReadingEvent;
        const uid = e.serialNumber ? unhex(e.serialNumber) : new Uint8Array(0);
        const ndef = (e.message?.records ?? []).map(toRawRecord);
        cleanup();
        resolve({ uid, tech: "iso14443a", isoDep: false, ndef, hints: ["web-nfc", "ndef-only"] });
      };
      const onError = () => { if (timeout) clearTimeout(timeout); cleanup(); reject(new NfcError("card-error", "NDEF reading error")); };
      const onAbort = () => { cleanup(); reject(new NfcError(opts.timeoutMs && !opts.signal?.aborted ? "timeout" : "aborted", "Scan cancelled")); };
      const cleanup = () => {
        reader.removeEventListener("reading", onReading);
        reader.removeEventListener("readingerror", onError);
        ac.signal.removeEventListener("abort", onAbort);
        opts.signal?.removeEventListener("abort", onExternalAbort);
      };
      reader.addEventListener("reading", onReading);
      reader.addEventListener("readingerror", onError);
      ac.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async transmit(): Promise<Uint8Array> {
    throw new NfcError("not-supported-by-transport", "APDU exchange is not supported by Web NFC (NDEF read/write only)");
  }

  async writeNdef(records: NdefRecord[], opts: { signal?: AbortSignal; overwrite?: boolean } = {}): Promise<void> {
    if (!this.reader) throw new NfcError("not-connected", "Call connect() first");
    try {
      await this.reader.write({ records: records.map(toWriteRecord) }, { overwrite: opts.overwrite ?? true, signal: opts.signal });
    } catch (err) {
      throw fromDomError(err, "card-error");
    }
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectCbs.add(cb);
    return () => this.disconnectCbs.delete(cb);
  }
}
