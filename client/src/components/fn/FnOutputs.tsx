// The outputs of a function run, in a message (5.3). A function returns one
// output or a list of them; every item is shown, played or run here — text,
// Markdown, code, tables, JSON, images, files, sound, video, notices, app
// panels, buttons, forms and sandboxed browser JavaScript.
//
// Each item stands on its own: its rendering is wrapped (an error boundary
// for what React draws, try/catch for what it does), so one bad item does
// not take the others with it. A failure is logged with the run on the server
// and handed to the model's error entry point, which may answer with outputs
// of its own (those are not reported again, so nothing loops).

import { Component, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type { FlashLevel, FnOutput } from "../../lib/fn-outputs";
import type { FnMeta } from "../../lib/message-kinds";
import type { FnEventBody } from "../../lib/functions";
import { t, tf, type Lang } from "../../lib/i18n";
import { Markdown } from "../Markdown";
import { FnForm } from "./FnForm";
import { FnSandbox } from "./FnSandbox";
import { FnHtml } from "./FnHtml";
import "./fn.css";

/** What the app gives the outputs: how to reach the model, show a notice, open a panel. */
export type FnHost = {
  lang: Lang;
  /** A click, a form, a reply — resolves true when the model answered. */
  event: (meta: FnMeta, ev: Exclude<FnEventBody, { type: "error" | "log" }>) => Promise<boolean>;
  /** A browser report: an output that could not be shown, a log line from browser code. */
  report: (meta: FnMeta, ev: Extract<FnEventBody, { type: "error" | "log" }>) => void;
  flash: (text: string, level: FlashLevel) => void;
  /** Opens an app panel; false when there is no such panel. */
  openWindow: (id: string, args: unknown) => boolean;
  tone: () => "light" | "dark";
};

export const FnHostContext = createContext<FnHost | null>(null);

/** A message is "fresh" for this long: its notices, sounds, panels and hidden browser code happen once, not on every redraw of the history. */
export const FN_FRESH_MS = 30_000;

/**
 * 6.7 (audit V2): outputs in another member's message. Any member can write
 * any "outputs" into a message of their own, so nothing in one acts by
 * itself: no notice in the app's own flash bar, no panel opened, no sound
 * started, and browser code only after the viewer's click ("Run browser code
 * from <sender>?") — hidden browser code from someone else never runs. Once
 * started, that code reaches the model only while the viewer is using it
 * (a recent click or key press) and a limited number of times; its notices
 * carry the sender's name. A failed output is logged with the run, but the
 * model's error entry point is not run in the viewer's name.
 */
export type FnPeer = { name: string };
/** Events a peer's browser code may send to the model in the viewer's name, per start. */
export const PEER_JS_EVENTS = 20;

/**
 * 6.12 (F-08): a button or a form in a model's message that ANOTHER member
 * sent reaches the model with THIS viewer's token — the model sees the click
 * as the viewer's. So the first such event of a message asks, naming the
 * model and the member; the answer holds for that message (and its browser
 * code, once started). Remembered per message for this page's lifetime.
 */
const peerConsents = new Set<string>();
type PeerConsent = {
  /** Resolves true when the event may go (asked now, or answered before for this message). */
  ask: () => Promise<boolean>;
  /** The viewer started this message's browser code: that counts as the answer. */
  grant: () => void;
};
const PeerConsentContext = createContext<PeerConsent | null>(null);
/** Test seam. */
export function _resetPeerConsentsForTests(): void { peerConsents.clear(); }

/** Is the viewer using the page right now (a click or key press moments ago, here or in the sandbox frame)? */
function viewerActive(): boolean {
  const ua = typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation : undefined;
  // Browsers without the API: the start click and the event budget are the limit.
  return ua ? ua.isActive : true;
}

type Item = { kind: "one"; index: number; output: FnOutput } | { kind: "buttons"; items: Array<{ index: number; output: Extract<FnOutput, { type: "button" }> }> };

/** Buttons next to each other form one row. */
export function groupOutputs(outputs: readonly FnOutput[]): Item[] {
  const items: Item[] = [];
  outputs.forEach((output, index) => {
    const last = items[items.length - 1];
    if (output.type === "button") {
      if (last && last.kind === "buttons") last.items.push({ index, output });
      else items.push({ kind: "buttons", items: [{ index, output }] });
    } else items.push({ kind: "one", index, output });
  });
  return items;
}

class ItemBoundary extends Component<{ children: ReactNode; onError: (e: Error) => void; lang: Lang }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.warn("[m5cet] a function output failed to render:", error, info.componentStack); this.props.onError(error); }
  render() {
    if (this.state.error) return <div className="fn-failed" role="note">{tf(this.props.lang, "fnui.renderFailed", { message: this.state.error.message.slice(0, 120) })}</div>;
    return this.props.children;
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A blob: URL for base64 data, released when the item goes away. */
function useBlobUrl(data: string, mime: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([b64ToBytes(data) as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, mime]);
  return url;
}

const cellText = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function FnMedia({ o, fresh, onError, lang }: { o: Extract<FnOutput, { type: "audio" | "video" }>; fresh: boolean; onError: (e: Error) => void; lang: Lang }) {
  // `fresh` is false for a peer's message: its sound or video waits for the viewer's play.
  const url = useBlobUrl(o.data, o.mime);
  const ref = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    if (!url || !fresh || !o.autoplay || !ref.current) return;
    // The browser may refuse to play without a tap: that is not an error — a play button stays.
    ref.current.play().catch((err: Error) => { if (err?.name === "NotAllowedError") setBlocked(true); else onError(err); });
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  const props = { ref, src: url || undefined, controls: true, loop: o.loop, preload: "metadata" as const, onError: () => { if (url) onError(new Error(`the ${o.type} could not be played (${o.mime})`)); } };
  return (
    <figure className={`fn-media fn-media--${o.type}`}>
      {o.title ? <figcaption className="fn-media__title">{o.title}</figcaption> : null}
      {o.type === "audio" ? <audio {...props} /> : <video {...props} playsInline />}
      {blocked ? <button type="button" className="fn-btn fn-btn--small" onClick={() => { setBlocked(false); void ref.current?.play().catch(onError); }}>▶ {t(lang, "fnui.play")}</button> : null}
    </figure>
  );
}

function FnFile({ o, lang }: { o: Extract<FnOutput, { type: "file" }>; lang: Lang }) {
  const download = () => {
    // Always as a download (octet-stream): a file from a function is never opened in this page.
    const u = URL.createObjectURL(new Blob([b64ToBytes(o.data) as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = u; a.download = o.name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };
  return <button type="button" className="fn-file" onClick={download}>📎 {o.name} <span className="fn-file__action">{t(lang, "fnui.download")}</span></button>;
}

function FnButton({ o, meta, host }: { o: Extract<FnOutput, { type: "button" }>; meta?: FnMeta; host: FnHost }) {
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "done">("idle");
  const consent = useContext(PeerConsentContext);
  const reachable = Boolean(meta?.chain) && (!meta?.events || meta.events.includes("button"));
  const classes = ["fn-btn", ...(o.css ?? "").split(" ").filter(Boolean).map((c) => `fn-btn--${c}`), state === "confirm" ? "fn-btn--confirm" : ""].filter(Boolean).join(" ");
  const click = async () => {
    if (!reachable || !meta || state === "busy" || state === "done") return;
    if (o.confirm && state !== "confirm") { setState("confirm"); return; }
    // 6.12 (F-08): another member's message — the viewer says first that it may go in their name.
    if (consent && !(await consent.ask())) { setState("idle"); return; }
    setState("busy");
    const ok = await host.event(meta, { type: "button", name: o.name, data: o.data });
    setState(ok && o.once ? "done" : "idle");
  };
  return (
    <button
      type="button"
      className={classes}
      style={o.style ? { color: o.style.color, background: o.style.background, borderColor: o.style.border } : undefined}
      disabled={o.disabled || !reachable || state === "busy" || state === "done"}
      aria-busy={state === "busy" || undefined}
      title={!reachable ? tf(host.lang, "fnui.noEvent", { what: t(host.lang, "fnui.what.button") }) : state === "confirm" ? o.confirm : undefined}
      onClick={() => void click()}
      onBlur={() => { if (state === "confirm") setState("idle"); }}
    >
      {o.icon ? <span className="fn-btn__icon" aria-hidden>{o.icon}</span> : null}
      <span>{state === "confirm" ? `${o.confirm || t(host.lang, "fnui.confirm")}` : o.title}</span>
      {state === "busy" ? <span className="fn-btn__spin" aria-hidden /> : null}
    </button>
  );
}

function FnWindow({ o, fresh, host, onError }: { o: Extract<FnOutput, { type: "window" }>; fresh: boolean; host: FnHost; onError: (e: Error) => void }) {
  const done = useRef(false);
  useEffect(() => {
    if (!fresh || done.current) return;
    done.current = true;
    if (!host.openWindow(o.id, o.args)) onError(new Error(`there is no panel "${o.id}"`));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <button type="button" className="fn-btn fn-btn--link fn-btn--small" onClick={() => { if (!host.openWindow(o.id, o.args)) onError(new Error(`there is no panel "${o.id}"`)); }}>{tf(host.lang, "fnui.openPanel", { id: o.id })}</button>;
}

function FnFlash({ o, fresh, host }: { o: Extract<FnOutput, { type: "flash" }>; fresh: boolean; host: FnHost }) {
  const done = useRef(false);
  useEffect(() => { if (fresh && !done.current) { done.current = true; host.flash(o.text, o.level); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className={`fn-flash fn-flash--${o.level}`} role="status">{o.text}</div>;
}

/** 6.7: a peer's browser code — a card naming the sender until the viewer starts it. */
function FnPeerJs({ o, peer, meta, host, onError }: { o: Extract<FnOutput, { type: "js" }>; peer: FnPeer; meta?: FnMeta; host: FnHost; onError: (e: Error) => void }) {
  const [started, setStarted] = useState(false);
  const budget = useRef(PEER_JS_EVENTS);
  const consent = useContext(PeerConsentContext);
  if (o.hidden) return <div className="fn-peer-code fn-peer-code--hidden" role="note" data-testid="fn-peer-hidden">{tf(host.lang, "fnui.peerHidden", { name: peer.name })}</div>;
  if (!started) {
    return (
      <div className="fn-peer-code" role="group" data-testid="fn-peer-code">
        <div className="fn-peer-code__text">{tf(host.lang, "fnui.peerAsk", { name: peer.name })}{o.title ? <span className="fn-peer-code__title"> · {o.title}</span> : null}</div>
        <div className="fn-peer-code__note">{t(host.lang, "fnui.peerNote")}</div>
        {meta?.chain ? <div className="fn-peer-code__note" data-testid="fn-peer-model-note">{tf(host.lang, "fnui.peerModelNote", { model: modelLabel(meta), name: peer.name })}</div> : null}
        <button type="button" className="fn-btn fn-btn--small" data-testid="fn-peer-run" onClick={() => { consent?.grant(); setStarted(true); }}>{t(host.lang, "fnui.peerRun")}</button>
      </div>
    );
  }
  // What the code may do in the viewer's name: only while they use it, and only so often.
  const spend = () => meta?.chain && viewerActive() && --budget.current >= 0;
  return (
    <div className="fn-peer-code__run">
      <div className="fn-js__title" data-testid="fn-peer-started">{tf(host.lang, "fnui.peerCode", { name: peer.name })}</div>
      <FnSandbox strict o={o} title={tf(host.lang, "fnui.peerCode", { name: peer.name })} bridge={{
        flash: (text, level) => host.flash(`${peer.name}: ${text}`, level),
        send: (name, data) => { if (spend()) void host.event(meta!, { type: "button", name, data, source: "js" }); },
        submit: (name, values) => { if (spend()) void host.event(meta!, { type: "form", name, values, source: "js" }); },
        log: (level, message) => { if (meta?.chain) host.report(meta, { type: "log", level, message }); },
        error: onError,
        tone: host.tone,
        lang: host.lang,
      }} />
    </div>
  );
}

function renderOne(o: FnOutput, ctx: { meta?: FnMeta; host: FnHost; fresh: boolean; onError: (e: Error) => void; peer?: FnPeer }): ReactNode {
  const { host, fresh, onError, meta, peer } = ctx;
  switch (o.type) {
    case "text": return <div className="fn-text">{o.text}</div>;
    case "markdown": return <Markdown text={o.text} className="md-fn" />;
    case "code": return <pre className="fn-code" data-lang={o.lang || undefined}><code>{o.text}</code></pre>;
    case "json": return <div className="fn-json">{o.title ? <div className="fn-json__title">{o.title}</div> : null}<pre><code>{JSON.stringify(o.value, null, 2)}</code></pre></div>;
    case "table": return (
      <div className="fn-table-wrap">
        <table className="fn-table">
          {o.title ? <caption>{o.title}</caption> : null}
          <thead><tr>{o.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>{o.rows.map((r, i) => <tr key={i}>{(Array.isArray(r) ? r : [r]).map((c, j) => <td key={j}>{cellText(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    case "image": return <img className="fn-image" src={`data:${o.mime};base64,${o.data}`} alt={o.alt ?? ""} loading="lazy" onError={() => onError(new Error(`the image could not be shown (${o.mime})`))} />;
    case "file": return <FnFile o={o} lang={host.lang} />;
    case "audio": case "video": return <FnMedia o={o} fresh={fresh} onError={onError} lang={host.lang} />;
    case "flash": return <FnFlash o={o} fresh={fresh} host={host} />;
    case "window": return <FnWindow o={o} fresh={fresh} host={host} onError={onError} />;
    case "button": return <FnButton o={o} meta={meta} host={host} />;
    case "form": return <FnFormItem o={o} meta={meta} host={host} />;
    case "html": return <FnHtml o={o} />;
    case "js": {
      // 6.7: someone else's browser code runs only when the viewer says so.
      if (peer) return <FnPeerJs o={o} peer={peer} meta={meta} host={host} onError={onError} />;
      // Hidden browser code is an effect: it runs once, when the message is new; a visible one is a widget and runs whenever it is shown.
      if (o.hidden && !fresh) return null;
      return <FnSandbox o={o} title={t(host.lang, "fnui.browserCode")} bridge={{
        flash: host.flash,
        send: (name, data) => { if (meta?.chain) void host.event(meta, { type: "button", name, data, source: "js" }); },
        submit: (name, values) => { if (meta?.chain) void host.event(meta, { type: "form", name, values, source: "js" }); },
        log: (level, message) => { if (meta?.chain) host.report(meta, { type: "log", level, message }); },
        error: onError,
        tone: host.tone,
        lang: host.lang,
      }} />;
    }
  }
  return null;
}

/** "/keyword · name" of the model a message came from. */
function modelLabel(meta: FnMeta): string {
  return meta.name && meta.name !== meta.keyword ? `${meta.name} (/${meta.keyword})` : `/${meta.keyword}`;
}

function FnFormItem({ o, meta, host }: { o: Extract<FnOutput, { type: "form" }>; meta?: FnMeta; host: FnHost }) {
  const consent = useContext(PeerConsentContext);
  const reachable = Boolean(meta?.chain) && (!meta?.events || meta.events.includes("form"));
  const submit = async (values: Record<string, unknown>): Promise<boolean> => {
    if (!meta) return false;
    // 6.12 (F-08): another member's message — the viewer says first that it may go in their name.
    if (consent && !(await consent.ask())) return false;
    return host.event(meta, { type: "form", name: o.name, values });
  };
  return (
    <div className="fn-form-wrap" title={!reachable ? tf(host.lang, "fnui.noEvent", { what: t(host.lang, "fnui.what.form") }) : undefined}>
      <FnForm spec={o} lang={host.lang} disabled={!reachable} onSubmit={(values) => submit(values as Record<string, unknown>)} />
    </div>
  );
}

/** 6.12 (F-08): the question before the first event of another member's model message goes in the viewer's name. */
function usePeerConsent(meta: FnMeta | undefined, from: FnPeer | undefined): { consent: PeerConsent | null; question: { answer: (yes: boolean) => void } | null } {
  const key = from && meta?.chain ? `${meta.chain}:${meta.call ?? ""}:${from.name}` : "";
  const [question, setQuestion] = useState<{ answer: (yes: boolean) => void } | null>(null);
  const pending = useRef<Array<(yes: boolean) => void>>([]);
  const consent = useMemo<PeerConsent | null>(() => (key ? {
    ask: () => {
      if (peerConsents.has(key)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        pending.current.push(resolve);
        setQuestion({
          answer: (yes) => {
            if (yes) peerConsents.add(key);
            const waiting = pending.current.splice(0);
            setQuestion(null);
            for (const r of waiting) r(yes);
          },
        });
      });
    },
    grant: () => { peerConsents.add(key); },
  } : null), [key]);
  // Gone before an answer: whoever waits hears "no".
  useEffect(() => () => { for (const r of pending.current.splice(0)) r(false); }, []);
  return { consent, question };
}

/** A function's outputs: every one shown, played or run — each on its own.
 *  `from`: they came in another member's message (6.7 — see FnPeer). */
export function FnOutputs({ outputs, meta, createdAt, fresh: freshProp, fromError = meta?.origin === "error", from }: { outputs: readonly FnOutput[]; meta?: FnMeta; createdAt?: number; fresh?: boolean; fromError?: boolean; from?: FnPeer }) {
  const host = useContext(FnHostContext) ?? FALLBACK_HOST;
  // Decided once, when the message first shows: a redraw later does not stop (or repeat) what it started.
  // A peer's message is never "fresh": its notices, panels and sounds wait for the viewer.
  const [fresh] = useState(() => !from && (freshProp ?? (createdAt !== undefined && Date.now() - createdAt < FN_FRESH_MS)));
  const items = useMemo(() => groupOutputs(outputs), [outputs]);
  const { consent, question } = usePeerConsent(meta, from);
  const questionId = useId();
  const reported = useRef(new Set<number>());
  const report = (index: number, err: Error) => {
    if (reported.current.has(index)) return;
    reported.current.add(index);
    if (!meta?.chain) { console.warn("[m5cet] function output", index, err); return; }
    // A peer's output: logged with the run, but the error entry point does not run in the viewer's name (fromError).
    try { host.report(meta, { type: "error", error: { type: err.name || "RenderError", message: String(err.message || err).slice(0, 1500), ...(err.stack ? { stack: err.stack.slice(0, 4000) } : {}) }, output: index, fromError: fromError || Boolean(from) }); }
    catch (e) { console.warn("[m5cet] could not report a function output error", e); }
  };
  return (
    <PeerConsentContext.Provider value={consent}>
    <div className="fn-outputs">
      {question && meta && from ? (
        <div className="fn-peer-consent" role="alertdialog" aria-labelledby={questionId} data-testid="fn-peer-consent">
          <div id={questionId} className="fn-peer-consent__text">{tf(host.lang, "fnui.peerConsent", { model: modelLabel(meta), name: from.name })}</div>
          <div className="fn-peer-consent__note">{t(host.lang, "fnui.peerConsentNote")}</div>
          <div className="fn-peer-consent__actions">
            <button type="button" className="fn-btn fn-btn--small" data-testid="fn-peer-consent-yes" onClick={() => question.answer(true)}>{t(host.lang, "fnui.peerConsentYes")}</button>
            <button type="button" className="fn-btn fn-btn--small fn-btn--link" data-testid="fn-peer-consent-no" onClick={() => question.answer(false)}>{t(host.lang, "common.cancel")}</button>
          </div>
        </div>
      ) : null}
      {items.map((it) => {
        if (it.kind === "buttons") return (
          <div key={`b${it.items[0].index}`} className="fn-buttons" role="group">
            {it.items.map(({ index, output }) => <ItemBoundary key={index} lang={host.lang} onError={(e) => report(index, e)}><FnButton o={output} meta={meta} host={host} /></ItemBoundary>)}
          </div>
        );
        const onError = (e: Error) => report(it.index, e);
        return (
          <div key={it.index} className={`fn-item fn-item--${it.output.type}`}>
            <ItemBoundary lang={host.lang} onError={onError}>{renderOne(it.output, { meta, host, fresh, onError, peer: from })}</ItemBoundary>
          </div>
        );
      })}
    </div>
    </PeerConsentContext.Provider>
  );
}

/** Outside the chat (tests, previews): nothing reaches a model. */
const FALLBACK_HOST: FnHost = {
  lang: "en",
  event: async () => false,
  report: () => undefined,
  flash: () => undefined,
  openWindow: () => false,
  tone: () => (typeof document !== "undefined" && document.documentElement.getAttribute("data-tone") === "dark" ? "dark" : "light"),
};
