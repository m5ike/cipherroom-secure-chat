// NFC / RFID / smart-card workbench UI. Self-contained: its own string
// dictionary (cs/en/de), its own CSS, and it drives the lib/nfc transport
// + card layer directly. Mounted from App.tsx as a modal panel.
//
// Strings live in the local DICT below on purpose — the task requires this
// component NOT to depend on lib/i18n.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Usb, Radio, Bluetooth, Smartphone, Plug, PlugZap, ScanLine, KeyRound,
  Download, Upload, Cpu, TerminalSquare, CreditCard, Copy, Trash2, Play, Square, Loader2,
} from "lucide-react";
import "./nfc-workbench.css";
import {
  listTransports, createTransport, NfcError,
  type CardTransport, type CardIdentity, type TransportId, type TransportInfo,
} from "../lib/nfc/index";
import { detectCard, type Candidate } from "../lib/nfc/cards/detect";
import { hex, unhex } from "../lib/nfc/cards/apdu";
import { describeRecord, textRecord, uriRecord, type NdefRecord } from "../lib/nfc/cards/ndef";
import {
  buildConnectionRecords, decodeConnectionRecords, summarizeRecords, hasConnectionRecord,
} from "../lib/nfc/cards/connection-card";
import {
  readNdefAuto, writeType4Ndef, writeType2Ndef, ultralightGetVersion, desfireGetVersion,
  selectPpse, selectMrtd, mifareDictionaryAttack, runApduScript, type DictionaryResult,
} from "../lib/nfc/probes";

/* ---------- props ---------- */

export type NfcWorkbenchProps = {
  lang: "cs" | "en" | "de";
  session: { room: string; passphrase: string; name: string } | null;
  appVersion: string;
  onConnect: (p: { room: string; passphrase: string; name?: string }) => void;
  onSystem: (message: string) => void;
};

/* ---------- i18n (local, per task) ---------- */

type Lang = NfcWorkbenchProps["lang"];
type Dict = Record<string, string>;

const DICT: Record<Lang, Dict> = {
  cs: {
    transport: "Čtečka / transport", connect: "Připojit", disconnect: "Odpojit", supported: "dostupné",
    unsupported: "nedostupné", notConnected: "Nepřipojeno", connectedTo: "Připojeno:",
    tabCard: "Karta", tabNdef: "NDEF", tabConn: "Připojka", tabMifare: "Mifare", tabApdu: "APDU", tabEmulate: "Emulace",
    readCard: "Načíst kartu", waiting: "Čekám na kartu…", identity: "Identita karty", noCard: "Zatím žádná karta.",
    uid: "UID", atr: "ATR", ats: "ATS", sak: "SAK", atqa: "ATQA", tech: "Technologie", isodep: "ISO-DEP",
    detected: "Rozpoznáno", probe: "Zkusit sondu", readNdef: "Přečíst NDEF", writeNdef: "Zapsat NDEF",
    records: "Záznamy", addText: "+ Text", addUri: "+ URI", text: "Text", uri: "URI", lang: "Jazyk",
    writeConn: "Zapsat připojku", readConn: "Přečíst připojku a připojit", pin: "PIN (4–16 číslic)",
    noSession: "Nejsi připojen k místnosti — připojku lze zapsat až po připojení.",
    connFallbackUrl: "Záložní URL (volitelně)", dictAttack: "Slovníkový útok (default klíče)", stop: "Zastavit",
    sectorsOpen: "otevřených sektorů", apduScript: "APDU skript (hex, jeden na řádek)", run: "Spustit",
    continueOnError: "Pokračovat po chybě", emulate: "Emulovat NDEF tag (Type 4)", startEmu: "Spustit emulaci",
    stopEmu: "Zastavit emulaci", emuNote: "Emulaci karty umí jen PN532 přes Web Serial. Nic jiného v prohlížeči kartu emulovat neumí.",
    log: "Log", clearLog: "Vyčistit", copy: "Kopírovat", connectFirst: "Nejdřív připoj čtečku.",
    apduUnsupported: "Tento transport neumí APDU (jen NDEF).",
    getVersion: "GET_VERSION", emv: "EMV (PPSE)", mrtd: "ePas (MRTD)",
    connWrote: "Připojka zapsána.", connRead: "Připojka přečtena — připojuji.", noConnRecord: "Tag neobsahuje připojku.",
    building: "Připravuji…", done: "Hotovo.", cancelled: "Zrušeno.",
  },
  en: {
    transport: "Reader / transport", connect: "Connect", disconnect: "Disconnect", supported: "available",
    unsupported: "unavailable", notConnected: "Not connected", connectedTo: "Connected:",
    tabCard: "Card", tabNdef: "NDEF", tabConn: "Connect tag", tabMifare: "Mifare", tabApdu: "APDU", tabEmulate: "Emulate",
    readCard: "Read card", waiting: "Waiting for a card…", identity: "Card identity", noCard: "No card yet.",
    uid: "UID", atr: "ATR", ats: "ATS", sak: "SAK", atqa: "ATQA", tech: "Technology", isodep: "ISO-DEP",
    detected: "Detected", probe: "Run probe", readNdef: "Read NDEF", writeNdef: "Write NDEF",
    records: "Records", addText: "+ Text", addUri: "+ URI", text: "Text", uri: "URI", lang: "Lang",
    writeConn: "Write connect tag", readConn: "Read connect tag & join", pin: "PIN (4–16 digits)",
    noSession: "You are not in a room — a connect tag can only be written once connected.",
    connFallbackUrl: "Fallback URL (optional)", dictAttack: "Dictionary attack (default keys)", stop: "Stop",
    sectorsOpen: "sectors opened", apduScript: "APDU script (hex, one per line)", run: "Run",
    continueOnError: "Continue on error", emulate: "Emulate NDEF tag (Type 4)", startEmu: "Start emulation",
    stopEmu: "Stop emulation", emuNote: "Only a PN532 on Web Serial can emulate a card. Nothing else in a browser can.",
    log: "Log", clearLog: "Clear", copy: "Copy", connectFirst: "Connect a reader first.",
    apduUnsupported: "This transport has no APDU channel (NDEF only).",
    getVersion: "GET_VERSION", emv: "EMV (PPSE)", mrtd: "ePassport (MRTD)",
    connWrote: "Connect tag written.", connRead: "Connect tag read — joining.", noConnRecord: "Tag has no connect record.",
    building: "Working…", done: "Done.", cancelled: "Cancelled.",
  },
  de: {
    transport: "Leser / Transport", connect: "Verbinden", disconnect: "Trennen", supported: "verfügbar",
    unsupported: "nicht verfügbar", notConnected: "Nicht verbunden", connectedTo: "Verbunden:",
    tabCard: "Karte", tabNdef: "NDEF", tabConn: "Verbindungstag", tabMifare: "Mifare", tabApdu: "APDU", tabEmulate: "Emulation",
    readCard: "Karte lesen", waiting: "Warte auf Karte…", identity: "Kartenidentität", noCard: "Noch keine Karte.",
    uid: "UID", atr: "ATR", ats: "ATS", sak: "SAK", atqa: "ATQA", tech: "Technologie", isodep: "ISO-DEP",
    detected: "Erkannt", probe: "Sonde starten", readNdef: "NDEF lesen", writeNdef: "NDEF schreiben",
    records: "Datensätze", addText: "+ Text", addUri: "+ URI", text: "Text", uri: "URI", lang: "Spr.",
    writeConn: "Verbindungstag schreiben", readConn: "Verbindungstag lesen & beitreten", pin: "PIN (4–16 Ziffern)",
    noSession: "Kein Raum verbunden — ein Verbindungstag kann erst nach dem Verbinden geschrieben werden.",
    connFallbackUrl: "Fallback-URL (optional)", dictAttack: "Wörterbuchangriff (Standardschlüssel)", stop: "Stopp",
    sectorsOpen: "Sektoren geöffnet", apduScript: "APDU-Skript (Hex, eine pro Zeile)", run: "Ausführen",
    continueOnError: "Bei Fehler fortfahren", emulate: "NDEF-Tag emulieren (Type 4)", startEmu: "Emulation starten",
    stopEmu: "Emulation stoppen", emuNote: "Nur ein PN532 über Web Serial kann eine Karte emulieren. Sonst nichts im Browser.",
    log: "Log", clearLog: "Leeren", copy: "Kopieren", connectFirst: "Zuerst einen Leser verbinden.",
    apduUnsupported: "Dieser Transport hat keinen APDU-Kanal (nur NDEF).",
    getVersion: "GET_VERSION", emv: "EMV (PPSE)", mrtd: "ePass (MRTD)",
    connWrote: "Verbindungstag geschrieben.", connRead: "Verbindungstag gelesen — trete bei.", noConnRecord: "Tag hat keinen Verbindungsdatensatz.",
    building: "Arbeite…", done: "Fertig.", cancelled: "Abgebrochen.",
  },
};

/* ---------- error → localized message ---------- */

function errText(lang: Lang, err: unknown): string {
  if (NfcError.is(err)) {
    const byCode: Partial<Record<string, Record<Lang, string>>> = {
      unsupported: { cs: "Prohlížeč tohle API nepodporuje.", en: "This browser lacks the API.", de: "Dem Browser fehlt die API." },
      "permission-denied": { cs: "Přístup k zařízení zamítnut.", en: "Device permission denied.", de: "Gerätezugriff verweigert." },
      "no-device": { cs: "Nevybráno žádné zařízení.", en: "No device selected.", de: "Kein Gerät ausgewählt." },
      disconnected: { cs: "Zařízení bylo odpojeno.", en: "Device disconnected.", de: "Gerät getrennt." },
      "not-connected": { cs: "Čtečka není připojená.", en: "Reader not connected.", de: "Leser nicht verbunden." },
      timeout: { cs: "Vypršel čas — karta nepřiložena.", en: "Timed out waiting for a card.", de: "Zeitüberschreitung." },
      aborted: { cs: "Zrušeno.", en: "Cancelled.", de: "Abgebrochen." },
      "no-card": { cs: "V poli není karta.", en: "No card in the field.", de: "Keine Karte im Feld." },
      "auth-failed": { cs: "Autentizace selhala.", en: "Authentication failed.", de: "Authentifizierung fehlgeschlagen." },
      "not-supported-by-transport": { cs: "Tento transport to neumí.", en: "Not supported by this transport.", de: "Von diesem Transport nicht unterstützt." },
    };
    const m = byCode[err.code]?.[lang];
    return m ? `${m}${err.detail ? ` (${err.detail})` : ""}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/* ---------- transport icon ---------- */

function TransportIcon({ id }: { id: TransportId }) {
  const cls = { width: 16, height: 16 } as const;
  if (id === "webnfc") return <Smartphone {...cls} />;
  if (id === "webusb-ccid") return <Usb {...cls} />;
  if (id === "webserial-pn532") return <Radio {...cls} />;
  return <Bluetooth {...cls} />;
}

/* ---------- log ---------- */

type LogKind = "tx" | "rx" | "info" | "err";
type LogEntry = { id: number; kind: LogKind; text: string };

/* ---------- component ---------- */

type Tab = "card" | "ndef" | "conn" | "mifare" | "apdu" | "emulate";

export function NfcWorkbench(props: NfcWorkbenchProps): React.JSX.Element {
  const { lang, session, appVersion, onConnect, onSystem } = props;
  const t = useCallback((k: keyof typeof DICT["en"]) => DICT[lang][k] ?? DICT.en[k] ?? k, [lang]);

  const transports = useMemo<TransportInfo[]>(() => listTransports(), []);
  const [selectedId, setSelectedId] = useState<TransportId>(() => transports.find((x) => x.supported)?.id ?? "webnfc");
  const [tab, setTab] = useState<Tab>("card");
  const [busy, setBusy] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState<CardIdentity | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);
  const transportRef = useRef<CardTransport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const addLog = useCallback((kind: LogKind, text: string) => {
    setLog((prev) => [...prev.slice(-400), { id: logId.current++, kind, text }]);
  }, []);

  // Tear down the transport on unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
    transportRef.current?.disconnect().catch(() => {});
  }, []);

  const selectedInfo = transports.find((x) => x.id === selectedId);
  const caps = transportRef.current?.capabilities;

  const runTask = useCallback(async (name: string, fn: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(name);
    try {
      await fn(ac.signal);
    } catch (err) {
      const msg = errText(lang, err);
      addLog("err", `✗ ${msg}`);
      onSystem(`NFC: ${msg}`);
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  }, [busy, lang, addLog, onSystem]);

  /* ----- connect / disconnect ----- */

  const doConnect = useCallback(() => runTask("connect", async () => {
    if (transportRef.current) { await transportRef.current.disconnect().catch(() => {}); }
    const tr = createTransport(selectedId);
    tr.onTrace?.((dir, bytes, note) => addLog(dir, `${dir === "tx" ? "→" : "←"} ${hex(bytes, " ")}${note ? `  ; ${note}` : ""}`));
    tr.onDisconnect(() => { setConnected(false); addLog("err", "device disconnected"); onSystem("NFC: device disconnected."); });
    await tr.connect();
    transportRef.current = tr;
    setConnected(true);
    addLog("info", `${t("connectedTo")} ${tr.label}`);
  }), [runTask, selectedId, addLog, onSystem, t]);

  const doDisconnect = useCallback(() => runTask("disconnect", async () => {
    abortRef.current?.abort();
    await transportRef.current?.disconnect();
    transportRef.current = null;
    setConnected(false);
    setIdentity(null);
    setCandidates([]);
    addLog("info", "disconnected");
  }), [runTask, addLog]);

  /* ----- read card ----- */

  const doReadCard = useCallback(() => runTask("read", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    addLog("info", t("waiting"));
    const id = await tr.waitForCard({ timeoutMs: 30_000, signal });
    setIdentity(id);
    const ranked = detectCard(id);
    setCandidates(ranked);
    addLog("info", `UID ${hex(id.uid) || "-"}  SAK ${id.sak !== undefined ? hex([id.sak]) : "-"}  → ${ranked[0]?.label ?? "?"}`);
    // Opportunistically read NDEF if the card looks like a tag.
    if (id.ndef?.length || id.isoDep || tr.capabilities.raw) {
      try {
        const res = await readNdefAuto(tr, id);
        if (res.records.length) {
          setNdefRecords(res.records);
          addLog("rx", `NDEF (${res.source}): ${summarizeRecords(res.records)}`);
          if (hasConnectionRecord(res.records)) addLog("info", "→ M5cet připojka detected (open the Connect tag tab)");
        }
      } catch (e) { if (!NfcError.is(e, "not-supported-by-transport") && !NfcError.is(e, "card-error")) throw e; }
    }
    onSystem(`NFC: ${ranked[0]?.label ?? "card"} — UID ${hex(id.uid) || "n/a"}`);
  }), [runTask, addLog, onSystem, t]);

  /* ----- NDEF editor ----- */

  const [ndefRecords, setNdefRecords] = useState<NdefRecord[]>([]);
  const [newText, setNewText] = useState("");
  const [newTextLang, setNewTextLang] = useState(lang);
  const [newUri, setNewUri] = useState("https://");

  const doWriteNdef = useCallback(() => runTask("write-ndef", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    if (!ndefRecords.length) return;
    if (tr.id === "webnfc" && tr.writeNdef) { await tr.writeNdef(ndefRecords, { overwrite: true }); }
    else if (identity?.isoDep) { await writeType4Ndef(tr, ndefRecords); }
    else { await writeType2Ndef(tr, ndefRecords); }
    addLog("info", `NDEF written (${ndefRecords.length} record(s))`);
    onSystem(`NFC: ${t("done")}`);
  }), [runTask, ndefRecords, identity, addLog, onSystem, t]);

  const doReadNdef = useCallback(() => runTask("read-ndef", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    const id = identity ?? await tr.waitForCard({ timeoutMs: 30_000, signal });
    if (!identity) setIdentity(id);
    const res = await readNdefAuto(tr, id);
    setNdefRecords(res.records);
    addLog("rx", `NDEF (${res.source}): ${res.records.map(describeRecord).join(" | ") || "empty"}`);
  }), [runTask, identity, addLog, onSystem, t]);

  /* ----- connect tag ----- */

  const [pin, setPin] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");

  const doWriteConn = useCallback(() => runTask("write-conn", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    if (!session) { onSystem(`NFC: ${t("noSession")}`); return; }
    const records = await buildConnectionRecords(
      { room: session.room, passphrase: session.passphrase, name: session.name },
      pin,
      { appVersion, fallbackUrl: fallbackUrl || undefined },
    );
    if (tr.id === "webnfc" && tr.writeNdef) await tr.writeNdef(records, { overwrite: true });
    else if (identity?.isoDep) await writeType4Ndef(tr, records);
    else await writeType2Ndef(tr, records);
    addLog("info", t("connWrote"));
    onSystem(`NFC: ${t("connWrote")}`);
  }), [runTask, session, pin, appVersion, fallbackUrl, identity, addLog, onSystem, t]);

  const doReadConn = useCallback(() => runTask("read-conn", async (signal) => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    const id = await tr.waitForCard({ timeoutMs: 30_000, signal });
    setIdentity(id);
    const res = await readNdefAuto(tr, id);
    if (!hasConnectionRecord(res.records)) { onSystem(`NFC: ${t("noConnRecord")}`); addLog("err", t("noConnRecord")); return; }
    const payload = await decodeConnectionRecords(res.records, pin);
    addLog("info", `${t("connRead")} room=${payload.room}`);
    onSystem(`NFC: ${t("connRead")}`);
    onConnect({ room: payload.room, passphrase: payload.passphrase, name: payload.name });
  }), [runTask, pin, onConnect, addLog, onSystem, t]);

  /* ----- probes ----- */

  const doProbe = useCallback((kind: Candidate["probe"] | "get-version-ul" | "get-version-df") => runTask("probe", async () => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    if (kind === "select-ppse") {
      const r = await selectPpse(tr);
      addLog(r.present ? "rx" : "info", r.present ? `EMV PPSE: ${r.label ?? ""} AIDs ${r.aids.join(", ")}\n${r.tree}` : `PPSE: ${r.tree}`);
    } else if (kind === "select-mrtd") {
      const r = await selectMrtd(tr);
      addLog(r.present ? "rx" : "info", `MRTD select: ${r.present ? "present" : "absent"} (${r.sw})`);
    } else if (kind === "get-version" || kind === "get-version-df") {
      try { const v = await desfireGetVersion(tr); addLog("rx", v.text); }
      catch { const v = await ultralightGetVersion(tr); addLog("rx", `${v.product} (${v.storageBytes} B): ${hex(v.raw, " ")}`); }
    } else if (kind === "get-version-ul") {
      const v = await ultralightGetVersion(tr); addLog("rx", `${v.product}: ${hex(v.raw, " ")}`);
    }
  }), [runTask, identity, addLog, onSystem, t]);

  /* ----- mifare dictionary ----- */

  const [dict, setDict] = useState<DictionaryResult | null>(null);
  const [dictProgress, setDictProgress] = useState(0);

  const doDict = useCallback(() => runTask("dict", async (signal) => {
    const tr = transportRef.current;
    if (!tr || !identity) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    setDict(null); setDictProgress(0);
    const result = await mifareDictionaryAttack(tr, identity, {
      signal,
      onProgress: (s, total) => setDictProgress(Math.round(((s + 1) / total) * 100)),
    });
    setDict(result);
    addLog("info", `Mifare ${result.type}: ${result.recoveredSectors}/${result.totalSectors} ${t("sectorsOpen")}`);
    onSystem(`NFC: Mifare ${result.recoveredSectors}/${result.totalSectors} ${t("sectorsOpen")}`);
  }), [runTask, identity, addLog, onSystem, t]);

  /* ----- apdu console ----- */

  const [apduText, setApduText] = useState("00A4040007D276000085010100\n00B0000010");
  const [apduContinue, setApduContinue] = useState(false);

  const doApdu = useCallback(() => runTask("apdu", async () => {
    const tr = transportRef.current;
    if (!tr) { onSystem(`NFC: ${t("connectFirst")}`); return; }
    if (!tr.capabilities.apdu) { addLog("err", t("apduUnsupported")); return; }
    const apdus = apduText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => unhex(l));
    const steps = await runApduScript(tr, apdus, { continueOnError: apduContinue });
    for (const s of steps) {
      addLog("tx", `→ ${hex(s.apdu, " ")}`);
      addLog(s.ok ? "rx" : "err", `← ${hex(s.response.data, " ")} ${hex([s.response.sw1, s.response.sw2])} ; ${s.note}`);
    }
  }), [runTask, apduText, apduContinue, addLog, onSystem, t]);

  /* ----- emulation ----- */

  const [emuText, setEmuText] = useState("m5cet.app");
  const emuAbort = useRef<AbortController | null>(null);
  const [emulating, setEmulating] = useState(false);

  const startEmu = useCallback(() => {
    const tr = transportRef.current;
    if (!tr?.emulateNdef) { onSystem(`NFC: ${t("emuNote")}`); return; }
    const ac = new AbortController();
    emuAbort.current = ac;
    setEmulating(true);
    addLog("info", "emulating NDEF Type 4 tag…");
    tr.emulateNdef([uriRecord(/^https?:\/\//.test(emuText) ? emuText : `https://${emuText}`)], {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === "activated") addLog("info", "reader activated");
        else if (e.type === "apdu") { addLog("rx", `← ${hex(e.command, " ")} ; ${e.note}`); addLog("tx", `→ ${hex(e.response, " ")}`); }
        else if (e.type === "released") addLog("info", "emulation released");
        else if (e.type === "error") addLog("err", e.message);
      },
    }).catch((err) => { if (!NfcError.is(err, "aborted")) addLog("err", errText(lang, err)); })
      .finally(() => { setEmulating(false); emuAbort.current = null; });
  }, [emuText, addLog, onSystem, t, lang]);

  const stopEmu = useCallback(() => { emuAbort.current?.abort(); }, []);

  /* ---------- render ---------- */

  const busyIcon = <Loader2 className="nfcwb__spin" style={{ border: "none", width: 14, height: 14 }} />;

  return (
    <div className="nfcwb">
      {/* transport picker */}
      <div className="nfcwb__section">
        <div className="nfcwb__section-title">
          <span>{t("transport")}</span>
          {connected
            ? <span className="nfcwb__badge nfcwb__badge--ok">{selectedInfo?.label}</span>
            : <span className="nfcwb__badge nfcwb__badge--no">{t("notConnected")}</span>}
        </div>
        <div className="nfcwb__transports">
          {transports.map((tr) => (
            <button
              key={tr.id}
              type="button"
              className="nfcwb__transport"
              aria-pressed={selectedId === tr.id}
              disabled={connected || !tr.supported}
              onClick={() => setSelectedId(tr.id)}
            >
              <TransportIcon id={tr.id} />
              <span style={{ flex: 1 }}>
                <span className="nfcwb__transport-name">{tr.label}</span>
              </span>
              <span className={`nfcwb__badge ${tr.supported ? "nfcwb__badge--ok" : "nfcwb__badge--no"}`}>
                {tr.supported ? t("supported") : t("unsupported")}
              </span>
            </button>
          ))}
        </div>
        <div className="nfcwb__row">
          {!connected ? (
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doConnect} disabled={!!busy || !selectedInfo?.supported}>
              {busy === "connect" ? busyIcon : <Plug width={14} height={14} />} {t("connect")}
            </button>
          ) : (
            <button type="button" className="nfcwb__btn" onClick={doDisconnect} disabled={!!busy}>
              <PlugZap width={14} height={14} /> {t("disconnect")}
            </button>
          )}
          <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doReadCard} disabled={!connected || !!busy}>
            {busy === "read" ? busyIcon : <ScanLine width={14} height={14} />} {t("readCard")}
          </button>
        </div>
      </div>

      {/* tabs */}
      <div className="nfcwb__tabs" role="tablist">
        {([["card", t("tabCard")], ["ndef", t("tabNdef")], ["conn", t("tabConn")], ["mifare", t("tabMifare")], ["apdu", t("tabApdu")], ["emulate", t("tabEmulate")]] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="nfcwb__tab" onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {/* CARD */}
      {tab === "card" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span>{t("identity")}</span></div>
          {!identity ? (
            <p className="nfcwb__hint">{t("noCard")}</p>
          ) : (
            <>
              <dl className="nfcwb__kv">
                <dt>{t("uid")}</dt><dd>{hex(identity.uid, " ") || "—"}</dd>
                {identity.sak !== undefined ? (<><dt>{t("sak")}</dt><dd>{hex([identity.sak])}</dd></>) : null}
                {identity.atqa ? (<><dt>{t("atqa")}</dt><dd>{hex(identity.atqa)}</dd></>) : null}
                {identity.ats ? (<><dt>{t("ats")}</dt><dd>{hex(identity.ats, " ")}</dd></>) : null}
                {identity.atr ? (<><dt>{t("atr")}</dt><dd>{hex(identity.atr, " ")}</dd></>) : null}
                <dt>{t("tech")}</dt><dd>{identity.tech}{identity.isoDep ? " · ISO-DEP" : ""}</dd>
              </dl>
              <div className="nfcwb__section-title"><span>{t("detected")}</span></div>
              {candidates.map((c) => (
                <div key={c.type} className="nfcwb__candidate">
                  <span className="nfcwb__conf">{Math.round(c.confidence * 100)}%</span>
                  <span>
                    <strong>{c.label}</strong>
                    <span className="nfcwb__hint"> — {c.reason}</span>
                    {c.probe ? (
                      <button type="button" className="nfcwb__btn" style={{ minHeight: "1.75rem", marginLeft: 6 }} disabled={!connected || !!busy} onClick={() => doProbe(c.probe!)}>
                        <Cpu width={12} height={12} /> {t("probe")}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}

      {/* NDEF */}
      {tab === "ndef" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title">
            <span>{t("records")}</span>
            <div className="nfcwb__row">
              <button type="button" className="nfcwb__btn" onClick={doReadNdef} disabled={!connected || !!busy}><Download width={14} height={14} /> {t("readNdef")}</button>
              <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doWriteNdef} disabled={!connected || !!busy || !ndefRecords.length}><Upload width={14} height={14} /> {t("writeNdef")}</button>
            </div>
          </div>
          {ndefRecords.length ? (
            <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.75rem" }}>
              {ndefRecords.map((r, i) => (
                <li key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{describeRecord(r)}</span>
                  <button type="button" className="nfcwb__btn" style={{ minHeight: "1.5rem", padding: "0 6px" }} onClick={() => setNdefRecords((p) => p.filter((_, j) => j !== i))}><Trash2 width={12} height={12} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="nfcwb__hint">{t("noCard")}</p>}
          <div className="nfcwb__grid2">
            <label className="nfcwb__label">{t("text")}
              <input className="nfcwb__input" value={newText} onChange={(e) => setNewText(e.target.value)} />
            </label>
            <label className="nfcwb__label">{t("lang")}
              <input className="nfcwb__input" value={newTextLang} onChange={(e) => setNewTextLang(e.target.value as Lang)} maxLength={5} />
            </label>
          </div>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn" disabled={!newText} onClick={() => { setNdefRecords((p) => [...p, textRecord(newText, newTextLang)]); setNewText(""); }}>{t("addText")}</button>
          </div>
          <label className="nfcwb__label">{t("uri")}
            <div className="nfcwb__row">
              <input className="nfcwb__input" style={{ flex: 1 }} value={newUri} onChange={(e) => setNewUri(e.target.value)} />
              <button type="button" className="nfcwb__btn" disabled={!newUri} onClick={() => setNdefRecords((p) => [...p, uriRecord(newUri)])}>{t("addUri")}</button>
            </div>
          </label>
        </div>
      ) : null}

      {/* CONNECT TAG */}
      {tab === "conn" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><CreditCard width={14} height={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("tabConn")}</span></div>
          {!session ? <div className="nfcwb__banner nfcwb__banner--warn">{t("noSession")}</div> : null}
          <label className="nfcwb__label">{t("pin")}
            <input className="nfcwb__input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 16))} />
          </label>
          <label className="nfcwb__label">{t("connFallbackUrl")}
            <input className="nfcwb__input" value={fallbackUrl} onChange={(e) => setFallbackUrl(e.target.value)} placeholder="https://…" />
          </label>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doWriteConn} disabled={!connected || !!busy || !session || pin.length < 4}>
              {busy === "write-conn" ? busyIcon : <KeyRound width={14} height={14} />} {t("writeConn")}
            </button>
            <button type="button" className="nfcwb__btn" onClick={doReadConn} disabled={!connected || !!busy || pin.length < 4}>
              {busy === "read-conn" ? busyIcon : <ScanLine width={14} height={14} />} {t("readConn")}
            </button>
          </div>
        </div>
      ) : null}

      {/* MIFARE */}
      {tab === "mifare" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title">
            <span>{t("dictAttack")}</span>
            {busy === "dict"
              ? <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={() => abortRef.current?.abort()}><Square width={12} height={12} /> {t("stop")}</button>
              : <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doDict} disabled={!connected || !!busy || !identity}><Play width={12} height={12} /> {t("run")}</button>}
          </div>
          {!caps?.mifareAuth ? <p className="nfcwb__hint">{t("apduUnsupported")}</p> : null}
          {busy === "dict" ? <div className="nfcwb__progress"><span style={{ width: `${dictProgress}%` }} /></div> : null}
          {dict ? (
            <>
              <p className="nfcwb__hint">{dict.type.toUpperCase()} — {dict.recoveredSectors}/{dict.totalSectors} {t("sectorsOpen")}</p>
              <div className="nfcwb__sectors">
                {dict.sectors.map((s) => {
                  const cls = s.keyA && s.keyB ? "nfcwb__sector--open" : s.keyA || s.keyB ? "nfcwb__sector--partial" : "nfcwb__sector--locked";
                  return <div key={s.sector} className={`nfcwb__sector ${cls}`} title={`S${s.sector} A:${s.keyA ?? "—"} B:${s.keyB ?? "—"}`}>{s.sector}</div>;
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* APDU */}
      {tab === "apdu" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span><TerminalSquare width={14} height={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("apduScript")}</span></div>
          <textarea className="nfcwb__textarea" value={apduText} onChange={(e) => setApduText(e.target.value)} spellCheck={false} />
          <div className="nfcwb__row">
            <label className="nfcwb__row" style={{ fontSize: "0.75rem", gap: 4 }}>
              <input type="checkbox" checked={apduContinue} onChange={(e) => setApduContinue(e.target.checked)} /> {t("continueOnError")}
            </label>
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={doApdu} disabled={!connected || !!busy}>
              {busy === "apdu" ? busyIcon : <Play width={14} height={14} />} {t("run")}
            </button>
          </div>
        </div>
      ) : null}

      {/* EMULATE */}
      {tab === "emulate" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__section-title"><span>{t("emulate")}</span></div>
          <div className="nfcwb__banner nfcwb__banner--warn">{t("emuNote")}</div>
          <label className="nfcwb__label">{t("uri")}
            <input className="nfcwb__input" value={emuText} onChange={(e) => setEmuText(e.target.value)} />
          </label>
          <div className="nfcwb__row">
            {!emulating
              ? <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={startEmu} disabled={!connected || !caps?.emulate}><Play width={14} height={14} /> {t("startEmu")}</button>
              : <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={stopEmu}><Square width={14} height={14} /> {t("stopEmu")}</button>}
          </div>
        </div>
      ) : null}

      {/* LOG */}
      <div className="nfcwb__section">
        <div className="nfcwb__section-title">
          <span>{t("log")}</span>
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn" style={{ minHeight: "1.75rem" }} onClick={() => { void navigator.clipboard?.writeText(log.map((l) => l.text).join("\n")); }}><Copy width={12} height={12} /> {t("copy")}</button>
            <button type="button" className="nfcwb__btn" style={{ minHeight: "1.75rem" }} onClick={() => setLog([])}><Trash2 width={12} height={12} /> {t("clearLog")}</button>
          </div>
        </div>
        <div className="nfcwb__log">
          {log.length === 0 ? <span className="nfcwb__log-info">—</span> : log.map((l) => (
            <div key={l.id} className={`nfcwb__log-${l.kind}`}>{l.text}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default NfcWorkbench;
