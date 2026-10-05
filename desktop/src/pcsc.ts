// The system smart-card reader for the page (6.13.1) — pure: no Electron, no
// native module. main.ts gives it a backend (pcsc-backend.ts → pcsc-mini) and a
// host (native dialogs, the encrypted settings, sending events to the page);
// the tests give it fakes.
//
// Why: a USB CCID reader (ACR122U, ACR1252U, ACR1281 …) belongs to the
// operating system's smart-card service, so WebUSB can never claim it (macOS
// CryptoTokenKit, Windows usbccid.sys, Linux pcscd). PC/SC is the system's own
// way in: SCardConnect in SHARED mode next to other programs (an e-ID or token
// middleware keeps working), SCardTransmit for APDUs. SCardControl (reader
// escape commands) is deliberately not offered.
//
// The rules, all enforced here:
//   * only the server page's main frame (senderPage(): the chosen server's
//     origin, the app window's main frame) — main.ts builds the sender facts
//   * the first use per server asks the user (a native confirmation); "allow"
//     is remembered in the encrypted settings and can be withdrawn in the menu;
//     "don't allow" holds for the page load (no prompt storm)
//   * the user picks the reader (a native chooser) — unless exactly one reader
//     holds a card; a reader the user picked stays picked for the page load
//   * nothing while the screen is locked; every connection closes when the page
//     navigates or closes, when access is withdrawn and when the app quits
//   * APDUs of 4 … 65 544 bytes, responses up to 65 538, one at a time per card,
//     timeouts, rate limits; errors as stable codes (pcsc-bridge.ts)

import {
  PCSC_MAX_APDU, PCSC_MAX_NAME, PCSC_MAX_RESPONSE, slotOfReader,
  type PcscErrorCode, type PcscFail, type PcscReader, type PcscSlot,
} from "../../client/src/lib/nfc/pcsc-bridge";

/* ---------------------------------------------------------------- backend */

/** A reader's state as PC/SC reports it. */
export type ReaderState = { present: boolean; mute: boolean; exclusive: boolean; atr: Uint8Array };

/** What the service needs from a PC/SC library (pcsc-mini in the app, a fake in tests). */
export interface PcscBackend {
  /** Starts watching readers; `change` fires for every reader already there too. Throws when PC/SC is unavailable. */
  start(events: { change(name: string, state: ReaderState): void; gone(name: string): void; error(err: unknown): void }): void;
  stop(): void;
  /** SCardConnect, SHARED, T=0 or T=1. */
  connect(reader: string): Promise<PcscCard>;
}

export interface PcscCard {
  readonly atr: Uint8Array;
  readonly protocol: string;
  /** SCardTransmit with a receive buffer of `maxResponse` bytes. */
  transmit(apdu: Uint8Array, maxResponse: number): Promise<Uint8Array>;
  /** SCardDisconnect, leaving the card as it is. */
  disconnect(): Promise<void>;
}

/* ------------------------------------------------------------------- host */

export interface PcscHost {
  /** The user allowed this server earlier (the encrypted settings). */
  isAllowed(origin: string): boolean;
  /** The native confirmation "Allow <server> to use smart-card readers?" — true = allow. */
  askAllow(origin: string): Promise<boolean>;
  /** Remembers "allow" for the server. */
  allow(origin: string): void;
  /** The native reader chooser; the reader's name, or null when cancelled. */
  chooseReader(origin: string, readers: PcscReader[], preferred: string | null): Promise<string | null>;
  /** Sends the page its reader list (it uses readers and is allowed). */
  notify(pageId: number, readers: PcscReader[]): void;
  log?(message: string): void;
}

/* ----------------------------------------------------------------- sender */

/** The facts main.ts reads off an IPC event. */
export type SenderFacts = {
  /** The sender is the app window's page (not a child window, not the app's own pages). */
  isPage: boolean;
  /** The message came from that page's main frame. */
  isMainFrame: boolean;
  /** The sending frame's URL. */
  frameUrl: string | null | undefined;
  /** The chosen server's origin (null when no server is open). */
  serverOrigin: string | null | undefined;
  /** The page's WebContents id. */
  pageId: number;
};

export type PcscPage = { id: number; origin: string };

/** The page a message may act for — the server page's main frame on the server's origin — or null. */
export function senderPage(s: SenderFacts): PcscPage | null {
  if (!s.isPage || !s.isMainFrame || !s.serverOrigin || s.serverOrigin === "null") return null;
  let origin: string;
  try { origin = new URL(String(s.frameUrl ?? "")).origin; } catch { return null; }
  return origin === s.serverOrigin ? { id: s.pageId, origin } : null;
}

/* ----------------------------------------------------------------- limits */

export type PcscLimits = {
  /** APDUs: a burst, then this many per second (an e-ID read with secure messaging sends a few hundred). */
  apduBurst: number;
  apduPerSecond: number;
  /** list / connect / disconnect. */
  callBurst: number;
  callPerSecond: number;
  /** Open connections per page. */
  maxHandles: number;
  connectTimeoutMs: number;
  transmitTimeoutMs: number;
};

export const DEFAULT_LIMITS: PcscLimits = {
  apduBurst: 400, apduPerSecond: 200, callBurst: 30, callPerSecond: 10, maxHandles: 4, connectTimeoutMs: 10_000, transmitTimeoutMs: 30_000,
};

class Bucket {
  private tokens: number;
  private at: number;
  constructor(private readonly burst: number, private readonly perSecond: number, private readonly now: () => number) {
    this.tokens = burst;
    this.at = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSecond);
    this.at = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/* ----------------------------------------------------------------- errors */

const fail = (code: PcscErrorCode, message: string, reader?: string): PcscFail => ({ ok: false, code, message, ...(reader ? { reader } : {}) });

/** A PC/SC library error (pcsc-mini's Err.code names the SCARD_* result) → a stable code. */
export function pcscErrorCode(err: unknown): PcscErrorCode {
  const code = String((err as { code?: unknown })?.code ?? (err as { name?: unknown })?.name ?? "");
  const msg = String((err as Error)?.message ?? "");
  const has = (...names: string[]) => names.some((n) => code === n || msg.includes(n));
  if (has("NoSmartCard")) return "no-card";
  if (has("RemovedCard")) return "removed";
  if (has("ResetCard")) return "reset";
  if (has("SharingViolation", "CardIsBusy")) return "busy";
  if (has("Timeout", "WaitedTooLong")) return "timeout";
  if (has("UnknownReader", "ReaderUnavailable", "NoReadersAvailable")) return "no-reader";
  if (has("NoService", "ServiceStopped", "Shutdown", "UnknownResMng")) return "unavailable";
  if (has("UnresponsiveCard", "UnpoweredCard", "UnsupportedCard", "ProtoMismatch", "InvalidAtr", "UnknownCard", "CommError", "CommDataLost")) return "card-error";
  if (has("InsufficientBuffer")) return "too-large";
  return "failed";
}

class Timeout extends Error { readonly code = "Timeout"; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Timeout(`no answer in ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/* ---------------------------------------------------------------- service */

type Handle = { id: string; reader: string; card: PcscCard; queue: Promise<unknown>; closed: boolean };

type PageCtx = {
  id: number;
  origin: string;
  /** Readers the user picked on this page load. */
  picked: Set<string>;
  handles: Map<string, Handle>;
  /** "Don't allow" on this page load. */
  denied: boolean;
  /** The page has used readers (it gets change events). */
  subscribed: boolean;
  lastSent: string;
  calls: Bucket;
  apdus: Bucket;
  /** One connect (and its chooser) at a time. */
  connecting: Promise<unknown>;
};

export type PcscServiceOptions = {
  limits?: Partial<PcscLimits>;
  now?: () => number;
  newId?: () => string;
};

export class PcscService {
  private readonly limits: PcscLimits;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readers = new Map<string, ReaderState>();
  private backend: PcscBackend | null = null;
  private startError: string | null = null;
  private pages = new Map<number, PageCtx>();
  private prompts = new Map<string, Promise<boolean>>();
  private locked = false;
  private seq = 0;
  private startedAt = 0;

  constructor(private readonly makeBackend: () => PcscBackend, private readonly host: PcscHost, opts: PcscServiceOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => `${Date.now().toString(36)}${(this.seq += 1).toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  }

  /* ----------------------------------------------------------- the reader list */

  private ensureStarted(): PcscFail | null {
    if (this.backend) return null;
    try {
      const b = this.makeBackend();
      b.start({
        change: (name, state) => this.onChange(name, state),
        gone: (name) => this.onGone(name),
        error: (err) => {
          this.host.log?.(`[pcsc] ${String((err as Error)?.message ?? err)}`);
          // The service went away (pcscd stopped, the last reader on macOS): start again on the next call.
          if (pcscErrorCode(err) === "unavailable") this.restart();
        },
      });
      this.backend = b;
      this.startError = null;
      this.startedAt = this.now();
      return null;
    } catch (err) {
      this.startError = String((err as Error)?.message ?? err);
      return fail("unavailable", `PC/SC is not available: ${this.startError}`);
    }
  }

  private restart(): void {
    try { this.backend?.stop(); } catch { /* ignore */ }
    this.backend = null;
    this.readers.clear();
    for (const ctx of this.pages.values()) this.closeAll(ctx);
    this.broadcast();
  }

  /** Waits a moment right after the start: PC/SC reports the attached readers asynchronously. */
  private async settle(): Promise<void> {
    while (this.readers.size === 0 && this.now() - this.startedAt < 600) await new Promise((r) => setTimeout(r, 50));
  }

  private onChange(name: string, state: ReaderState): void {
    if (typeof name !== "string" || !name || name.length > PCSC_MAX_NAME) return;
    const atr = state.atr instanceof Uint8Array ? state.atr : new Uint8Array(state.atr ?? []);
    this.readers.set(name, { present: Boolean(state.present), mute: Boolean(state.mute), exclusive: Boolean(state.exclusive), atr });
    if (!state.present) for (const ctx of this.pages.values()) for (const h of [...ctx.handles.values()]) if (h.reader === name) this.close(ctx, h);
    this.broadcast();
  }

  private onGone(name: string): void {
    this.readers.delete(name);
    for (const ctx of this.pages.values()) {
      for (const h of [...ctx.handles.values()]) if (h.reader === name) this.close(ctx, h);
      ctx.picked.delete(name);
    }
    this.broadcast();
  }

  /** The readers as the page sees them, sorted by name. */
  view(): PcscReader[] {
    return [...this.readers.entries()]
      .map(([name, s]) => ({ name, slot: slotOfReader(name, s.atr) as PcscSlot, card: s.present && !s.mute }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private broadcast(): void {
    if (this.locked) return;
    const list = this.view();
    const json = JSON.stringify(list);
    for (const ctx of this.pages.values()) {
      if (!ctx.subscribed || ctx.lastSent === json || !this.host.isAllowed(ctx.origin)) continue;
      ctx.lastSent = json;
      this.host.notify(ctx.id, list);
    }
  }

  /* -------------------------------------------------------------- pages */

  private ctxOf(page: PcscPage): PageCtx {
    let ctx = this.pages.get(page.id);
    if (ctx && ctx.origin !== page.origin) { this.releasePage(page.id); ctx = undefined; }
    if (!ctx) {
      ctx = {
        id: page.id, origin: page.origin, picked: new Set(), handles: new Map(), denied: false, subscribed: false, lastSent: "",
        calls: new Bucket(this.limits.callBurst, this.limits.callPerSecond, this.now),
        apdus: new Bucket(this.limits.apduBurst, this.limits.apduPerSecond, this.now),
        connecting: Promise.resolve(),
      };
      this.pages.set(page.id, ctx);
    }
    return ctx;
  }

  /** The common gate of every call: a page, not locked, within the call rate. */
  private gate(page: PcscPage | null, kind: "call" | "apdu"): { ctx: PageCtx } | PcscFail {
    if (!page) return fail("not-allowed", "Only the server page may use card readers");
    if (this.locked) return fail("locked", "The screen is locked");
    const ctx = this.ctxOf(page);
    if (!(kind === "apdu" ? ctx.apdus : ctx.calls).take()) return fail("rate-limited", "Too many requests");
    return { ctx };
  }

  /** Asks once per server (concurrent calls share the question); "don't allow" holds for the page load. */
  private async allowed(ctx: PageCtx): Promise<boolean> {
    if (this.host.isAllowed(ctx.origin)) return true;
    if (ctx.denied) return false;
    let p = this.prompts.get(ctx.origin);
    if (!p) {
      p = this.host.askAllow(ctx.origin).then((ok) => {
        if (ok) this.host.allow(ctx.origin);
        return ok;
      }, () => false).finally(() => this.prompts.delete(ctx.origin));
      this.prompts.set(ctx.origin, p);
    }
    const ok = await p;
    if (!ok) for (const c of this.pages.values()) if (c.origin === ctx.origin) c.denied = true;
    return ok && this.pages.get(ctx.id) === ctx;
  }

  /* -------------------------------------------------------------- the API */

  async list(page: PcscPage | null): Promise<{ ok: true; readers: PcscReader[] } | PcscFail> {
    const g = this.gate(page, "call");
    if ("ok" in g) return g;
    const ctx = g.ctx;
    // No PC/SC on this computer: say so without asking for a permission that could not be used.
    const started = this.ensureStarted();
    if (started) return started;
    if (!(await this.allowed(ctx))) return fail("denied", "Smart-card readers are not allowed for this server");
    await this.settle();
    ctx.subscribed = true;
    const list = this.view();
    ctx.lastSent = JSON.stringify(list);
    return { ok: true, readers: list };
  }

  async connect(page: PcscPage | null, reader: unknown): Promise<{ ok: true; handle: string; reader: string; slot: PcscSlot; atr: Uint8Array; protocol: string } | PcscFail> {
    const g = this.gate(page, "call");
    if ("ok" in g) return g;
    const ctx = g.ctx;
    if (reader !== undefined && reader !== null && (typeof reader !== "string" || !reader || reader.length > PCSC_MAX_NAME)) return fail("bad-request", "Bad reader name");
    const run = ctx.connecting.then(() => this.connectNow(ctx, (reader as string | null | undefined) ?? null));
    ctx.connecting = run.catch(() => undefined);
    return run;
  }

  private async connectNow(ctx: PageCtx, wanted: string | null): Promise<{ ok: true; handle: string; reader: string; slot: PcscSlot; atr: Uint8Array; protocol: string } | PcscFail> {
    const started = this.ensureStarted();
    if (started) return started;
    if (!(await this.allowed(ctx))) return fail("denied", "Smart-card readers are not allowed for this server");
    await this.settle();
    ctx.subscribed = true;
    const list = this.view();
    if (list.length === 0) return fail("no-reader", "No smart-card reader is connected");
    let name: string | null = null;
    if (wanted && ctx.picked.has(wanted) && this.readers.has(wanted)) name = wanted;
    else {
      const withCard = list.filter((r) => r.card);
      // The user picks the reader — unless exactly one holds a card (and the page did not name another one).
      if (!wanted && withCard.length === 1) name = withCard[0].name;
      else {
        name = await this.host.chooseReader(ctx.origin, list, wanted);
        if (this.pages.get(ctx.id) !== ctx || this.locked) return fail("not-allowed", "The page changed");
        if (!name) return fail("cancelled", "No reader chosen");
        if (!this.readers.has(name)) return fail("no-reader", "The reader is gone");
      }
    }
    ctx.picked.add(name);
    const state = this.readers.get(name);
    const slot = slotOfReader(name, state?.atr);
    if (!state?.present) return fail("no-card", "No card in the reader", name);
    if (state.mute) return fail("card-error", "The card does not answer", name);
    // A new connection to a reader replaces this page's old one there (a card was swapped).
    for (const h of [...ctx.handles.values()]) if (h.reader === name) this.close(ctx, h);
    if (ctx.handles.size >= this.limits.maxHandles) return fail("busy", "Too many open connections");
    const backend = this.backend;
    if (!backend) return fail("unavailable", "PC/SC is not available");
    let card: PcscCard;
    try {
      card = await withTimeout(backend.connect(name), this.limits.connectTimeoutMs);
    } catch (err) {
      const code = pcscErrorCode(err);
      return fail(code === "failed" ? "card-error" : code, String((err as Error)?.message ?? err), name);
    }
    // The page navigated, access was withdrawn or the screen locked meanwhile: let go at once.
    if (this.pages.get(ctx.id) !== ctx || this.locked || !this.host.isAllowed(ctx.origin)) {
      void card.disconnect().catch(() => undefined);
      return fail(this.locked ? "locked" : "not-allowed", "The page changed");
    }
    const id = this.newId();
    ctx.handles.set(id, { id, reader: name, card, queue: Promise.resolve(), closed: false });
    const atr = card.atr instanceof Uint8Array ? card.atr : new Uint8Array(card.atr ?? []);
    return { ok: true, handle: id, reader: name, slot, atr: new Uint8Array(atr), protocol: String(card.protocol ?? "") };
  }

  async transmit(page: PcscPage | null, handle: unknown, apdu: unknown): Promise<{ ok: true; response: Uint8Array } | PcscFail> {
    const g = this.gate(page, "apdu");
    if ("ok" in g) return g;
    const ctx = g.ctx;
    if (typeof handle !== "string" || handle.length > 64) return fail("bad-request", "Bad handle");
    const bytes = toBytes(apdu);
    if (!bytes) return fail("bad-request", "The APDU must be bytes");
    if (bytes.length > PCSC_MAX_APDU) return fail("too-large", `An APDU is at most ${PCSC_MAX_APDU} bytes`);
    if (bytes.length < 4) return fail("bad-request", "An APDU has at least 4 bytes");
    const h = ctx.handles.get(handle);
    if (!h || h.closed) return fail("bad-handle", "No such connection");
    if (!this.host.isAllowed(ctx.origin)) { this.closeAll(ctx); return fail("denied", "Smart-card readers are not allowed for this server"); }
    const run = h.queue.then(async (): Promise<{ ok: true; response: Uint8Array } | PcscFail> => {
      if (h.closed) return fail("bad-handle", "The connection was closed");
      try {
        const r = await withTimeout(h.card.transmit(bytes, PCSC_MAX_RESPONSE), this.limits.transmitTimeoutMs);
        const resp = r instanceof Uint8Array ? r : new Uint8Array(r ?? []);
        if (resp.length > PCSC_MAX_RESPONSE) return fail("too-large", "The response is too large");
        return { ok: true, response: new Uint8Array(resp) };
      } catch (err) {
        const code = pcscErrorCode(err);
        // The card or the connection is gone: this handle is over.
        if (code === "removed" || code === "reset" || code === "no-card" || code === "no-reader" || code === "timeout" || code === "unavailable") this.close(ctx, h);
        return fail(code, String((err as Error)?.message ?? err), h.reader);
      }
    });
    h.queue = run.catch(() => undefined);
    return run;
  }

  async disconnect(page: PcscPage | null, handle: unknown): Promise<{ ok: true } | PcscFail> {
    const g = this.gate(page, "call");
    if ("ok" in g) return g;
    if (typeof handle !== "string") return fail("bad-request", "Bad handle");
    const h = g.ctx.handles.get(handle);
    if (!h) return fail("bad-handle", "No such connection");
    await this.close(g.ctx, h);
    return { ok: true };
  }

  /* ------------------------------------------------------ lifecycle hooks */

  private close(ctx: PageCtx, h: Handle): Promise<void> {
    if (h.closed) return Promise.resolve();
    h.closed = true;
    ctx.handles.delete(h.id);
    // After the APDU in flight, if any; a driver that never returns does not hold anything up.
    return h.queue.then(() => withTimeout(h.card.disconnect(), this.limits.connectTimeoutMs)).catch(() => undefined);
  }

  private closeAll(ctx: PageCtx): void {
    for (const h of [...ctx.handles.values()]) void this.close(ctx, h);
  }

  /** The page navigated, reloaded or closed: its connections, picks and answers end. */
  releasePage(id: number): void {
    const ctx = this.pages.get(id);
    if (!ctx) return;
    this.closeAll(ctx);
    this.pages.delete(id);
  }

  /** Access for a server was withdrawn (menu): its pages lose their connections and events. */
  revoke(origin: string): void {
    for (const ctx of this.pages.values()) {
      if (ctx.origin !== origin) continue;
      this.closeAll(ctx);
      ctx.picked.clear();
      ctx.subscribed = false;
      ctx.lastSent = "";
    }
  }

  /** The screen locked (or unlocked): while locked, no reader access at all. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) for (const ctx of this.pages.values()) this.closeAll(ctx);
    else { for (const ctx of this.pages.values()) ctx.lastSent = ""; this.broadcast(); }
  }

  isLocked(): boolean { return this.locked; }

  /** The app quits. */
  shutdown(): void {
    for (const id of [...this.pages.keys()]) this.releasePage(id);
    try { this.backend?.stop(); } catch { /* ignore */ }
    this.backend = null;
    this.readers.clear();
  }

  /** Open connections (tests, the self-test). */
  openHandles(pageId?: number): number {
    let n = 0;
    for (const ctx of this.pages.values()) if (pageId === undefined || ctx.id === pageId) n += ctx.handles.size;
    return n;
  }

  /* ------------------------------------------------------------ self-test */

  /**
   * The packaged app's self-test (M5CET_SMOKE_PCSC=1): the readers, and for each
   * reader with a card its ATR and — on a contactless slot only — the reader's
   * GET UID (FF CA 00 00 00). Read-only; nothing else is sent to any card.
   */
  async selfTest(waitMs = 1500): Promise<{ ok: boolean; error?: string; readers: Array<PcscReader & { atr?: string; uid?: string; sw?: string; protocol?: string; error?: string }> }> {
    const step = (m: string) => this.host.log?.(`[pcsc self-test] ${m}`);
    step("start");
    const started = this.ensureStarted();
    step(started ? `unavailable: ${started.message}` : "started");
    if (started) return { ok: false, error: started.message, readers: [] };
    const until = this.now() + waitMs;
    while (this.readers.size === 0 && this.now() < until) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const out: Array<PcscReader & { atr?: string; uid?: string; sw?: string; protocol?: string; error?: string }> = [];
    for (const r of this.view()) {
      const row: PcscReader & { atr?: string; uid?: string; sw?: string; protocol?: string; error?: string } = { ...r };
      out.push(row);
      if (!r.card || !this.backend) continue;
      try {
        step(`connect ${r.name}`);
        const card = await withTimeout(this.backend.connect(r.name), this.limits.connectTimeoutMs);
        try {
          row.atr = hex(card.atr);
          row.protocol = card.protocol;
          if (slotOfReader(r.name, card.atr) === "contactless") {
            step("GET UID");
            const resp = await withTimeout(card.transmit(Uint8Array.of(0xff, 0xca, 0x00, 0x00, 0x00), PCSC_MAX_RESPONSE), 5000);
            row.sw = hex(resp.slice(-2));
            if (resp.length >= 2 && resp[resp.length - 2] === 0x90 && resp[resp.length - 1] === 0x00) row.uid = hex(resp.slice(0, -2));
          }
        } finally {
          step("disconnect");
          await withTimeout(card.disconnect(), 5000).catch(() => undefined);
        }
      } catch (err) {
        row.error = `${pcscErrorCode(err)}: ${String((err as Error)?.message ?? err)}`;
      }
    }
    step(`done (${out.length} readers)`);
    return { ok: true, readers: out };
  }
}

/** Uint8Array (or a plain byte array / ArrayBuffer from IPC) → a copy, or null. */
function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  if (Array.isArray(v) && v.length <= PCSC_MAX_APDU + 1 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return Uint8Array.from(v as number[]);
  return null;
}
