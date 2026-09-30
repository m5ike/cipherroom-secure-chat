// m5.nfc for functions (6.3), host-side: who may drive the caller's NFC
// hardware, and the safe shape of the command that goes to the device and the
// result that comes back. The op itself runs on the DEVICE — the runner turns
// an m5.nfc call into an "nfc" run interaction (runner.ts), the caller's NFC
// bridge (client or Android) executes it and answers with an NfcResult. This
// module only decides access and keeps keys off the wire.
//
// Who may (exactly as m5.telephony):
//   a person's run (chat, the console)  their own NFC module access
//   a run nobody started (a webhook, a schedule, the API)  the model's grant
//        (Functions › model › Beyond the caller: give it NFC)
//
// The no-raw-key guarantee: a model never hands the device a card key or PIN
// and never receives one. To use a protected card it names a secret the DEVICE
// holds (command.secretRef); the executor resolves it locally. So the command
// that leaves here carries no key/PIN in its args, and the result that returns
// is whitelisted to public fields — a buggy or hostile executor cannot leak a
// key back to the model.

import { checkAccess, adminSubject, userSubject, type Subject } from "../access";
import { accountStore, usernameOf } from "../accounts/store";
import { clientConfigStore } from "../client-config";
import { normalizeCommand, type NfcCommand, type NfcResult, type NfcResultStatus } from "../../client/src/lib/nfc/command";
import type { NfcTech } from "../../client/src/lib/nfc/catalog";
import type { M5RecordType } from "../../client/src/lib/nfc/m5card";
import type { Caller, Model } from "./types";

export class NfcCallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "NfcCallError"; }
}

export type NfcContext = { model: Model; caller: Caller; runId: string };

/* ---------------------------------------------------------------- access */

const PERSONS = new Set(["console", "user", "guest"]);

function subjectOf(caller: Caller): Subject {
  if (caller.kind === "console") return adminSubject(caller.name, caller.adminRole ?? "operator");
  if (caller.kind === "user" && caller.account) {
    const acc = accountStore.get(caller.account);
    return userSubject(acc ? usernameOf(acc) : null);
  }
  return userSubject(null);
}

/** May this run drive the caller's NFC hardware? Throws with the reason when not. */
export function nfcAllowed(ctx: NfcContext): void {
  const rule = clientConfigStore.get().modules.nfc;
  if (rule && rule.enabled === false) throw new NfcCallError("module-disabled", "the NFC module is switched off (Modules & groups)");
  if (PERSONS.has(ctx.caller.kind)) {
    const c = checkAccess("nfc", subjectOf(ctx.caller), { path: "m5.nfc", via: "function" });
    if (!c.allowed) throw new NfcCallError("nfc-denied", `NFC is not available to ${ctx.caller.name || "the caller"} on this server (Modules & groups)`);
    return;
  }
  // A run nobody started (a webhook, a schedule, the API): the model's grant.
  const g = ctx.model.grants?.nfc;
  if (!g?.enabled) throw new NfcCallError("nfc-denied", `this model may not use NFC on its own (a ${ctx.caller.kind} run): give it NFC in Functions › model › Beyond the caller`);
}

/* ---------------------------------------------------- keys never cross */

/**
 * Argument names that would be a raw card key or PIN — a model must never send
 * one: a protected card is used via command.secretRef, resolved on the device.
 * (Record payloads a model builds — a Wi-Fi password, a URL login — are content,
 * not card credentials, and live in args.records, which is left untouched.)
 */
const SECRET_ARG_RE = /^(key|keys|key_?a|key_?b|pin|pins|pwd|pack|password|passphrase|secret|apikey|api_?key)$/i;

/** Drops any raw-key / PIN argument at the top level of args (secretRef stays). */
function stripSecretArgs(args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!SECRET_ARG_RE.test(k)) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

/** The op ids a model may ask for reach at most this many; a wild op is refused. */
const MAX_TIMEOUT = 120;

/** Normalises what the model asked and guarantees no raw key/PIN leaves here. */
export function sanitizeNfcCommand(raw: unknown): NfcCommand {
  const cmd = normalizeCommand(raw);
  if (!cmd) throw new NfcCallError("bad-argument", "an NFC command needs an op (a catalogue op id, e.g. scan, read-uid, ndef-read, m5-read)");
  const args = stripSecretArgs(cmd.args);
  const out: NfcCommand = { op: cmd.op };
  if (cmd.reader) out.reader = cmd.reader;
  if (cmd.tech) out.tech = cmd.tech;
  if (cmd.timeout) out.timeout = Math.min(MAX_TIMEOUT, cmd.timeout);
  if (args) out.args = args;
  if (cmd.secretRef) out.secretRef = cmd.secretRef;
  if (cmd.records && cmd.records.length) out.records = cmd.records;
  return out;
}

/* --------------------------------------------------- results stay public */

const RESULT_STATUS = new Set<NfcResultStatus>(["ok", "no-card", "timeout", "unsupported", "denied", "auth-failed", "error"]);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strReq = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Whitelists the device's answer to the public NfcResult shape — the executor
 * never returns a key, so any field outside this shape is dropped, keeping that
 * promise even if an executor misbehaves.
 */
export function sanitizeNfcResult(raw: unknown): NfcResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = RESULT_STATUS.has(r.status as NfcResultStatus) ? (r.status as NfcResultStatus) : "error";
  const out: NfcResult = { status };
  const card = r.card && typeof r.card === "object" ? r.card as Record<string, unknown> : null;
  if (card) out.card = { uid: strReq(card.uid), tech: (str(card.tech) as NfcTech) || "unknown", label: strReq(card.label), ...(str(card.atqa) ? { atqa: str(card.atqa) } : {}), ...(str(card.sak) ? { sak: str(card.sak) } : {}), ...(str(card.ats) ? { ats: str(card.ats) } : {}), ...(str(card.atr) ? { atr: str(card.atr) } : {}), ...(str(card.memory) ? { memory: str(card.memory) } : {}) };
  if (Array.isArray(r.ndef)) out.ndef = r.ndef.slice(0, 64).map((n) => { const x = (n && typeof n === "object" ? n : {}) as Record<string, unknown>; return { kind: strReq(x.kind), ...(str(x.type) ? { type: str(x.type) } : {}), ...(str(x.text) ? { text: str(x.text) } : {}), ...(str(x.lang) ? { lang: str(x.lang) } : {}), ...(str(x.data) ? { data: str(x.data) } : {}) }; });
  if (str(r.data)) out.data = str(r.data);
  if (Array.isArray(r.records)) out.records = r.records.slice(0, 64).map((rec) => { const x = (rec && typeof rec === "object" ? rec : {}) as Record<string, unknown>; return { id: Number(x.id) || 0, type: str(x.type) as M5RecordType, oneTime: Boolean(x.oneTime), summary: strReq(x.summary) }; });
  if (str(r.message)) out.message = str(r.message)!.slice(0, 500);
  return out;
}

/* ------------------------------------------------------------ rate limit */

const RATE = () => Math.max(1, Number(process.env.NFC_FN_RATE) || 60);
const counts = new Map<string, { minute: number; n: number }>();
/** Counts a model's NFC commands so a loop cannot spam the caller's device. */
export function nfcSpend(ctx: NfcContext): void {
  const key = ctx.model.id && ctx.model.id !== "__adhoc__" ? ctx.model.id : `console:${ctx.caller.name}`;
  const minute = Math.floor(Date.now() / 60_000);
  const c = counts.get(key);
  const next = c && c.minute === minute ? { minute, n: c.n + 1 } : { minute, n: 1 };
  if (next.n > RATE()) throw new NfcCallError("nfc-limit", `at most ${RATE()} NFC commands a minute for one model (NFC_FN_RATE)`);
  counts.set(key, next);
  if (counts.size > 5_000) counts.delete(counts.keys().next().value!);
}
