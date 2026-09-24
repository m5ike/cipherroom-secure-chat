// The Layout builder's preview of the app's windows, the Room window, dialogs
// and panels (4.13): each drawn by its own component with the made-up props
// of layout-samples.tsx, in the window the app shows it in. A state a
// component only reaches by being used (an open detail, a created invite) is
// reached the same way: a few clicks after it is drawn (`steps`).
// Nothing here talks to a server.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { t, type Lang } from "./lib/i18n";
import { loadPreferences, type Preferences } from "./lib/preferences";
import type { LayoutId } from "./lib/layouts";
import { renderLayout } from "./components/LayoutView";
import { useLayoutBase } from "./components/LayoutProvider";
import { SimpleModal } from "./components/SimpleModal";
import { Modal } from "./components/Modal";
import { RoomDialog, RoomTabs } from "./components/RoomDialog";
import { NeedSignIn } from "./components/NeedSignIn";
import { SignedInBadge } from "./components/SignedInBadge";
import { UserInfoView, type UserInfo } from "./components/UserInfoModal";
import { MessageInfoView, type MessageInfo } from "./components/MessageInfoModal";
import { AccountAccess, AccountInfoModal, ChatRetentionSection } from "./components/AccountPanel";
import { AnalyticsPanel, EncryptionPanel, NotificationsPanel, PrivacyPanel, RoomSecurityPanel, SettingsPanel, TrustPanel, ProfilePanel } from "./components/panels";
import { AudioControls, PeerList, VideoControls } from "./components/CallPanels";
import { ConnectionPanel, FilesPanel, LocationPanel, SpeechPanel } from "./components/ToolPanels";
import { InvitePrompt, ShareConnection, ShareResult, ShareSection } from "./components/SharePanel";
import { PhonePanel } from "./components/PhonePanel";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { connectionsProps, noop, roomProps, sampleAccount, SAMPLE_STATUS } from "./layout-samples";

const NOW = Date.UTC(2026, 8, 24, 10, 0);

/* ------------------------------------------------------------- driving */

let driving = false;
/** A click of the preview itself (not the operator's): not an element being picked. */
export function isDriving(): boolean { return driving; }

type Step = { click: string; nth?: number } | { change: string; value: string };

function setValue(el: Element, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

/** Draws `children`, then takes the steps (each after the page has settled). */
function Steps({ steps, children }: { steps: Step[]; children: ReactNode }) {
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const step of steps) {
        await new Promise((ok) => setTimeout(ok, 60));
        if (!alive) return;
        driving = true;
        try {
          if ("click" in step) (document.querySelectorAll(step.click)[step.nth ?? 0] as HTMLElement | undefined)?.click();
          else { const el = document.querySelector(step.change); if (el) setValue(el, step.value); }
        } finally { driving = false; }
      }
    })();
    return () => { alive = false; };
  }, [steps]);
  return <>{children}</>;
}

/** A layout drawn straight with made-up data (a state its component reaches only with a server). */
function Direct({ id, lang, data }: { id: LayoutId; lang: Lang; data: Record<string, unknown> }) {
  const { tree, base } = useLayoutBase(id, lang);
  return renderLayout(tree, { ...base, data });
}

/* ------------------------------------------------------------- samples */

const USER_INFO: UserInfo = {
  name: "Bob", username: "rychly-orel-2x9d", avatar: "🦊", peerId: "p-0123456789abcdef0123", self: false, connectedForMs: 3_723_000, ip: "203.0.113.9", candidateType: "srflx",
  transport: "p2p-direct", appType: "M5cet web", usesServer: true, sentBytes: 2_345_678, recvBytes: 912, security: "DTLS-SRTP · AES-GCM", fingerprint: "AB:CD:EF:01:23:45",
};

const MESSAGE_INFO: MessageInfo = {
  id: "m1", mine: false, sender: "Bob", senderId: "p-b", recipients: ["Alice", "Carol"], ip: "203.0.113.9", route: "P2P DataChannel", createdAt: NOW, secure: true,
  cipher: "U2FsdGVkX1+q9w3n0bZ4…".repeat(8), plaintext: "Ahoj, v kolik se sejdeme?", flags: ["reply"], cryptoVersion: 3, sealedWith: "pair",
  audit: [{ state: "created", at: NOW }, { state: "encrypted", at: NOW + 40, meta: "AES-GCM" }, { state: "sent", at: NOW + 90 }, { state: "delivered", at: NOW + 420 }],
  identity: { text: "Ověřený klíč", tone: "ok" },
};

const PEERS = [
  { id: "p-0123456789abcdef", name: "Bob", status: "open", audio: "live" },
  { id: "p-fedcba9876543210", name: "Carol", status: "connecting", audio: "muted" },
  { id: "p-00aa11bb22cc33dd", name: "Dan", status: "closed" },
] as const;

function transferStats(progress: number, transport: "p2p" | "relay") {
  return { id: "x", name: "a", size: 8_400_000, received: Math.round(8_400_000 * progress), direction: "in" as const, transport, encrypted: true, bytesPerSecond: 1_200_000, startedAt: NOW - 5000, updatedAt: NOW, etaSeconds: 4, progress };
}
const TRANSFERS = [
  { id: "t1", name: "photos.zip", size: 8_400_000, direction: "in", status: "active", stats: transferStats(0.42, "p2p") },
  { id: "t2", name: "report.pdf", size: 912_000, direction: "out", status: "active", stats: transferStats(0.9, "relay") },
];

const CONN_LOG = [
  { at: NOW - 120_000, attempt: 1, event: "connecting" }, { at: NOW - 60_000, attempt: 2, event: "retry", delayMs: 2500 }, { at: NOW - 30_000, attempt: 2, event: "open" },
];

const SHARE = { id: "s1", url: "https://chat.example.org/#join=Zm9vYmFyLWJhei1xdXV4", code: "482915730264", maxUses: 3, maxAttempts: 5, expiresAt: NOW + 86_400_000, revokeToken: "r" };

const SPEECH_STATUS = async () => ({
  tts: { enabled: true, connectors: [{ id: "elevenlabs", label: "ElevenLabs · Rachel" }, { id: "openai", label: "OpenAI · alloy" }] },
  stt: { enabled: false, connectors: [] },
});

const ACCOUNT_ACTIONS = { onAddPasskey: noop, onRemovePasskey: noop, onCreateRecovery: async () => "K7QM-2XPA-9RTD-VB4H-EW8N-3JCZ-LF6U", onRemoveRecovery: noop };

function prefsSample(variant: string): Preferences {
  const on = variant !== "off";
  return { ...loadPreferences(), name: "Alice", avatar: "🦊", bio: "Brno · noční směny", timezone: "Europe/Prague", notificationsEnabled: on, analyticsConsent: on };
}

/* --------------------------------------------------------------- parts */

/** The component (in its window) that draws a layout of the app, in one of its situations. */
export function AppPart({ layout, variant: v, lang }: { layout: LayoutId; variant: string; lang: Lang }): ReactNode {
  const [prefs, setPrefsState] = useState(() => prefsSample(v));
  const setPrefs = (patch: Partial<Preferences>) => setPrefsState((p) => ({ ...p, ...patch }));
  const steps = useMemo<Step[]>(() => PREVIEW_STEPS[`${layout}:${v}`] ?? [], [layout, v]);
  const win = (title: string, body: ReactNode, extra: { header?: ReactNode; className?: string; testId?: string } = {}) => (
    <SimpleModal title={title} onClose={noop} {...extra}>{body}</SimpleModal>
  );
  const panel = { open: true, onClose: noop, prefs, setPrefs, lang };
  let node: ReactNode = null;
  switch (layout) {
    case "window":
      node = v === "stacked"
        ? <>{win(t(lang, "menu.room"), <p className="text-sm">…</p>)}{win(t(lang, "cx.title"), <p className="text-sm">{t(lang, "cx.intro")}</p>)}</>
        : win(t(lang, v === "tabs" ? "menu.room" : "menu.peers"), <PeerList peers={PEERS as never} lang={lang} />, v === "tabs" ? { header: <RoomTabs lang={lang} tab="server" locked={false} onTab={noop} />, className: "room-dialog" } : {});
      break;
    case "window.large":
      node = <Modal open onClose={noop} title={t(lang, "menu.settings")} side={v === "right" ? "right" : "center"}><p className="text-sm">{t(lang, "cx.intro")}</p></Modal>;
      break;
    case "room.tabs":
      node = <div className="p-3"><RoomTabs lang={lang} tab={v === "light" ? "light" : "server"} locked={v === "locked"} onTab={noop} /></div>;
      break;
    case "room": {
      const p = roomProps(v, lang, <ShareSection lang={lang} room="tym-brno" passphrase="correct horse battery" ready={v === "connected"} />);
      node = win(t(lang, "menu.room"), <RoomDialog {...p} />, { header: <RoomTabs lang={lang} tab={p.tab} locked={p.locked} onTab={noop} />, className: "room-dialog", testId: "room-dialog" });
      break;
    }
    case "part.needSignIn":
      node = <div className="p-4"><NeedSignIn lang={lang} compact={v === "compact"} text={v === "text" ? t(lang, "cx.need.account") : undefined} onOpen={v === "text" ? undefined : noop} /></div>;
      break;
    case "part.signedIn":
      node = <div className="p-4"><SignedInBadge lang={lang} account={{ ...sampleAccount(), mailbox: { pending: v === "pending" ? 3 : 0, bytes: 0 } }} onClick={noop} /></div>;
      break;
    case "dialog.userInfo": {
      const info: UserInfo = v === "peer" ? USER_INFO : { ...USER_INFO, safety: { mine: "5f".repeat(32), theirs: "a3".repeat(32), verified: v === "verified", onVerified: noop, onExclude: noop } };
      node = win(t(lang, "userinfo.title"), <UserInfoView info={info} lang={lang} />);
      break;
    }
    case "dialog.messageInfo": {
      const info: MessageInfo = v === "file"
        ? { ...MESSAGE_INFO, attachment: { name: "report.pdf", mime: "application/pdf", size: 48_213, url: "" } }
        : v === "sealed" ? { ...MESSAGE_INFO, secure: false, cipher: undefined, plaintext: undefined, flags: [], identity: { text: "?", tone: "muted" }, cryptoVersion: undefined } : MESSAGE_INFO;
      node = win(t(lang, "msginfo.title"), <MessageInfoView info={info} lang={lang} onForward={noop} />);
      break;
    }
    case "dialog.integrity":
      node = win(t(lang, "ver.title"), <Direct id="dialog.integrity" lang={lang} data={{
        found: [
          { kind: "app", item: "M5cet", local: "4.0.6", server: "4.13.0", key: "app-0" },
          { kind: "asset", item: "/assets/index-3f9a.js", local: "a1b2c3", server: "", key: "asset-1" },
        ],
        keepPrefs: true, fixing: v === "fixing",
      }} />, { testId: "integrity-modal" });
      break;
    case "dialog.account":
      node = win(t(lang, "acc.title"), <AccountInfoModal account={sampleAccount(v === "new" ? "new" : "full")} status={SAMPLE_STATUS} busy={false} message="" lang={lang}
        onRefresh={noop} onSaveNow={noop} onSignOut={noop} onDelete={noop} actions={ACCOUNT_ACTIONS} onOpenConnection={noop} />);
      break;
    case "panel.access": {
      const steps = [{ id: "passkey", state: "ok" as const }, { id: "key", state: "run" as const, detail: "…" }, { id: "database", state: "warn" as const, detail: "…" }];
      const progress = v === "steps" ? { kind: "signin" as const, steps } : v === "error" ? { kind: "signin" as const, steps, error: { code: "unknown-passkey", message: "" } } : null;
      node = win(t(lang, "app.connection.title"), <AccountAccess account={v === "signedin" || v === "code" ? sampleAccount() : null} status={SAMPLE_STATUS} supported busy={false} message="" lang={lang}
        nickname="Alice" progress={progress as never} onSignIn={noop} onRegister={noop} onSignOutAndWipe={noop} onRecover={noop} actions={ACCOUNT_ACTIONS} />);
      break;
    }
    case "panel.retention":
      node = win(t(lang, "app.connection.title"), <ChatRetentionSection value="server" onChange={noop} account={v === "signedout" ? null : sampleAccount()} lang={lang} />);
      break;
    case "panel.profile":
      // Signed in is a session of this browser: drawn with the account's data.
      node = v === "signedin"
        ? <Modal open onClose={noop} title={t(lang, "profile.title")}><Direct id="panel.profile" lang={lang} data={{ prefs, account: { username: "bystry-sokol-7k3q", id: "bystry-sokol-7k3q" }, busy: false, msg: "", canOpenConnection: true }} /></Modal>
        : <ProfilePanel {...panel} onOpenConnection={noop} />;
      break;
    case "panel.settings": node = <SettingsPanel {...panel} onOpenAppearance={noop} />; break;
    case "panel.privacy": node = <PrivacyPanel {...panel} onLocalPurge={noop} onServerPurge={async () => ({ ok: true, message: "" })} />; break;
    case "panel.encryption": node = <EncryptionPanel {...panel} />; break;
    case "panel.notifications":
      node = <NotificationsPanel {...panel} onEnable={async () => undefined} onDisable={noop} pushAvailable={v !== "off"} signedIn={v !== "off"} onTestLocal={async () => ({ ok: true })} onTestPush={async () => ({ ok: true })} />;
      break;
    case "panel.analytics": node = <AnalyticsPanel {...panel} />; break;
    case "panel.roomSecurity": node = <RoomSecurityPanel {...panel} room={v === "none" ? "" : "tym-brno"} />; break;
    case "panel.trust":
      node = <TrustPanel {...panel} peerFingerprints={v === "empty" ? {} : { "p-0123456789abcdef": { digest: "ab".repeat(32), firstSeenAt: "2026-09-20T10:00:00Z", lastSeenAt: "2026-09-24T10:00:00Z" } }} roomFingerprint={v === "empty" ? null : "cd".repeat(32)} />;
      break;
    case "part.peers": node = win(t(lang, "menu.peers"), <PeerList peers={(v === "empty" ? [] : PEERS) as never} lang={lang} />); break;
    case "part.audio":
      node = win(t(lang, "menu.audio"), <AudioControls audioStatus={v as never} audioPeerCount={2} connected media={v === "off" ? null : { a: "e2ee", b: "e2ee" }} onJoin={noop} onLeave={noop} onToggleMute={noop} lang={lang} />);
      break;
    case "part.video":
      node = win(t(lang, "menu.video"), <VideoControls connected mode={v === "video" ? "video" : "off"} videoOn={v === "video"} onStart={noop} onLeave={noop} onToggleCamera={noop} localVideoRef={{ current: null }} remoteVideosRef={{ current: null }} lang={lang} />);
      break;
    case "panel.files": node = win(t(lang, "menu.files"), <FilesPanel connected enabled maxBytes={50_000_000} transfers={(v === "active" ? TRANSFERS : []) as never} onPickFile={noop} />); break;
    case "panel.location": node = win(t(lang, "menu.location"), <LocationPanel lang={lang} connected watching={v === "watching"} onShareOnce={noop} onStartContinuous={noop} onStopContinuous={noop} />); break;
    case "panel.speech": node = win(t(lang, "menu.speech"), <SpeechPanel lang={lang} serverMode={v === "server"} recognitionRef={{ current: null }} onSendText={noop} onInsertText={noop} loadServerStatus={SPEECH_STATUS} />); break;
    case "panel.connection":
      node = win(t(lang, "app.connection.title"), <ConnectionPanel lang={lang} prefs={prefs} setPrefs={setPrefs} desired={v === "none" ? "disconnected" : "connected"}
        status={(v === "none" ? null : { state: "open", rttMs: 38, strategy: "balanced", lastActivityAt: NOW, lastPongAt: NOW }) as never} log={(v === "none" ? [] : CONN_LOG) as never} />);
      break;
    case "part.shareResult": node = win(t(lang, "menu.room"), <ShareResult lang={lang} share={SHARE} busy={false} onAnother={noop} onRevoke={noop} />); break;
    case "panel.share": node = win(t(lang, "menu.room"), <ShareSection lang={lang} room="tym-brno" passphrase="correct horse battery" ready={v === "ready"} />); break;
    case "panel.shareConnection":
      node = win(t(lang, "sc.title"), <ShareConnection lang={lang} connection={{ label: "Tým Brno", color: "#2f80ed", room: "tym-brno", passphrase: "k", server: v === "server" ? "wss://chat.example.org" : "" }} onDone={noop} />);
      break;
    case "part.invite":
      node = win(t(lang, "invite.title"), v === "wrong"
        ? <Direct id="part.invite" lang={lang} data={{ value: "4829-1573-0264", code: "482915730264", busy: false, dead: false, message: t(lang, "invite.wrong").replace("{left}", "2") }} />
        : <InvitePrompt lang={lang} parts={{ id: "x", key: "y" } as never} onAccept={noop} onDismiss={noop} />);
      break;
    case "panel.phone":
      node = win(t(lang, "menu.phone"), <PhonePanel lang={lang} loadStatus={async () => (v === "off"
        ? { enabled: false, sms: [], voice: [] }
        : { enabled: true, sms: [{ id: "twilio", label: "Twilio" }], voice: [{ id: "telnyx", label: "Telnyx" }, { id: "vonage", label: "Vonage" }] })} />);
      break;
    case "panel.connections":
      node = win(t(lang, "cx.title"), <ConnectionsPanel {...connectionsProps(v, lang)} />);
      break;
    case "part.connectionEdit":
      node = win(t(lang, "cx.title"), <ConnectionsPanel {...connectionsProps("list", lang)} startWith={v === "new" ? "new" : undefined} />);
      break;
    case "part.connectionDetail":
    case "part.connectionSettings":
      node = win(t(lang, "cx.title"), <ConnectionsPanel {...connectionsProps("list", lang)} />);
      break;
    default:
      node = null;
  }
  return <Steps steps={steps}>{node}</Steps>;
}

/** What is clicked or typed once a situation is drawn (by "layout:variant"). */
export const PREVIEW_STEPS: Readonly<Record<string, Step[]>> = {
  "panel.access:code": [{ click: "[data-testid=recovery-create]" }],
  "part.shareResult:qr": [{ click: "[data-testid=share-via-qr]" }],
  "panel.phone:call": [{ change: ".phone__number", value: "+420123456789" }],
  "panel.phone:sms": [{ change: ".phone__number", value: "+420123456789" }, { click: ".phone__tab", nth: 1 }, { change: "[data-testid=phone-sms-text]", value: "Ahoj, jsem na cestě." }],
  "part.connectionEdit:edit": [{ click: "[data-testid=cx-edit]", nth: 1 }],
  "part.connectionDetail:log": [{ click: "[data-testid=cx-details]" }],
  "part.connectionSettings:plain": [{ click: "[data-testid=cx-tab-settings]" }],
};
