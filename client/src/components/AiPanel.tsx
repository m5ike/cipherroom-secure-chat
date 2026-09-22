// AI assistant panel (Server-enhanced mode). Talks to /api/ai/* which the
// operator wires to a provider (OpenAI / Anthropic / HuggingFace / Ollama…).
// Replies can be dropped straight into the composer. When the module is off or
// unconfigured, the panel explains what the operator must enable — it never
// pretends to work.

import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, ClipboardCopy, CornerDownLeft } from "lucide-react";
import { t, type Lang } from "../lib/i18n";
import { fetchAiStatus, aiComplete, type AiMessage, type AiConnectorInfo } from "../lib/ai";

export function AiPanel({ lang, onInsert }: { lang: Lang; onInsert: (text: string) => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; connectors: AiConnectorInfo[] } | null>(null);
  const [connector, setConnector] = useState<string>("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAiStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      if (s.connectors[0]) setConnector(s.connectors[0].id);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError("");
    const next: AiMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    const res = await aiComplete(next, connector || undefined);
    setBusy(false);
    if (res.ok) {
      setMessages((cur) => [...cur, { role: "assistant", content: res.text }]);
    } else {
      setError(res.message);
    }
  }

  if (status && !status.enabled) {
    return (
      <div className="space-y-3">
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {t(lang, "ai.disabled")}
        </p>
        <p className="text-xs text-muted-foreground">{t(lang, "ai.disabled.hint")}</p>
      </div>
    );
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <select className="share-select flex-1" value={connector} onChange={(e) => setConnector(e.target.value)} data-testid="ai-connector">
          {(status?.connectors ?? []).map((c) => <option key={c.id} value={c.id}>{c.label}{c.model ? ` · ${c.model}` : ""}</option>)}
        </select>
      </div>

      <div className="ai-thread" data-testid="ai-thread">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(lang, "ai.intro")}</p>
        ) : messages.map((m, i) => (
          <div key={i} className={`ai-msg ai-msg--${m.role}`}>
            <span className="ai-msg__role">{m.role === "user" ? t(lang, "ai.you") : "AI"}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {busy ? <div className="ai-msg ai-msg--assistant"><span className="ai-msg__role">AI</span><p className="opacity-60">…</p></div> : null}
        <div ref={endRef} />
      </div>

      {error ? <p className="text-xs text-destructive" data-testid="ai-error">{error}</p> : null}

      {lastAssistant ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="ai-chip" onClick={() => onInsert(lastAssistant.content)} data-testid="ai-insert">
            <CornerDownLeft className="h-3.5 w-3.5" /> {t(lang, "ai.insert")}
          </button>
          <button type="button" className="ai-chip" onClick={() => void navigator.clipboard?.writeText(lastAssistant.content)}>
            <ClipboardCopy className="h-3.5 w-3.5" /> {t(lang, "common.copy")}
          </button>
        </div>
      ) : null}

      <div className="composer-bar">
        <textarea
          className="composer-input"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder={t(lang, "ai.placeholder")}
          data-testid="ai-input"
        />
        <button type="button" className="composer-send" onClick={() => void send()} disabled={busy || !input.trim()} aria-label={t(lang, "common.send")}>
          <Send className="h-4 w-4" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t(lang, "ai.note")}</p>
    </div>
  );
}
