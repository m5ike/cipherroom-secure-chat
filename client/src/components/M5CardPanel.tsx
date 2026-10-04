// The M5Cet card panel (6.3, tasks 5 & 6): the READER that lists a card's
// records and opens each with its PIN or the account, and the visual BUILDER
// that assembles a card's records and writes them.
//
// It leans on lib/nfc/m5card.ts (the container format) and lib/nfc/m5cet-card
// (the tag I/O + capacity), and never keeps a key or PIN longer than the one
// operation that needs it.

import { useCallback, useMemo, useRef, useState } from "react";
import { KeyRound, Plus, ArrowUp, ArrowDown, Trash2, Save, ScanLine, FilePlus2, Pencil } from "lucide-react";
import { MenuIcon } from "./MenuIcon";
import { t as translate, type Lang } from "../lib/i18n";
import { RECORD_META, BUILDABLE_RECORDS, recordSummary, type CardFile } from "../lib/nfc/records";
import {
  buildCard, openRecord, cardKeys, isValidCardPin, decodeContainer,
  type M5Record, type M5RecordType, type SealedRecord, type M5CardMode,
} from "../lib/nfc/m5card";
import {
  readM5Card, writeM5Card, eraseRecordAndRewrite, estimateContainerBytes,
  estimateNdefBytes, nominalCapacity,
} from "../lib/nfc/m5cet-card";
import type { Bytes } from "../lib/crypto";
import { currentAccount, confirmAccountRoot, isSignedIn } from "../lib/account";
import type { CardTransport, CardIdentity } from "../lib/nfc/transport";
import { NfcError } from "../lib/nfc/errors";
import { isHttpsUrl } from "../lib/site-path";

export type M5CardPanelProps = {
  lang: Lang;
  getTransport: () => CardTransport | null;
  identity: CardIdentity | null;
  setIdentity: (id: CardIdentity) => void;
  connected: boolean;
  busy: string | null;
  run: (name: string, fn: (signal: AbortSignal) => Promise<void>) => void;
  log: (kind: "tx" | "rx" | "info" | "err", text: string) => void;
  onSystem: (message: string) => void;
  /** Join a server room carried by a server-room record. */
  onJoinRoom?: (p: { room: string; passphrase: string; name?: string }) => void;
  /** Hand an opened key/identity/passkey record to the app's import. */
  onImport?: (rec: M5Record) => void;
  /** Usable NDEF capacity of the present tag, when the workbench knows it. */
  capacityBytes?: number;
};

/** Flatten the builder's draft fields into the record's real data shape. */
function finalizeData(draft: Draft): Record<string, unknown> {
  const d = draft.data;
  if (draft.type === "message" || draft.type === "one-time-message") {
    const out: Record<string, unknown> = {};
    for (const f of ["text", "url", "key"] as const) if (d[f]) out[f] = d[f];
    if (d.file) out.file = d.file;
    if (d.serverRefId) out.serverRef = { id: d.serverRefId, ...(d.serverRefServer ? { server: d.serverRefServer } : {}) };
    return out;
  }
  return d;
}

type Draft = { key: number; type: M5RecordType; mode: M5CardMode; oneTime: boolean; data: Record<string, unknown> };

function defaultData(type: M5RecordType): Record<string, unknown> {
  switch (type) {
    case "message": case "one-time-message": return { text: "" };
    case "server-room": return { server: "", room: "", passphrase: "", name: "" };
    case "wifi": return { ssid: "", password: "", auth: "WPA" };
    case "url-login": return { url: "https://", user: "", password: "" };
    case "contact": return { name: "", tel: "", email: "" };
    case "external-key": return { label: "", key: "", algo: "" };
    case "passkey-backup": { const a = currentAccount(); return { account: { id: a?.id ?? "", username: a?.username ?? a?.userName ?? "" }, root: "", at: Date.now() }; }
    case "identity-backup": { const a = currentAccount(); return { user: a?.username ?? a?.userName ?? "", keys: {}, at: Date.now() }; }
  }
}

function downloadText(name: string, mime: string, content: string): void {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch { /* no DOM download here */ }
}

function vcardOf(d: { name?: string; tel?: string; email?: string; org?: string; url?: string; note?: string }): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${d.name ?? ""}`];
  if (d.org) lines.push(`ORG:${d.org}`);
  if (d.tel) lines.push(`TEL:${d.tel}`);
  if (d.email) lines.push(`EMAIL:${d.email}`);
  if (d.url) lines.push(`URL:${d.url}`);
  if (d.note) lines.push(`NOTE:${d.note}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

function wifiString(d: { ssid?: string; password?: string; auth?: string; hidden?: boolean }): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  return `WIFI:T:${d.auth ?? "WPA"};S:${esc(d.ssid ?? "")};P:${esc(d.password ?? "")};${d.hidden ? "H:true;" : ""};`;
}

/** A localized, human message for a card-write failure (the write helpers
 *  raise typed NfcError codes with a machine `detail`). */
function writeErrorText(lang: Lang, err: unknown): string {
  if (NfcError.is(err)) {
    switch (err.code) {
      case "read-only": return translate(lang, "nfc.err.readOnly");
      case "too-small": {
        const [need, have] = (err.detail ?? "").split("/");
        return translate(lang, "nfc.err.tooSmall").replace("{need}", need ?? "?").replace("{have}", have ?? "?");
      }
      case "no-key": return translate(lang, "nfc.err.noKey").replace("{sector}", err.detail ?? "?");
      case "not-supported-by-transport": return translate(lang, "nfc.err.notWritable");
      default: return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function M5CardPanel(props: M5CardPanelProps): React.JSX.Element {
  const { lang, getTransport, identity, setIdentity, connected, busy, run, log, onSystem, onJoinRoom, onImport } = props;
  const keyCounter = useRef(1);
  const tr = useCallback((k: string) => translate(lang, k), [lang]);
  const [mode, setMode] = useState<"read" | "build">("read");

  /* ------------------------------------------------------- reader state */
  const [sealed, setSealed] = useState<SealedRecord[] | null>(null);
  const [container, setContainer] = useState<Bytes | null>(null);
  const [pin, setPin] = useState("");
  const [detail, setDetail] = useState<{ rec: M5Record; note?: string } | null>(null);

  const readCard = useCallback(() => run("m5-read", async (signal) => {
    const t = getTransport();
    if (!t) { onSystem(`NFC: ${tr("nfc.connectFirst")}`); return; }
    const id = identity ?? await t.waitForCard({ timeoutMs: 30_000, signal });
    if (!identity) setIdentity(id);
    const card = await readM5Card(t, id);
    if (!card) { setSealed(null); setContainer(null); onSystem(`NFC: ${tr("nfc.m5.none")}`); log("info", tr("nfc.m5.none")); return; }
    setSealed(card.sealed); setContainer(card.container); setDetail(null);
    log("info", `${tr("nfc.m5.detected")} — ${card.sealed.length}`);
    onSystem(`NFC: ${tr("nfc.m5.detected")}`);
  }), [run, getTransport, identity, setIdentity, onSystem, tr, log]);

  const keyProviderFor = useCallback(async (recMode: M5CardMode) => {
    if (recMode === "internal") {
      if (!isSignedIn()) throw new Error(tr("nfc.m5.needAccount"));
      const root = await confirmAccountRoot();
      return cardKeys(null, root as Bytes | null);
    }
    if (!isValidCardPin(pin)) throw new Error(tr("nfc.m5.pin"));
    return cardKeys(pin, null);
  }, [pin, tr]);

  const actOnRecord = useCallback(async (rec: M5Record) => {
    const meta = RECORD_META[rec.type];
    const d = rec.data as Record<string, unknown>;
    if (meta.action === "display") {
      const text = typeof d.text === "string" ? d.text : "";
      const url = typeof d.url === "string" ? d.url : "";
      setDetail({ rec });
      if (text) onSystem(text);
      if (url) onSystem(url);
      if (rec.oneTime && container && identity) {
        const t = getTransport();
        if (t) {
          try { const next = await eraseRecordAndRewrite(t, identity, container, rec.id); setContainer(next); setSealed(decodeContainer(next)); onSystem(`NFC: ${tr("nfc.m5.oneTimeGone")}`); }
          catch { onSystem(`NFC: ${tr("nfc.m5.oneTimeKept")}`); }
        }
      }
    } else if (meta.action === "save") {
      if (rec.type === "wifi") { setDetail({ rec, note: wifiString(d) }); onSystem(`NFC: ${recordSummary("wifi", d)}`); }
      else if (rec.type === "contact") { downloadText(`${String(d.name ?? "contact")}.vcf`, "text/vcard", typeof d.vcard === "string" ? d.vcard : vcardOf(d)); onSystem(`NFC: ${tr("nfc.rec.saveContact")}`); }
      else if (rec.type === "url-login") { try { await navigator.clipboard?.writeText(String(d.password ?? "")); } catch { /* clipboard blocked */ } setDetail({ rec }); }
      else { onImport?.(rec); setDetail({ rec }); onSystem(`NFC: ${tr(RECORD_META[rec.type].label)} → ${tr("nfc.rec.import")}`); }
    } else { // run
      if (rec.type === "server-room" && onJoinRoom) onJoinRoom({ room: String(d.room ?? ""), passphrase: String(d.passphrase ?? ""), name: typeof d.name === "string" ? d.name : undefined });
      // 6.7 (N29): only an https: link opens — never javascript:, data: or blob: from a card.
      else { const url = String(d.url ?? ""); if (isHttpsUrl(url)) window.open(url, "_blank", "noopener"); else if (url) onSystem(`NFC: ${tr("nfc.urlRefused")}`); }
    }
  }, [container, identity, getTransport, sealed, onSystem, tr, onImport, onJoinRoom]);

  const openOne = useCallback((s: SealedRecord) => run("m5-open", async () => {
    const keys = await keyProviderFor(s.mode);
    const rec = await openRecord(s, keys);
    log("rx", `${tr(RECORD_META[rec.type].label)}: ${recordSummary(rec.type, rec.data)}`);
    await actOnRecord(rec);
  }), [run, keyProviderFor, actOnRecord, log, tr]);

  /* -------------------------------------------------------- builder state */
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [pickType, setPickType] = useState<M5RecordType>("message");
  const [buildPin, setBuildPin] = useState("");

  const addDraft = useCallback(() => {
    setDrafts((p) => [...p, { key: keyCounter.current++, type: pickType, mode: RECORD_META[pickType].accountOnly ? "internal" : "external", oneTime: !!RECORD_META[pickType].oneTimeDefault, data: defaultData(pickType) }]);
  }, [pickType]);

  const patch = useCallback((key: number, up: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => {
    setDrafts((p) => p.map((d) => d.key === key ? { ...d, ...(typeof up === "function" ? up(d) : up) } : d));
  }, []);
  const patchData = useCallback((key: number, field: string, value: unknown) => {
    setDrafts((p) => p.map((d) => d.key === key ? { ...d, data: { ...d.data, [field]: value } } : d));
  }, []);
  const move = useCallback((key: number, dir: -1 | 1) => {
    setDrafts((p) => { const i = p.findIndex((d) => d.key === key); const j = i + dir; if (i < 0 || j < 0 || j >= p.length) return p; const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  }, []);

  const containerBytes = useMemo(() => estimateContainerBytes(drafts.map((d) => ({ data: finalizeData(d) }))), [drafts]);
  const ndefBytes = useMemo(() => estimateNdefBytes(containerBytes), [containerBytes]);
  const capacity = props.capacityBytes ?? nominalCapacity("ndef")!;
  const over = ndefBytes > capacity;

  const writeCard = useCallback(() => run("m5-write", async (signal) => {
    const t = getTransport();
    if (!t) { onSystem(`NFC: ${tr("nfc.connectFirst")}`); return; }
    if (!drafts.length) return;
    const needsInternal = drafts.some((d) => d.mode === "internal");
    const needsExternal = drafts.some((d) => d.mode === "external");
    if (needsExternal && !isValidCardPin(buildPin)) { onSystem(`NFC: ${tr("nfc.build.pinInvalid")}`); return; }
    let root: Bytes | null = null;
    if (needsInternal) { if (!isSignedIn()) { onSystem(`NFC: ${tr("nfc.build.needAccount")}`); return; } root = (await confirmAccountRoot()) as Bytes | null; }
    const records: M5Record[] = drafts.map((d) => ({ id: 0, type: d.type, mode: d.mode, oneTime: d.oneTime, data: finalizeData(d) }));
    const bytes = await buildCard(records, cardKeys(needsExternal ? buildPin : null, root));
    // Web NFC's write() waits for the tag itself, so we must NOT consume it
    // with waitForCard first; other readers need the identity to pick a write
    // path (Type 4 / MIFARE Classic / Type 2).
    let id: CardIdentity;
    if (t.id === "webnfc") id = identity ?? { uid: new Uint8Array(0), tech: "iso14443a", isoDep: false, hints: [] };
    else { id = identity ?? await t.waitForCard({ timeoutMs: 30_000, signal }); if (!identity) setIdentity(id); }
    try {
      await writeM5Card(t, id, bytes, { signal });
      log("info", `${tr("nfc.build.written")} (${bytes.length} B)`);
      onSystem(`NFC: ${tr("nfc.build.written")} (${bytes.length} B)`);
    } catch (err) {
      const msg = writeErrorText(lang, err);
      log("err", msg);
      onSystem(`NFC: ${msg}`);
    }
  }), [run, getTransport, drafts, buildPin, identity, setIdentity, onSystem, tr, log, lang]);

  const loadFromCard = useCallback(() => run("m5-edit", async (signal) => {
    const t = getTransport();
    if (!t) { onSystem(`NFC: ${tr("nfc.connectFirst")}`); return; }
    const id = identity ?? await t.waitForCard({ timeoutMs: 30_000, signal });
    if (!identity) setIdentity(id);
    const card = await readM5Card(t, id);
    if (!card) { onSystem(`NFC: ${tr("nfc.m5.none")}`); return; }
    const loaded: Draft[] = [];
    let locked = 0;
    for (const s of card.sealed) {
      try {
        const keys = s.mode === "internal" ? cardKeys(null, (await confirmAccountRoot()) as Bytes | null) : cardKeys(isValidCardPin(buildPin) ? buildPin : (isValidCardPin(pin) ? pin : ""), null);
        const rec = await openRecord(s, keys);
        loaded.push({ key: keyCounter.current++, type: rec.type, mode: rec.mode, oneTime: !!rec.oneTime, data: (rec.data ?? {}) as Record<string, unknown> });
      } catch { locked++; }
    }
    setDrafts(loaded); setMode("build");
    if (locked) onSystem(`NFC: ${locked} × ${tr("nfc.m5.locked")}`);
  }), [run, getTransport, identity, setIdentity, buildPin, pin, onSystem, tr]);

  /* --------------------------------------------------------------- render */
  return (
    <div className="nfcwb__m5">
      <div className="nfcwb__subtabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "read"} className="nfcwb__tab" onClick={() => setMode("read")}>{tr("nfc.m5")}</button>
        <button type="button" role="tab" aria-selected={mode === "build"} className="nfcwb__tab" onClick={() => setMode("build")}>{tr("nfc.build")}</button>
      </div>

      {mode === "read" ? (
        <div className="nfcwb__section">
          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={readCard} disabled={!connected || !!busy}>
              <ScanLine width={14} height={14} /> {tr("nfc.scan.once")}
            </button>
            <button type="button" className="nfcwb__btn" onClick={loadFromCard} disabled={!connected || !!busy}>
              <Pencil width={14} height={14} /> {tr("nfc.build.edit")}
            </button>
          </div>
          <label className="nfcwb__label">{tr("nfc.m5.pin")}
            <input className="nfcwb__input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 18))} placeholder="••••••" />
          </label>
          <p className="nfcwb__hint">{tr("nfc.m5.pinHint")}</p>
          {sealed === null ? <p className="nfcwb__hint">{tr("nfc.card.none")}</p> : sealed.length === 0 ? <p className="nfcwb__hint">{tr("nfc.ndef.empty")}</p> : (
            <ul className="nfcwb__m5list">
              {sealed.map((s) => {
                const meta = RECORD_META[s.type];
                return (
                  <li key={s.id} className="nfcwb__m5rec">
                    <MenuIcon name={meta.icon} className="nfcwb__m5icon" />
                    <span className="nfcwb__m5body">
                      <strong>{tr(meta.label)}</strong>
                      {s.oneTime ? <span className="nfcwb__badge nfcwb__badge--warn">{tr("nfc.m5.oneTime")}</span> : null}
                      <span className="nfcwb__hint"> {s.mode === "internal" ? tr("nfc.build.mode.passkey") : tr("nfc.build.mode.pin")}</span>
                    </span>
                    <button type="button" className="nfcwb__btn" disabled={!!busy} onClick={() => openOne(s)}>
                      <KeyRound width={12} height={12} /> {tr(meta.actionLabel)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {detail ? (
            <div className="nfcwb__banner">
              <strong>{tr(RECORD_META[detail.rec.type].label)}</strong>
              <pre className="nfcwb__detail">{detail.note ?? JSON.stringify(detail.rec.data, null, 2)}</pre>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="nfcwb__section">
          <div className="nfcwb__row">
            <select className="nfcwb__input" value={pickType} onChange={(e) => setPickType(e.target.value as M5RecordType)} aria-label={tr("nfc.build.pick")}>
              {BUILDABLE_RECORDS.map((type) => <option key={type} value={type}>{tr(RECORD_META[type].label)}</option>)}
            </select>
            <button type="button" className="nfcwb__btn" onClick={addDraft}><Plus width={14} height={14} /> {tr("nfc.build.add")}</button>
          </div>

          {drafts.length === 0 ? <p className="nfcwb__hint">{tr("nfc.build.empty")}</p> : (
            <ul className="nfcwb__drafts">
              {drafts.map((d) => (
                <li key={d.key} className="nfcwb__draft">
                  <div className="nfcwb__draft-head">
                    <MenuIcon name={RECORD_META[d.type].icon} className="nfcwb__m5icon" />
                    <strong style={{ flex: 1 }}>{tr(RECORD_META[d.type].label)}</strong>
                    <button type="button" className="nfcwb__btn nfcwb__btn--icon" title={tr("nfc.build.up")} onClick={() => move(d.key, -1)}><ArrowUp width={12} height={12} /></button>
                    <button type="button" className="nfcwb__btn nfcwb__btn--icon" title={tr("nfc.build.down")} onClick={() => move(d.key, 1)}><ArrowDown width={12} height={12} /></button>
                    <button type="button" className="nfcwb__btn nfcwb__btn--icon" title={tr("nfc.build.remove")} onClick={() => setDrafts((p) => p.filter((x) => x.key !== d.key))}><Trash2 width={12} height={12} /></button>
                  </div>
                  <DraftFields draft={d} lang={lang} patchData={patchData} />
                  <div className="nfcwb__row nfcwb__draft-opts">
                    <label className="nfcwb__inline">
                      <span>{tr("nfc.build.mode")}</span>
                      <select className="nfcwb__input" value={d.mode} disabled={RECORD_META[d.type].accountOnly} onChange={(e) => patch(d.key, { mode: e.target.value as M5CardMode })}>
                        <option value="external">{tr("nfc.build.mode.pin")}</option>
                        <option value="internal">{tr("nfc.build.mode.passkey")}</option>
                      </select>
                    </label>
                    <label className="nfcwb__inline">
                      <input type="checkbox" checked={d.oneTime} onChange={(e) => patch(d.key, { oneTime: e.target.checked })} /> {tr("nfc.build.oneTime")}
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <label className="nfcwb__label">{tr("nfc.build.pin")}
            <input className="nfcwb__input" inputMode="numeric" value={buildPin} onChange={(e) => setBuildPin(e.target.value.replace(/\D/g, "").slice(0, 18))} placeholder="••••••" />
          </label>

          <div className="nfcwb__capacity">
            <span>{translate(lang, "nfc.build.size").replace("{n}", String(ndefBytes))}</span>
            <span className={over ? "nfcwb__over" : ""}>{translate(lang, "nfc.build.capacity").replace("{used}", String(ndefBytes)).replace("{cap}", String(capacity))}</span>
          </div>
          <div className="nfcwb__meter"><span style={{ width: `${Math.min(100, Math.round((ndefBytes / capacity) * 100))}%` }} className={over ? "nfcwb__meter--over" : ""} /></div>
          {over ? <p className="nfcwb__hint nfcwb__over">{tr("nfc.build.over")}</p> : null}

          <div className="nfcwb__row">
            <button type="button" className="nfcwb__btn nfcwb__btn--primary" onClick={writeCard} disabled={!connected || !!busy || !drafts.length || over}>
              <Save width={14} height={14} /> {tr("nfc.build.write")}
            </button>
            <button type="button" className="nfcwb__btn" onClick={() => setDrafts([])} disabled={!drafts.length}><FilePlus2 width={14} height={14} /> {tr("nfc.log.clear")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- field editors */

function DraftFields({ draft, lang, patchData }: { draft: Draft; lang: Lang; patchData: (key: number, field: string, value: unknown) => void }): React.JSX.Element {
  const tr = (k: string) => translate(lang, k);
  const d = draft.data;
  const str = (f: string) => (typeof d[f] === "string" ? (d[f] as string) : "");
  const field = (f: string, labelKey: string, type: "text" | "url" = "text") => (
    <label className="nfcwb__label">{tr(labelKey)}
      <input className="nfcwb__input" type={type} value={str(f)} onChange={(e) => patchData(draft.key, f, e.target.value)} />
    </label>
  );
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      const b64 = typeof res === "string" ? (res.split(",")[1] ?? "") : "";
      const cf: CardFile = { name: file.name, mime: file.type || "application/octet-stream", b64 };
      patchData(draft.key, "file", cf);
    };
    reader.readAsDataURL(file);
  };

  switch (draft.type) {
    case "message": case "one-time-message":
      return (<>
        <label className="nfcwb__label">{tr("nfc.f.text")}
          <textarea className="nfcwb__textarea" rows={2} value={str("text")} onChange={(e) => patchData(draft.key, "text", e.target.value)} />
        </label>
        {field("url", "nfc.f.url", "url")}
        <label className="nfcwb__label">{tr("nfc.f.file")}<input className="nfcwb__input" type="file" onChange={onFile} /></label>
        {typeof d.file === "object" && d.file ? <p className="nfcwb__hint">{(d.file as CardFile).name}</p> : null}
        {field("key", "nfc.f.key")}
        {field("serverRefId", "nfc.f.serverRef")}
      </>);
    case "server-room":
      return (<>{field("server", "nfc.f.server", "url")}{field("room", "nfc.f.room")}{field("passphrase", "nfc.f.passphrase")}{field("name", "nfc.f.name")}</>);
    case "wifi":
      return (<>{field("ssid", "nfc.f.ssid")}{field("password", "nfc.f.password")}
        <label className="nfcwb__label">{tr("nfc.f.auth")}
          <select className="nfcwb__input" value={str("auth") || "WPA"} onChange={(e) => patchData(draft.key, "auth", e.target.value)}>
            <option value="WPA">WPA/WPA2</option><option value="WEP">WEP</option><option value="nopass">Open</option>
          </select>
        </label>
        <label className="nfcwb__inline"><input type="checkbox" checked={!!d.hidden} onChange={(e) => patchData(draft.key, "hidden", e.target.checked)} /> {tr("nfc.f.hidden")}</label>
      </>);
    case "url-login":
      return (<>{field("url", "nfc.f.url", "url")}{field("user", "nfc.f.user")}{field("password", "nfc.f.password")}{field("note", "nfc.f.note")}</>);
    case "contact":
      return (<>{field("name", "nfc.f.name")}{field("tel", "nfc.f.tel")}{field("email", "nfc.f.email")}{field("org", "nfc.f.org")}{field("url", "nfc.f.url", "url")}{field("note", "nfc.f.note")}</>);
    case "external-key":
      return (<>{field("label", "nfc.f.label")}
        <label className="nfcwb__label">{tr("nfc.f.key")}<textarea className="nfcwb__textarea" rows={2} value={str("key")} onChange={(e) => patchData(draft.key, "key", e.target.value)} /></label>
        {field("algo", "nfc.f.algo")}</>);
    case "passkey-backup": case "identity-backup":
      return (<p className="nfcwb__hint">{tr(RECORD_META[draft.type].label)} — {tr("nfc.build.needAccount")}</p>);
  }
}

export default M5CardPanel;
