// APDU application templates in the NFC workbench (6.10): the menu of
// m5mobile.define.apduTemplates grouped by card type, and a run's output —
// live progress while the steps run, then one of four views (raw in/out ·
// raw · JSON · readable) with three icon actions:
//
//   Share       the system share sheet (Web Share: the text, or the JSON as a
//               file); without it the text is copied and saved as a file.
//   Forward     pick a room you are in, then everyone or one member: sent as a
//               chat message — the view's text, or the JSON as a file.
//   To myself   a note in the current room's history that only I see and that
//               is never sent (App.tsx: ChatMessage.kind = "note", as on Android).
//
// Card numbers are masked in every view and in what the three actions send
// (G-19, template-views.ts) unless the holder ticks "show the full card number".
//
// The chat side (rooms, members, sending, the note) comes from the app as an
// NfcChatBridge; without one (a test, the workbench outside a room) Forward
// and To-myself say why they are off. Pure presentational parts: the
// workbench runs the template (template-runner.ts) and passes the run here.

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Forward, Loader2, NotebookPen, Send, Share2, Square, SquareArrowDown, X } from "lucide-react";
import { TEMPLATE_VIEWS, templateProblems, type ApduTemplate, type TemplateView } from "../lib/nfc/apdu-templates";
import type { TemplateProgress, TemplateRun } from "../lib/nfc/template-runner";
import { readableHtml, runFileName, runMasks, templateView, viewMime } from "../lib/nfc/template-views";
import { FnHtml } from "./fn/FnHtml";
import { t as translate, tf, tp, type Lang } from "../lib/i18n";

/* ------------------------------------------------------------ the chat side */

export type ForwardMember = { id: string; name: string };
export type ForwardRoom = { key: string; label: string; current: boolean; members: ForwardMember[] };
export type ForwardTarget = { roomKey: string; member?: ForwardMember };
export type ForwardBody = { kind: "text"; text: string } | { kind: "file"; file: File; caption: string };
export type ChatResult = { ok: boolean; message?: string };

/** What the app lends the workbench to forward an output or keep it as a note. */
export type NfcChatBridge = {
  /** The rooms I am in: the one on screen first, then the ones kept in the background. */
  rooms(): ForwardRoom[];
  forward(target: ForwardTarget, body: ForwardBody): Promise<ChatResult>;
  /** The room a note would go into (the one on screen), or null when there is none. */
  noteRoom(): string | null;
  /** A note in that room's history that only I see — never sent. */
  noteToSelf(body: { text: string; file?: File }): Promise<ChatResult>;
};

/** A chat message has a cap; a longer text goes as a .txt file instead. */
export const FORWARD_TEXT_MAX = 60_000;

/* ------------------------------------------------------------ the menu */

type Group = "emv" | "emrtd" | "desfire" | "iso7816" | "other";
const GROUP_ORDER: Group[] = ["emv", "emrtd", "desfire", "iso7816", "other"];

export type MenuEntry = { index: number; template: Record<string, unknown>; label: string; note?: string; legacy?: "apdu" | "op"; commands?: number; steps: number; problems: string[] };

/** The define's templates, grouped by card type, with what each would run (or why it cannot). */
export function templateMenu(list: unknown[]): Array<{ group: Group; entries: MenuEntry[] }> {
  const groups = new Map<Group, MenuEntry[]>();
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const x = raw as Record<string, unknown> & ApduTemplate;
    const problems = templateProblems(x);
    const hasSteps = Array.isArray(x.steps) && x.steps.length > 0;
    const lines = typeof x.apdu === "string" ? x.apdu.split(/\r?\n/).filter((l) => l.replace(/[^0-9A-Fa-f]/g, "").length >= 8).length : 0;
    const legacy = hasSteps ? undefined : typeof x.op === "string" ? "op" as const : lines || x.apduHex ? "apdu" as const : undefined;
    const card = x.card ?? (x.op === "emv-read" ? "emv" : x.op === "eid-read" ? "emrtd" : undefined);
    const group: Group = card && GROUP_ORDER.includes(card as Group) ? card as Group : "other";
    const label = String(x.label ?? x.name ?? `APDU ${index + 1}`);
    const entry: MenuEntry = { index, template: x, label, ...(typeof x.note === "string" && x.note ? { note: x.note } : {}), ...(legacy ? { legacy } : {}), ...(legacy === "apdu" ? { commands: Math.max(1, lines) } : {}), steps: hasSteps ? x.steps!.length : legacy ? 1 : 0, problems };
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  });
  return GROUP_ORDER.filter((g) => groups.has(g)).map((group) => ({ group, entries: groups.get(group)! }));
}

export function TemplateMenu({ lang, templates, disabled, onPick, onClose }: { lang: Lang; templates: unknown[]; disabled?: boolean; onPick: (template: Record<string, unknown>) => void; onClose?: () => void }): React.JSX.Element {
  const tr = (k: string) => translate(lang, k);
  const groups = useMemo(() => templateMenu(templates), [templates]);
  return (
    <div className="nfcwb__tplmenu" role="menu" aria-label={tr("nfc.tpl.title")}>
      <div className="nfcwb__tplmenu-title">
        <span><SquareArrowDown width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{tr("nfc.tpl.title")}</span>
        {onClose ? <button type="button" className="nfcwb__btn nfcwb__btn--icon" aria-label={tr("nfc.tpl.close")} title={tr("nfc.tpl.close")} onClick={onClose}><X width={12} height={12} /></button> : null}
      </div>
      {groups.length === 0 ? <div className="nfcwb__tplmenu-empty">{tr("nfc.tpl.none")}</div> : groups.map((g) => (
        <div key={g.group} className="nfcwb__tplgroup" role="group" aria-label={tr(`nfc.tpl.group.${g.group}`)}>
          <div className="nfcwb__tplgroup-title">{tr(`nfc.tpl.group.${g.group}`)}</div>
          {g.entries.map((e) => {
            const bad = e.problems.length > 0;
            const meta = e.legacy === "apdu" ? tf(lang, "nfc.tpl.legacy.apdu", { n: e.commands ?? 1 }) : e.legacy === "op" ? tr("nfc.tpl.legacy.op") : tp(lang, "nfc.tpl.steps", e.steps);
            return (
              <button key={e.index} type="button" role="menuitem" className={`nfcwb__tplmenu-item${e.legacy ? " nfcwb__tplmenu-item--legacy" : ""}`} disabled={disabled || bad}
                title={bad ? tf(lang, "nfc.tpl.problem", { problem: e.problems.join("; ") }) : e.note} onClick={() => onPick(e.template)}>
                <span className="nfcwb__tplmenu-main">
                  <span className="nfcwb__tplmenu-label">{e.label}</span>
                  {bad ? <span className="nfcwb__tplmenu-problem">{tf(lang, "nfc.tpl.problem", { problem: e.problems.join("; ") })}</span>
                    : e.note ? <span className="nfcwb__hint">{e.note}</span> : null}
                </span>
                <span className={`nfcwb__tplmenu-meta${e.legacy ? " nfcwb__tplmenu-meta--legacy" : ""}`}>{meta}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ sharing */

function download(name: string, mime: string, text: string): void {
  try {
    const u = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = u; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(u), 10_000);
  } catch { /* no download here */ }
}

/**
 * The text a view sends: readable and JSON as they are, io / raw under the
 * template's name (saying when card numbers are masked). G-19: masked unless
 * `full` — the holder ticked "show the full card number".
 */
export function viewText(run: TemplateRun, view: TemplateView, lang: Lang, full = false): string {
  const body = templateView(run, view, { lang, full });
  const masked = !full && runMasks(run);
  return view === "io" || view === "raw" ? `${run.label} — ${translate(lang, `nfc.tpl.view.${view}`)}${masked ? ` · ${translate(lang, "nfc.tpl.masked.short")}` : ""}\n\n${body}` : body;
}

/** Share: Web Share (the text, or the JSON as a .json file); else copy + download. */
export async function shareRun(run: TemplateRun, view: TemplateView, lang: Lang, full = false): Promise<"shared" | "copied" | "cancelled"> {
  const text = viewText(run, view, lang, full);
  const name = runFileName(run, view);
  const mime = viewMime(view);
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { canShare?: (d: ShareData) => boolean }) : undefined;
  try {
    if (nav?.share) {
      const file = typeof File !== "undefined" ? new File([text], name, { type: mime }) : null;
      if (view === "json" && file && nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: run.label }); return "shared"; }
      await nav.share({ title: run.label, text });
      return "shared";
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") return "cancelled";
    // Refused (no user gesture, a too-long text …): copy + download below.
  }
  try { await nav?.clipboard?.writeText(text); } catch { /* not allowed */ }
  download(name, mime, text);
  return "copied";
}

/** What Forward / To-myself send for a view: its text, or the JSON as a file (a text too long for a message also goes as a file). */
export function chatBody(run: TemplateRun, view: TemplateView, lang: Lang, asFile: boolean, full = false): ForwardBody {
  const text = viewText(run, view, lang, full);
  if (asFile || view === "json" || text.length > FORWARD_TEXT_MAX) {
    const v: TemplateView = view === "json" || asFile ? "json" : view;
    const body = v === "json" ? templateView(run, "json", { full }) : text;
    return { kind: "file", file: new File([body], runFileName(run, v), { type: viewMime(v) }), caption: `${run.label} — ${translate(lang, `nfc.tpl.view.${v}`)}` };
  }
  return { kind: "text", text };
}

/* ------------------------------------------------------------ the output */

export type TemplateRunViewProps = {
  lang: Lang;
  /** The run being shown (null while the first one runs). */
  run: TemplateRun | null;
  /** While a run goes: where it is. */
  progress?: (TemplateProgress & { template: string }) | null;
  onCancel?: () => void;
  chat?: NfcChatBridge | null;
  /** A short notice (shared, sent, saved, an error). */
  onNotice?: (text: string) => void;
};

export function TemplateRunView({ lang, run, progress, onCancel, chat, onNotice }: TemplateRunViewProps): React.JSX.Element {
  const tr = (k: string) => translate(lang, k);
  const [view, setView] = useState<TemplateView>("readable");
  const [fwdOpen, setFwdOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // G-19: card numbers are masked in every view — and in what is shared, forwarded or kept — unless the holder asks.
  const [full, setFull] = useState(false);
  useEffect(() => { setFull(false); }, [run]);
  const masks = useMemo(() => (run ? runMasks(run) : false), [run]);
  const text = useMemo(() => (run && view !== "readable" ? templateView(run, view, { lang, full }) : ""), [run, view, lang, full]);
  const html = useMemo(() => (run && view === "readable" ? readableHtml(run, lang, full) : ""), [run, view, lang, full]);
  const noteRoom = chat?.noteRoom() ?? null;
  const rooms = chat?.rooms() ?? [];
  const notice = (s: string) => onNotice?.(s);

  const doShare = async () => {
    if (!run) return;
    const r = await shareRun(run, view, lang, full);
    if (r === "shared") notice(tr("nfc.tpl.shared"));
    else if (r === "copied") notice(tf(lang, "nfc.tpl.copied", { name: runFileName(run, view) }));
  };
  const doSelf = async () => {
    if (!run || !chat) return;
    setBusy(true);
    try {
      const body = chatBody(run, view, lang, false, full);
      const r = await chat.noteToSelf(body.kind === "text" ? { text: body.text } : { text: body.caption, file: body.file });
      notice(r.ok ? r.message || tf(lang, "nfc.tpl.self.saved", { room: noteRoom ?? "" }) : tf(lang, "nfc.tpl.fwd.failed", { reason: r.message ?? "?" }));
    } finally { setBusy(false); }
  };

  return (
    <div className="nfcwb__tplrun" aria-live="polite">
      <div className="nfcwb__section-title">
        <span>{run?.label ?? progress?.template ?? tr("nfc.tpl.output")}</span>
        {run ? (
          <div className="nfcwb__row nfcwb__tplrun-actions">
            <button type="button" className="nfcwb__btn nfcwb__btn--icon" aria-label={tr("nfc.tpl.share")} title={tr("nfc.tpl.share")} onClick={() => void doShare()}><Share2 width={14} height={14} /></button>
            <button type="button" className="nfcwb__btn nfcwb__btn--icon" aria-label={tr("nfc.tpl.forward")} title={rooms.length ? tr("nfc.tpl.forward") : tr("nfc.tpl.fwd.noRooms")} aria-pressed={fwdOpen} disabled={!rooms.length || busy} onClick={() => setFwdOpen((v) => !v)}><Forward width={14} height={14} /></button>
            <button type="button" className="nfcwb__btn nfcwb__btn--icon" aria-label={tr("nfc.tpl.self")} title={noteRoom ? tr("nfc.tpl.self") : tr("nfc.tpl.self.noRoom")} disabled={!noteRoom || busy} onClick={() => void doSelf()}><NotebookPen width={14} height={14} /></button>
          </div>
        ) : null}
      </div>

      {progress ? (
        <div className="nfcwb__tplprogress" role="status">
          <Loader2 className="nfcwb__spinicon" width={14} height={14} />
          <span className="nfcwb__tplprogress-text">
            {tf(lang, "nfc.tpl.running", { n: progress.step, m: progress.total, label: progress.label })}
            <span className="nfcwb__hint"> · {tf(lang, "nfc.tpl.apdus", { n: progress.exchanges })}</span>
          </span>
          {onCancel ? <button type="button" className="nfcwb__btn nfcwb__btn--danger" onClick={onCancel}><Square width={12} height={12} /> {tr("nfc.tpl.cancel")}</button> : null}
          <div className="nfcwb__progress"><span style={{ width: `${progress.total ? Math.round((progress.step / progress.total) * 100) : 0}%` }} /></div>
        </div>
      ) : null}

      {run ? (
        <>
          <div className={`nfcwb__banner ${run.ok ? "nfcwb__banner--ok" : "nfcwb__banner--warn"}`}>
            {run.ok ? <CircleCheck width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} /> : <CircleAlert width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />}
            {run.cancelled ? tr("nfc.tpl.cancelled") : run.ok
              ? tf(lang, "nfc.tpl.done", { n: run.exchanges.length, s: (run.ms / 1000).toFixed(1) })
              : tf(lang, "nfc.tpl.failed", { n: run.problems.length, apdus: run.exchanges.length })}
            {!run.ok && !run.cancelled ? <ul className="nfcwb__tplproblems">{run.problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
          </div>

          {fwdOpen && chat ? <ForwardDialog lang={lang} rooms={rooms} view={view} onClose={() => setFwdOpen(false)} onSend={async (target, asFile) => {
            setBusy(true);
            try {
              const r = await chat.forward(target, chatBody(run, view, lang, asFile, full));
              const room = rooms.find((x) => x.key === target.roomKey)?.label ?? "";
              notice(r.ok ? r.message || tf(lang, "nfc.tpl.fwd.sent", { to: target.member?.name ?? tr("nfc.tpl.fwd.everyone"), room }) : tf(lang, "nfc.tpl.fwd.failed", { reason: r.message ?? "?" }));
              if (r.ok) setFwdOpen(false);
            } finally { setBusy(false); }
          }} busy={busy} /> : null}

          {/* G-19: a notice above the views, and the switch — only when masking hides something; off after every run. */}
          {masks ? (
            <div className="nfcwb__row nfcwb__tplmask">
              <span className="nfcwb__hint" data-testid="nfc-tpl-masked">{full ? tr("nfc.tpl.masked.off") : tr("nfc.tpl.masked.on")}</span>
              <label className="nfcwb__inline"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> {tr("nfc.tpl.masked.full")}</label>
            </div>
          ) : null}
          <div className="nfcwb__tabs nfcwb__tplviews" role="tablist" aria-label={tr("nfc.tpl.views")}>
            {TEMPLATE_VIEWS.map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className="nfcwb__tab" onClick={() => setView(v)}>{tr(`nfc.tpl.view.${v}`)}</button>
            ))}
          </div>
          {view === "readable"
            ? <div className="nfcwb__tplout nfcwb__tplout--readable" data-view="readable"><FnHtml o={{ type: "html", html }} /></div>
            : <pre className="nfcwb__tplout nfcwb__log" data-view={view}>{text || "—"}</pre>}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ forward */

function ForwardDialog({ lang, rooms, view, busy, onClose, onSend }: { lang: Lang; rooms: ForwardRoom[]; view: TemplateView; busy: boolean; onClose: () => void; onSend: (target: ForwardTarget, asFile: boolean) => void | Promise<void> }): React.JSX.Element {
  const tr = (k: string) => translate(lang, k);
  const [roomKey, setRoomKey] = useState(rooms[0]?.key ?? "");
  const [memberId, setMemberId] = useState("");
  const [asFile, setAsFile] = useState(view === "json");
  const room = rooms.find((r) => r.key === roomKey);
  const member = room?.members.find((m) => m.id === memberId);
  return (
    <div className="nfcwb__fwd" role="dialog" aria-label={tr("nfc.tpl.fwd.title")}>
      <div className="nfcwb__section-title">
        <span><Forward width={13} height={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />{tr("nfc.tpl.fwd.title")}</span>
        <button type="button" className="nfcwb__btn nfcwb__btn--icon" aria-label={tr("nfc.tpl.close")} onClick={onClose}><X width={12} height={12} /></button>
      </div>
      <fieldset className="nfcwb__fwd-set">
        <legend className="nfcwb__hint">{tr("nfc.tpl.fwd.room")}</legend>
        {rooms.map((r) => (
          <label key={r.key} className="nfcwb__inline">
            <input type="radio" name="nfc-fwd-room" checked={roomKey === r.key} onChange={() => { setRoomKey(r.key); setMemberId(""); }} /> {r.label}
            {!r.current ? <span className="nfcwb__hint"> · {tr("nfc.tpl.fwd.background")}</span> : null}
          </label>
        ))}
      </fieldset>
      <fieldset className="nfcwb__fwd-set">
        <legend className="nfcwb__hint">{tr("nfc.tpl.fwd.to")}</legend>
        <label className="nfcwb__inline"><input type="radio" name="nfc-fwd-to" checked={!memberId} onChange={() => setMemberId("")} /> {tr("nfc.tpl.fwd.everyone")}</label>
        {(room?.members ?? []).map((m) => (
          <label key={m.id} className="nfcwb__inline"><input type="radio" name="nfc-fwd-to" checked={memberId === m.id} onChange={() => setMemberId(m.id)} /> {m.name}</label>
        ))}
        {room && !room.members.length ? <span className="nfcwb__hint">{tr("nfc.tpl.fwd.noMembers")}</span> : null}
      </fieldset>
      <fieldset className="nfcwb__fwd-set">
        <legend className="nfcwb__hint">{tr("nfc.tpl.fwd.as")}</legend>
        <label className="nfcwb__inline"><input type="radio" name="nfc-fwd-as" checked={!asFile} disabled={view === "json"} onChange={() => setAsFile(false)} /> {tf(lang, "nfc.tpl.fwd.asText", { view: tr(`nfc.tpl.view.${view}`) })}</label>
        <label className="nfcwb__inline"><input type="radio" name="nfc-fwd-as" checked={asFile} onChange={() => setAsFile(true)} /> {tr("nfc.tpl.fwd.asFile")}</label>
      </fieldset>
      {room && !room.current ? <p className="nfcwb__hint">{tf(lang, "nfc.tpl.fwd.switch", { room: room.label })}</p> : null}
      <div className="nfcwb__row">
        <button type="button" className="nfcwb__btn nfcwb__btn--primary" disabled={!room || busy} onClick={() => void onSend({ roomKey, ...(member ? { member } : {}) }, asFile)}>
          {busy ? <Loader2 className="nfcwb__spinicon" width={14} height={14} /> : <Send width={14} height={14} />} {tr("nfc.tpl.fwd.send")}
        </button>
      </div>
    </div>
  );
}
