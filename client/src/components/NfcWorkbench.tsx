// NFC / RFID / smart-card workbench UI (6.3). Drives the lib/nfc transport +
// card layer directly and, while mounted, registers the WEB executor so a
// Functions model's m5.nfc.* calls reach this device (bridge.ts).
//
// Strings come from lib/i18n (nfc.* / nfc.rec.*). The tool builds STANDARD
// NFC operations with keys the USER holds — a key dictionary like MIFARE
// Classic Tool. It never recovers unknown keys (no nested/darkside), and EMV
// / e-ID are PUBLIC data only. See lib/nfc/catalog.ts for the full stance.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Usb, Radio, Bluetooth, Smartphone, Plug, PlugZap, ScanLine, KeyRound,
  Download, Upload, Cpu, TerminalSquare, CreditCard, Copy, Trash2, Play, Square, Loader2, Lock, Fingerprint,
  SquareArrowDown,
} from "lucide-react";
import "./nfc-workbench.css";
import {
  listTransports, createTransport, NfcError,
  type CardTransport, type CardIdentity, type TransportId, type TransportInfo,
} from "../lib/nfc/index";
import { detectCard, type Candidate } from "../lib/nfc/cards/detect";
import { NFC_CATALOG, NFC_READERS, opsFor, techInfo, type NfcTech, type NfcOp, type ReaderKind } from "../lib/nfc/catalog";
import { hex, unhex } from "../lib/nfc/cards/apdu";
import { describeRecord, textRecord, uriRecord, type NdefRecord } from "../lib/nfc/cards/ndef";
import { buildConnectionRecords, decodeConnectionRecords, hasConnectionRecord } from "../lib/nfc/cards/connection-card";
import {
  readNdefAuto, writeType4Ndef, writeType2Ndef, ultralightGetVersion, desfireGetVersion,
  selectPpse, selectMrtd, runApduScript,
} from "../lib/nfc/probes";
import { classicDump, classicWriteBlock, classicRestore, ultralightReadPages, ntagReadCounter, writeUidGen1a, writeUidGen2, buildBlock0, type ClassicDump } from "../lib/nfc/cards/tag-io";
import { createWebExecutor, techForCardType } from "../lib/nfc/web-executor";
import { registerNfcExecutor } from "../lib/nfc/bridge";
import { nominalCapacity } from "../lib/nfc/m5cet-card";
import { t as translate, type Lang } from "../lib/i18n";
import { useDefine } from "../lib/define/client";
import { M5CardPanel } from "./M5CardPanel";
import type { M5Record } from "../lib/nfc/m5card";

export type NfcWorkbenchProps = {
  lang: Lang;
  session: { room: string; passphrase: string; name: string } | null;
  appVersion: string;
  onConnect: (p: { room: string; passphrase: string; name?: string }) => void;
  onSystem: (message: string) => void;
};

const READER_TRANSPORT: Record<ReaderKind, TransportId> = {
  internal: "webnfc", usb: "webusb-ccid", serial: "webserial-pn532", bluetooth: "webbluetooth-pn532",
};
const KIND_KEY: Record<ReaderKind, string> = {
  internal: "nfc.reader.internal", usb: "nfc.reader.usb", bluetooth: "nfc.reader.bluetooth", serial: "nfc.reader.serial",
};
const READER_STORE = "m5cet:nfc:reader";
const KEYS_STORE = "m5cet:nfc:keys";

function errText(lang: Lang, err: unknown): string {
  if (NfcError.is(err)) {
    const byCode: Partial<Record<string, string>> = {
      unsupported: "nfc.apdu.unsupported", "permission-denied": "nfc.reader.unavailable",
      "not-connected": "nfc.connectFirst", "no-card": "nfc.scan.tap", aborted: "nfc.cancelled",
    };
    const key = byCode[err.code];
    return key ? translate(lang, key) : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function ReaderIcon({ kind }: { kind: ReaderKind }) {
  const p = { width: 16, height: 16 } as const;
  if (kind === "internal") return <Smartphone {...p} />;
  if (kind === "usb") return <Usb {...p} />;
  if (kind === "serial") return <Radio {...p} />;
  return <Bluetooth {...p} />;
}

type LogKind = "tx" | "rx" | "info" | "err";
type LogEntry = { id: number; kind: LogKind; text: string };
type Tab = "card" | "ndef" | "mifare" | "m5" | "conn" | "apdu" | "emulate";

function loadKeys(): string[] {
  try { const raw = localStorage.getItem(KEYS_STORE); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}

export function NfcWorkbench(props: NfcWorkbenchProps): React.JSX.Element {
  const { lang, session, appVersion, onConnect, onSystem } = props;
  const t = useCallback((k: string) => translate(lang, k), [lang]);

  const transports = useMemo<TransportInfo[]>(() => listTransports(), []);
  const byId = useMemo(() => new Map(transports.map((x) => [x.id, x])), [transports]);
  const initialKind = useMemo<ReaderKind>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(READER_STORE); } catch { /* ignore */ }
    const kinds = Object.keys(READER_TRANSPORT) as ReaderKind[];
    if (stored && (kinds as string[]).includes(stored)) return stored as ReaderKind;
    return kinds.find((k) => byId.get(READER_TRANSPORT[k])?.supported) ?? "internal";
  }, [byId]);

  const [reader, setReader] = useState<ReaderKind>(initialKind);
  const [tab, setTab] = useState<Tab>("card");
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState<CardIdentity | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [tech, setTech] = useState<NfcTech>("unknown");
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);
  const transportRef = useRef<CardTransport | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scanAbort = useRef<AbortController | null>(null);

  const [keyDict, setKeyDict] = useState<string[]>(loadKeys);
  const keyBytesRef = useRef<Uint8Array[]>([]);
  useEffect(() => {
    keyBytesRef.current = keyDict.map((k) => { try { return unhex(k); } catch { return null; } }).filter((x): x is Uint8Array => !!x && x.length === 6);
    try { localStorage.setItem(KEYS_STORE, JSON.stringify(keyDict)); } catch { /* ignore */ }
  }, [keyDict]);

  const addLog = useCallback((kind: LogKind, text: string) => {
    setLog((prev) => [...prev.slice(-400), { id: logId.current++, kind, text }]);
  }, []);

  const selectedTransport = byId.get(READER_TRANSPORT[reader]);

  // Register the web executor for m5.nfc while the workbench is mounted.
  useEffect(() => {
    const unregister = registerNfcExecutor(createWebExecutor({
      getTransport: () => transportRef.current,
      resolveKeys: () => keyBytesRef.current,
      allowWrites: false,
    }));
    return unregister;
  }, []);

  useEffect(() => () => { abortRef.current?.abort(); scanAbort.current?.abort(); transportRef.current?.disconnect().catch(() => {}); }, []);

  const runTask = useCallback((name: string, fn: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(name);
    void (async () => {
      try { await fn(ac.signal); }
      catch (err) { const msg = errText(lang, err); addLog("err", `✗ ${msg}`); onSystem(`NFC: ${msg}`); }
      finally { abortRef.current = null; setBusy(null); }
    })();
  }, [busy, lang, addLog, onSystem]);

  const caps = transportRef.current?.capabilities;

  /* ----------------------------- connect ----------------------------- */

  const doConnect = useCallback(() => runTask("connect", async () => {
    if (transportRef.current) await transportRef.current.disconnect().catch(() => {});
    const tr = createTransport(READER_TRANSPORT[reader]);
    tr.onTrace?.((dir, bytes, note) => addLog(dir, `${dir === "tx" ? "→" : "←"} ${hex(bytes, " ")}${note ? `  ; ${note}` : ""}`));
    tr.onDisconnect(() => { setConnected(false); addLog("err", t("nfc.deviceLost")); onSystem(`NFC: ${t("nfc.deviceLost")}`); });
    await tr.connect();
    transportRef.current = tr;
    setConnected(true);
    try { localStorage.setItem(READER_STORE, reader); } catch { /* ignore */ }
    addLog("info", `${t("nfc.connected")}: ${tr.label}`);
  }), [runTask, reader, addLog, onSystem, t]);

  const doDisconnect = useCallback(() => runTask("disconnect", async () => {
    scanAbort.current?.abort(); setScanning(false);
    await transportRef.current?.disconnect();
    transportRef.current = null;
    setConnected(false); setIdentity(null); setCandidates([]); setTech("unknown");
    addLog("info", t("nfc.disconnect"));
  }), [runTask, addLog, t]);

  /* --------------------------- scan / read --------------------------- */

  const ingest = useCallback(async (tr: CardTransport, id: CardIdentity) => {
    setIdentity(id);
    const ranked = detectCard(id);
    setCandidates(ranked);
    setTech(ranked[0] ? techForCardType(ranked[0].type) : "unknown");
    addLog("info", `UID ${hex(id.uid) || "-"}  SAK ${id.sak !== undefined ? hex([id.sak]) : "-"} → ${ranked[0]?.label ?? "?"}`);
    if (id.ndef?.length || id.isoDep || tr.capabilities.raw) {
      try {
        const res = await readNdefAuto(tr, id);
        if (res.records.length) {
          setNdefRecords(res.records);
          addLog("rx", `NDEF (${res.source}): ${res.records.map(describeRecord).join(" | ")}`);
          if (hasConnectionRecord(res.records)) addLog("info", `→ ${t("nfc.conn")}`);
        }
      } catch (e) { if (!NfcError.is(e, "not-supported-by-transport") && !NfcError.is(e, "card-error")) throw e; }
    }
    onSystem(`NFC: ${ranked[0]?.label ?? "card"} — UID ${hex(id.uid) || "n/a"}`);
  }, [addLog, onSystem, t]);

  const doReadOnce = useCallback(() => runTask("read", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    addLog("info", t("nfc.scan.waiting"));
    const id = await tr.waitForCard({ timeoutMs: 30_000, signal });
    await ingest(tr, id);
  }), [runTask, ingest, addLog, onSystem, t]);

  const toggleScan = useCallback(() => {
    if (scanning) { scanAbort.current?.abort(); setScanning(false); return; }
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const ac = new AbortController();
    scanAbort.current = ac;
    setScanning(true);
    addLog("info", t("nfc.scan.loop"));
    void (async () => {
      try {
        while (!ac.signal.aborted) {
          const id = await tr.waitForCard({ timeoutMs: 60_000, signal: ac.signal });
          await ingest(tr, id);
          await tr.releaseCard?.().catch(() => {});
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (err) { if (!NfcError.is(err, "aborted")) addLog("err", errText(lang, err)); }
      finally { setScanning(false); scanAbort.current = null; }
    })();
  }, [scanning, ingest, addLog, onSystem, t, lang]);

  /* ------------------------------ NDEF ------------------------------- */

  const [ndefRecords, setNdefRecords] = useState<NdefRecord[]>([]);
  const [newText, setNewText] = useState("");
  const [newUri, setNewUri] = useState("https://");

  const writeNdefTo = useCallback(async (tr: CardTransport, records: NdefRecord[]) => {
    if (tr.id === "webnfc" && tr.writeNdef) await tr.writeNdef(records, { overwrite: true });
    else if (identity?.isoDep) await writeType4Ndef(tr, records);
    else await writeType2Ndef(tr, records);
  }, [identity]);

  const doReadNdef = useCallback(() => runTask("ndef-read", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const id = identity ?? await tr.waitForCard({ timeoutMs: 30_000, signal });
    if (!identity) setIdentity(id);
    const res = await readNdefAuto(tr, id);
    setNdefRecords(res.records);
    addLog("rx", `NDEF (${res.source}): ${res.records.map(describeRecord).join(" | ") || t("nfc.ndef.empty")}`);
  }), [runTask, identity, addLog, onSystem, t]);

  const doWriteNdef = useCallback(() => runTask("ndef-write", async () => {
    const tr = transportRef.current;
    if (!tr || !ndefRecords.length) { if (!tr) onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    await writeNdefTo(tr, ndefRecords);
    addLog("info", `${t("nfc.ndef.write")} (${ndefRecords.length})`);
    onSystem(`NFC: ${t("nfc.done")}`);
  }), [runTask, ndefRecords, writeNdefTo, addLog, onSystem, t]);

  /* --------------------------- connect tag --------------------------- */

  const [pin, setPin] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");

  const doWriteConn = useCallback(() => runTask("conn-write", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    if (!session) { onSystem(`NFC: ${t("nfc.conn.noSession")}`); return; }
    const records = await buildConnectionRecords(
      { room: session.room, passphrase: session.passphrase, name: session.name },
      pin, { appVersion, fallbackUrl: fallbackUrl || undefined },
    );
    await writeNdefTo(tr, records);
    addLog("info", t("nfc.conn.wrote"));
    onSystem(`NFC: ${t("nfc.conn.wrote")}`);
  }), [runTask, session, pin, appVersion, fallbackUrl, writeNdefTo, addLog, onSystem, t]);

  const doReadConn = useCallback(() => runTask("conn-read", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const id = await tr.waitForCard({ timeoutMs: 30_000, signal });
    setIdentity(id);
    const res = await readNdefAuto(tr, id);
    if (!hasConnectionRecord(res.records)) { onSystem(`NFC: ${t("nfc.conn.none")}`); addLog("err", t("nfc.conn.none")); return; }
    const payload = await decodeConnectionRecords(res.records, pin);
    addLog("info", `${t("nfc.conn.joined")} room=${payload.room}`);
    onSystem(`NFC: ${t("nfc.conn.joined")}`);
    onConnect({ room: payload.room, passphrase: payload.passphrase, name: payload.name });
  }), [runTask, pin, onConnect, addLog, onSystem, t]);

  /* ------------------------------ probes ----------------------------- */

  const runProbe = useCallback((kind: NonNullable<Candidate["probe"]>) => runTask("probe", async () => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    if (kind === "select-ppse") { const r = await selectPpse(tr); addLog(r.present ? "rx" : "info", r.present ? `EMV PPSE: ${r.label ?? ""} ${r.aids.join(", ")}\n${r.tree}` : `PPSE: ${r.tree}`); }
    else if (kind === "select-mrtd") { const r = await selectMrtd(tr); addLog("rx", `MRTD: ${r.present ? "present" : "absent"} (${r.sw})`); }
    else if (kind === "get-version") { try { const v = await desfireGetVersion(tr); addLog("rx", v.text); } catch { const v = await ultralightGetVersion(tr); addLog("rx", `${v.product} (${v.storageBytes} B)`); } }
    else { await doReadNdef(); }
  }), [runTask, identity, addLog, onSystem, t, doReadNdef]);

  /* --------------------------- Mifare Classic ------------------------ */

  const [dump, setDump] = useState<ClassicDump | null>(null);
  const [dumpProgress, setDumpProgress] = useState(0);
  const [wBlock, setWBlock] = useState("4");
  const [wData, setWData] = useState("");

  const doDump = useCallback(() => runTask("classic-dump", async (signal) => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    setDump(null); setDumpProgress(0);
    const result = await classicDump(tr, identity, { keys: keyBytesRef.current, signal, onProgress: (s, total) => setDumpProgress(Math.round(((s + 1) / total) * 100)) });
    setDump(result);
    const msg = translate(lang, "nfc.classic.sectorsOpen").replace("{open}", String(result.sectors.filter((s) => s.key).length)).replace("{total}", String(result.sectors.length));
    addLog("info", `Mifare ${result.type}: ${result.readableBlocks}/${result.totalBlocks} — ${msg}`);
    onSystem(`NFC: ${msg}`);
  }), [runTask, identity, addLog, onSystem, t, lang]);

  const doWriteBlock = useCallback(() => runTask("classic-write", async () => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const key = keyBytesRef.current[0];
    if (!key) { onSystem(`NFC: ${t("nfc.classic.needKeys")}`); return; }
    await classicWriteBlock(tr, identity, Number(wBlock), unhex(wData), key, "B");
    addLog("info", `${t("nfc.classic.write")} #${wBlock}`);
    onSystem(`NFC: ${t("nfc.done")}`);
  }), [runTask, identity, wBlock, wData, addLog, onSystem, t]);

  const doRestore = useCallback(() => runTask("classic-restore", async (signal) => {
    const tr = transportRef.current;
    if (!tr || !identity || !dump) return;
    const r = await classicRestore(tr, identity, dump, { keys: keyBytesRef.current, signal });
    addLog("info", `restore: ${r.written} written, ${r.skipped} skipped`);
    onSystem(`NFC: ${t("nfc.done")}`);
  }), [runTask, identity, dump, addLog, onSystem, t]);

  const saveDump = useCallback(() => {
    if (!dump) return;
    const json = JSON.stringify({ ...dump, sectors: dump.sectors.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ block: b.block, data: b.data ? hex(b.data) : null, trailer: b.trailer })) })) }, null, 2);
    try { const url = URL.createObjectURL(new Blob([json], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = `mifare-${dump.uid || "dump"}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); } catch { /* ignore */ }
  }, [dump]);

  /* ------------------------ Ultralight / NTAG ------------------------ */

  const doUlRead = useCallback(() => runTask("ul-read", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const data = await ultralightReadPages(tr, 4, 24);
    addLog("rx", `pages 4..: ${hex(data, " ")}`);
  }), [runTask, addLog, onSystem, t]);

  const doCounter = useCallback(() => runTask("ntag-counter", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const n = await ntagReadCounter(tr);
    addLog("rx", `NTAG counter: ${n}`);
  }), [runTask, addLog, onSystem, t]);

  /* ------------------------------- UID ------------------------------- */

  const [newUid, setNewUid] = useState("");
  const [uidGen, setUidGen] = useState<"gen1a" | "gen2">("gen1a");

  const doWriteUid = useCallback(() => runTask("write-uid", async () => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    const uid = unhex(newUid);
    const block0 = buildBlock0(uid, identity.sak ?? 0x08, identity.atqa ?? unhex("0400"));
    if (uidGen === "gen1a") await writeUidGen1a(tr, block0);
    else { const key = keyBytesRef.current[0] ?? unhex("FFFFFFFFFFFF"); await writeUidGen2(tr, identity, block0, key, "A"); }
    addLog("info", `${t("nfc.uid.change")} → ${hex(uid)}`);
    onSystem(`NFC: ${t("nfc.done")}`);
  }), [runTask, identity, newUid, uidGen, addLog, onSystem, t]);

  /* ------------------------------ APDU ------------------------------- */

  const [apduText, setApduText] = useState("00A404000E325041592E5359532E444446303100\n00B0000000");
  const [apduContinue, setApduContinue] = useState(false);

  // Run a newline-separated APDU script (each line one hex APDU). Shared by the
  // APDU console's Run button and the Application-template menu, so a template
  // sends its saved APDUs immediately with its own text (not the stale state).
  const runApduText = useCallback((text: string) => runTask("apdu", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("nfc.connectFirst")}`); return; }
    if (!tr.capabilities.apdu) { addLog("err", t("nfc.apdu.unsupported")); return; }
    const apdus = text.split(/\r?\n/).map((l) => l.trim().replace(/[^0-9A-Fa-f]/g, "")).filter(Boolean).map((l) => unhex(l));
    if (!apdus.length) { addLog("err", t("nfc.tpl.bad")); return; }
    const steps = await runApduScript(tr, apdus, { continueOnError: apduContinue });
    for (const s of steps) { addLog("tx", `→ ${hex(s.apdu, " ")}`); addLog(s.ok ? "rx" : "err", `← ${hex(s.response.data, " ")} ${hex([s.response.sw1, s.response.sw2])} ; ${s.note}`); }
  }), [runTask, apduContinue, addLog, onSystem, t]);

  const doApdu = useCallback(() => runApduText(apduText), [runApduText, apduText]);

  /* --------------------- application templates (define) --------------- */
  // Operator-defined APDU application templates: m5mobile.define.apduTemplates,
  // an array of { label?/name?, apdu?/apduHex? } served to the web app. The
  // "Application template" op (next to Select application) opens this menu.
  const define = useDefine();
  const [tplOpen, setTplOpen] = useState(false);
  const apduTemplates = useMemo(() => {
    const v = (define.values as Record<string, unknown>).apduTemplates;
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : [];
  }, [define.values]);

  const applyTemplate = useCallback((tpl: Record<string, unknown>) => {
    const raw = String(tpl.apdu ?? tpl.apduHex ?? tpl.value ?? "");
    const clean = raw.split(/\r?\n/).map((l) => l.trim().replace(/[^0-9A-Fa-f]/g, "")).filter(Boolean).join("\n");
    if (clean.replace(/\s/g, "").length < 8) { onSystem(`NFC: ${t("nfc.tpl.bad")}`); return; }
    setApduText(clean);
    setTplOpen(false);
    setTab("apdu");
    void runApduText(clean);
  }, [runApduText, onSystem, t]);

  /* ---------------------------- emulation ---------------------------- */

  const [emuText, setEmuText] = useState("m5cet.app");
  const emuAbort = useRef<AbortController | null>(null);
  const [emulating, setEmulating] = useState(false);

  const startEmu = useCallback(() => {
    const tr = transportRef.current;
    if (!tr?.emulateNdef) { onSystem(`NFC: ${t("nfc.emulate.note")}`); return; }
    const ac = new AbortController();
    emuAbort.current = ac; setEmulating(true);
    addLog("info", t("nfc.emulate.start"));
    tr.emulateNdef([uriRecord(/^https?:\/\//.test(emuText) ? emuText : `https://${emuText}`)], {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "activated") addLog("info", "reader activated");
        else if (e.type === "apdu") { addLog("rx", `← ${hex(e.command, " ")} ; ${e.note}`); addLog("tx", `→ ${hex(e.response, " ")}`); }
        else if (e.type === "released") addLog("info", "released");
        else if (e.type === "error") addLog("err", e.message);
      },
    }).catch((err) => { if (!NfcError.is(err, "aborted")) addLog("err", errText(lang, err)); }).finally(() => { setEmulating(false); emuAbort.current = null; });
  }, [emuText, addLog, onSystem, t, lang]);

  /* --------------------------- function menu ------------------------- */

  const opEnabled = useCallback((op: NfcOp): boolean => {
    if (!caps) return false;
    switch (op.id) {
      case "scan": case "read-uid": case "read-public": return true;
      case "ndef-read": return true;
      case "ndef-write": case "ndef-lock": case "conn-write": return caps.write;
      case "classic-read": case "classic-write": case "classic-dump": case "classic-restore": return caps.mifareAuth;
      case "ul-read": case "ul-write": case "ntag-read": case "ntag-write": case "ntag-counter": case "ul-password": case "ntag-password": return caps.raw;
      case "write-uid": return caps.raw || caps.mifareAuth;
      case "raw-apdu": case "select-aid": case "desfire-apps": case "emv-public": case "eid-public": return caps.apdu;
      case "app-template": return caps.apdu;
      case "m5-read": case "m5-write": case "m5-erase": case "conn-read": return caps.write || caps.raw || caps.apdu;
      case "m5-emulate": case "conn-emulate": return caps.emulate;
      default: return false; // desfire-files/read/write, felica-*, v-* — not on the web readers yet
    }
  }, [caps]);

  const runOp = useCallback((op: NfcOp) => {
    switch (op.id) {
      case "scan": toggleScan(); break;
      case "read-uid": case "read-public": doReadOnce(); break;
      case "ndef-read": doReadNdef(); setTab("ndef"); break;
      case "ndef-write": case "ndef-lock": setTab("ndef"); break;
      case "classic-dump": case "classic-read": setTab("mifare"); doDump(); break;
      case "classic-write": case "classic-restore": setTab("mifare"); break;
      case "ul-read": case "ntag-read": doUlRead(); break;
      case "ntag-counter": doCounter(); break;
      case "emv-public": runProbe("select-ppse"); break;
      case "eid-public": runProbe("select-mrtd"); break;
      case "desfire-apps": runProbe("get-version"); break;
      case "raw-apdu": case "select-aid": setTab("apdu"); setTplOpen(false); break;
      case "app-template": setTplOpen((v) => !v); break;
      case "m5-read": case "m5-write": case "m5-erase": setTab("m5"); break;
      case "conn-read": case "conn-write": setTab("conn"); break;
      case "m5-emulate": case "conn-emulate": setTab("emulate"); break;
      default: onSystem(`NFC: ${op.label} — ${t("nfc.ops.notOnReader")}`);
    }
  }, [toggleScan, doReadOnce, doReadNdef, doDump, doUlRead, doCounter, runProbe, onSystem, t]);

  const capacityBytes = useMemo(() => nominalCapacity(tech) ?? nominalCapacity("ndef"), [tech]);

  const busyIcon = <Loader2 className="nfcwb__spinicon" width={14} height={14} />;
  const ops = opsFor(tech);

  /* ------------------------------- render ---------------------------- */

  return (
    <div className="nfcwb">
      {/* reader selection */}
      <div className="nfcwb__section">
        <div className="nfcwb__section-title">
          <span>{t("nfc.reader")}</span>
          {connected ? <span className="nfcwb__badge nfcwb__badge--ok">{selectedTransport?.label}</span> : <span className="nfcwb__badge nfcwb__badge--no">{t("nfc.notConnected")}</span>}
        </div>
        <div className="nfcwb__transports">
          {NFC_READERS.map((r) => {
            const info = byId.get(READER_TRANSPORT[r.kind]);
            const supported = !!info?.supported;
            return (
              <button key={r.kind} type="button" className="nfcwb__transport" aria-pressed={reader === r.kind} disabled={connected || !supported} onClick={() => setReader(r.kind)}>
                <ReaderIcon kind={r.kind} />
                <span style={{ flex: 1 }}><span className="nfcwb__transport-name">{t(KIND_KEY[r.kind])}</span> <span className="nfcwb__hint">{info?.label}</span></span>
                <span className={`nfcwb__badge ${supported ? "nfcwb__badge--ok" : "nfcwb__badge--no"}`}>{supported ? t("nfc.reader.available") : t("nfc.reader.unavailable")}</span>
              </button>
            );
          })}
        </div>
        <div className="nfcwb__row">
          {!connected
            ? <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doConnect} disabled={!!busy || !selectedTransport?.supported}>{busy === "connect" ? busyIcon : <Plug width={14} height={14} />} {t("nfc.connect")}</button>
            : <button type="button" className="nfcwb__btn" onClick={doDisconnect} disabled={!!busy}><PlugZap width={14} height={14} /> {t("nfc.disconnect")}</button>}
          <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doReadOnce} disabled={!connected || !!busy}>{busy === "read" ? busyIcon : <ScanLine width={14} height={14} />} {t("nfc.scan.once")}</button>
          <button type="button" className={`nfcwb__btn ${scanning ? "nfcwb__btn--danger" : ""}`} onClick={toggleScan} disabled={!connected || (!!busy && !scanning)}>{scanning ? <Square width={14} height={14} /> : <Radio width={14} height={14} />} {scanning ? t("nfc.scan.stop") : t("nfc.scan.loop")}</button>
        </div>
      </div>

      {/* tabs */}
      <div className="nfcwb__tabs" role="tablist">
        {(["card", "ndef", "mifare", "m5", "conn", "apdu", "emulate"] as Tab[]).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="nfcwb__tab" onClick={() => setTab(id)}>
            {id === "card" ? t("nfc.card") : id === "ndef" ? t("nfc.ndef") : id === "mifare" ? "Mifare" : id === "m5" ? t("nfc.m5") : id === "conn" ? t("nfc.conn") : id === "apdu" ? t("nfc.apdu") : t("nfc.emulate")}
          </button>
        ))}
      </div>

      {/* CARD + function menu + UID */}
      {tab === "card" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span>{t("nfc.card.identity")}</span></div>
          {!identity ? <p className="nfcwb__hint">{t("nfc.card.none")}</p> : (
            <>
              <dl className="nfcwb__kv">
                <dt>{t("nfc.card.uid")}</dt><dd>{hex(identity.uid, " ") || "—"}</dd>
                {identity.sak !== undefined ? (<><dt>{t("nfc.card.sak")}</dt><dd>{hex([identity.sak])}</dd></>) : null}
                {identity.atqa ? (<><dt>{t("nfc.card.atqa")}</dt><dd>{hex(identity.atqa)}</dd></>) : null}
                {identity.ats ? (<><dt>{t("nfc.card.ats")}</dt><dd>{hex(identity.ats, " ")}</dd></>) : null}
                {identity.atr ? (<><dt>{t("nfc.card.atr")}</dt><dd>{hex(identity.atr, " ")}</dd></>) : null}
                <dt>{t("nfc.card.tech")}</dt><dd>{techInfo(tech).label}{identity.isoDep ? " · ISO-DEP" : ""}</dd>
              </dl>

              <div className="nfcwb__section-title"><span>{t("nfc.card.detected")}</span></div>
              {candidates.map((c) => (
                <div key={c.type} className="nfcwb__candidate">
                  <span className="nfcwb__conf">{Math.round(c.confidence * 100)}%</span>
                  <span><strong>{c.label}</strong><span className="nfcwb__hint"> — {c.reason}</span>
                    {c.probe ? <button type="button" className="nfcwb__btn nfcwb__btn--icon" disabled={!connected || !!busy} onClick={() => runProbe(c.probe!)}><Cpu width={12} height={12} /></button> : null}
                  </span>
                </div>
              ))}

              <div className="nfcwb__section-title"><span>{t("nfc.ops")}</span></div>
              <div className="nfcwb__ops">
                {ops.map((op) => {
                  const enabled = opEnabled(op);
                  return (
                    <button key={op.id} type="button" className="nfcwb__op" disabled={!connected || !!busy || !enabled} title={op.help} onClick={() => runOp(op)}>
                      <span>{t(`nfc.op.${op.id}`) || op.label}</span>
                      {op.needs ? <span className="nfcwb__op-needs">{op.needs === "pin" ? t("nfc.ops.needsPin") : op.needs === "account" ? t("nfc.ops.needsAccount") : op.needs === "keys-dictionary" ? t("nfc.ops.needsKeys") : t("nfc.ops.needsKey")}</span> : null}
                      {!enabled ? <span className="nfcwb__op-off">{t("nfc.ops.notOnReader")}</span> : null}
                    </button>
                  );
                })}
              </div>

              {/* Application templates (m5mobile.define.apduTemplates) */}
              {tplOpen && ops.some((o) => o.id === "app-template") ? (
                <div className="nfcwb__tplmenu" role="menu">
                  <div className="nfcwb__tplmenu-title"><SquareArrowDown width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.tpl.title")}</div>
                  {apduTemplates.length === 0
                    ? <div className="nfcwb__tplmenu-empty">{t("nfc.tpl.none")}</div>
                    : apduTemplates.map((tpl, i) => (
                        <button key={i} type="button" role="menuitem" className="nfcwb__tplmenu-item" disabled={!connected || !!busy}
                          onClick={() => applyTemplate(tpl)}>
                          <span>{String(tpl.label ?? tpl.name ?? `APDU ${i + 1}`)}</span>
                          {tpl.aid ? <span className="nfcwb__hint">{String(tpl.aid)}</span> : null}
                        </button>
                      ))}
                </div>
              ) : null}

              {/* Change UID (magic cards) */}
              <div className="nfcwb__section-title"><span><Fingerprint width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.uid.change")}</span></div>
              <div className="nfcwb__banner nfcwb__banner--warn">{t("nfc.uid.magicWarn")}</div>
              <label className="nfcwb__label">{t("nfc.uid.new")}
                <input className="nfcwb__input" value={newUid} onChange={(e) => setNewUid(e.target.value)} placeholder="DEADBEEF" />
              </label>
              <div className="nfcwb__row">
                <select className="nfcwb__input" value={uidGen} onChange={(e) => setUidGen(e.target.value as "gen1a" | "gen2")}>
                  <option value="gen1a">{t("nfc.uid.gen1a")}</option>
                  <option value="gen2">{t("nfc.uid.gen2")}</option>
                </select>
                <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={doWriteUid} disabled={!connected || !!busy || !caps?.raw || newUid.replace(/[^0-9a-f]/gi, "").length < 8}>
                  {busy === "write-uid" ? busyIcon : <KeyRound width={14} height={14} />} {t("nfc.uid.change")}
                </button>
              </div>

              <div className="nfcwb__section-title"><span>{t("nfc.tech.known")}</span></div>
              <div className="nfcwb__techs">{NFC_CATALOG.filter((x) => x.tech !== "unknown").map((x) => <span key={x.tech} className={`nfcwb__techchip ${x.tech === tech ? "nfcwb__techchip--on" : ""}`}>{x.label}</span>)}</div>
            </>
          )}
        </div>
      ) : null}

      {/* NDEF */}
      {tab === "ndef" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title">
            <span>{t("nfc.ndef.records")}</span>
            <div className="nfcwb__row">
              <button type="button" className="nfcwb__btn" onClick={doReadNdef} disabled={!connected || !!busy}><Download width={14} height={14} /> {t("nfc.ndef.read")}</button>
              <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doWriteNdef} disabled={!connected || !!busy || !ndefRecords.length}><Upload width={14} height={14} /> {t("nfc.ndef.write")}</button>
            </div>
          </div>
          {ndefRecords.length ? (
            <ul className="nfcwb__ndeflist">
              {ndefRecords.map((r, i) => (
                <li key={i}><span className="nfcwb__mono">{describeRecord(r)}</span>
                  <button type="button" className="nfcwb__btn nfcwb__btn--icon" onClick={() => setNdefRecords((p) => p.filter((_, j) => j !== i))}><Trash2 width={12} height={12} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="nfcwb__hint">{t("nfc.ndef.empty")}</p>}
          <label className="nfcwb__label">{t("nfc.ndef.text")}
            <div className="nfcwb__row"><input className="nfcwb__input" style={{ flex: 1 }} value={newText} onChange={(e) => setNewText(e.target.value)} />
              <button type="button" className="nfcwb__btn" disabled={!newText} onClick={() => { setNdefRecords((p) => [...p, textRecord(newText, lang)]); setNewText(""); }}>{t("nfc.ndef.addText")}</button>
            </div>
          </label>
          <label className="nfcwb__label">{t("nfc.ndef.uri")}
            <div className="nfcwb__row"><input className="nfcwb__input" style={{ flex: 1 }} value={newUri} onChange={(e) => setNewUri(e.target.value)} />
              <button type="button" className="nfcwb__btn" disabled={!newUri} onClick={() => setNdefRecords((p) => [...p, uriRecord(newUri)])}>{t("nfc.ndef.addUri")}</button>
            </div>
          </label>
        </div>
      ) : null}

      {/* MIFARE */}
      {tab === "mifare" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><KeyRound width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.keys")}</span></div>
          <p className="nfcwb__hint">{t("nfc.keys.hint")}</p>
          <div className="nfcwb__keys">
            {keyDict.map((k, i) => (
              <span key={i} className="nfcwb__keychip"><span className="nfcwb__mono">{k}</span><button type="button" className="nfcwb__btn nfcwb__btn--icon" onClick={() => setKeyDict((p) => p.filter((_, j) => j !== i))}><Trash2 width={11} height={11} /></button></span>
            ))}
          </div>
          <div className="nfcwb__row">
            <input className="nfcwb__input" style={{ flex: 1 }} placeholder={t("nfc.keys.placeholder")} maxLength={17}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.replace(/[^0-9a-f]/gi, "").toUpperCase(); if (v.length === 12) { setKeyDict((p) => [...new Set([...p, v])]); (e.target as HTMLInputElement).value = ""; } } }} />
            <span className="nfcwb__hint">{translate(lang, "nfc.keys.count").replace("{n}", String(keyDict.length))}</span>
          </div>
          {!caps?.mifareAuth ? <div className="nfcwb__banner nfcwb__banner--warn">{t("nfc.classic.needKeys")}</div> : null}
          <div className="nfcwb__row">
            {busy === "classic-dump"
              ? <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={() => abortRef.current?.abort()}><Square width={12} height={12} /> {t("nfc.scan.stop")}</button>
              : <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doDump} disabled={!connected || !!busy || !identity || !caps?.mifareAuth}><Play width={12} height={12} /> {t("nfc.classic.dump")}</button>}
            <button type="button" className="nfcwb__btn" onClick={doRestore} disabled={!connected || !!busy || !dump}><Upload width={12} height={12} /> {t("nfc.classic.restore")}</button>
            <button type="button" className="nfcwb__btn" onClick={saveDump} disabled={!dump}><Download width={12} height={12} /> {t("nfc.classic.saveDump")}</button>
          </div>
          {busy === "classic-dump" ? <div className="nfcwb__progress"><span style={{ width: `${dumpProgress}%` }} /></div> : null}
          {dump ? (
            <>
              <p className="nfcwb__hint">{dump.type.toUpperCase()} — {dump.readableBlocks}/{dump.totalBlocks}</p>
              <div className="nfcwb__sectors">
                {dump.sectors.map((s) => <div key={s.sector} className={`nfcwb__sector ${s.key ? "nfcwb__sector--open" : "nfcwb__sector--locked"}`} title={`S${s.sector} ${s.keyType ?? ""} ${s.key ?? "—"}`}>{s.sector}</div>)}
              </div>
              <div className="nfcwb__grid2">
                <label className="nfcwb__label">{t("nfc.classic.write")} #<input className="nfcwb__input" value={wBlock} onChange={(e) => setWBlock(e.target.value.replace(/\D/g, ""))} /></label>
                <label className="nfcwb__label">16 B hex<input className="nfcwb__input nfcwb__mono" value={wData} onChange={(e) => setWData(e.target.value)} placeholder="00112233…" /></label>
              </div>
              <button type="button" className="nfcwb__btn" onClick={doWriteBlock} disabled={!connected || !!busy || wData.replace(/[^0-9a-f]/gi, "").length !== 32}><Upload width={12} height={12} /> {t("nfc.classic.write")}</button>
            </>
          ) : null}
          <div className="nfcwb__section-title"><span>Ultralight / NTAG</span></div>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn" onClick={doUlRead} disabled={!connected || !!busy || !caps?.raw}><Download width={12} height={12} /> {t("nfc.ul.read")}</button>
            <button type="button" className="nfcwb__btn" onClick={doCounter} disabled={!connected || !!busy || !caps?.raw}><Cpu width={12} height={12} /> {t("nfc.ul.counter")}</button>
          </div>
        </div>
      ) : null}

      {/* M5Cet */}
      {tab === "m5" ? (
        <M5CardPanel lang={lang} getTransport={() => transportRef.current} identity={identity} setIdentity={setIdentity} connected={connected} busy={busy} run={runTask} log={addLog} onSystem={onSystem}
          onJoinRoom={onConnect} onImport={(rec: M5Record) => onSystem(`NFC: import ${rec.type}`)} capacityBytes={capacityBytes} />
      ) : null}

      {/* CONNECT TAG */}
      {tab === "conn" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><CreditCard width={14} height={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.conn")}</span></div>
          {!session ? <div className="nfcwb__banner nfcwb__banner--warn">{t("nfc.conn.noSession")}</div> : null}
          <label className="nfcwb__label">{t("nfc.conn.pin")}
            <input className="nfcwb__input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 16))} />
          </label>
          <label className="nfcwb__label">{t("nfc.conn.fallbackUrl")}
            <input className="nfcwb__input" value={fallbackUrl} onChange={(e) => setFallbackUrl(e.target.value)} placeholder="https://…" />
          </label>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doWriteConn} disabled={!connected || !!busy || !session || pin.length < 4}>{busy === "conn-write" ? busyIcon : <KeyRound width={14} height={14} />} {t("nfc.conn.write")}</button>
            <button type="button" className="nfcwb__btn" onClick={doReadConn} disabled={!connected || !!busy || pin.length < 4}>{busy === "conn-read" ? busyIcon : <ScanLine width={14} height={14} />} {t("nfc.conn.read")}</button>
          </div>
        </div>
      ) : null}

      {/* APDU */}
      {tab === "apdu" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><TerminalSquare width={14} height={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.apdu.script")}</span></div>
          <textarea className="nfcwb__textarea" value={apduText} onChange={(e) => setApduText(e.target.value)} spellCheck={false} />
          <div className="nfcwb__row">
            <label className="nfcwb__inline"><input type="checkbox" checked={apduContinue} onChange={(e) => setApduContinue(e.target.checked)} /> {t("nfc.apdu.continueOnError")}</label>
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doApdu} disabled={!connected || !!busy}>{busy === "apdu" ? busyIcon : <Play width={14} height={14} />} {t("nfc.apdu.run")}</button>
          </div>
        </div>
      ) : null}

      {/* EMULATE */}
      {tab === "emulate" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><Lock width={14} height={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("nfc.emulate")}</span></div>
          <div className="nfcwb__banner nfcwb__banner--warn">{t("nfc.emulate.note")}</div>
          <label className="nfcwb__label">{t("nfc.ndef.uri")}<input className="nfcwb__input" value={emuText} onChange={(e) => setEmuText(e.target.value)} /></label>
          <div className="nfcwb__row">
            {!emulating
              ? <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={startEmu} disabled={!connected || !caps?.emulate}><Play width={14} height={14} /> {t("nfc.emulate.start")}</button>
              : <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={() => emuAbort.current?.abort()}><Square width={14} height={14} /> {t("nfc.emulate.stop")}</button>}
          </div>
        </div>
      ) : null}

      {/* LOG */}
      <div className="nfcwb__section">
        <div className="nfcwb__section-title">
          <span>{t("nfc.log")}</span>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn nfcwb__btn--icon" onClick={() => { void navigator.clipboard?.writeText(log.map((l) => l.text).join("\n")); }}><Copy width={12} height={12} /> {t("nfc.log.copy")}</button>
            <button type="button" className="nfcwb__btn nfcwb__btn--icon" onClick={() => setLog([])}><Trash2 width={12} height={12} /> {t("nfc.log.clear")}</button>
          </div>
        </div>
        <div className="nfcwb__log">
          {log.length === 0 ? <span className="nfcwb__log-info">—</span> : log.map((l) => <div key={l.id} className={`nfcwb__log-${l.kind}`}>{l.text}</div>)}
        </div>
      </div>
    </div>
  );
}

export default NfcWorkbench;
