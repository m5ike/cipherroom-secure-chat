// The APDU template runner (6.10) — runs ONE template of
// m5mobile.define.apduTemplates (apdu-templates.ts, the contract) from its
// first step to its last over ISO-DEP, and records every command and response.
//
// Fixed commands ({ apdu }) are sent as written; 61xx (GET RESPONSE) and 6Cxx
// (wrong Le, sent again) are followed up and every APDU of that dance is
// recorded. A step's `expect` lists the status words that count as success
// ("9000" by default, "xx" a wildcard byte).
//
// Reader operations ({ op }) are the EMV reader's own steps (cards/emv.ts —
// readEmv() is built from the same functions) and the e-ID reader
// (cards/mrtd.ts): what they send depends on what the card answered before —
// the directory's AIDs, the PDOL a GET PROCESSING OPTIONS fills, the AFL the
// records follow. The e-ID read opens the chip with the holder's key, asked
// through `askEidKey` (the workbench's MRZ / CAN form; m5.nfc: the model's
// args); its commands are recorded as they go to the card — under secure
// messaging, protected (encrypted and MACed), labelled with what was being
// read (EF.COM, DG1 …).
//
// When a step fails:
//   • an `optional` step is a warning and the run goes on;
//   • a failed SELECT (select-ppse / select-pse / select-aid) or fixed command
//     ends the run — inside for-each-aid it ends that application, the loop
//     goes on with the next one;
//   • a refused GET PROCESSING OPTIONS is an error but the read goes on (the
//     files can still be read); get-data, read-log, read-afl and read-files
//     only gather — what the card does not have is no error;
//   • an e-ID read that cannot open the document (no key, a wrong key) fails.
// Every problem is said in `problems`; `ok` is true when there is none.
//
// The run is READ-ONLY (G-18): templateProblems() refuses a template with a
// command that is not a read (apdu-templates.ts READ_ONLY_COMMANDS — no VERIFY,
// no GENERATE AC, no INTERNAL AUTHENTICATE, no UPDATE / WRITE / PUT DATA…), a
// fixed command is checked again before it is sent, and every APDU — the
// readers' own included — passes the same list on its way to the card (the
// e-ID secure channel's GET CHALLENGE, EXTERNAL / GENERAL AUTHENTICATE, MSE and
// the odd READ BINARY are allowed only inside eid-read). A refused command is
// never sent; a command the card did not answer is recorded as "(no answer)".

import type { CardTransport } from "./transport";
import { NfcError } from "./errors";
import { asciiOf, describeSw, hex, isOk, splitResponse, swHex, transmitSmart, unhex, type Response } from "./cards/apdu";
import {
  appGetData, appGpo, appReadAfl, appReadFiles, appReadLog, finishApp, probeAids, readEmv, selectAid, selectPpse, selectPse, startApp,
  type EmvAppState, type EmvSender,
} from "./cards/emv";
import { readMrtd } from "./cards/mrtd";
import { emvTagInfo, schemeForAid } from "./emv-tags";
import { readOnlyRefusal, templateProblems, templateSteps, type ApduTemplate, type TemplateExchange, type TemplateStep } from "./apdu-templates";
import type { EmvApp, EmvData, MrtdData } from "./command";

/* ------------------------------------------------------------------ types */

/** Where a run is: step n of m (the template's own steps), what it does now, how many APDUs so far. */
export type TemplateProgress = { step: number; total: number; label: string; op: string; exchanges: number };

/** The holder's key for an e-ID step: the MRZ (or its three fields) or the CAN printed on the card. */
export type EidKey = { mrz?: string; key?: { documentNumber: string; dateOfBirth: string; dateOfExpiry: string }; can?: string };

export type RunTemplateOptions = {
  /** Each step as it starts (the progress line). */
  onStep?: (p: TemplateProgress) => void;
  /** Each APDU as it is answered (a live transcript). */
  onExchange?: (e: TemplateExchange) => void;
  /** An e-ID step asks the holder's key; null (or no asker) = not given, the step fails without reading. */
  askEidKey?: (args: { readPhoto?: boolean; all?: boolean }) => Promise<EidKey | null>;
  /** Cancels between two APDUs. */
  signal?: AbortSignal;
  /** The clock (tests). */
  now?: () => number;
};

/** One fixed command's answer, decoded for the readable report (a DESFire, a plain ISO 7816 card). */
export type GenericItem = {
  step: number;
  label: string;
  command: string;
  /** The answer's data (hex) after GET RESPONSE, without the status word. */
  response: string;
  sw: string;
  status: TemplateExchange["status"];
};

/** MIFARE DESFire facts from GetVersion (3 frames), GetApplicationIDs, GetFreeMemory, GetKeySettings. */
export type DesfireInfo = {
  hardware?: DesfirePart;
  software?: DesfirePart;
  uid?: string;
  batch?: string;
  /** Production week (1–53) and year, from the last GetVersion frame (BCD). */
  week?: number;
  year?: number;
  /** Application ids (3 bytes each, shown most significant byte first). */
  applications?: string[];
  /** Free memory, bytes. */
  freeMemory?: number;
  keySettings?: { raw: string; masterKeyChangeable: boolean; freeDirectoryList: boolean; freeCreateDelete: boolean; configurationChangeable: boolean; maxKeys: number; crypto?: string };
};
export type DesfirePart = { vendor: string; type: string; subtype: number; version: string; storage: string; storageBytes: number; protocol: string; raw: string };

export type GenericData = { items: GenericItem[]; desfire?: DesfireInfo };

export type TemplateRun = {
  label: string;
  card?: ApduTemplate["card"];
  note?: string;
  /** No problem: every required step did what it should. */
  ok: boolean;
  cancelled?: boolean;
  /** Every APDU sent, in order — what the io / raw / json views show. */
  exchanges: TemplateExchange[];
  /** What the steps read: the EMV applications, the e-ID document, the fixed commands' answers. */
  data: { emv?: EmvData; mrtd?: MrtdData; generic: GenericData };
  problems: string[];
  startedAt: number;
  ms: number;
};

/* ------------------------------------------------------------- commands */

const DESFIRE_INS: Record<number, string> = {
  0x60: "GetVersion", 0xaf: "Additional frame", 0x6a: "GetApplicationIDs", 0x6e: "GetFreeMemory", 0x45: "GetKeySettings", 0x5a: "SelectApplication",
  0x6f: "GetFileIDs", 0xf5: "GetFileSettings", 0xbd: "ReadData", 0x6c: "GetValue", 0xbb: "ReadRecords", 0x64: "GetKeyVersion", 0x51: "GetCardUID",
  0x0a: "Authenticate", 0x1a: "AuthenticateISO", 0xaa: "AuthenticateAES", 0x6d: "GetDFNames", 0x61: "GetISOFileIDs",
};
const ISO_INS: Record<number, string> = {
  0xa4: "SELECT", 0xb0: "READ BINARY", 0xb1: "READ BINARY", 0xb2: "READ RECORD", 0xc0: "GET RESPONSE", 0xca: "GET DATA", 0xcb: "GET DATA",
  0x84: "GET CHALLENGE", 0x82: "EXTERNAL / MUTUAL AUTHENTICATE", 0x88: "INTERNAL AUTHENTICATE", 0x22: "MANAGE SECURITY ENVIRONMENT",
  0x86: "GENERAL AUTHENTICATE", 0x87: "GENERAL AUTHENTICATE", 0x20: "VERIFY", 0x24: "CHANGE REFERENCE DATA", 0x2c: "RESET RETRY COUNTER",
  0xd6: "UPDATE BINARY", 0xdc: "UPDATE RECORD", 0xe2: "APPEND RECORD", 0x70: "MANAGE CHANNEL",
};

/** A command in words: "SELECT 2PAY.SYS.DDF01", "READ RECORD 1 (SFI 2)", "GET DATA 9F36 (Application transaction counter)", "GetVersion (DESFire)". */
export function describeCommand(cmdHex: string | Uint8Array): string {
  let c: Uint8Array;
  try { c = typeof cmdHex === "string" ? unhex(cmdHex) : cmdHex; } catch { return "?"; }
  if (c.length < 4) return "?";
  const [cla, ins, p1, p2] = c;
  if (cla === 0x90) return `${DESFIRE_INS[ins] ?? `INS ${hex([ins])}`} (DESFire)`;
  const sm = (cla & 0x0c) === 0x0c && cla !== 0xff;
  const tail = sm ? " (secure messaging)" : "";
  const lc = c.length > 5 ? c[4] : 0;
  const body = c.length > 5 ? c.slice(5, 5 + lc) : new Uint8Array(0);
  if (cla === 0x80 && ins === 0xa8) return "GET PROCESSING OPTIONS";
  if (cla === 0x80 && ins === 0xca) { const tag = hex([p1, p2]).replace(/^00/, ""); return `GET DATA ${tag} (${emvTagInfo(tag).name})`; }
  if (cla === 0x80 && ins === 0xae) return "GENERATE AC";
  const name = ISO_INS[ins] ?? `INS ${hex([ins])}`;
  if (ins === 0xa4 && !sm) {
    if (p1 === 0x04) {
      const printable = body.length > 0 && body.every((b) => b >= 0x20 && b < 0x7f);
      return `SELECT ${printable ? asciiOf(body) : hex(body)}`;
    }
    if (body.length === 2) return `SELECT FILE ${hex(body)}`;
    if (p1 === 0x00 && body.length === 0) return "SELECT MF";
  }
  if (ins === 0xb2 && (p2 & 0x07) === 0x04) return `READ RECORD ${p1}${p2 >> 3 ? ` (SFI ${p2 >> 3})` : ""}${tail}`;
  if (ins === 0xb0 && !sm) return `READ BINARY ${p1 & 0x80 ? `SFI ${p1 & 0x1f}` : `offset ${(p1 << 8) | p2}`}`;
  if (ins === 0xc0) return "GET RESPONSE";
  return `${name}${tail}`;
}

/** A status word against a list of expected ones ("9000", "91AF", "61xx" — x is any digit). */
export function swMatches(sw: string, expect: string[]): boolean {
  const s = sw.toUpperCase();
  return expect.some((e) => {
    const p = String(e).toUpperCase().replace(/\s/g, "");
    return p.length === 4 && [...p].every((ch, i) => ch === "X" || ch === s[i]);
  });
}

/* --------------------------------------------------------------- DESFire */

const DESFIRE_TYPE: Record<number, string> = { 0x01: "MIFARE DESFire", 0x02: "MIFARE Plus", 0x03: "MIFARE Ultralight", 0x04: "NTAG", 0x08: "MIFARE DESFire Light" };
const DESFIRE_MAJOR: Record<number, string> = { 0x00: "D40", 0x01: "EV1", 0x12: "EV2", 0x22: "EV2 XL", 0x30: "EV3", 0x33: "EV3" };

function storageText(b: number): { text: string; bytes: number } {
  const n = b >> 1;
  const bytes = 2 ** n;
  const size = (x: number) => (x >= 1024 ? `${x / 1024} KB` : `${x} B`);
  return { text: b & 1 ? `between ${size(bytes)} and ${size(bytes * 2)}` : size(bytes), bytes };
}

function desfirePart(b: Uint8Array): DesfirePart | undefined {
  if (b.length < 7) return undefined;
  const st = storageText(b[5]);
  const type = DESFIRE_TYPE[b[1]] ?? `type ${hex([b[1]])}`;
  const major = b[1] === 0x01 || b[1] === 0x08 ? DESFIRE_MAJOR[b[3]] : undefined;
  return {
    vendor: b[0] === 0x04 ? "NXP Semiconductors" : `vendor ${hex([b[0]])}`,
    type, subtype: b[2],
    version: `${b[3]}.${b[4]}${major ? ` (${major})` : ""}`,
    storage: st.text, storageBytes: st.bytes,
    protocol: b[6] === 0x05 ? "ISO 14443-2 and -3" : `protocol ${hex([b[6]])}`,
    raw: hex(b.slice(0, 7)),
  };
}

const bcd = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);

/** Decodes the DESFire commands of a run's fixed steps (GetVersion's three frames, GetApplicationIDs, GetFreeMemory, GetKeySettings). */
export function decodeDesfire(items: GenericItem[]): DesfireInfo | undefined {
  const out: DesfireInfo = {};
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const c = it.command.toUpperCase();
    if (c.startsWith("9060")) {
      const frames = [it.response];
      for (let j = i + 1; j < items.length && items[j].command.toUpperCase().startsWith("90AF") && frames.length < 3; j++) frames.push(items[j].response);
      const all = (() => { try { return unhex(frames.join("")); } catch { return new Uint8Array(0); } })();
      const hw = desfirePart(all.slice(0, 7));
      const sw = desfirePart(all.slice(7, 14));
      if (hw) out.hardware = hw;
      if (sw) out.software = sw;
      if (all.length >= 21) out.uid = hex(all.slice(14, 21));
      if (all.length >= 26) out.batch = hex(all.slice(21, 26));
      if (all.length >= 28) { out.week = bcd(all[26]); out.year = 2000 + bcd(all[27]); }
    } else if (c.startsWith("906A") && it.status !== "error") {
      const b = (() => { try { return unhex(it.response); } catch { return new Uint8Array(0); } })();
      const ids: string[] = [];
      for (let k = 0; k + 2 < b.length; k += 3) ids.push(hex([b[k + 2], b[k + 1], b[k]]));
      out.applications = ids;
    } else if (c.startsWith("906E") && it.response.length >= 6) {
      const b = unhex(it.response);
      out.freeMemory = b[0] | (b[1] << 8) | (b[2] << 16);
    } else if (c.startsWith("9045") && it.response.length >= 4) {
      const b = unhex(it.response);
      const crypto = (b[1] >> 6) & 0x03;
      out.keySettings = {
        raw: it.response.toUpperCase(),
        masterKeyChangeable: Boolean(b[0] & 0x01), freeDirectoryList: Boolean(b[0] & 0x02), freeCreateDelete: Boolean(b[0] & 0x04), configurationChangeable: Boolean(b[0] & 0x08),
        maxKeys: b[1] & 0x0f, crypto: crypto === 0 ? "DES / 2K3DES" : crypto === 1 ? "3K3DES" : crypto === 2 ? "AES" : undefined,
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/* ---------------------------------------------------------------- the run */

const OP_LABEL: Record<string, string> = {
  "select-ppse": "SELECT PPSE (2PAY.SYS.DDF01)", "select-pse": "SELECT PSE (1PAY.SYS.DDF01)", "get-data": "GET DATA", "read-log": "Transaction history",
  gpo: "GET PROCESSING OPTIONS", "read-afl": "Records the AFL lists", "read-files": "Other short files", "for-each-aid": "Every application",
  "eid-read": "e-ID / e-passport read", "emv-read": "EMV read",
};

/** A step's label as people read it (its own, else one made from what it does). */
export function stepLabel(s: TemplateStep): string {
  if (s.label && s.label.trim()) return s.label.trim();
  if ("apdu" in s) return describeCommand(String(s.apdu).replace(/\s/g, ""));
  if (s.op === "select-aid") return s.aid ? `SELECT ${s.aid.toUpperCase()}${schemeForAid(s.aid) ? ` (${schemeForAid(s.aid)})` : ""}` : "SELECT the application";
  if (s.op === "get-data") return `GET DATA ${s.tags.join(", ")}`;
  if (s.op === "read-files") return `READ RECORD SFI ${s.sfi?.[0] ?? 1}–${s.sfi?.[1] ?? 30}`;
  return OP_LABEL[s.op] ?? s.op;
}

const SELECT_OPS = new Set(["select-ppse", "select-pse", "select-aid"]);

/** Runs every step of a template on the card in the field, one after another. */
export async function runTemplate(t: CardTransport, template: ApduTemplate | Record<string, unknown>, opts: RunTemplateOptions = {}): Promise<TemplateRun> {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const tpl = template as ApduTemplate;
  const label = typeof tpl.label === "string" && tpl.label.trim() ? tpl.label.trim() : String((template as Record<string, unknown>).name ?? "APDU template");
  const startedAt = Date.now();
  const t0 = now();
  const exchanges: TemplateExchange[] = [];
  const problems: string[] = [];
  const items: GenericItem[] = [];
  const run: TemplateRun = { label, ...(tpl.card ? { card: tpl.card } : {}), ...(tpl.note ? { note: tpl.note } : {}), ok: false, exchanges, data: { generic: { items } }, problems, startedAt, ms: 0 };
  const finish = (): TemplateRun => { run.ms = Math.round(now() - t0); run.ok = problems.length === 0 && !run.cancelled; return run; };

  const shape = templateProblems(template);
  if (shape.length) { problems.push(...shape); return finish(); }
  if (t.capabilities && t.capabilities.apdu === false) { problems.push("this reader has no APDU channel (ISO-DEP) — use a USB / Bluetooth / serial reader or the phone"); return finish(); }
  const steps = templateSteps(template);

  // Every APDU goes through here: recorded with the step it belongs to.
  let seq = 0;
  const cur = { step: 0, label: "", op: "" };
  const record = async (cmd: Uint8Array): Promise<Uint8Array> => {
    if (opts.signal?.aborted) throw new NfcError("aborted", "cancelled");
    // G-18: nothing but reads reaches the card — the readers' own commands
    // included; the e-ID secure channel's only inside eid-read (as on Android).
    const refused = readOnlyRefusal(cmd, { channel: cur.op === "eid-read" });
    if (refused) throw new NfcError("invalid-argument", refused);
    const started = now();
    const push = (data: string, sw: string, status: TemplateExchange["status"]) => {
      const e: TemplateExchange = { step: cur.step, label: cur.label, op: cur.op, command: hex(cmd), response: data, sw, status, ms: Math.max(0, Math.round(now() - started)) };
      exchanges.push(e);
      try { opts.onExchange?.(e); } catch { /* a listener's problem */ }
    };
    let raw: Uint8Array;
    // A transport failure is recorded too: "← (no answer)".
    try { raw = await t.transmit(cmd); } catch (e) { push("", "", "error"); throw e; }
    let data = "", sw = "";
    try { const r = splitResponse(raw); data = hex(r.data); sw = swHex(r.sw); } catch { data = hex(raw); }
    const swNum = sw ? parseInt(sw, 16) : -1;
    // A status a reader goes on from (success, 61xx, a Le to fix, the end of a file) — else a warning.
    push(data, sw, swNum >= 0 && (isOk(swNum) || swNum >> 8 === 0x6c || swNum === 0x6282) ? "ok" : "warn");
    return raw;
  };
  // The transport the readers see: the card's, with every transmit recorded.
  const recorded = new Proxy(t, {
    get(target, prop) {
      if (prop === "transmit") return record;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as CardTransport;
  const send: EmvSender = (cmd) => transmitSmart(record, cmd);

  // What the steps collect.
  const apps = new Map<string, EmvAppState>();
  const selected: string[] = [];
  let dirAids: string[] = [];
  let tree: string | undefined;
  let deep = false;
  let current: EmvAppState | null = null;
  let legacyEmv: EmvData | undefined;
  const budget = { left: 400 };
  const total = steps.length;
  let topIndex = 0;

  const appFor = (): EmvAppState => {
    if (current) return current;
    // A step before any SELECT works on what the card has selected now.
    const aid = (tpl.aid ?? "").toUpperCase();
    current = startApp(aid, { fci: [] });
    apps.set(aid, current);
    return current;
  };
  const lastOf = (n: number): TemplateExchange | undefined => { for (let i = exchanges.length - 1; i >= 0; i--) if (exchanges[i].step === n) return exchanges[i]; return undefined; };
  const mark = (n: number, status: TemplateExchange["status"]) => { const e = lastOf(n); if (e) e.status = status; };
  const swWords = (sw: number) => `${swHex(sw)} ${describeSw(sw)}`;

  /** Runs one step; false when it failed in a way that ends the run (or the application). */
  const runStep = async (s: TemplateStep, prefix: string, loopAid?: string): Promise<boolean> => {
    if (opts.signal?.aborted) throw new NfcError("aborted", "cancelled");
    seq++;
    const lbl = `${prefix}${stepLabel(s)}`;
    cur.step = seq; cur.label = lbl; cur.op = "apdu" in s ? "" : s.op;
    try { opts.onStep?.({ step: topIndex, total, label: lbl, op: cur.op, exchanges: exchanges.length }); } catch { /* listener */ }
    const fail = (why: string, optional?: boolean): boolean => {
      if (optional) { mark(seq, "warn"); return true; }
      mark(seq, "error");
      problems.push(`${lbl}: ${why}`);
      return false;
    };

    if ("apdu" in s) {
      let cmd: Uint8Array;
      try { cmd = unhex(String(s.apdu)); } catch { return fail("not a hex command"); }
      // G-18: a fixed command only reads (never the e-ID channel's commands either).
      const refused = readOnlyRefusal(cmd);
      if (refused) return fail(refused);
      const r: Response = await transmitSmart(record, cmd);
      const sw = swHex(r.sw);
      const expect = Array.isArray(s.expect) && s.expect.length ? s.expect : ["9000"];
      const good = swMatches(sw, expect);
      mark(seq, good ? "ok" : s.optional ? "warn" : "error");
      items.push({ step: seq, label: lbl, command: hex(cmd), response: hex(r.data), sw, status: good ? "ok" : s.optional ? "warn" : "error" });
      if (good) return true;
      return fail(`${swWords(r.sw)} (expected ${expect.join(" / ")})`, s.optional);
    }

    switch (s.op) {
      case "select-ppse":
      case "select-pse": {
        const dir = s.op === "select-ppse" ? await selectPpse(send) : await selectPse(send);
        if (!dir.ok) return fail(`${swWords(dir.sw)} — no ${s.op === "select-ppse" ? "contactless" : "contact"} payment directory`, s.optional);
        dirAids = [...new Set([...dirAids, ...dir.aids])];
        if (dir.tree) tree = tree ? `${tree}\n${dir.tree}` : dir.tree;
        return true;
      }
      case "select-aid": {
        const aid = (s.aid ?? loopAid ?? tpl.aid ?? "").toUpperCase();
        if (!aid) return fail("no AID — give one, or run it inside for-each-aid", s.optional);
        const sel = await selectAid(send, aid);
        if (!sel.ok) return fail(`${swWords(sel.sw)} — ${aid} is not on this card`, s.optional);
        current = startApp(aid, sel);
        apps.delete(aid);
        apps.set(aid, current);
        if (!selected.includes(aid)) selected.push(aid);
        return true;
      }
      case "get-data":
        await appGetData(send, appFor(), s.tags);
        return true;
      case "read-log":
        await appReadLog(send, appFor(), { ask: true });
        return true;
      case "gpo": {
        const r = await appGpo(send, appFor());
        if (!r.ok) { mark(seq, "error"); problems.push(`${lbl}: ${swWords(r.sw)} — the card refused GET PROCESSING OPTIONS`); }
        return true;
      }
      case "read-afl":
        await appReadAfl(send, appFor());
        return true;
      case "read-files":
        deep = true;
        await appReadFiles(send, appFor(), { sfi: s.sfi, records: s.records }, budget);
        return true;
      case "for-each-aid": {
        const max = Math.max(1, Math.min(16, Math.trunc(Number(s.max) || 8)));
        let aids = dirAids.length ? dirAids : (Array.isArray(s.aids) && s.aids.length ? s.aids.map((a) => a.toUpperCase()) : []);
        if (!aids.length) {
          cur.label = `${lbl} — find applications (no directory)`;
          aids = await probeAids(send, max);
          if (!aids.length) return fail("no payment application answered (no directory, none of the well-known AIDs)");
        }
        for (const aid of aids.slice(0, max)) {
          current = null;
          for (const inner of Array.isArray(s.steps) ? s.steps : []) {
            if (!(await runStep(inner, `${prefix}${aid} · `, aid))) break;
          }
        }
        current = null;
        return true;
      }
      case "eid-read": {
        const args = s.args ?? {};
        const key = opts.askEidKey ? await opts.askEidKey({ readPhoto: args.readPhoto, all: args.all }) : null;
        if (opts.signal?.aborted) throw new NfcError("aborted", "cancelled");
        if (!key || (!key.mrz && !key.key && !key.can)) return fail("the document's key (the MRZ or the CAN) was not given — nothing was read");
        const base = lbl;
        const d = await readMrtd(recorded, { ...key, readPhoto: args.readPhoto !== false, all: args.all !== false, onPhase: (p) => { cur.label = `${base} · ${p}`; } });
        cur.label = base;
        run.data.mrtd = d;
        if (d.access === "none") return fail(d.message || "the document could not be opened");
        return true;
      }
      case "emv-read": {
        const a = s.args ?? {};
        const d = await readEmv(recorded, { ...(typeof a.aid === "string" ? { aid: a.aid } : {}), ...(typeof a.deep === "boolean" ? { deep: a.deep } : {}), ...(typeof a.history === "boolean" ? { history: a.history } : {}) });
        legacyEmv = d;
        if (!d.apps.length) return fail(d.aids.length ? "the applications did not answer" : "no EMV application found");
        return true;
      }
      default:
        return fail(`unknown op "${(s as { op?: string }).op}"`);
    }
  };

  try {
    for (const s of steps) {
      topIndex++;
      if (!(await runStep(s, ""))) break;
    }
  } catch (e) {
    if (NfcError.is(e, "aborted") || opts.signal?.aborted) { run.cancelled = true; problems.push("cancelled"); }
    else problems.push(`${cur.label || label}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The EMV applications the steps read, as the 6.6 reader gives them (the card report reads that).
  if (apps.size || dirAids.length || selected.length) {
    const list: EmvApp[] = [...apps.values()].filter((a) => a.aid || a.records.length || a.x.getData.size || a.tags.size).map(finishApp);
    const aids = dirAids.length ? dirAids : selected;
    run.data.emv = { scheme: list[0]?.scheme ?? (aids[0] ? schemeForAid(aids[0]) : undefined), aids, apps: list, ...(tree ? { tree } : {}), deep, apdus: exchanges.length };
  }
  if (legacyEmv) run.data.emv = run.data.emv ? { ...legacyEmv, apps: [...run.data.emv.apps, ...legacyEmv.apps], aids: [...new Set([...run.data.emv.aids, ...legacyEmv.aids])], apdus: exchanges.length } : { ...legacyEmv, apdus: exchanges.length };
  const desfire = decodeDesfire(items);
  if (desfire) run.data.generic.desfire = desfire;
  return finish();
}
