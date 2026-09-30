// The WEB executor for the m5.nfc bridge (6.3, task 7).
//
// A Functions model calls `await m5.nfc.scan()` (or read-uid / ndef-read /
// classic-dump / m5-read / emv-public …); the sandbox turns it into an
// NfcCommand and the run interaction handler hands it to runNfcCommand()
// (bridge.ts). This module is the executor the WEB platform registers: it
// maps a catalogue op id onto the workbench's transport + card layer and
// returns an NfcResult.
//
// TWO hard rules from command.ts, enforced here:
//   • a result NEVER carries a key or a card PIN. Saved keys are resolved
//     locally from `secretRef`; they drive an operation but never leave.
//   • writes only happen when the platform allows them (a model does not
//     silently rewrite a user's card) — otherwise the op is "denied".

import { toBase64 } from "../crypto";
import type { CardTransport, CardIdentity } from "./transport";
import { NfcError } from "./errors";
import { detectCard, type CardType } from "./cards/detect";
import { techInfo, supportsOp, type NfcTech } from "./catalog";
import { readNdefAuto, selectPpse, selectMrtd } from "./probes";
import { decodeRecord, type NdefRecord } from "./cards/ndef";
import { hex, unhex, splitResponse, describeSw } from "./cards/apdu";
import { classicDump, ultralightReadPages, ntagReadCounter } from "./cards/tag-io";
import { readM5Card, lockedSummaries } from "./m5cet-card";
import type { NfcCommand, NfcResult, NfcResultStatus } from "./command";

/** What the platform (the workbench) gives the executor. */
export type WebExecutorDeps = {
  /** The reader currently connected in the workbench, or null. */
  getTransport: () => CardTransport | null;
  /** Mifare Classic keys the user holds, for a named `secretRef` (or all). */
  resolveKeys?: (secretRef?: string) => Uint8Array[];
  /** Whether a model may drive a WRITE op. Off by default. */
  allowWrites?: boolean;
  /** Default seconds to wait for a card when the command gives none. */
  defaultTimeout?: number;
};

const CARD_TYPE_TO_TECH: Record<CardType, NfcTech> = {
  "mifare-classic-1k": "mifare-classic-1k",
  "mifare-classic-4k": "mifare-classic-4k",
  "mifare-classic-mini": "mifare-classic-mini",
  "mifare-ultralight": "mifare-ultralight",
  ntag21x: "ntag21x",
  "mifare-desfire": "mifare-desfire",
  "iso-dep-generic": "iso-dep",
  emv: "emv",
  mrtd: "eid",
  felica: "felica",
  iso15693: "iso15693",
  "connection-tag": "connection-tag",
  unknown: "unknown",
};

/** Map a detector CardType onto a catalogue NfcTech (shared with the UI). */
export function techForCardType(type: CardType): NfcTech {
  return CARD_TYPE_TO_TECH[type] ?? "unknown";
}

function techOf(id: CardIdentity): NfcTech {
  const best = detectCard(id)[0];
  return best ? CARD_TYPE_TO_TECH[best.type] : "unknown";
}

function cardField(id: CardIdentity, tech: NfcTech): NonNullable<NfcResult["card"]> {
  const info = techInfo(tech);
  return {
    uid: hex(id.uid),
    tech,
    label: info.label,
    ...(id.sak !== undefined ? { sak: hex([id.sak]) } : {}),
    ...(id.atqa ? { atqa: hex(id.atqa) } : {}),
    ...(id.ats ? { ats: hex(id.ats) } : {}),
    ...(id.atr ? { atr: hex(id.atr) } : {}),
    ...(info.memory ? { memory: info.memory } : {}),
  };
}

function ndefField(records: NdefRecord[]): NfcResult["ndef"] {
  return records.map((r) => {
    const d = decodeRecord(r);
    switch (d.kind) {
      case "text": return { kind: "text", text: d.text, lang: d.lang };
      case "uri": case "absolute-uri": return { kind: "uri", data: d.uri };
      case "mime": return { kind: "mime", type: d.mime, data: hex(d.payload) };
      case "external": return { kind: "external", type: d.type, data: hex(d.payload) };
      case "smart-poster": return { kind: "smart-poster", data: d.uri };
      case "empty": return { kind: "empty" };
      default: return { kind: "unknown", type: String(d.tnf) };
    }
  });
}

function statusFor(err: unknown): { status: NfcResultStatus; message: string } {
  if (NfcError.is(err)) {
    const map: Partial<Record<string, NfcResultStatus>> = {
      timeout: "timeout", aborted: "timeout", "no-card": "no-card",
      "auth-failed": "auth-failed", unsupported: "unsupported",
      "not-supported-by-transport": "unsupported", "permission-denied": "denied",
    };
    return { status: map[err.code] ?? "error", message: err.message };
  }
  return { status: "error", message: err instanceof Error ? err.message : String(err) };
}

/** Build the web executor. Register it with registerNfcExecutor(). */
export function createWebExecutor(deps: WebExecutorDeps) {
  const defaultTimeout = (deps.defaultTimeout ?? 20) * 1000;

  return async function execute(command: NfcCommand, signal?: AbortSignal): Promise<NfcResult> {
    const t = deps.getTransport();
    if (!t) return { status: "unsupported", message: "Connect a reader in the NFC workbench first." };
    const timeoutMs = command.timeout ? command.timeout * 1000 : defaultTimeout;
    const op = command.op;

    try {
      // Every op needs a card in the field.
      const id = await t.waitForCard({ timeoutMs, signal });
      const tech = command.tech && command.tech !== "unknown" ? command.tech : techOf(id);
      const card = cardField(id, tech);

      // A command may narrow to a tech that does not support the op.
      if (tech !== "unknown" && op !== "scan" && !supportsOp(tech, op)) {
        return { status: "unsupported", card, message: `${techInfo(tech).label} does not support "${op}".` };
      }

      switch (op) {
        case "scan":
        case "read-public": {
          const out: NfcResult = { status: "ok", card };
          try {
            const res = await readNdefAuto(t, id);
            if (res.records.length) out.ndef = ndefField(res.records);
            const m5 = await readM5Card(t, id);
            if (m5) out.records = lockedSummaries(m5.sealed);
          } catch (e) { if (!NfcError.is(e, "not-supported-by-transport") && !NfcError.is(e, "card-error")) throw e; }
          return out;
        }
        case "read-uid":
          return { status: "ok", card };

        case "ndef-read": {
          const res = await readNdefAuto(t, id);
          return { status: "ok", card, ndef: ndefField(res.records) };
        }

        case "m5-read": {
          const m5 = await readM5Card(t, id);
          if (!m5) return { status: "ok", card, message: "Not an M5Cet card." };
          return { status: "ok", card, records: lockedSummaries(m5.sealed) };
        }

        case "classic-read":
        case "classic-dump": {
          const keys = deps.resolveKeys?.(command.secretRef) ?? [];
          const dump = await classicDump(t, id, { keys, signal });
          // Only the block bytes leave — never the keys that opened them.
          const bytes = dump.sectors.flatMap((s) => s.blocks).filter((b) => b.data).flatMap((b) => Array.from(b.data!));
          return {
            status: "ok", card, data: toBase64(Uint8Array.from(bytes)),
            message: `${dump.readableBlocks}/${dump.totalBlocks} blocks read (${dump.type.toUpperCase()}).`,
          };
        }

        case "ul-read":
        case "ntag-read": {
          const from = Number(command.args?.from ?? 4);
          const count = Number(command.args?.count ?? 16);
          const data = await ultralightReadPages(t, from, count);
          return { status: "ok", card, data: toBase64(data) };
        }
        case "ntag-counter": {
          const n = await ntagReadCounter(t);
          return { status: "ok", card, message: `Read counter: ${n}` };
        }

        case "emv-public": {
          const r = await selectPpse(t);
          return { status: "ok", card, message: r.present ? `EMV: ${r.label ?? ""} AIDs ${r.aids.join(", ")}` : `No PPSE (${r.tree})` };
        }
        case "eid-public": {
          const r = await selectMrtd(t);
          return { status: "ok", card, message: `MRTD ${r.present ? "present" : "absent"} (${r.sw}). Public presence only — no BAC/PACE, no data.` };
        }

        case "raw-apdu":
        case "select-aid": {
          const hexApdu = typeof command.args?.apdu === "string" ? command.args.apdu : null;
          if (!hexApdu) return { status: "error", card, message: "raw-apdu needs args.apdu (hex)." };
          const resp = splitResponse(await t.transmit(unhex(hexApdu)));
          return { status: "ok", card, data: toBase64(resp.data), message: `SW ${describeSw(resp.sw)}` };
        }

        default:
          // Writes and not-yet-implemented reads.
          if (techInfo(tech).ops.find((o) => o.id === op)?.kind !== "read") {
            if (!deps.allowWrites) return { status: "denied", card, message: `"${op}" is a write — run it in the NFC workbench, not from a model.` };
          }
          return { status: "unsupported", card, message: `"${op}" is not available on this reader from the m5.nfc bridge.` };
      }
    } catch (err) {
      return statusFor(err);
    }
  };
}
