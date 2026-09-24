// The AI assistant (4.14): a conversation with the server's AI — the models
// the operator lets this user use, how much a model reasons, the answer as it
// is written (Markdown, reasoning, sources), stopping it, putting the last
// answer into the message. Drawn by the layout "panel.ai" (lib/layouts/ai.ts).
// What is sent goes to the server and the operator's provider: it is not
// end-to-end encrypted like the chat, and the window says so.

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { t, type Lang } from "../lib/i18n";
import { aiChat, fetchAiStatus, type AiCitation, type AiReasoning, type AiStatus } from "../lib/ai";
import { renderLayout } from "./LayoutView";
import { useLayoutBase } from "./LayoutProvider";
import { Markdown } from "./Markdown";

export type AiTurnView = {
  key: string;
  role: "user" | "assistant";
  text: string;
  model: string;
  reasoning: string;
  citations: AiCitation[];
  error: string;
  stats: string;
  pending: boolean;
};

const LEVELS: AiReasoning[] = ["off", "low", "medium", "high"];
const STORE = "m5cet:ai";

function remembered(): { model?: string; reasoning?: AiReasoning } {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "{}") as { model?: string; reasoning?: AiReasoning }; } catch { return {}; }
}
function remember(v: { model: string; reasoning: AiReasoning }): void {
  try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ }
}

/** The server's refusal in the user's words (its own message when there is no translation). */
function errorText(lang: Lang, code: string, message: string): string {
  const key = `ai.err.${code}`;
  const s = t(lang, key);
  return s === key ? message : s;
}

let seq = 0;
const nextKey = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function AiPanel({ lang, onInsert, onSignIn, loadStatus = fetchAiStatus, chat = aiChat, initialTurns }: {
  lang: Lang;
  onInsert: (text: string) => void;
  /** Opens the Connection window (when only signed-in users may use the AI). */
  onSignIn?: () => void;
  /** Where the status and answers come from (the Layout builder's preview gives its own). */
  loadStatus?: () => Promise<AiStatus>;
  chat?: typeof aiChat;
  initialTurns?: AiTurnView[];
}) {
  const { tree, base } = useLayoutBase("panel.ai", lang);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<AiReasoning>(() => remembered().reasoning ?? "off");
  const [turns, setTurns] = useState<AiTurnView[]>(initialTurns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<AbortController | null>(null);
  const [copied, setCopied] = useState(false);
  const threadRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    void loadStatus().then((s) => {
      if (!alive) return;
      setStatus(s);
      const wanted = remembered().model;
      setModel(s.models.some((m) => m.ref === wanted) ? wanted! : s.default || s.models[0]?.ref || "");
    });
    return () => { alive = false; };
  }, [loadStatus]);

  // Stop a running answer when the window closes.
  useEffect(() => () => busy?.abort(), [busy]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const current = status?.models.find((m) => m.ref === model);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !status || status.state !== "ready") return;
    // What the model is told: each question with the answer it got (a failed or empty one leaves both out).
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    turns.forEach((x, i) => {
      const next = turns[i + 1];
      if (x.role === "user" && next?.role === "assistant" && next.text && !next.error) history.push({ role: "user", content: x.text }, { role: "assistant", content: next.text });
    });
    const user: AiTurnView = { key: nextKey(), role: "user", text, model: "", reasoning: "", citations: [], error: "", stats: "", pending: false };
    const answer: AiTurnView = { key: nextKey(), role: "assistant", text: "", model: current?.label ?? model, reasoning: "", citations: [], error: "", stats: "", pending: true };
    setTurns((all) => [...all, user, answer]);
    setInput("");
    const controller = new AbortController();
    setBusy(controller);
    // The pieces of a stream are gathered and drawn once a frame.
    let text2 = "";
    let thought = "";
    let frame = 0;
    const draw = () => {
      frame = 0;
      setTurns((all) => all.map((x) => (x.key === answer.key ? { ...x, text: text2, reasoning: thought } : x)));
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const r = await chat({ model, reasoning: current?.reasoning ? reasoning : "off", messages: [...history, { role: "user", content: text }] }, {
      onText: (p) => { text2 += p; later(); },
      onReasoning: (p) => { thought += p; later(); },
      onCitations: (c) => setTurns((all) => all.map((x) => (x.key === answer.key ? { ...x, citations: c } : x))),
    }, controller.signal);
    if (frame) cancelAnimationFrame(frame);
    setBusy(null);
    setTurns((all) => all.map((x) => {
      if (x.key !== answer.key) return x;
      if (r.ok) {
        const d = r.done;
        return { ...x, text: d.text || text2, reasoning: d.reasoning || thought, citations: d.citations ?? x.citations, pending: false, stats: t(lang, "ai.stats").replace("{s}", (d.ms / 1000).toFixed(1)).replace("{n}", String(d.usage.output)) };
      }
      if (r.code === "cancelled") return { ...x, text: text2, reasoning: thought, pending: false, stats: t(lang, "ai.stopped") };
      return { ...x, text: text2, reasoning: thought, pending: false, error: errorText(lang, r.code, r.message) };
    }));
  }, [input, busy, status, turns, current, model, reasoning, chat, lang]);

  const lastAnswer = useMemo(() => [...turns].reverse().find((x) => x.role === "assistant" && !x.pending && x.text && !x.error), [turns]);

  if (!status) return <div className="p-4 text-center text-sm text-muted-foreground" aria-busy="true">…</div>;

  return renderLayout(tree, {
    ...base,
    data: {
      state: status.state,
      models: status.models,
      model,
      canReason: Boolean(current?.reasoning),
      levels: LEVELS,
      reasoning,
      turns,
      last: Boolean(lastAnswer),
      copied,
      input,
      maxInput: status.limits.maxInputChars,
      busy: Boolean(busy),
      canSend: Boolean(input.trim()) && !busy,
    },
    actions: {
      signIn: () => onSignIn?.(),
      model: (e) => { const v = (e as ChangeEvent<HTMLSelectElement>).target.value; setModel(v); remember({ model: v, reasoning }); },
      reasoning: (e) => { const v = (e as ChangeEvent<HTMLSelectElement>).target.value as AiReasoning; setReasoning(v); remember({ model, reasoning: v }); },
      newChat: () => { setTurns([]); setCopied(false); },
      insert: () => { if (lastAnswer) onInsert(lastAnswer.text); },
      copy: () => {
        if (!lastAnswer) return;
        void navigator.clipboard?.writeText(lastAnswer.text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }, () => undefined);
      },
      input: (e) => setInput((e as ChangeEvent<HTMLTextAreaElement>).target.value),
      key: (e) => {
        const k = e as KeyboardEvent<HTMLTextAreaElement>;
        if (k.key === "Enter" && !k.shiftKey && !k.nativeEvent.isComposing) { k.preventDefault(); void send(); }
      },
      send: (e) => { (e as FormEvent).preventDefault(); void send(); },
      stop: () => busy?.abort(),
    },
    slots: {
      text: (arg) => {
        const turn = arg as AiTurnView;
        if (turn.role === "user") return <div className="ai-msg__text">{turn.text}</div>;
        return (
          <div className="ai-msg__text" data-testid="ai-answer">
            {turn.text ? <Markdown text={turn.text} /> : null}
            {turn.pending ? <span className="ai-cursor" aria-label={t(lang, "ai.writing")} /> : null}
          </div>
        );
      },
    },
    refs: { thread: threadRef as never },
  });
}
