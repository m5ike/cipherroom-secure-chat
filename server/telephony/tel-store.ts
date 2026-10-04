// The m5.telephony records (6.0): every call and message a function placed,
// the temporary numbers (DID sessions) of the audio bridge, and the log of
// what happened to them — in $DATA_DIR/telephony.db (TELEPHONY_DB_FILE moves
// it). The main service (where the providers' webhooks land) and the admin
// service (the console's test runs, which may wait for a call) both open it:
// SQLite in WAL mode is the channel between them. Without the SQLite driver
// the records live in memory (one process, until a restart).

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSqliteDriver, type SqliteDatabase } from "../storage/db";
import { DocTable } from "../storage/doc-table";
import type { CallAction, CallStatus, ProviderId } from "./providers/types";
import type { Caller } from "../functions/types";
import type { TelLogEntry as TelEventLogEntry } from "./control/types";

export const telId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
/** A webhook capability: 192 random bits (the URL is the secret, the provider's signature the proof). */
export const telToken = (): string => randomBytes(24).toString("base64url");

export function telDbPath(): string {
  const explicit = process.env.TELEPHONY_DB_FILE?.trim();
  if (explicit) return resolve(explicit);
  const dir = process.env.DATA_DIR?.trim();
  return dir ? resolve(dir, "telephony.db") : resolve(process.cwd(), ".m5cet", "telephony.db");
}

/** Who placed a call or a message: the model (its handlers run later), the run, the caller. */
export type TelOwner = {
  modelId: string;
  /** "package@version:file" — a handler "fn" runs as `${entry}#fn` (or "file#fn" → that file). */
  entry: string;
  chainId: string;
  runId: string;
  caller: Caller;
  test: boolean;
};

/** The call events a function can react to. */
export const HANDLER_EVENTS = ["answer", "hangup", "busy", "noanswer", "failed", "machine", "digits", "status"] as const;
export type HandlerEvent = typeof HANDLER_EVENTS[number];

export type TelCallEvent = {
  seq: number; at: number; kind: string; status: CallStatus | null;
  digits?: string; cause?: string; sipCode?: string; durationSec?: number; note?: string;
};

export type TelCall = {
  id: string;
  /** The capability in this call's webhook URLs (/wh/tel/<token>/…). */
  token: string;
  provider: ProviderId;
  providerCallId: string;
  direction: "outbound" | "inbound";
  from: string;
  to: string;
  status: CallStatus;
  /** async: handlers run later; sync: the run that placed it waits (and may steer it); native: provider logic as given. */
  mode: "async" | "sync" | "native";
  /** What to do when answered (when no handler says otherwise). */
  actions: CallAction[];
  handlers: Partial<Record<HandlerEvent, string>>;
  owner: TelOwner | null;
  /** Telnyx Call Control: actions still to run, and the event that resumes them. */
  pending: CallAction[];
  waitFor: string | null;
  /** A gather's handler (digits), by the gather's name. */
  gatherFn: string;
  events: TelCallEvent[];
  seq: number;
  timeoutSec: number;
  timeLimitSec: number;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  durationSec: number | null;
  /** The audio bridge session this call belongs to (an inbound call to a temporary number). */
  bridge: string;
  error: string;
  /** Steering from a waiting run (sync mode): the latest actions it asked for. */
  steer: { seq: number; actions: CallAction[] } | null;
  /** 6.9: the call runs a TSA (Telephony & SIP Application) — its session and, for Telnyx, where it is. */
  tsa?: TelTsaState;
};

/**
 * 6.9: a call that runs a TSA (control/calls.ts). Twilio and Vonage ask for
 * each turn's logic at the TSA's callback URLs; Telnyx (asynchronous call
 * control) is driven from here: the actions still to run and the event the
 * call waits for.
 */
export type TelTsaState = {
  /** The TSA, and what chose it (the inbound / outbound rule, or the console). */
  id: string;
  rule: string;
  /** The number the routing saw (the DID called; a test SIP address's test DID). */
  did: string;
  service: "app" | "sip";
  /** The runtime's session ("" until started). */
  session: string;
  status: "pending" | "running" | "ended";
  /** Telnyx: what is left of the current turn, and what the call waits for. */
  queue: CallAction[];
  wait: TelTsaWait | null;
  /** A dial (transfer) in progress: its other leg. */
  dial: { leg: string; answeredAt: number | null; durationSec?: number } | null;
};

export type TelTsaWait = {
  /** The provider event that ends the wait (call.speak.ended, call.gather.ended…). */
  event: string;
  /** The TSA callback URL of the waiting action (its s / n / e say where to resume). */
  url: string;
  kind: "continue" | "digits" | "speech" | "recording" | "dial" | "stream";
  finishOnKey?: string;
  input?: Array<"dtmf" | "speech">;
  /** A speech gather: the words heard so far; a recording: the key that ended it. */
  heard?: string;
  key?: string;
};

export type TelMessage = {
  id: string;
  token: string;
  provider: ProviderId;
  providerId: string;
  channel: "sms" | "whatsapp" | "viber" | "messenger";
  from: string;
  to: string;
  status: string;
  owner: TelOwner | null;
  /** A handler for status changes ("fn" in the owner's file). */
  onStatus: string;
  events: Array<{ at: number; status: string; error?: string }>;
  createdAt: number;
  updatedAt: number;
  parts: number | null;
  price: string;
};

export type BridgeStatus = "waiting" | "ringing" | "verifying" | "connected" | "ended" | "expired" | "released";
export type BridgeAttempt = { at: number; from: string; ok: boolean; digits: string; callId: string };

/** A temporary number (DID) with its access code, routed to one member of a room. */
export type BridgeSession = {
  id: string;
  /** The capability of the member's audio / reply channel (/media/tel/client/<clientToken>). */
  clientToken: string;
  /** The capability of the provider's media stream (/media/tel/<mediaToken>). */
  mediaToken: string;
  number: string;
  provider: ProviderId;
  /** 5 digits, typed by the caller followed by #. */
  code: string;
  /** The room (its hash) and the member the call is for. */
  roomHash: string;
  member: { peerId?: string; accountId?: string; name?: string };
  label: string;
  /** auto: audio when the member takes it, else speech ↔ text; audio; text. */
  mode: "auto" | "audio" | "text";
  language: string;
  voice: string;
  status: BridgeStatus;
  createdAt: number;
  expiresAt: number;
  connectedAt: number | null;
  endedAt: number | null;
  maxCallSec: number;
  attempts: BridgeAttempt[];
  callId: string;
  caller: string;
  owner: TelOwner | null;
  /** How the member took it: audio (their browser plays and speaks) or text (speech ↔ text). */
  channel: "" | "audio" | "text";
  stats: { heardSegments: number; spokenReplies: number; audioInSec: number; audioOutSec: number };
  /** The number was bought for this session (released when it ends). */
  bought: boolean;
  numberId: string;
};

export type TelLogEntry = {
  id: string; at: number; kind: string; level: "info" | "notice" | "warn" | "error";
  ref: string; provider: string; summary: string; detail: Record<string, unknown>;
};

class TelStore {
  private db: SqliteDatabase | null = null;
  private opening: Promise<void> | null = null;
  private reason = "";

  readonly calls = new DocTable<TelCall>("calls", () => this.db, (v) => v.createdAt, (v) => v.token);
  readonly messages = new DocTable<TelMessage>("messages", () => this.db, (v) => v.createdAt, (v) => v.token);
  readonly bridges = new DocTable<BridgeSession>("bridges", () => this.db, (v) => v.createdAt, (v) => v.number);
  readonly log = new DocTable<TelLogEntry>("log", () => this.db, (v) => v.at, (v) => v.ref);
  /** 6.9: the module's event log (Telephony › Log; control/log.ts) — filtered by call. */
  readonly events = new DocTable<TelEventLogEntry>("tel_log", () => this.db, (v) => v.at, (v) => v.callId);

  private mirror: ((e: TelLogEntry) => void) | null = null;
  /** 6.9: every record() line is also written to the event log (control/log.ts sets this). */
  setRecordMirror(fn: ((e: TelLogEntry) => void) | null): void { this.mirror = fn; }

  ready(): Promise<void> {
    if (this.db) return Promise.resolve();
    this.opening ??= (async () => {
      const Driver = await loadSqliteDriver();
      if (!Driver) { this.reason = "the SQLite driver is not installed — telephony records are kept in memory only"; return; }
      const file = telDbPath();
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
        try { chmodSync(file, 0o600); } catch { /* not ours */ }
        const db = new Driver(file, { timeout: 5000 });
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        for (const t of [this.calls, this.messages, this.bridges, this.log, this.events]) db.exec(t.schema());
        this.db = db;
        this.reason = "";
      } catch (err) {
        this.reason = `cannot open ${file}: ${(err as Error).message} — telephony records are kept in memory only`;
      }
    })();
    return this.opening;
  }

  status(): { persistent: boolean; file: string; reason: string } {
    return { persistent: Boolean(this.db), file: telDbPath(), reason: this.reason };
  }

  callByToken(token: string): TelCall | null { return this.calls.list({ device: token, limit: 1 })[0] ?? null; }
  messageByToken(token: string): TelMessage | null { return this.messages.list({ device: token, limit: 1 })[0] ?? null; }
  callByProviderId(provider: string, providerCallId: string): TelCall | null {
    if (!providerCallId) return null;
    return this.calls.list({ limit: 1, filter: (c) => c.provider === provider && c.providerCallId === providerCallId })[0] ?? null;
  }

  /** A line in the telephony log (the console shows it; functions read it with m5.telephony.log). */
  record(e: Omit<TelLogEntry, "id" | "at"> & { at?: number }): TelLogEntry {
    const entry: TelLogEntry = { id: telId("tl"), at: e.at ?? Date.now(), ...e, summary: e.summary.slice(0, 300) };
    this.log.put(entry);
    if (this.mirror) { try { this.mirror(entry); } catch { /* the log never breaks a call */ } }
    return entry;
  }

  /** Tests: forget the open database and the in-memory rows. */
  reset(): void {
    try { this.db?.close(); } catch { /* closed */ }
    this.db = null;
    this.opening = null;
    for (const t of [this.calls, this.messages, this.bridges, this.log, this.events]) t.clearMemory();
  }
}

export const telStore = new TelStore();
