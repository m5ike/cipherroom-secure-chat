// The Layout builder's preview (4.0.5): the app's own components, CSS and
// templates, drawn with made-up people and messages and the layouts the
// console is editing. The console (same origin) frames this page and talks
// to it with postMessage:
//
//   console → preview   { type: "m5-lb:hello" } · { type: "m5-lb:render", config, layout, variant, theme, tone, lang, selected, mode }
//   preview → console   { type: "m5-lb:ready" } · { type: "m5-lb:select", id } · { type: "m5-lb:errors", errors }
//
// Nothing here talks to a server: no account, no room, no network.

import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./mobile.css";
import "./account.css";
import "./themes.css";
import { renderLayout, setLayoutPreviewMode, type LayoutEnv } from "./components/LayoutView";
import { MessageBubble, type MessageBubbleProps } from "./components/MessageBubble";
import { RecipientsWidget, type WidgetPeer } from "./components/RecipientsWidget";
import { UserBadge } from "./components/UserBadge";
import { MainMenu } from "./components/MainMenu";
import { SignedInBadge } from "./components/SignedInBadge";
import { TransferCard } from "./components/TransferCard";
import { AudioRecorder } from "./components/AudioRecorder";
import { SendOptions, DEFAULT_SEND_STATE } from "./components/SendOptions";
import { DEFAULT_LAYOUT, layoutBlocks, layoutTree, renderTemplate, sanitizeLayout, type LayoutConfig } from "./lib/layout-config";
import { applyLayoutStyles } from "./lib/layout-client";
import { isLayoutId, type LayoutId } from "./lib/layouts";
import { SAMPLE_MESSAGES, type SampleMessage } from "./lib/layouts/samples";
import { applyTheme } from "./lib/themes";
import { isThemeId, type ThemeId } from "./lib/theme-catalog";
import { t, type Lang } from "./lib/i18n";
import { linkify } from "./lib/linkify";
import { formatBytes } from "./lib/format";
import type { AccountSummary } from "./lib/account";
import type { WidgetState } from "./lib/preferences";

type Request = {
  type: "m5-lb:render";
  config: unknown;
  layout: LayoutId;
  variant: string;
  theme: ThemeId;
  tone: "light" | "dark";
  lang: Lang;
  selected: string;
  mode: "select" | "interact";
};

const noop = () => undefined;
const QUICK_EMOJI = ["😀", "😂", "🥳", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❓"];
const post = (msg: unknown) => { try { window.parent.postMessage(msg, window.location.origin); } catch { /* not framed */ } };

const errors = new Map<string, string>();
setLayoutPreviewMode({ onError: (id, message) => { errors.set(`${id}: ${message}`, id); } });

const SAMPLE_ACCOUNT = {
  id: "bystry-sokol-7k3q", username: "bystry-sokol-7k3q", userName: "bystry-sokol-7k3q", credentialId: "x", alg: -7, createdAt: 0, lastLoginAt: 0, loginCount: 1,
  vault: { profileBytes: 0, profileUpdatedAt: 0, chatBytes: 0, chatUpdatedAt: 0, messages: 0, messageBytes: 0, rooms: 0 },
  mailbox: { pending: 2, bytes: 0 }, away: [], pushDevices: 0, audit: [],
} as unknown as AccountSummary;

const time = (minutesAgo: number) => {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** One sample message drawn by the real MessageBubble with the draft layouts. */
function SampleBubble({ m, cfg, lang }: { m: SampleMessage; cfg: LayoutConfig; lang: Lang }) {
  const kind = m.kind;
  const vars = { sender: m.senderName, time: time(m.minutesAgo), date: time(m.minutesAgo), room: "tym-brno", appName: "M5cet" };
  const badge = kind === "in"
    ? <UserBadge name={m.senderName} senderId={m.senderId} mine={false} style={undefined} onChangeStyle={noop} onResetStyle={noop} onInfo={noop} lang={lang} />
    : null;
  const props: MessageBubbleProps = {
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName,
    mine: kind === "out",
    isSystem: kind === "sys",
    secure: false,
    createdAt: Date.now() - m.minutesAgo * 60_000,
    timeLabel: kind === "sys" || !cfg.flags.showTime ? "" : renderTemplate(kind === "out" ? cfg.templates.outgoingMeta : cfg.templates.incomingMeta, vars, cfg.partials),
    text: m.text,
    onVanish: noop,
    badge,
    head: kind === "sys"
      ? { showLogo: cfg.flags.showSystemLogo, headerText: renderTemplate(cfg.templates.systemHeader, { ...vars, date: cfg.flags.systemFullDate ? vars.date : vars.time }, cfg.partials) }
      : kind === "out" ? { showAvatar: cfg.flags.showAvatars, avatar: "🦊" } : undefined,
    lang,
    renderText: linkify,
    formatSize: formatBytes,
    onInfo: kind === "sys" ? undefined : noop,
    onReply: kind === "sys" || !cfg.flags.showActions ? undefined : noop,
    onForward: kind === "sys" || !cfg.flags.showActions ? undefined : noop,
    systemCollapseAfterSec: 0,
    tree: layoutTree(cfg, kind === "sys" ? "message.sys" : kind === "out" ? "message.out" : "message.in"),
    blocks: layoutBlocks(cfg),
    ...(m.extra as Partial<MessageBubbleProps>),
  };
  if (props.secure && !cfg.flags.showLockIcon) props.secure = false;
  return <MessageBubble {...props} />;
}

function messagesFor(layout: LayoutId, variant: string): SampleMessage[] {
  const kind = layout === "message.in" ? "in" : layout === "message.out" ? "out" : layout === "message.sys" ? "sys" : null;
  const list = kind ? SAMPLE_MESSAGES.filter((m) => m.kind === kind) : [...SAMPLE_MESSAGES];
  return variant === "text" ? list.filter((m) => !m.extra) : list;
}

/** The composer with its own little state, so the preview can be tried out. */
function PreviewComposer({ cfg, env, variant, lang }: { cfg: LayoutConfig; env: Omit<LayoutEnv, "data">; variant: string; lang: Lang }) {
  const [emojiOpen, setEmojiOpen] = useState(variant === "emoji");
  const [text, setText] = useState(variant === "plain" ? "Tomorrow at 9?" : "");
  const [reply, setReply] = useState(variant === "reply");
  const [send, setSend] = useState(DEFAULT_SEND_STATE);
  const peers = variant === "alone" ? 0 : 2;
  return renderLayout(layoutTree(cfg, "composer"), {
    ...env,
    data: {
      replyTo: reply ? { id: "i2", senderName: "Carol", text: "Only for you two." } : null,
      emojiOpen,
      emojis: QUICK_EMOJI,
      filesOn: true,
      openPeerCount: peers,
      room: "tym-brno",
      placeholder: renderTemplate(cfg.templates.composerPlaceholder, { placeholder: peers > 0 ? t(lang, "chat.placeholder") : t(lang, "chat.placeholder.waiting"), room: "tym-brno", peerCount: String(peers) }, cfg.partials),
      messageInput: text,
      everyone: variant !== "private",
      recipientNames: variant === "private" ? "Bob, Carol" : "",
    },
    actions: {
      submit: (e) => { (e as Event).preventDefault?.(); setText(""); },
      input: (e) => setText((e as { target: HTMLTextAreaElement }).target.value),
      toggleEmoji: () => setEmojiOpen((v) => !v),
      insertEmoji: (_e, emoji) => setText((v) => v + String(emoji)),
      cancelReply: () => setReply(false),
    },
    slots: {
      recorder: () => <AudioRecorder lang={lang} disabled={peers === 0} onRecorded={noop} onError={noop} />,
      sendOptions: () => <SendOptions value={send} onChange={setSend} onSend={noop} canSend={text.trim().length > 0 && peers > 0} lang={lang} />,
    },
  });
}

function PreviewWidget({ cfg, variant, lang, fab }: { cfg: LayoutConfig; variant: string; lang: Lang; fab: boolean }) {
  const [state, setState] = useState<WidgetState>({
    x: 0, y: 0, minimized: fab, locked: fab ? variant === "docked" : false, autoRoom: variant !== "manual", width: 260, opacity: 1, fontScale: 1, zoom: 1, accent: "",
  });
  const [selected, setSelected] = useState(new Set(["p1"]));
  const peers: WidgetPeer[] = variant === "empty" ? [] : [
    { id: "p1", name: "Bob", status: "open", rttMs: 38 },
    { id: "p2", name: "Carol", status: "open", rttMs: 140, avatar: "🦊" },
    { id: "p3", name: "Dan", status: "away" },
    { id: "p4", name: "Eve", status: "closed" },
  ];
  return (
    <RecipientsWidget
      peers={peers}
      room="tym-brno"
      state={state}
      selected={selected}
      onTogglePeer={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
      onToggleAuto={(auto) => setState((s) => ({ ...s, autoRoom: auto }))}
      onSelectAll={() => setSelected(new Set(peers.map((p) => p.id)))}
      onSelectNone={() => setSelected(new Set())}
      onPeerInfo={noop}
      onRoomInfo={noop}
      onMove={(x, y) => setState((s) => ({ ...s, x, y }))}
      onMinimize={(min) => setState((s) => ({ ...s, minimized: min }))}
      onUpdate={(patch) => setState((s) => ({ ...s, ...patch }))}
      title={renderTemplate(cfg.templates.widgetTitle, { title: t(lang, "recipients.title"), peerCount: String(peers.filter((p) => p.status === "open").length), room: "tym-brno" }, cfg.partials)}
      lang={lang}
      tree={layoutTree(cfg, "widget")}
      fabTree={layoutTree(cfg, "widget.fab")}
      blocks={layoutBlocks(cfg)}
      configOpen={variant === "config"}
    />
  );
}

function View({ req }: { req: Request }) {
  const cfg = useMemo(() => sanitizeLayout(req.config ?? DEFAULT_LAYOUT), [req.config]);
  const lang = req.lang;
  const env = useMemo(() => ({
    lang,
    translate: (key: string) => t(lang, key),
    blocks: layoutBlocks(cfg),
    formats: { links: (text: string) => linkify(text) },
  }), [lang, cfg]);
  const v = req.variant;
  let content: ReactNode = null;

  const header = (): ReactNode => {
    const joined = v === "joined" || v === "full";
    return renderLayout(layoutTree(cfg, "header"), {
      ...env,
      data: {
        status: joined ? "joined" : v === "offline" ? "offline" : "idle",
        room: joined || v === "offline" ? "tym-brno" : "",
        openPeerCount: joined ? 2 : 0,
        reconnectPending: false,
        statusTitle: joined ? "state: open\nattempts: 1\nlast reconnects: 0\nnext reconnect in: —\nRTT: 38ms" : "—",
        showSwitcher: v === "full",
        profiles: [{ id: "a", label: "Tým Brno" }, { id: "b", label: "Rodina" }],
        activeProfileId: "a",
        showFullscreen: v === "full",
        fullscreen: false,
        signedIn: v === "full",
        username: v === "full" ? "bystry-sokol-7k3q" : "",
      },
      actions: { openRoom: noop, switchProfile: noop, toggleFullscreen: noop },
      slots: {
        signedIn: () => (v === "full" ? <SignedInBadge account={SAMPLE_ACCOUNT} onClick={noop} lang={lang} /> : null),
        menu: () => <MainMenu mode="speeddial" lang={lang} onOpen={noop} user={{ name: "Alice", avatar: "🦊" }} onClearQuit={noop} editMode={false} onToggleEditMode={noop} buildLabel="M5cet · preview" />,
      },
    });
  };

  if (req.layout === "header") {
    content = header();
  } else if (req.layout === "chat") {
    const messages = v === "empty" ? [] : messagesFor("chat", "all");
    content = (
      <div className="flex min-h-[100dvh] flex-col">
        {header()}
        {renderLayout(layoutTree(cfg, "chat"), {
          ...env,
          data: {
            notice: v === "empty" ? "" : "Carol left the room.",
            room: "tym-brno",
            myIdShort: "a41f09c2d7",
            connected: v !== "empty",
            copied: false,
            transfers: v === "transfers" ? [{ id: "t1", name: "photos.zip", size: 8_400_000, direction: "in" }, { id: "t2", name: "report.pdf", size: 912_000, direction: "out" }] : [],
            empty: messages.length === 0,
            emptyTitle: renderTemplate(cfg.templates.chatEmptyTitle, { title: t(lang, "chat.empty.title"), appName: "M5cet" }, cfg.partials),
            emptyBody: renderTemplate(cfg.templates.chatEmptyBody, { body: t(lang, "chat.empty.body"), appName: "M5cet" }, cfg.partials),
            hiddenMessages: v === "earlier" ? 12 : 0,
            newestFirst: false,
            showEarlierText: t(lang, "chat.showEarlier").replace("{n}", "12"),
            messages,
          },
          actions: { disconnect: noop, copyRoom: noop, openRoom: noop, showEarlier: noop },
          slots: {
            transfer: (tr) => {
              const x = tr as { id: string; name: string; size: number; direction: "in" | "out" };
              return <TransferCard id={x.id} name={x.name} size={x.size} direction={x.direction} initialStats={{ id: x.id, name: x.name, size: x.size, received: Math.round(x.size * 0.42), direction: x.direction, transport: "p2p", encrypted: true, bytesPerSecond: 1_200_000, startedAt: Date.now() - 5000, updatedAt: Date.now(), etaSeconds: 4, progress: 0.42 }} finalStatus="active" />;
            },
            message: (m) => <SampleBubble m={m as SampleMessage} cfg={cfg} lang={lang} />,
            composer: () => <PreviewComposer cfg={cfg} env={env} variant="plain" lang={lang} />,
          },
        })}
      </div>
    );
  } else if (req.layout === "composer") {
    content = <div className="flex min-h-[100dvh] flex-col justify-end"><PreviewComposer key={v} cfg={cfg} env={env} variant={v} lang={lang} /></div>;
  } else if (req.layout === "widget" || req.layout === "widget.fab") {
    content = <div className="min-h-[100dvh]"><PreviewWidget key={`${req.layout}:${v}`} cfg={cfg} variant={v} lang={lang} fab={req.layout === "widget.fab"} /></div>;
  } else {
    content = (
      <div className="chat-surface min-h-[100dvh] p-3 sm:p-5">
        <div className="chat-column mx-auto w-full space-y-3">
          {messagesFor(req.layout, v).map((m) => <SampleBubble key={m.id} m={m} cfg={cfg} lang={lang} />)}
        </div>
      </div>
    );
  }
  return <>{content}</>;
}

function Preview() {
  const [req, setReq] = useState<Request | null>(null);
  const hoverRef = useRef<HTMLStyleElement | null>(null);
  const selRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const d = event.data as (Omit<Partial<Request>, "type"> & { type?: string }) | null;
      // The console asks whether the preview is there (it may have loaded first).
      if (d && d.type === "m5-lb:hello") { post({ type: "m5-lb:ready" }); return; }
      if (!d || d.type !== "m5-lb:render" || !isLayoutId(d.layout)) return;
      setReq({
        type: "m5-lb:render",
        config: d.config,
        layout: d.layout,
        variant: String(d.variant ?? ""),
        theme: isThemeId(d.theme) ? d.theme : "motorsport",
        tone: d.tone === "dark" ? "dark" : "light",
        lang: d.lang === "en" || d.lang === "de" ? d.lang : "cs",
        selected: String(d.selected ?? ""),
        mode: d.mode === "interact" ? "interact" : "select",
      });
    };
    window.addEventListener("message", onMessage);
    post({ type: "m5-lb:ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // The template, the tone and the old component styles (CSS variables).
  useEffect(() => {
    if (!req) return;
    applyTheme(req.theme, "default", "classic", { tone: req.tone });
    applyLayoutStyles(sanitizeLayout(req.config ?? DEFAULT_LAYOUT));
    document.documentElement.lang = req.lang;
  }, [req]);

  // Selecting: a click picks the element (instead of running it); hover shows it.
  useEffect(() => {
    if (!req) return;
    const sel = document.head.appendChild(selRef.current ?? document.createElement("style"));
    selRef.current = sel;
    const hov = document.head.appendChild(hoverRef.current ?? document.createElement("style"));
    hoverRef.current = hov;
    sel.textContent = req.selected ? `[data-lb-id="${CSS.escape(req.selected)}"]{outline:2px solid #f5a524 !important;outline-offset:2px}` : "";
    if (req.mode !== "select") { hov.textContent = ""; return; }
    const pick = (event: Event) => {
      const hit = (event.target as Element | null)?.closest?.("[data-lb-id]");
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "click") post({ type: "m5-lb:select", id: hit.getAttribute("data-lb-id") });
    };
    const hover = (event: Event) => {
      const hit = (event.target as Element | null)?.closest?.("[data-lb-id]");
      hov.textContent = hit ? `[data-lb-id="${CSS.escape(hit.getAttribute("data-lb-id") ?? "")}"]{outline:1px dashed #f5a524 !important;outline-offset:1px;cursor:pointer}` : "";
    };
    const types = ["click", "pointerdown", "pointerup", "mousedown", "submit", "change", "input"];
    for (const ty of types) document.addEventListener(ty, pick, true);
    document.addEventListener("mouseover", hover, true);
    return () => {
      for (const ty of types) document.removeEventListener(ty, pick, true);
      document.removeEventListener("mouseover", hover, true);
    };
  }, [req]);

  // After each render: what did not work.
  useEffect(() => {
    if (!req) return;
    post({ type: "m5-lb:errors", errors: [...errors.entries()].map(([message, id]) => ({ id, message })) });
    errors.clear();
  });

  if (!req) return null;
  return <View req={req} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
