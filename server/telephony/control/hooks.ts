// The seams between the parts of Telephony & SIP 6.9, so each can be built
// and tested on its own: a part REGISTERS what it provides when its module
// loads; the others CALL through these hooks and handle "not there" (a test
// without the part, an older process). Nothing here does I/O itself.
//
//   decide      control/rules.ts     the inbound / outbound rules → a RouteDecision
//   inroute     control/inroute.ts   the inroute table (route codes)
//   tsa         tsa/runtime.ts       start a TSA on a call, resume it with an event
//   routeAudio  bridge (media)       connect a call's audio to a room / a member by an inroute entry
//   log         control/log.ts       the module's event log (Telephony › Log)
//   permissions control/store.ts     the current TelPermissions

import type { CallAction } from "../providers/types";
import type { InrouteEntry, RouteDecision, RouteQuestion, TelLogEntry, TelPermissions } from "./types";
import { DEFAULT_PERMISSIONS } from "./types";
import type { TsaEvent, TsaSession } from "../tsa/types";

/** The call a TSA runs on, as the runtime needs it (tel-store's TelCall has more). */
export type TsaCallRef = {
  /** tel-store TelCall.id, or "sim:<id>" in the simulator. */
  id: string;
  /** The capability in the call's webhook URLs (/wh/tel/<token>/<kind>) — the runtime builds gather / record / dial action URLs from it. */
  token: string;
  provider: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  did: string;
};

/** A turn of a running TSA: the actions to give the provider now (rendered by its adapter). */
export type TsaTurn = { session: TsaSession; actions: CallAction[] };

export type RouteAudioResult =
  | { ok: true; detail: string; actions: CallAction[] }
  | { ok: false; reason: "code" | "failed"; detail: string };

export type TelHooks = {
  decide?: (q: RouteQuestion) => Promise<RouteDecision>;
  inroute?: {
    lookup(code: string): Promise<InrouteEntry | null>;
    /** Counts a use (and removes the entry when maxUses is reached). */
    used(code: string): Promise<void>;
    add(spec: { code?: string; digits?: number; type: InrouteEntry["type"]; room: string; user?: string; ttl?: number; label?: string; maxUses?: number; createdBy: InrouteEntry["createdBy"] }): Promise<InrouteEntry>;
    /** 6.10 (G-05): may this call try a code now — null, or why not (a lockout of the module or the DID, the caller over budget). */
    guard?(who: { caller: string; did: string }): Promise<string | null>;
    /** 6.10 (G-05): a wrong code — counted per caller, per DID and module-wide (a burst trips a lockout). */
    failure?(who: { caller: string; did: string }, detail: { code?: string; callId?: string; provider?: string }): Promise<void>;
  };
  tsa?: {
    start(call: TsaCallRef, tsaId: string, opts?: { draft?: boolean; vars?: Record<string, unknown> }): Promise<TsaTurn>;
    resume(sessionId: string, event: TsaEvent): Promise<TsaTurn>;
  };
  /** Route the call's audio by an inroute entry (route_audio): the actions that start the media stream, or why not. */
  routeAudio?: (call: TsaCallRef, entry: InrouteEntry, opts: { announce?: string; mode: "fail" | "text"; sessionId: string }) => Promise<RouteAudioResult>;
  log?: (e: Partial<TelLogEntry> & Pick<TelLogEntry, "kind" | "summary">) => void;
  permissions?: () => TelPermissions;
};

export const telHooks: TelHooks = {};

/** Writes to the module's log when the log part is there (else to the console, briefly). */
export function telLog(e: Partial<TelLogEntry> & Pick<TelLogEntry, "kind" | "summary">): void {
  if (telHooks.log) { try { telHooks.log(e); } catch { /* the log never breaks a call */ } return; }
  if (e.level === "error" || e.level === "warn") console.warn(`[telephony] ${e.kind}: ${e.summary}`);
}

export function telPermissions(): TelPermissions {
  return telHooks.permissions ? telHooks.permissions() : DEFAULT_PERMISSIONS;
}
