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
import { normalizeCommand, type CardFile, type EmvApp, type EmvData, type EmvTag, type MrtdData, type MrtdDocument, type MrtdFileInfo, type MrtdImage, type MrtdPersonal, type MrtdSecurity, type NfcCommand, type NfcResult, type NfcResultStatus } from "../../client/src/lib/nfc/command";
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
  if (r.emv && typeof r.emv === "object") out.emv = sanitizeEmv(r.emv as Record<string, unknown>);
  if (r.mrtd && typeof r.mrtd === "object") out.mrtd = sanitizeMrtd(r.mrtd as Record<string, unknown>);
  if (str(r.message)) out.message = str(r.message)!.slice(0, 500);
  return out;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const tagList = (v: unknown, max: number): EmvTag[] => (Array.isArray(v) ? v.slice(0, max).map((tg) => { const y = (tg && typeof tg === "object" ? tg : {}) as Record<string, unknown>; return { tag: strReq(y.tag).slice(0, 8), name: strReq(y.name).slice(0, 80), value: strReq(y.value).slice(0, 256), hex: strReq(y.hex).slice(0, 512) }; }) : []);
/** A string record (a log entry, a personal detail): keys and values bounded. */
function strRecord(v: unknown, maxKeys: number, maxLen: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, maxKeys)) if (/^[A-Za-z0-9_]{1,24}$/.test(k) && typeof x === "string") out[k] = x.slice(0, maxLen);
  return out;
}
const strList = (v: unknown, max: number, len: number): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, len)) : undefined);
const fileName = (v: unknown) => strReq(v).replace(/[^\w.+-]/g, "_").slice(0, 80) || "file.bin";

/** 6.5: EMV read data — holder / public fields only, bounded (6.6: the history, the records, GET DATA). */
function sanitizeEmv(r: Record<string, unknown>): EmvData {
  const apps = Array.isArray(r.apps) ? r.apps.slice(0, 16).map((a) => {
    const x = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const app: EmvApp = { aid: strReq(x.aid).slice(0, 32).toUpperCase(), tags: tagList(x.tags, 256) };
    for (const k of ["label", "scheme", "pan", "panMasked", "expiry", "cardholder", "effective", "issuerCountry", "panSequence", "aip", "afl"] as const) if (str(x[k])) (app as Record<string, unknown>)[k] = str(x[k])!.slice(0, 64);
    if (str(x.logFormat)) app.logFormat = str(x.logFormat)!.slice(0, 128);
    for (const k of ["atc", "pinTryCounter", "lastOnlineAtc", "logSfi"] as const) { const n = num(x[k]); if (n !== undefined) app[k] = n; }
    if (Array.isArray(x.log)) app.log = x.log.slice(0, 60).map((e) => strRecord(e, 24, 256));
    if (Array.isArray(x.getData)) app.getData = tagList(x.getData, 32);
    if (Array.isArray(x.records)) app.records = x.records.slice(0, 320).map((rec) => { const y = (rec && typeof rec === "object" ? rec : {}) as Record<string, unknown>; return { sfi: num(y.sfi) ?? 0, record: num(y.record) ?? 0, hex: strReq(y.hex).replace(/[^0-9A-Fa-f]/g, "").slice(0, 1024), ...(y.log === true ? { log: true } : {}) }; });
    return app;
  }) : [];
  const out: EmvData = { aids: Array.isArray(r.aids) ? r.aids.filter((a): a is string => typeof a === "string").slice(0, 16).map((a) => a.toUpperCase().slice(0, 32)) : [], apps };
  if (str(r.scheme)) out.scheme = str(r.scheme)!.slice(0, 40);
  if (str(r.tree)) out.tree = str(r.tree)!.slice(0, 4000);
  if (typeof r.deep === "boolean") out.deep = r.deep;
  const apdus = num(r.apdus); if (apdus !== undefined) out.apdus = apdus;
  return out;
}

/** The pictures and files a document may hand over, by count and size (base64 only). */
const IMAGE_BUDGET = 1_400_000;
const RAW_BUDGET = 1_200_000;

/** 6.5: MRTD read data — the holder's own document, bounded; photo capped (6.6: every group, the pictures, the security objects). */
function sanitizeMrtd(r: Record<string, unknown>): MrtdData {
  const access = r.access === "bac" || r.access === "pace" ? r.access : "none";
  const out: MrtdData = { present: Boolean(r.present), access };
  if (r.pace && typeof r.pace === "object") {
    const p = r.pace as Record<string, unknown>;
    out.pace = { supported: p.supported === true, ...(str(p.protocol) ? { protocol: str(p.protocol)!.slice(0, 60) } : {}), ...(num(p.parameterId) !== undefined ? { parameterId: num(p.parameterId) } : {}), ...(p.used === true ? { used: true } : {}), ...(p.password === "mrz" || p.password === "can" ? { password: p.password } : {}) };
  }
  if (Array.isArray(r.dataGroups)) out.dataGroups = r.dataGroups.filter((x): x is string => typeof x === "string").slice(0, 20);
  if (str(r.ldsVersion)) out.ldsVersion = str(r.ldsVersion)!.slice(0, 12);
  if (str(r.unicodeVersion)) out.unicodeVersion = str(r.unicodeVersion)!.slice(0, 12);
  if (r.mrzInfo && typeof r.mrzInfo === "object") {
    const m = r.mrzInfo as Record<string, unknown>;
    out.mrzInfo = {};
    for (const k of ["documentCode", "documentNumber", "issuer", "nationality", "surname", "givenNames", "dateOfBirth", "sex", "dateOfExpiry", "optionalData", "mrz"] as const) if (str(m[k])) out.mrzInfo[k] = str(m[k])!.slice(0, 120);
  }
  if (r.personal && typeof r.personal === "object") {
    const p = r.personal as Record<string, unknown>;
    const pers: MrtdPersonal = {};
    for (const k of ["fullName", "personalNumber", "fullDateOfBirth", "placeOfBirth", "address", "telephone", "profession", "title", "personalSummary", "custody"] as const) if (str(p[k])) pers[k] = str(p[k])!.slice(0, 500);
    const on = strList(p.otherNames, 16, 200); if (on?.length) pers.otherNames = on;
    const td = strList(p.otherTravelDocuments, 16, 60); if (td?.length) pers.otherTravelDocuments = td;
    if (Object.keys(pers).length) out.personal = pers;
  }
  if (r.document && typeof r.document === "object") {
    const d = r.document as Record<string, unknown>;
    const doc: MrtdDocument = {};
    for (const k of ["issuingAuthority", "dateOfIssue", "endorsements", "taxExit", "personalizationTime", "personalizationDevice"] as const) if (str(d[k])) doc[k] = str(d[k])!.slice(0, 500);
    const op = strList(d.otherPersons, 16, 200); if (op?.length) doc.otherPersons = op;
    if (Object.keys(doc).length) out.document = doc;
  }
  if (str(r.optional)) out.optional = str(r.optional)!.slice(0, 4000);
  const notify = strList(r.personsToNotify, 16, 500); if (notify?.length) out.personsToNotify = notify;
  if (str(r.photo) && str(r.photoMime)) { const b64 = str(r.photo)!; if (b64.length <= 400_000 && B64.test(b64)) { out.photo = b64; out.photoMime = str(r.photoMime)!.slice(0, 40); } }
  if (Array.isArray(r.images)) {
    let used = 0;
    const imgs: MrtdImage[] = [];
    for (const im of r.images.slice(0, 12)) {
      const x = (im && typeof im === "object" ? im : {}) as Record<string, unknown>;
      const data = strReq(x.data), mime = strReq(x.mime);
      if (!data || data.length > 400_000 || !B64.test(data) || !/^image\/(jpeg|jp2|png|gif|webp)$/.test(mime) || used + data.length > IMAGE_BUDGET) continue;
      used += data.length;
      const kind = ["face", "portrait", "signature", "document", "other"].includes(strReq(x.kind)) ? strReq(x.kind) as MrtdImage["kind"] : "other";
      imgs.push({ group: strReq(x.group).slice(0, 8), kind, mime, data, name: fileName(x.name) });
    }
    if (imgs.length) out.images = imgs;
  }
  if (Array.isArray(r.files)) out.files = r.files.slice(0, 32).map((f) => {
    const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const status = ["read", "protected", "absent", "error"].includes(strReq(x.status)) ? strReq(x.status) as MrtdFileInfo["status"] : "error";
    return { name: strReq(x.name).slice(0, 16), fid: strReq(x.fid).slice(0, 8), status, ...(num(x.size) !== undefined ? { size: num(x.size) } : {}), ...(typeof x.hashOk === "boolean" ? { hashOk: x.hashOk } : {}), ...(str(x.message) ? { message: str(x.message)!.slice(0, 200) } : {}) };
  });
  if (Array.isArray(r.raw)) {
    let used = 0;
    const raw: CardFile[] = [];
    for (const f of r.raw.slice(0, 32)) {
      const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      const data = strReq(x.data);
      if (!data || data.length > 400_000 || !B64.test(data) || used + data.length > RAW_BUDGET) continue;
      used += data.length;
      raw.push({ name: fileName(x.name), mime: /^[\w.+-]+\/[\w.+-]+$/.test(strReq(x.mime)) ? strReq(x.mime) : "application/octet-stream", data });
    }
    if (raw.length) out.raw = raw;
  }
  if (r.security && typeof r.security === "object") {
    const sec = r.security as Record<string, unknown>;
    const s: MrtdSecurity = {};
    if (str(sec.hashAlgorithm)) s.hashAlgorithm = str(sec.hashAlgorithm)!.slice(0, 20);
    if (sec.passive === "ok" || sec.passive === "mismatch" || sec.passive === "unchecked") s.passive = sec.passive;
    if (sec.signer && typeof sec.signer === "object") { const g = strRecord(sec.signer, 5, 300); const signer: NonNullable<MrtdSecurity["signer"]> = {}; for (const k of ["subject", "issuer", "serial", "notBefore", "notAfter"] as const) if (g[k]) signer[k] = g[k]; if (Object.keys(signer).length) s.signer = signer; }
    const pr = strList(sec.protocols, 24, 80); if (pr?.length) s.protocols = pr;
    if (str(sec.activeAuthKey)) s.activeAuthKey = str(sec.activeAuthKey)!.slice(0, 80);
    if (Object.keys(s).length) out.security = s;
  }
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
