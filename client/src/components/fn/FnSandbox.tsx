// A function's JavaScript for the viewer's browser (5.3: m5.out.js,
// m5.browser.run). It runs in /fn-sandbox.html inside an iframe with
// sandbox="allow-scripts" and no allow-same-origin: an opaque origin, so the
// code cannot reach the app — not its storage, its keys, its session or the
// page around it. It talks to the app only through postMessage, and only
// through a few verbs: resize, flash, send (the model's button entry point),
// submit (its form entry point), log and error. Each is limited in number.

import { useEffect, useRef, useState } from "react";
import type { FlashLevel, FnOutput } from "../../lib/fn-outputs";

type JsOutput = Extract<FnOutput, { type: "js" }>;
export type SandboxBridge = {
  flash: (text: string, level: FlashLevel) => void;
  send: (name: string, data: unknown) => void;
  submit: (name: string, values: Record<string, unknown>) => void;
  log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  error: (err: Error) => void;
  tone: () => "light" | "dark";
  lang: string;
};

/**
 * Where the sandbox page lives. 6.12 (F-08): browser code from ANOTHER member's
 * message runs in the strict variant (`?origin=peer`): the server answers it
 * with a CSP of `connect-src 'none'` and images / media only from `data:` and
 * `blob:` — the code cannot send what it sees, or the viewer's address and
 * time, to any server; it reaches the model only through the app's bridge.
 * The viewer's own code and a model's answer to the viewer keep the page as
 * it was. (A server without the variant ignores the query: the old page.)
 */
export const SANDBOX_URL = "/fn-sandbox.html";
export const STRICT_SANDBOX_URL = "/fn-sandbox.html?origin=peer";
export function sandboxUrl(strict: boolean): string {
  return strict ? STRICT_SANDBOX_URL : SANDBOX_URL;
}

/** Messages a sandbox may send in its lifetime (a loop that floods the app is cut off). */
const BUDGET = 200;
const LEVELS = new Set(["info", "success", "warning", "error"]);

export function FnSandbox({ o, title, bridge, strict = false }: { o: JsOutput; title: string; bridge: SandboxBridge; strict?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(o.hidden ? 0 : o.height ?? 48);
  const started = useRef(false);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    let budget = BUDGET;
    const start = () => {
      const win = frame.current?.contentWindow;
      if (!win || started.current) return;
      started.current = true;
      // The sandbox has an opaque origin: "*" is the only target it can have; it accepts only its parent.
      win.postMessage({ m5: "run", code: o.code, args: o.args ?? null, tone: bridgeRef.current.tone(), lang: bridgeRef.current.lang }, "*");
    };
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d.m5 !== true || typeof d.kind !== "string") return;
      if (--budget < 0) return;
      const b = bridgeRef.current;
      const s = (v: unknown, max: number) => String(v ?? "").slice(0, max);
      switch (d.kind) {
        case "ready": start(); break;
        case "resize": if (!o.hidden && o.height === undefined) setHeight(Math.max(0, Math.min(2000, Math.round(Number(d.height) || 0)))); break;
        case "flash": b.flash(s(d.text, 500), LEVELS.has(String(d.level)) ? d.level as FlashLevel : "info"); break;
        case "send": b.send(s(d.name, 64), d.data ?? null); break;
        case "submit": b.submit(s(d.name, 64), d.values && typeof d.values === "object" && !Array.isArray(d.values) ? d.values as Record<string, unknown> : {}); break;
        case "log": b.log((["debug", "info", "warn", "error"].includes(String(d.level)) ? d.level : "info") as "info", s(d.message, 2000)); break;
        case "error": { const err = new Error(s(d.message, 1500) || "the browser code failed"); err.name = s(d.name, 60) || "BrowserError"; if (d.stack) err.stack = s(d.stack, 4000); b.error(err); break; }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [o]);

  return (
    <div className={`fn-js${o.hidden ? " fn-js--hidden" : ""}`}>
      {o.title && !o.hidden ? <div className="fn-js__title">{o.title}</div> : null}
      <iframe
        ref={frame}
        className="fn-js__frame"
        src={sandboxUrl(strict)}
        data-strict={strict ? "true" : undefined}
        sandbox="allow-scripts"
        allow="autoplay"
        title={o.title || title}
        style={{ height: o.hidden ? 0 : height }}
        aria-hidden={o.hidden || undefined}
        tabIndex={o.hidden ? -1 : undefined}
        onLoad={() => { if (!started.current) window.setTimeout(() => { const win = frame.current?.contentWindow; if (win && !started.current) { started.current = true; win.postMessage({ m5: "run", code: o.code, args: o.args ?? null, tone: bridgeRef.current.tone(), lang: bridgeRef.current.lang }, "*"); } }, 50); }}
      />
    </div>
  );
}
