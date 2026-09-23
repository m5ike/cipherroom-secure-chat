// Single-file React client for M5cet. Owns the WebSocket signaling lifecycle,
// the per-peer RTCPeerConnection mesh, the encryption envelope, the
// connection-keeper integration, and the modular Settings panels.
//
// Architectural notes:
//   - Encryption helpers (deriveRoomKey/encryptEnvelope/decryptEnvelope)
//     live below — see their JSDoc for the crypto contract.
//   - Optional features (calls, speech, file transfer, push, NFC, maps)
//     are isolated under client/src/lib/<module>.ts so the bundle stays
//     small and tree-shakable. App.tsx only orchestrates them.
//   - Anything that touches the network goes through deriveRoomKey or the
//     /api surface in cipherroom-api.ts. The server never sees plaintext.

import {
  Activity,
  Bell,
  BellOff,
  Copy,
  CornerUpLeft,
  Image as ImageIcon,
  KeyRound,
  Lock,
  LogOut,
  Mic,
  MicOff,
  Menu as MenuIcon,
  Moon,
  Paperclip,
  PhoneOff,
  Radio,
  ShieldCheck,
  Smile,
  Sun,
  Trash2,
  UserCircle2,
  Settings as SettingsIcon,
  Eye,
  Cloud,
  Languages,
  Bell as BellIcon,
  Wifi,
  WifiOff,
  Users,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { ChangeEvent, FormEvent, KeyboardEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectCapabilities } from "./lib/capabilities";
import { clearPreferences, loadPreferences, savePreferences, DEFAULT_ROOM_SECURITY, type Preferences, type WidgetState } from "./lib/preferences";
import { linkify } from "./lib/linkify";
import { fetchPushStatus, subscribeToPush, ensureServiceWorker, sendTestPush, showLocalTestNotification } from "./lib/push";
import { dispatchInternal, installPublicAPI } from "./lib/cipherroom-api";
import { applyTheme, applyTypography, applyColorOverrides, applyEffects, applyChatSurface } from "./lib/themes";
import { ensureFonts, GOOGLE_FONTS } from "./lib/fonts";
import { applyDeviceAttributes, deviceInfo, fullscreenSupported, toggleFullscreen, watchFullscreen } from "./lib/device";
import { buildStylesheet } from "./lib/style-overrides";
import { useStyleOverrides } from "./lib/style-editor";
import { buildLabel, watchForNewVersion, type DeployedBuild } from "./lib/build-info";
import { styleKeyFor, bubbleStyleFrom, sanitizePerUserStyle, isEmptyStyle, type PerUserStyle } from "./lib/message-styles";
import { sealText, generateSealCode, type MsgFlags } from "./lib/message-kinds";
import { MessageBubble, RecipientHint } from "./components/MessageBubble";
import { UserBadge, Avatar } from "./components/UserBadge";
import { SendOptions, DEFAULT_SEND_STATE, type SendState } from "./components/SendOptions";
import { RecipientsWidget, type WidgetPeer } from "./components/RecipientsWidget";
import { AudioRecorder } from "./components/AudioRecorder";
import { UserInfoView, type UserInfo } from "./components/UserInfoModal";
import { MessageInfoView, type MessageInfo } from "./components/MessageInfoModal";
// The NFC / smart-card workbench pulls in the transport + card-parsing tree;
// load it only when the panel opens so the initial bundle stays lean.
const NfcWorkbench = lazy(() => import("./components/NfcWorkbench").then((m) => ({ default: m.NfcWorkbench })));
// Loaded on first use: the Appearance screen and the Edit Mode inspector.
const AppearancePanel = lazy(() => import("./components/AppearancePanel").then((m) => ({ default: m.AppearancePanel })));
const StyleInspector = lazy(() => import("./components/StyleInspector").then((m) => ({ default: m.StyleInspector })));
const PhonePanel = lazy(() => import("./components/PhonePanel").then((m) => ({ default: m.PhonePanel })));
import { AiPanel } from "./components/AiPanel";
import { detectLang, t, type Lang } from "./lib/i18n";
import type { ConnectionStatus, KeepaliveStrategy } from "./lib/connection-keeper";
import { dispatchCommand, isAdminCommand } from "./lib/admin-commands";
import {
  extractRemoteFingerprint,
  persistFingerprint,
  compareFingerprint,
  dropFingerprint,
  formatFingerprint,
  sha256Hex,
  type Fingerprint,
} from "./lib/fingerprint";
import {
  newIncomingRegistry,
  handleIncomingFrame,
  sendFile,
  type FileTransferEnvelope,
  type IncomingCallbacks,
} from "./lib/file-transfer";
import { detectGeolocation, getCurrentPosition, watchPosition, osmLink, type LatLng, type LocationWatcher } from "./lib/maps";
import { detectSpeechCaps, listVoices, speak, stopSpeaking, startRecognition, fetchServerSpeechStatus, serverTts, type VoicePreset, type ServerVoiceInfo } from "./lib/speech";
import { toBase64 } from "./lib/crypto";
// Crypto v2: per-purpose keys, bound contexts, signed bodies (envelope.ts).
import {
  createReplayGuard, deriveRoomKeys, isSealedSignal, openMessage, openSignal, sealMessage, sealSignal,
  type Envelope as DataChannelEnvelope, type RoomKeys, type Signer,
} from "./lib/envelope";
import { createPinStore, keyFingerprint, keyId, loadIdentity, type Identity } from "./lib/identity";
import { validatePayload, type AudioStatusPayload, type ChatPayload } from "./lib/validate";
import { newId } from "./lib/id";
import { APP_VERSION } from "./lib/build-info";
import { TransferCard } from "./components/TransferCard";
import { MainMenu } from "./components/MainMenu";
import { formatTime, formatFullDate, formatBytes } from "./lib/format";
import { fetchLayoutConfig, applyLayoutStyles, loadCachedLayout } from "./lib/layout-client";
import { renderTemplate, type LayoutConfig } from "./lib/layout-config";
import { freshRtcConfig, turnConfigPromise } from "./lib/rtc";
import { M5Logo } from "./components/M5Logo";
import { InvitePrompt, ShareSection } from "./components/SharePanel";
import { createSessionCache, SESSION_IDLE_LIMIT_MS, type DesiredState } from "./lib/session-cache";
import { parseShareFragment, type ShareLinkParts, type SharePayload } from "./lib/share-link";
import type { AttachmentMeta, ChatMessage, MessageAudit, MessageIdentity, MsgState } from "./lib/chat-types";
import { isInlineImage } from "./lib/validate";
import { AccountInfoModal, ChatRetentionSection, SignedInBadge } from "./components/AccountPanel";
import {
  accountStatus, accountSupported, accountToken, addPasskey, createRecoveryCode, currentAccount, deleteAccount as deleteServerAccount,
  endSession, linkPushSubscription, loadVault, logAccountEvent, recoverWithCode, refreshAccount, registerAccount, removePasskey,
  removeRecoveryCode, restoreSession, saveVault, signInWithPasskey, signOutAccount, type AccountStatus, type AccountSummary,
} from "./lib/account";
import { createHistoryStore, createServerSealer, prepareHistory, sanitizeRestored, type ChatRetention } from "./lib/chat-history";
import { startBackgroundTick, watchLifecycle, type ResumeEvent, type SuspendEvent } from "./lib/lifecycle";
import { createFlashQueue, kindForText, type FlashMessage } from "./lib/flash";
import { createOutbox, type QueuedMessage } from "./lib/outbox";
import { FlashMessages } from "./components/FlashMessages";
import {
  addStorageEvent, attachStorageSocket, forgetServerData, putMessages as putServerMessages,
  readMessages as readServerMessages, recordTransfer as recordServerTransfer, sendLog as sendServerLog,
  startStorageSession, storageSessionId, storageStatus, type StorageStatus,
} from "./lib/storage-client";
import { leaveToGoodbye, wipeEverything } from "./lib/wipe";
import {
  AnalyticsPanel,
  EncryptionPanel,
  NotificationsPanel,
  PrivacyPanel,
  ProfilePanel,
  RoomSecurityPanel,
  SettingsPanel,
  TrustPanel,
  profileFromPrefs,
} from "./components/panels";

type PeerStatus = "connecting" | "open" | "closed";
type AudioStatus = "off" | "joining" | "live" | "muted";

type PeerView = {
  id: string;
  name: string;
  status: PeerStatus;
  initiator: boolean;
  audio: AudioStatus;
};

// The message shapes live in lib/chat-types.ts so the history store and the
// account vault can talk about them without importing the whole app.
export type { MsgState, MessageAudit } from "./lib/chat-types";

/** Room-scoped reference of a signed-in member (protocol v2 `account`; v1
 *  servers called it `accountId`, and v2 still sends that alias). */
type AccountRefFields = { account?: string | null; accountId?: string | null };
const accountRefOf = (f: AccountRefFields): string => f.account ?? f.accountId ?? "";

type SignalFrame =
  | {
      type: "joined";
      protocol?: number;
      peerId: string;
      room: string;
      /** Proves on a reconnect that we are the same client (keeps the peer id). */
      resume?: string;
      peers: Array<{ peerId: string; name: string; joinedAt: number } & AccountRefFields>;
      // Signed-in members the server answers for while they are gone.
      away?: Array<{ name: string; since: number } & AccountRefFields>;
      account?: ({ away: boolean } & AccountRefFields) | { invalid: true } | null;
    }
  | ({ type: "peer-joined"; peerId: string; name: string; joinedAt: number } & AccountRefFields)
  // Away relay (see server/signaling/relay.ts)
  | ({ type: "peer-away"; peerId?: string; name: string; since: number } & AccountRefFields)
  | ({ type: "peer-back"; peerId?: string; name?: string } & AccountRefFields)
  | ({ type: "peer-gone" } & AccountRefFields)
  | ({ type: "peer-updated"; peerId: string; name: string } & AccountRefFields)
  | { type: "relay-deliver"; items: RelayItem[] }
  | { type: "relay-status"; messageId: string; recipient: { name: string } & AccountRefFields; state: MsgState | "rejected" | "duplicate"; at: number; reason?: string }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; source: string; payload: unknown }
  | { type: "signal-undeliverable"; target: string }
  | { type: "hello"; peerId: string; protocol?: number }
  | { type: "pong"; t: number; serverTs: number }
  | { type: "presence-ack"; away: boolean }
  | ({ type: "auth-result"; ok: boolean; invalid?: boolean; account: ({ away: boolean } & AccountRefFields) | null })
  | { type: "account-revoked"; reason: string }
  | { type: "rate-limited"; frame: string; retryAfterMs: number }
  | { type: "replaced"; reason: string }
  | { type: "closed-by-server"; reason: string }
  | { type: "admin-command"; command: { id: string; kind: string; createdAt: number; payload?: Record<string, unknown> } }
  | { type: "error"; message: string; code?: string }
  // Server-relayed file transfer (only when direct P2P cannot be established)
  | { type: "proxy-meta"; transferId: string; iv: string; ciphertext: string; transport: "proxy"; v?: number; from?: string }
  | { type: "proxy-chunk"; transferId: string; seq: number; iv: string; ciphertext: string; transport: "proxy"; v?: number; from?: string }
  | { type: "proxy-end"; transferId: string; transport: "proxy"; v?: number; iv?: string; ciphertext?: string; from?: string }
  | { type: "proxy-cancel"; transferId: string; transport: "proxy"; from?: string }
  | { type: "proxy-progress"; transferId: string; received: number; transport: "proxy" }
  | { type: "proxy-ack"; transferId: string; accepted: boolean; reason?: string; transport: "proxy" }
  | { type: "proxy-need"; transferId: string; seqs: number[]; from?: string };

/** A decrypted payload after validate.ts: a chat message or an audio status. */
type DecryptedPayload = ChatPayload | AudioStatusPayload;

/** A signed-in participant who is not connected right now: the server takes
 *  their messages and hands them over when they come back. `accountId` holds
 *  the room-scoped reference the server gave us, never a real account id. */
type AwayPeer = { accountId: string; name: string; since: number };

/** One item out of the away mailbox. */
type RelayItem = {
  id: string;
  kind: "message" | "status";
  messageId: string;
  from: { peerId: string; name: string } & AccountRefFields;
  envelope?: DataChannelEnvelope;
  status?: { state: "delivered" | "read"; at: number; recipientName: string };
  storedAt: number;
};

type PeerHandle = {
  id: string;
  name: string;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  initiator: boolean;
  audio: AudioStatus;
  audioElement?: HTMLAudioElement;
  outgoingAudioSenders: RTCRtpSender[];
};

const PORT_BASE = "__PORT_5000__";
const EXTERNAL_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL as string | undefined;
// Inline (data-URL) attachment cap. Anything larger goes through the
// chunked DataChannel transfer path (file-transfer.ts), which has its
// own user-configurable hard limit (Preferences.maxAttachmentBytes).
const INLINE_ATTACHMENT_LIMIT = 512 * 1024;
const QUICK_EMOJI = ["😀", "😂", "🥳", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❓"];

function normalizeRoom(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "secure-room"
  );
}

function wsUrl() {
  if (EXTERNAL_SIGNALING_URL?.trim()) {
    return EXTERNAL_SIGNALING_URL.trim();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (PORT_BASE.startsWith("__")) {
    return `${protocol}//${window.location.host}/ws`;
  }

  const url = new URL(PORT_BASE, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

async function fileToAttachment(file: File): Promise<AttachmentMeta> {
  if (file.size > INLINE_ATTACHMENT_LIMIT) {
    throw new Error(`File exceeds inline cap of ${formatBytes(INLINE_ATTACHMENT_LIMIT)}; use chunked transfer.`);
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  const dataUrl = `data:${file.type || "application/octet-stream"};base64,${toBase64(buffer)}`;
  return {
    kind: file.type.startsWith("image/") ? "image" : "file",
    name: file.name.slice(0, 96),
    mime: file.type || "application/octet-stream",
    size: file.size,
    dataUrl,
  };
}

/** Read the in-use ICE candidate pair to learn the peer's remote address and
 *  how media is routed (direct host/reflexive vs TURN relay). Best-effort:
 *  returns null when getStats is blocked or the pair is not yet nominated. */
async function extractPeerAddress(pc: RTCPeerConnection): Promise<{ ip?: string; candidateType?: string } | null> {
  try {
    const stats = await pc.getStats();
    let pairId: string | null = null;
    const remotes = new Map<string, RTCIceCandidate & { address?: string; ip?: string; candidateType?: string }>();
    stats.forEach((r: { type?: string; state?: string; selected?: boolean; nominated?: boolean; remoteCandidateId?: string; id?: string; address?: string; ip?: string; candidateType?: string }) => {
      if (r.type === "candidate-pair" && (r.selected || r.nominated || r.state === "succeeded")) pairId = r.remoteCandidateId ?? null;
      if (r.type === "remote-candidate" && r.id) remotes.set(r.id, r as never);
    });
    const remote = pairId ? remotes.get(pairId) : undefined;
    if (!remote) return null;
    return { ip: remote.address || remote.ip, candidateType: remote.candidateType };
  } catch {
    return null;
  }
}

function UnsupportedBanner({ reasons }: { reasons: string[] }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-lg rounded-3xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">M5cet — browser unsupported</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This app needs modern browser crypto and WebRTC. Use a recent Edge, Chrome, Firefox, or Safari.
        </p>
        <ul className="mt-4 space-y-1 text-sm">
          {reasons.map((reason) => (
            <li key={reason} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

export type PanelKey =
  | "profile"
  | "settings"
  | "appearance"
  | "privacy"
  | "encryption"
  | "notifications"
  | "analytics"
  | "roomSecurity"
  | "trust"
  | "invite"
  | "join"
  | "peers"
  | "audio"
  | "video"
  | "files"
  | "location"
  | "nfc"
  | "speech"
  | "ai"
  | "phone"
  | "connection"
  | null;

function ChatApp() {
  const capabilitiesRef = useRef(detectCapabilities());
  const capabilities = capabilitiesRef.current;
  const initialPrefs = useMemo<Preferences>(() => {
    const loaded = loadPreferences();
    if (!loaded.lang) loaded.lang = detectLang(undefined);
    return loaded;
  }, []);

  const [prefs, setPrefsState] = useState<Preferences>(initialPrefs);
  const lang = prefs.lang;

  const [name, setName] = useState(
    () => initialPrefs.name || `peer-${Math.floor(1000 + Math.random() * 9000)}`,
  );
  const [roomInput, setRoomInput] = useState(initialPrefs.lastRoom || "brno-secure");
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<"idle" | "deriving" | "connecting" | "joined" | "offline">("idle");
  const [room, setRoom] = useState("");
  const [myId, setMyId] = useState(() => newId("peer"));
  const [messageInput, setMessageInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>("");
  // The state the user asked for. "connected" is enforced: the app keeps
  // retrying until it holds; only the Disconnect button (or the idle limit,
  // or Clear & Quit) sets it back. Mirrors intentRef for rendering.
  const [desired, setDesired] = useState<DesiredState>("disconnected");
  const [connLog, setConnLog] = useState<Array<{ at: number; attempt: number; event: ConnLogEvent; delayMs?: number }>>([]);
  const [inviteParts, setInviteParts] = useState<ShareLinkParts | null>(null);
  const [sessionPassphrase, setSessionPassphrase] = useState("");
  const sessionCacheRef = useRef(createSessionCache());
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushVapidKey, setPushVapidKey] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [now, setNow] = useState(Date.now());

  // --- message kinds + recipient selection ---
  const [sendOpts, setSendOpts] = useState<SendState>(DEFAULT_SEND_STATE);
  // Selected private recipients (peerIds). Empty + autoRoom off => nothing sends.
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [widget, setWidget] = useState<WidgetState>(initialPrefs.widget);

  // --- signed-in user (passkey account) + away relay ---
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accStatus, setAccStatus] = useState<AccountStatus | null>(null);
  const [accBusy, setAccBusy] = useState(false);
  const [accMsg, setAccMsg] = useState("");
  const [showAccount, setShowAccount] = useState(false);
  /** Signed-in members of the room the server is currently answering for. */
  const [awayPeers, setAwayPeers] = useState<AwayPeer[]>([]);
  const accountRef = useRef<AccountSummary | null>(null);
  const awayPeersRef = useRef<AwayPeer[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const retentionRef = useRef<ChatRetention>(initialPrefs.chatRetention);
  const historyRef = useRef(createHistoryStore());
  /** Seals what the server's session store keeps, with a key only this browser has. */
  const serverSealerRef = useRef(createServerSealer());
  const lastVaultSaveRef = useRef(0);
  /** What the server offers as storage, and the session store of a browser
   *  that has no passkey (server-enhanced mode). */
  const [serverStorage, setServerStorage] = useState<StorageStatus | null>(null);
  const serverStorageRef = useRef<StorageStatus | null>(null);
  /** Who sent a relayed message, so a read receipt can find its way back. */
  const relaySendersRef = useRef<Map<string, { peerId: string; accountId?: string }>>(new Map());
  const prefsRef = useRef(initialPrefs);
  // Which participant's info modal is open (peerId, or "self").
  const [userInfoFor, setUserInfoFor] = useState<string | null>(null);
  // Which message's info/audit modal is open (message id).
  const [msgInfoFor, setMsgInfoFor] = useState<string | null>(null);
  // The message currently being replied to (shown as a composer preview).
  const [replyingTo, setReplyingTo] = useState<{ id: string; senderName: string; text: string } | null>(null);
  // Per-peer byte counters + network facts, for the info modal.
  const peerStatsRef = useRef<Map<string, { sent: number; recv: number; openedAt: number }>>(new Map());
  const peerNetRef = useRef<Map<string, { ip?: string; candidateType?: string }>>(new Map());
  const widgetPersistRef = useRef<number | null>(null);
  // Admin-edited layout / templates (styles → CSS vars, text templates → labels).
  // Starts from the cached copy for an instant first paint, then refreshes.
  const [layout, setLayout] = useState<LayoutConfig>(() => loadCachedLayout());
  useEffect(() => {
    let cancelled = false;
    const load = () => { void fetchLayoutConfig().then((cfg) => { if (!cancelled) setLayout(cfg); }); };
    load();
    const timer = window.setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => { applyLayoutStyles(layout); }, [layout]);
  const tplVars = (message: { senderName: string; createdAt: number }) => ({
    sender: message.senderName,
    time: formatTime(message.createdAt, lang, prefs.timezone),
    date: formatFullDate(message.createdAt, lang, prefs.timezone),
    room,
    appName: "M5cet",
  });

  const socketRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, PeerHandle>>(new Map());
  /** The room's keys (crypto v2) while connected. */
  const keyRef = useRef<RoomKeys | null>(null);
  /** This device's signing identity (identity.ts), loaded once. */
  const identityRef = useRef<Identity | null>(null);
  /** Trust-on-first-use pins: room + name → key id. */
  const pinsRef = useRef(createPinStore());
  /** Message ids already accepted — a replay is dropped. */
  const replayRef = useRef(createReplayGuard());
  /** From our last `joined`: lets a reconnect keep the same peer id. */
  const resumeRef = useRef<{ room: string; peerId: string; secret: string } | null>(null);
  /** Which room + passphrase keyRef was derived for. */
  const keyForRef = useRef("");
  /** The next `joined` answers the user's own Connect: close the join form. */
  const closeJoinPanelRef = useRef(false);
  /** Per peer: the order signals go out / are handled in (sealing is async). */
  const signalOutRef = useRef(new Map<string, Promise<void>>());
  const signalInRef = useRef(new Map<string, Promise<void>>());
  /** Peers whose crypto we already warned about (legacy, unsealed, key mismatch). */
  const warnedPeersRef = useRef(new Set<string>());
  const roomRef = useRef("");
  const nameRef = useRef(name);
  const myIdRef = useRef(myId);
  const localAudioStreamRef = useRef<MediaStream | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const largeFileInputRef = useRef<HTMLInputElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const audioStatusRef = useRef<AudioStatus>("off");
  const notificationsEnabledRef = useRef(initialPrefs.notificationsEnabled);
  const intentRef = useRef(false);
  /**
   * `clientStoppedRef` is true ONLY when the user pressed the Disconnect
   * button. It gates all auto-reconnect logic: even if the WebSocket
   * dropped for a network reason, we will not try to rejoin the room if
   * the user explicitly asked to leave.
   */
  const clientStoppedRef = useRef(true);
  const heartbeatRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const incomingFilesRef = useRef(newIncomingRegistry());
  // --- notices at the top of the screen, and messages waiting to be sent ---
  const flashRef = useRef(createFlashQueue({ durationMs: initialPrefs.flash.seconds * 1000 }));
  const [flash, setFlash] = useState<{ current: FlashMessage | null; queued: number }>({ current: null, queued: 0 });
  /** Light mode has no server to hold a message: it waits here instead. */
  const outboxRef = useRef(createOutbox<DataChannelEnvelope>(async (entry) => {
    const targets = entry.targets.length > 0 ? new Set(entry.targets) : undefined;
    return broadcastEnvelopeRef.current(entry.envelope, targets);
  }));
  /** Set once broadcastEnvelope exists (it is declared further down). */
  const broadcastEnvelopeRef = useRef<(envelope: DataChannelEnvelope, targets?: Set<string>) => Promise<number>>(async () => 0);
  /** Same for the flush, which a freshly opened channel wants to trigger. */
  const flushOutboxRef = useRef<(reason: string) => Promise<void>>(async () => undefined);
  const [queuedIds, setQueuedIds] = useState<Set<string>>(new Set());
  /** What the connection looked like when the browser put the page aside. */
  const suspendedStateRef = useRef<{ desired: DesiredState; room: string; away: boolean } | null>(null);
  /** Bottom edge of the header + status bar: where a docked panel may start. */
  const dockAnchorRef = useRef<HTMLDivElement | null>(null);
  /** Files we sent, by transferId: how to repeat the chunks a receiver lost. */
  const resendableRef = useRef(new Map<string, (seqs: number[]) => Promise<void>>());
  const passphraseRef = useRef("");
  const roomInputRef = useRef("");
  const locationWatcherRef = useRef<LocationWatcher | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null);
  const [callMode, setCallMode] = useState<"audio" | "video" | "off">("off");
  // DTLS fingerprints per peerId — populated when peer connection
  // transitions to "connected". Used for TOFU (trust on first use)
  // panel inside the security modal.
  const [peerFingerprints, setPeerFingerprints] = useState<Record<string, Fingerprint>>({});
  // Room-key fingerprint (deterministic SHA-256 over roomId + passphrase)
  // — used as a "differential presence" anchor so two connected rooms
  // with different passphrases never accidentally merge.
  const [roomFingerprint, setRoomFingerprint] = useState<string | null>(null);
  const [videoOn, setVideoOn] = useState(false);
  /**
   * Live transfer table. One entry per active or recently completed
   * file transfer, keyed by transferId. Entries bucket incoming and
   * outgoing flows and surface live stats (Bps, ETA, transport).
   * Cleared when the user dismisses or when GC expires the entry.
   */
  const [transfers, setTransfers] = useState<Array<{
    id: string;
    name: string;
    size: number;
    direction: "in" | "out";
    status: "active" | "completed" | "cancelled" | "error";
    stats: import("./lib/file-transfer").TransferStats;
    errorMessage?: string;
  }>>([]);
  // Async handlers outlive the render that created them; they read the latest
  // list through this ref instead of a stale closure.
  const transfersRef = useRef(transfers);
  useEffect(() => { transfersRef.current = transfers; }, [transfers]);
  const [pushBusy, setPushBusy] = useState(false);
  const remoteVideosRef = useRef<HTMLDivElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  function updateTransfer(id: string, patch: Partial<typeof transfers[number]>) {
    setTransfers((cur) => cur.map((t) => t.id === id ? { ...t, ...patch } : t));
  }
  function dropTransfer(id: string) {
    setTransfers((cur) => cur.filter((t) => t.id !== id));
  }
  function startTransferTracking(id: string, name: string, size: number, direction: "in" | "out") {
    setTransfers((cur) => {
      if (cur.some((t) => t.id === id)) return cur;
      const stats: import("./lib/file-transfer").TransferStats = {
        id,
        name,
        size,
        received: 0,
        direction,
        transport: "p2p",
        encrypted: true,
        bytesPerSecond: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        etaSeconds: 0,
        progress: 0,
      };
      return [...cur, { id, name, size, direction, status: "active", stats }];
    });
  }

  const openPeerCount = useMemo(() => peers.filter((peer) => peer.status === "open").length, [peers]);
  const audioPeerCount = useMemo(
    () => peers.filter((peer) => peer.audio === "live" || peer.audio === "muted").length,
    [peers],
  );

  const visibleMessages = useMemo(() => {
    const filtered = messages.filter((message) => !message.expiresAt || message.expiresAt > now);
    const sec = (room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY;
    if (sec.sort === "desc") return [...filtered].reverse();
    return filtered;
  }, [messages, now, prefs.roomSecurity, room]);

  // Away members count as reachable: the server takes the message for them.
  const canSend = status === "joined" && (openPeerCount > 0 || awayPeers.length > 0) && messageInput.trim().length > 0;

  function setPrefs(next: Partial<Preferences>) {
    setPrefsState((current) => {
      const merged = { ...current, ...next };
      savePreferences(merged);
      return merged;
    });
  }

  // Apply theme/font/effects whenever they change.
  useEffect(() => {
    applyTheme(prefs.theme, prefs.accent, prefs.layout);
  }, [prefs.theme, prefs.accent, prefs.layout]);
  useEffect(() => {
    applyTypography({
      font: prefs.font, chatFont: prefs.chatFont, monoFont: prefs.monoFont, sizePx: prefs.textSize,
      weight: prefs.fontWeight, lineHeight: prefs.lineHeight, letterSpacing: prefs.letterSpacing, chatScale: prefs.chatScale,
    });
  }, [prefs.font, prefs.chatFont, prefs.monoFont, prefs.textSize, prefs.fontWeight, prefs.lineHeight, prefs.letterSpacing, prefs.chatScale]);
  useEffect(() => {
    applyColorOverrides({
      accentColor: prefs.accentColor, bubbleMine: prefs.bubbleMine, bubbleTheirs: prefs.bubbleTheirs,
      uiRadius: prefs.uiRadius, bubbleRadius: prefs.bubbleRadius,
    });
  }, [prefs.accentColor, prefs.bubbleMine, prefs.bubbleTheirs, prefs.uiRadius, prefs.bubbleRadius, prefs.theme, prefs.accent]);
  useEffect(() => {
    applyDeviceAttributes(deviceInfo(), prefs.deviceLayout);
  }, [prefs.deviceLayout]);
  // Google fonts in use — the UI / messages / code fonts and any family an
  // Edit Mode rule names — load only with consent (the request reveals the IP).
  const styleOverrides = useStyleOverrides();
  useEffect(() => {
    const css = buildStylesheet(styleOverrides);
    const inRules = GOOGLE_FONTS.filter((f) => f.google && css.includes(`'${f.google.family}'`)).map((f) => f.id);
    ensureFonts([prefs.font, prefs.chatFont, prefs.monoFont, ...inRules], prefs.googleFonts);
  }, [prefs.font, prefs.chatFont, prefs.monoFont, prefs.googleFonts, styleOverrides]);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => watchFullscreen(setFullscreen), []);
  // A tab opened before a deploy keeps the old bundle: offer a reload.
  const [newBuild, setNewBuild] = useState<DeployedBuild | null>(null);
  useEffect(() => watchForNewVersion(setNewBuild), []);
  useEffect(() => {
    applyEffects(prefs.effects);
  }, [prefs.effects]);
  useEffect(() => {
    applyChatSurface({
      bgColor: prefs.chatBgColor,
      bgImage: prefs.chatBgImage,
      saturation: prefs.chatBgSaturation,
      opacity: prefs.chatBgOpacity,
      pattern: prefs.chatPattern,
      width: prefs.chatWidth,
    });
  }, [prefs.chatBgColor, prefs.chatBgImage, prefs.chatBgSaturation, prefs.chatBgOpacity, prefs.chatPattern, prefs.chatWidth]);
  useEffect(() => {
    document.documentElement.setAttribute("lang", prefs.lang);
  }, [prefs.lang]);

  // Persist widget layout, debounced so a drag does not thrash localStorage.
  function updateWidget(patch: Partial<WidgetState>) {
    setWidget((cur) => {
      const next = { ...cur, ...patch };
      if (widgetPersistRef.current !== null) window.clearTimeout(widgetPersistRef.current);
      widgetPersistRef.current = window.setTimeout(() => setPrefs({ widget: next }), 400);
      return next;
    });
  }

  // --- per-user message styling ---
  function setMessageStyle(key: string, patch: PerUserStyle) {
    setPrefsState((cur) => {
      const merged = sanitizePerUserStyle({ ...(cur.messageStyles[key] ?? {}), ...patch });
      const styles = { ...cur.messageStyles };
      if (isEmptyStyle(merged)) delete styles[key]; else styles[key] = merged;
      const next = { ...cur, messageStyles: styles };
      savePreferences(next);
      return next;
    });
  }
  function resetMessageStyle(key: string) {
    setPrefsState((cur) => {
      if (!cur.messageStyles[key]) return cur;
      const styles = { ...cur.messageStyles };
      delete styles[key];
      const next = { ...cur, messageStyles: styles };
      savePreferences(next);
      return next;
    });
  }

  // --- recipient selection (drives the floating widget + composer hint) ---
  function togglePeerRecipient(peerId: string) {
    if (widget.autoRoom) {
      // Switching from "everyone" to a private subset: start with just this one.
      updateWidget({ autoRoom: false });
      setRecipients(new Set([peerId]));
      return;
    }
    setRecipients((cur) => {
      const next = new Set(cur);
      if (next.has(peerId)) next.delete(peerId); else next.add(peerId);
      return next;
    });
  }
  function selectAllRecipients() {
    updateWidget({ autoRoom: false });
    setRecipients(new Set([
      ...Array.from(peersRef.current.values()).filter((p) => p.channel?.readyState === "open").map((p) => p.id),
      ...awayPeersRef.current.map((a) => awayKey(a.accountId)),
    ]));
  }
  function selectNoRecipients() { setRecipients(new Set()); }
  function setAutoRoom(auto: boolean) { updateWidget({ autoRoom: auto }); if (auto) setRecipients(new Set()); }

  // ---------------------------------------------------------------------
  // The signed-in user: their passkey account, the encrypted vault and the
  // away relay the server runs for them (server/accounts/*).
  // ---------------------------------------------------------------------

  useEffect(() => { accountRef.current = account; }, [account]);
  useEffect(() => { awayPeersRef.current = awayPeers; }, [awayPeers]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { retentionRef.current = prefs.chatRetention; }, [prefs.chatRetention]);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  /** Away members appear in the recipients list under this id. */
  const awayKey = (accountId: string) => `away:${accountId}`;

  /** Merge restored / relayed messages into the conversation, by id and time. */
  function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    if (incoming.length === 0) return current;
    const byId = new Map(current.map((m) => [m.id, m]));
    for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m);
    return Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What the vault keeps for this conversation (trimmed, never the cipher). */
  function chatVaultPayload() {
    return {
      messages: prepareHistory(messagesRef.current),
      rooms: roomRef.current ? [roomRef.current] : [],
      savedAt: Date.now(),
    };
  }

  /** Stores the conversation where the chosen retention mode says it goes.
   *  Coalesced to once every 30 s unless `force`. */
  async function persistChat(force = false) {
    const mode = retentionRef.current;
    const currentRoom = roomRef.current;
    if (!currentRoom || mode === "ephemeral") return;
    if (mode === "session") { await historyRef.current.save(currentRoom, messagesRef.current); return; }
    if (!accountRef.current) {
      // No passkey: the server-enhanced session store takes it, with a
      // one-day life (server/storage/service.ts).
      if (!storageSessionId()) return;
      const at = Date.now();
      if (!force && at - lastVaultSaveRef.current < 30_000) return;
      lastVaultSaveRef.current = at;
      // Sealed here first: the server keeps rows it cannot read, and no
      // names or ids beyond what ordering and expiry need.
      const sealer = serverSealerRef.current;
      const rows = await Promise.all(prepareHistory(messagesRef.current).map(async (m) => {
        const payload = await sealer.seal(m);
        return payload ? { id: m.id, room: currentRoom, createdAt: m.createdAt, senderId: "", senderName: "", mine: m.mine, expiresAt: m.expiresAt ?? 0, payload } : null;
      }));
      await putServerMessages(rows.filter((r): r is NonNullable<typeof r> => r !== null));
      return;
    }
    const at = Date.now();
    if (!force && at - lastVaultSaveRef.current < 30_000) return;
    lastVaultSaveRef.current = at;
    try {
      const summary = await saveVault({ chat: chatVaultPayload(), profile: profileFromPrefs(prefsRef.current) });
      if (summary) setAccount(summary);
    } catch (err) {
      setAccMsg((err as Error).message);
    }
  }

  /** Opens the server-side vault and brings its contents into the app. */
  async function applyVault(announce = false): Promise<number> {
    try {
      const { profile, chat } = await loadVault<Partial<Preferences>>();
      if (profile) setPrefs(profile);
      const restored = chat ? sanitizeRestored(chat.messages, myIdRef.current) : [];
      if (restored.length) setMessages((cur) => mergeMessages(cur, restored));
      void logAccountEvent("decrypt-ok", { messages: restored.length, profile: Boolean(profile) });
      void logAccountEvent("data-loaded", { messages: restored.length });
      if (restored.length) void logAccountEvent("chat-restored", { messages: restored.length });
      if (announce) systemMessage(t(lang, "acc.loaded").replace("{n}", String(restored.length)));
      return restored.length;
    } catch (err) {
      void logAccountEvent("decrypt-failed");
      setAccMsg(t(lang, "acc.decryptFailed"));
      throw err;
    }
  }

  /** Hands this device's push subscription to the account so the server can
   *  wake it while the user is away. */
  async function linkPushForAccount() {
    try {
      if (!("serviceWorker" in navigator)) return;
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await linkPushSubscription(subscription);
    } catch { /* notifications are optional */ }
  }

  /** Tell the server who we are on the open socket (away relay + presence).
   *  Protocol v2: an `auth` frame — rejoining the room (as v1 did) made
   *  every peer see us leave and come back, and tore down their WebRTC
   *  connections just because we signed in. */
  function announceAccountToServer() {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !roomRef.current) return;
    socket.send(JSON.stringify({
      type: "auth",
      token: accountToken() ?? null,
      away: retentionRef.current === "server" && Boolean(accountRef.current),
    }));
  }

  async function runAccountTask(work: () => Promise<void>) {
    setAccBusy(true);
    setAccMsg("");
    try { await work(); } catch (err) { setAccMsg((err as Error).message); } finally { setAccBusy(false); }
  }

  function signInToAccount() {
    return runAccountTask(async () => {
      const acc = await signInWithPasskey();
      setAccount(acc);
      setPrefs({ chatRetention: "server" });
      retentionRef.current = "server";
      setAccMsg(t(lang, "acc.signedInAs").replace("{name}", acc.userName));
      systemMessage(t(lang, "acc.signedInAs").replace("{name}", acc.userName));
      await applyVault(true);
      await linkPushForAccount();
      announceAccountToServer();
    });
  }

  function createAccount() {
    return runAccountTask(async () => {
      const acc = await registerAccount(prefs.name || "M5cet");
      setAccount(acc);
      setPrefs({ chatRetention: "server" });
      retentionRef.current = "server";
      await saveVault({ profile: profileFromPrefs(prefsRef.current), chat: chatVaultPayload() });
      setAccount(currentAccount());
      setAccMsg(t(lang, "acc.signedInAs").replace("{name}", acc.userName));
      await linkPushForAccount();
      announceAccountToServer();
    });
  }

  /** "Sign out — wipe the session and its data": the server keeps the sealed
   *  vault, this browser keeps nothing. */
  function signOutAndWipe() {
    return runAccountTask(async () => {
      if (accountRef.current) {
        await persistChat(true).catch(() => undefined);
        void logAccountEvent("data-cleared");
        await signOutAccount();
      }
      await historyRef.current.clear();
      await sessionCacheRef.current.clear();
      setAccount(null);
      setAwayPeers([]);
      setMessages([]);
      setShowAccount(false);
      userDisconnect();
      systemMessage(t(lang, "data.cleared"));
      setAccMsg(t(lang, "data.cleared"));
    });
  }

  function deleteAccountForever() {
    if (!window.confirm(t(lang, "acc.delete.confirm"))) return;
    void runAccountTask(async () => {
      await deleteServerAccount();
      await historyRef.current.clear();
      setAccount(null);
      setAwayPeers([]);
      setMessages([]);
      setShowAccount(false);
      setPrefs({ chatRetention: "ephemeral" });
      retentionRef.current = "ephemeral";
      systemMessage(t(lang, "acc.deleted"));
    });
  }

  /** 3.1: the account window's passkey, recovery and device actions. */
  const accountActions = {
    onAddPasskey: (label: string) => void runAccountTask(async () => {
      setAccount(await addPasskey(label || navigator.platform || "passkey"));
      setAccMsg(t(lang, "acc.passkeys.added"));
    }),
    onRemovePasskey: (credentialId: string) => void runAccountTask(async () => { setAccount(await removePasskey(credentialId)); }),
    onCreateRecovery: async (): Promise<string | null> => {
      let code: string | null = null;
      await runAccountTask(async () => { const r = await createRecoveryCode(); setAccount(r.account); code = r.code; });
      return code;
    },
    onRemoveRecovery: () => void runAccountTask(async () => { setAccount(await removeRecoveryCode()); }),
    onEndSession: (id: string) => void runAccountTask(async () => { const fresh = await endSession(id); if (fresh) setAccount(fresh); }),
  };

  /** Every passkey lost: the recovery code, a new passkey, and back in. */
  function recoverAccount(code: string) {
    return runAccountTask(async () => {
      const acc = await recoverWithCode(code, navigator.platform || "recovered");
      setAccount(acc);
      setPrefs({ chatRetention: "server" });
      retentionRef.current = "server";
      setAccMsg(t(lang, "acc.recover.done"));
      systemMessage(t(lang, "acc.recover.done"));
      await applyVault(true);
      await linkPushForAccount();
      announceAccountToServer();
    });
  }

  function saveAccountDataNow() {
    void runAccountTask(async () => {
      await persistChat(true);
      const fresh = await refreshAccount();
      if (fresh) setAccount(fresh);
      setAccMsg(t(lang, "acc.saved"));
    });
  }

  /** Away members the next message should also reach. */
  function awayTargets(): AwayPeer[] {
    const list = awayPeersRef.current;
    if (list.length === 0) return [];
    if (widget.autoRoom) return list;
    return list.filter((a) => recipients.has(awayKey(a.accountId)));
  }

  /** Hands an already-encrypted envelope to the server for away members. */
  function relayToAway(messageId: string, envelope: DataChannelEnvelope, targets: AwayPeer[]): number {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || targets.length === 0) return 0;
    socket.send(JSON.stringify({ type: "relay", messageId, to: targets.map((a) => a.accountId), envelope }));
    return targets.length;
  }

  /** A status the server reports for a message we sent to an away member. */
  function applyRelayStatus(frame: { messageId: string; recipient: { name: string } & AccountRefFields; state: MsgState | "rejected" | "duplicate"; at: number; reason?: string }) {
    if (frame.state === "duplicate") return; // the server already had it
    if (frame.state === "rejected") {
      systemMessage(`${frame.recipient.name || "?"}: ${frame.reason ?? "relay rejected"}`);
      return;
    }
    const state = frame.state;
    if (state === "stored") systemMessage(t(lang, "away.stored").replace("{name}", frame.recipient.name));
    setMessages((cur) => cur.map((m) => {
      if (m.id !== frame.messageId || !m.mine) return m;
      if (m.audit?.some((a) => a.state === state && a.meta === frame.recipient.name)) return m;
      return { ...m, audit: [...(m.audit ?? []), { state, at: frame.at, meta: frame.recipient.name }] };
    }));
  }

  /** What the sender's signature says, and how it compares with the key we
   *  pinned for that name in this room (trust on first use). */
  async function identityFor(signer: Signer | null, senderName: string): Promise<MessageIdentity> {
    if (!signer) return { state: "unsigned" };
    // Signed in: the ACCOUNT key vouches for the device (3.1), so the pin
    // follows the person across devices; otherwise it is the device key.
    const byAccount = Boolean(signer.valid && signer.account?.valid);
    const pinned = byAccount ? signer.account!.publicKey : signer.publicKey;
    const kid = await keyId(pinned);
    const fingerprint = await keyFingerprint(pinned);
    if (!signer.valid || (signer.account && !signer.account.valid)) {
      warnOnce(`invalid:${kid}`, t(lang, "sec.identity.invalidFlash").replace("{name}", senderName), "error");
      return { state: "invalid", kid, fingerprint };
    }
    let verdict = pinsRef.current.check(roomRef.current, senderName, kid);
    // The same device signing in to its account is an upgrade, not a stranger.
    if (verdict === "changed" && byAccount && pinsRef.current.pinned(roomRef.current, senderName) === await keyId(signer.publicKey)) {
      pinsRef.current.accept(roomRef.current, senderName, kid);
      verdict = "match";
    }
    if (verdict === "changed") {
      warnOnce(`changed:${kid}`, t(lang, "sec.identity.changedFlash").replace("{name}", senderName), "error");
      return { state: "changed", kid, fingerprint, account: byAccount };
    }
    return { state: "verified", kid, fingerprint, account: byAccount };
  }

  /** A security notice, once per subject per session. */
  function warnOnce(subject: string, text: string, kind: FlashMessage["kind"] = "warning") {
    if (warnedPeersRef.current.has(subject)) return;
    warnedPeersRef.current.add(subject);
    systemMessage(text, { kind });
  }

  /** A validated chat payload as a conversation entry. */
  function chatMessageFrom(p: ChatPayload, extra: Partial<ChatMessage>): ChatMessage {
    return {
      id: p.id,
      senderId: p.senderId,
      senderName: p.senderName,
      text: p.text,
      createdAt: p.createdAt,
      attachment: p.attachment,
      mine: false,
      secure: true,
      expiresAt: computeExpiry(p.ttlMinutes, p.createdAt),
      flags: p.flags,
      to: p.to,
      replyTo: p.replyTo,
      forwardedFrom: p.forwardedFrom,
      ...extra,
    };
  }

  /** The mailbox the server kept while we were away. */
  async function handleRelayDelivery(items: RelayItem[]) {
    const keys = keyRef.current;
    if (!keys || items.length === 0) return;
    const handled: string[] = [];
    const incoming: ChatMessage[] = [];
    for (const item of items) {
      if (item.kind === "status" && item.status) {
        applyRelayStatus({
          messageId: item.messageId,
          recipient: { accountId: accountRefOf(item.from), name: item.status.recipientName },
          state: item.status.state,
          at: item.status.at,
        });
        handled.push(item.id);
        continue;
      }
      if (!item.envelope) { handled.push(item.id); continue; }
      let opened: Awaited<ReturnType<typeof openMessage<unknown>>>;
      try {
        opened = await openMessage<unknown>(keys, item.envelope);
      } catch {
        // Not our room key (another passphrase) — leave it; it expires on
        // the server, or opens once we join with the right key.
        continue;
      }
      handled.push(item.id);
      // The payload must name the peer the server says relayed it, and
      // never us; anything malformed is dropped.
      const plaintext = validatePayload(opened.payload, { transportSender: item.from.peerId, myId: myIdRef.current });
      if (!plaintext || plaintext.kind === "audio-status") continue;
      if (messagesRef.current.some((m) => m.id === plaintext.id) || !replayRef.current.accept(plaintext.id)) continue;
      relaySendersRef.current.set(plaintext.id, { peerId: item.from.peerId, accountId: accountRefOf(item.from) });
      incoming.push(chatMessageFrom(plaintext, {
        cryptoVersion: opened.version,
        identity: await identityFor(opened.signer, plaintext.senderName),
        audit: [
          { state: "created", at: plaintext.createdAt },
          { state: "stored", at: item.storedAt, meta: "server" },
          { state: "received", at: Date.now(), meta: "relay" },
          { state: "decrypted", at: Date.now() },
        ],
      }));
    }
    if (incoming.length > 0) {
      setMessages((cur) => mergeMessages(cur, incoming));
      systemMessage(t(lang, "away.received").replace("{n}", String(incoming.length)));
      void logAccountEvent("decrypt-ok", { messages: incoming.length });
    }
    const socket = socketRef.current;
    if (handled.length > 0 && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "relay-ack", ids: handled }));
    }
  }

  /** The furthest a message of mine got, for the mark on its bubble. */
  function deliveryStateOf(message: ChatMessage): MsgState | undefined {
    if (!message.mine) return undefined;
    if (queuedIds.has(message.id)) return "queued";
    const sec = (room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY;
    if (!sec.messageStatus) return undefined;
    const order: MsgState[] = ["sent", "stored", "forwarded", "delivered", "read"];
    let best: MsgState | undefined;
    for (const entry of message.audit ?? []) {
      if (order.indexOf(entry.state) > order.indexOf(best ?? "sent")) best = entry.state;
      else if (!best && entry.state === "sent") best = "sent";
    }
    return best;
  }

  /** Read receipt for a message the server relayed to us. */
  function sendReadReceipt(messageId: string) {
    const sender = relaySendersRef.current.get(messageId);
    const socket = socketRef.current;
    if (!sender || socket?.readyState !== WebSocket.OPEN) return;
    const sec = (roomRef.current && prefsRef.current.roomSecurity[roomRef.current]) || DEFAULT_ROOM_SECURITY;
    if (!sec.readReceipts) return;
    // Protocol v2: the server routes it by what it relayed to us — no
    // address from our side (a v1 client could aim receipts anywhere).
    socket.send(JSON.stringify({ type: "receipt", messageIds: [messageId], state: "read" }));
  }

  useEffect(() => {
    if (!notice) setNotice(t(lang, "chat.empty.body"));
    // intentionally no deps for first render only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  useEffect(() => {
    audioStatusRef.current = audioStatus;
  }, [audioStatus]);

  useEffect(() => {
    notificationsEnabledRef.current = prefs.notificationsEnabled;
  }, [prefs.notificationsEnabled]);

  useEffect(() => {
    if (!capabilities.localStorage) return;
    setPrefs({ name, lastRoom: roomInput });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, roomInput]);

  useEffect(() => {
    if (prefs.mode !== "server") return;
    let cancelled = false;
    void (async () => {
      const remote = await fetchPushStatus();
      if (cancelled || !remote) return;
      setPushAvailable(remote.enabled);
      setPushVapidKey(remote.vapidPublicKey);
      if (capabilities.serviceWorker) await ensureServiceWorker();
    })();
    return () => {
      cancelled = true;
    };
  }, [prefs.mode, capabilities.serviceWorker]);

  useEffect(() => {
    installPublicAPI();
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [visibleMessages.length]);

  // Tick once a second to evict expired messages.
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      setMessages((current) => current.filter((message) => !message.expiresAt || message.expiresAt > Date.now()));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  function setPeerView(id: string, update: Partial<PeerView> & { name?: string; initiator?: boolean }) {
    setPeers((current) => {
      const existing = current.find((peer) => peer.id === id);
      if (!existing) {
        return [
          ...current,
          {
            id,
            name: update.name || `peer-${id.slice(-4)}`,
            status: update.status || "connecting",
            initiator: update.initiator ?? false,
            audio: update.audio || "off",
          },
        ];
      }
      return current.map((peer) => (peer.id === id ? { ...peer, ...update } : peer));
    });
  }

  /**
   * A notice from the app itself. It flashes at the top of the screen, and
   * lands in the conversation only when the user asked for that — the chat
   * is for what people said (Preferences.showSystemInChat).
   */
  function systemMessage(text: string, opts: { detail?: string; kind?: FlashMessage["kind"]; chatOnly?: boolean } = {}) {
    const prefsNow = prefsRef.current;
    if (!opts.chatOnly && prefsNow.flash.enabled) {
      flashRef.current.push({ text, detail: opts.detail, kind: opts.kind ?? kindForText(text) });
    }
    if (!prefsNow.showSystemInChat && !opts.chatOnly) return;
    setMessages((current) => [
      ...current,
      {
        id: newId("system"),
        senderId: "system",
        senderName: "M5cet",
        text,
        createdAt: Date.now(),
        mine: false,
        secure: false,
      },
    ]);
  }

  /**
   * SDP and ICE go through the server sealed with the room's signal key
   * (crypto v2): it routes them but can neither read nor alter them — the
   * DTLS fingerprints inside the SDP are what makes a call end-to-end.
   * Sealing is async, so signals to one peer go out through a queue to keep
   * the offer ahead of its candidates.
   */
  function sendSignal(target: string, payload: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    const keys = keyRef.current;
    const from = myIdRef.current;
    const previous = signalOutRef.current.get(target) ?? Promise.resolve();
    const next = previous.then(async () => {
      const socket = socketRef.current;
      if (!keys || socket?.readyState !== WebSocket.OPEN) return;
      const sealed = await sealSignal(keys, from, target, payload);
      socket.send(JSON.stringify({ type: "signal", target, payload: sealed }));
    }).catch(() => undefined);
    signalOutRef.current.set(target, next);
  }

  /** Seals a chat payload for the room, signed by this device. */
  async function sealForRoom(payload: { id: string }): Promise<DataChannelEnvelope | null> {
    const keys = keyRef.current;
    if (!keys) return null;
    identityRef.current ??= await loadIdentity().catch(() => null);
    return sealMessage(keys, payload.id, payload, identityRef.current);
  }

  /** Send an envelope to every open peer, or only to `targets` (peerIds). */
  async function broadcastEnvelope(envelope: DataChannelEnvelope, targets?: Set<string>): Promise<number> {
    const serialized = JSON.stringify(envelope);
    const bytes = serialized.length;
    let sent = 0;
    peersRef.current.forEach((peer) => {
      if (targets && !targets.has(peer.id)) return;
      if (peer.channel?.readyState === "open") {
        try {
          peer.channel.send(serialized);
          sent += 1;
          const st = peerStatsRef.current.get(peer.id);
          if (st) st.sent += bytes;
        } catch {
          // ignore
        }
      }
    });
    return sent;
  }

  async function broadcastAudioStatus(next: AudioStatus) {
    const envelope = await sealForRoom({
      kind: "audio-status",
      id: newId("audio"),
      createdAt: Date.now(),
      senderId: myIdRef.current,
      senderName: nameRef.current,
      status: next,
    } as { id: string });
    if (envelope) await broadcastEnvelope(envelope);
  }

  function attachAudioTrack(handle: PeerHandle, stream: MediaStream) {
    if (handle.audioElement) {
      handle.audioElement.srcObject = stream;
      return;
    }
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.dataset.peerId = handle.id;
    audio.srcObject = stream;
    document.body.appendChild(audio);
    handle.audioElement = audio;
  }

  function detachAudioElement(handle: PeerHandle) {
    if (!handle.audioElement) return;
    handle.audioElement.srcObject = null;
    handle.audioElement.remove();
    handle.audioElement = undefined;
  }

  function ttlForRoom(): { perMessage: number; absolute: number } {
    const override = roomRef.current ? prefs.roomTtl[roomRef.current] : undefined;
    const perMessage = override?.defaultMinutes && override.defaultMinutes > 0 ? override.defaultMinutes : prefs.ttlDefaultMinutes;
    const absolute = override?.absoluteMinutes ?? 0;
    return { perMessage, absolute };
  }

  function computeExpiry(ttlMinutes: number | undefined, createdAt: number) {
    const { absolute } = ttlForRoom();
    const candidates: number[] = [];
    if (typeof ttlMinutes === "number" && ttlMinutes > 0) candidates.push(createdAt + ttlMinutes * 60 * 1000);
    if (absolute > 0) candidates.push(createdAt + absolute * 60 * 1000);
    return candidates.length === 0 ? undefined : Math.min(...candidates);
  }

  /**
   * What happens to a file arriving over either transport. `askAgain` sends
   * the receiver's request for lost chunks the way that transport needs.
   */
  function fileCallbacks(askAgain: (transferId: string, seqs: number[]) => boolean): IncomingCallbacks {
    return {
      onMeta: (meta, transport) => {
        startTransferTracking(meta.transferId, meta.name, meta.size, "in");
        systemMessage(
          `Přijímám soubor ${meta.name} (${formatBytes(meta.size)}) od ${meta.senderName} přes ${transport === "p2p" ? "P2P" : "server proxy"}.`,
        );
      },
      onNeed: (transferId, seqs, _transport, round) => {
        void sendServerLog("warn", "transfer.chunks-missing", { transferId, missing: seqs.length, round });
        // Do not throw away a file that is all but delivered.
        if (!askAgain(transferId, seqs)) return;
        systemMessage(lang === "cs"
          ? `Chybí ${seqs.length} částí souboru — žádám o jejich zopakování (pokus ${round}).`
          : `${seqs.length} file chunks missing — asking the sender to repeat them (attempt ${round}).`);
      },
      onProgress: (id, recv, total, stats) => {
        updateTransfer(id, { stats: { ...stats, received: recv, size: total } });
      },
      onComplete: (id, blob, meta, transport, proof) => {
        updateTransfer(id, {
          status: "completed",
          stats: {
            id,
            name: meta.name,
            size: meta.size,
            received: meta.size,
            direction: "in",
            transport,
            encrypted: true,
            bytesPerSecond: 0,
            startedAt: meta.createdAt,
            updatedAt: Date.now(),
            etaSeconds: 0,
            progress: 1,
          },
        });
        // Auto-dismiss complete card after 60 s so the chat stream
        // does not grow unbounded when many files arrive.
        window.setTimeout(() => dropTransfer(id), 60_000);
        // meta.mime is already reduced to a type that is safe to open from
        // a blob: URL of this origin (file-transfer.ts checkMeta).
        const url = URL.createObjectURL(blob);
        systemMessage(t(lang, proof.verified ? "file.verified" : "file.unverified").replace("{name}", meta.name), { kind: proof.verified ? "success" : "info" });
        void identityFor(proof.signer, meta.senderName).then((identity) => {
          setMessages((current) => current.some((m) => m.id === meta.transferId) ? current : [
            ...current,
            {
              id: meta.transferId,
              senderId: meta.senderId,
              senderName: meta.senderName,
              text: "",
              createdAt: meta.createdAt,
              mine: false,
              secure: true,
              cryptoVersion: proof.version,
              identity,
              attachment: {
                kind: isInlineImage(meta.mime) ? "image" : "file",
                name: meta.name,
                mime: meta.mime,
                size: meta.size,
                dataUrl: url,
              },
            },
          ]);
        });
      },
      onCancel: (id) => updateTransfer(id, { status: "cancelled" }),
      onError: (id, msg) => {
        updateTransfer(id, { status: "error", errorMessage: msg });
        systemMessage(`File transfer failed: ${msg}`, { kind: "error" });
      },
    };
  }

  function wireDataChannel(peerId: string, channel: RTCDataChannel) {
    const handle = peersRef.current.get(peerId);
    if (handle) {
      handle.channel = channel;
    }
    const peerName = () => peersRef.current.get(peerId)?.name || `peer-${peerId.slice(-4)}`;

    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      peerStatsRef.current.set(peerId, { sent: 0, recv: 0, openedAt: Date.now() });
      setPeerView(peerId, { status: "open" });
      setNotice(lang === "cs"
        ? "P2P data kanál je otevřený."
        : lang === "de" ? "P2P-Datenkanal offen." : "P2P data channel is open.");
      // Crypto v2: both sides compare key check values first, so a wrong
      // passphrase shows up as exactly that instead of undecryptable noise.
      const keys = keyRef.current;
      if (keys) {
        try { channel.send(JSON.stringify({ kind: "key-check", v: 2, check: keys.check })); } catch { /* closing */ }
      }
      void broadcastAudioStatus(audioStatusRef.current);
    };
    channel.onclose = () => setPeerView(peerId, { status: "closed", audio: "off" });
    // Someone came online: whatever was waiting for them can go now.
    channel.addEventListener("open", () => { void flushOutboxRef.current("kanál otevřen"); });
    channel.onerror = () => {
      setPeerView(peerId, { status: "closed" });
      systemMessage(`Connection with ${peerName()} dropped.`);
    };
    channel.onmessage = async (event) => {
      const dataStr = String(event.data);
      const st = peerStatsRef.current.get(peerId);
      if (st) st.recv += dataStr.length;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(dataStr) as Record<string, unknown>; } catch { return; }
      if (!raw || typeof raw !== "object") return;
      const keys = keyRef.current;
      if (!keys) return;

      if (raw.kind === "key-check") {
        if (raw.check !== keys.check) warnOnce(`mismatch:${peerId}`, t(lang, "sec.keyMismatch").replace("{name}", peerName()), "error");
        return;
      }

      // The receiver lost a few chunks and asks for them again.
      if (raw.kind === "file-need") {
        const transferId = String(raw.transferId ?? "");
        const seqs = Array.isArray(raw.seqs) ? raw.seqs.filter((n): n is number => Number.isInteger(n)).slice(0, 5_000) : [];
        const repeat = resendableRef.current.get(transferId);
        if (repeat && seqs.length) {
          systemMessage(lang === "cs"
            ? `Posílám znovu ${seqs.length} chybějících částí souboru.`
            : `Re-sending ${seqs.length} missing file chunks.`);
          void repeat(seqs).catch(() => undefined);
        }
        return;
      }

      // File transfer frames bypass the normal envelope decode.
      if (typeof raw.kind === "string" && /^file-(meta|chunk|end|cancel)$/.test(raw.kind) && typeof raw.transferId === "string") {
        await handleIncomingFrame(keys, incomingFilesRef.current, raw as unknown as FileTransferEnvelope, prefs.maxAttachmentBytes, fileCallbacks((transferId, seqs) => {
          try {
            channel.send(JSON.stringify({ kind: "file-need", transferId, seqs, transport: "p2p" }));
            return true;
          } catch { return false; } // channel gone: the end-of-transfer error follows
        }));
        return;
      }

      const envelope = raw as unknown as DataChannelEnvelope;
      const receivedAt = Date.now();
      let opened: Awaited<ReturnType<typeof openMessage<unknown>>>;
      try {
        opened = await openMessage<unknown>(keys, envelope);
      } catch {
        systemMessage(lang === "cs"
          ? "Přišla zpráva, ale nejde dešifrovat. Druhá strana má pravděpodobně jiný klíč."
          : lang === "de" ? "Nachricht konnte nicht entschlüsselt werden — andere Seite hat anderen Schlüssel."
            : "A message arrived but could not be decrypted. The other side likely has a different room key.");
        return;
      }
      if (opened.version === 1) warnOnce(`legacy:${peerId}`, t(lang, "sec.legacyPeer").replace("{name}", peerName()));

      // Checked, bounded, and bound to this channel's peer: a payload
      // naming another sender (or us) is not shown.
      const plaintext = validatePayload(opened.payload, { transportSender: peerId, myId: myIdRef.current });
      if (!plaintext) {
        warnOnce(`dropped:${peerId}`, t(lang, "proto.dropped").replace("{name}", peerName()));
        return;
      }
      if (!replayRef.current.accept(plaintext.id)) return; // a replay: already shown

      if (plaintext.kind === "audio-status") {
        setPeerView(peerId, { audio: plaintext.status });
        return;
      }
      if (messagesRef.current.some((m) => m.id === plaintext.id)) return;

      const identity = await identityFor(opened.signer, plaintext.senderName);
      setMessages((current) => [
        ...current,
        chatMessageFrom(plaintext, {
          cipher: envelope.ciphertext,
          cryptoVersion: opened.version,
          identity,
          audit: [
            { state: "created", at: plaintext.createdAt },
            { state: "received", at: receivedAt, meta: peerId.slice(-6) },
            { state: "decrypted", at: Date.now() },
          ],
        }),
      ]);
      dispatchInternal("message", { senderId: plaintext.senderId });

      if (
        notificationsEnabledRef.current &&
        typeof document !== "undefined" &&
        document.hidden &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(`M5cet · ${plaintext.senderName}`, {
            body: plaintext.flags?.sealed ? "🔒" : plaintext.text || "(attachment)",
            tag: "m5cet",
          });
        } catch {
          // ignore
        }
      }
    };
  }

  async function createPeer(peerId: string, peerName: string, initiator: boolean) {
    if (peersRef.current.has(peerId) || peerId === myIdRef.current) return;

    // TURN credentials may be short-lived (TURN_SECRET): refreshed here if close to expiry.
    const pc = new RTCPeerConnection(await freshRtcConfig());
    if (peersRef.current.has(peerId)) { pc.close(); return; } // raced by another signal meanwhile
    const handle: PeerHandle = {
      id: peerId,
      name: peerName,
      pc,
      initiator,
      audio: "off",
      outgoingAudioSenders: [],
    };
    peersRef.current.set(peerId, handle);
    setPeerView(peerId, { name: peerName, status: "connecting", initiator });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, event.candidate.toJSON());
      }
    };
    pc.onconnectionstatechange = () => {
      if (["closed", "failed", "disconnected"].includes(pc.connectionState)) {
        setPeerView(peerId, { status: "closed", audio: "off" });
      }
      if (pc.connectionState === "connected") {
        // Best-effort TOFU fingerprint collection. We tolerate null
        // (older browsers / blocked stats) — UI simply shows "not yet
        // available" in that case.
        void extractRemoteFingerprint(pc).then(async (raw) => {
          if (!raw) return;
          // Normalise to lowercase hex without colons and persist.
          const digest = raw.toLowerCase();
          const cmp = compareFingerprint(peerId, digest);
          persistFingerprint(peerId, digest);
          setPeerFingerprints((prev) => ({
            ...prev,
            [peerId]: {
              digest,
              firstSeenAt: cmp.stored?.firstSeenAt || new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            },
          }));
          if (cmp.status === "mismatch") {
            systemMessage(
              `Bezpečnostní varování: DTLS fingerprint pro ${peerId.slice(-6)} se změnil — možný MITM. Ověřte s protistranou mimo-band.`,
            );
          }
        }).catch(() => {
          // Stats API may throw on closed connections — ignore.
        });
        // Best-effort: read the selected candidate pair so the user-info modal
        // can show the peer's remote address + how the media is routed.
        void extractPeerAddress(pc).then((net) => { if (net) peerNetRef.current.set(peerId, net); }).catch(() => undefined);
      }
    };
    pc.ondatachannel = (event) => wireDataChannel(peerId, event.channel);
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      attachAudioTrack(handle, stream);
      // Add a video element if the remote stream contains video tracks.
      const hasVideo = stream.getVideoTracks().length > 0;
      if (hasVideo && remoteVideosRef.current) {
        let v = remoteVideosRef.current.querySelector(`video[data-peer="${handle.id}"]`) as HTMLVideoElement | null;
        if (!v) {
          v = document.createElement("video");
          v.autoplay = true;
          v.playsInline = true;
          v.dataset.peer = handle.id;
          v.className = "aspect-video w-full rounded-2xl border border-border bg-black";
          remoteVideosRef.current.appendChild(v);
        }
        v.srcObject = stream;
      }
    };

    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getAudioTracks().forEach((track) => {
        const sender = pc.addTrack(track, localAudioStreamRef.current!);
        handle.outgoingAudioSenders.push(sender);
      });
    }

    if (initiator) {
      const channel = pc.createDataChannel("m5cet", { ordered: true });
      wireDataChannel(peerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peerId, offer);
    }
  }

  /** Signals from one peer are applied in the order they arrived: opening a
   *  sealed one is async, and a candidate must not overtake its offer. */
  function handleSignal(source: string, payload: unknown): Promise<void> {
    const previous = signalInRef.current.get(source) ?? Promise.resolve();
    const next = previous
      .then(() => applySignal(source, payload))
      .catch((err) => console.warn("[m5cet] signal from", source.slice(-6), "failed:", (err as Error)?.message ?? err));
    signalInRef.current.set(source, next);
    return next;
  }

  async function applySignal(source: string, payload: unknown) {
    const keys = keyRef.current;
    if (!keys) return;
    // Only sealed signals are accepted: a plain one could have been written
    // by the server itself (to sit in the middle of the call). v2 clients
    // always seal; a pre-3.0 client is told to update.
    if (!isSealedSignal(payload)) {
      warnOnce(`unsealed:${source}`, t(lang, "sec.unsealedSignal").replace("{name}", peersRef.current.get(source)?.name || `peer-${source.slice(-4)}`));
      return;
    }
    let desc: RTCSessionDescriptionInit | RTCIceCandidateInit;
    try {
      desc = await openSignal<RTCSessionDescriptionInit | RTCIceCandidateInit>(keys, source, myIdRef.current, payload.sealed);
    } catch {
      warnOnce(`mismatch:${source}`, t(lang, "sec.keyMismatch").replace("{name}", peersRef.current.get(source)?.name || `peer-${source.slice(-4)}`), "error");
      return;
    }

    let handle = peersRef.current.get(source);
    if (!handle) {
      await createPeer(source, `peer-${source.slice(-4)}`, false);
      handle = peersRef.current.get(source);
    }
    if (!handle) return;

    if ("type" in desc && (desc.type === "offer" || desc.type === "answer")) {
      await handle.pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        const answer = await handle.pc.createAnswer();
        await handle.pc.setLocalDescription(answer);
        sendSignal(source, answer);
      }
      return;
    }

    if ("candidate" in desc && desc.candidate) {
      await handle.pc.addIceCandidate(desc);
    }
  }

  function startHeartbeat() {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
    }
    const intervals = { conservative: 45_000, balanced: 25_000, aggressive: 12_000 } as const;
    const ms = intervals[prefs.keepaliveStrategy];
    heartbeatRef.current = window.setInterval(() => {
      const sock = socketRef.current;
      if (sock?.readyState === WebSocket.OPEN) {
        try { sock.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch { /* ignore */ }
      }
    }, ms);
  }

  function stopHeartbeat() {
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }

  /**
   * Persistent reconnect — retries forever while the user has intent to stay
   * connected. Only `disconnect()` clears the intent and stops the loop.
   * Used full-jitter exponential backoff capped at 120 s to avoid hammering
   * the server during an outage.
   */
  function scheduleReconnect() {
    if (!intentRef.current) return;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const attempt = ++reconnectAttemptsRef.current;
    const initial = prefs.keepaliveStrategy === "aggressive" ? 500 : prefs.keepaliveStrategy === "conservative" ? 1500 : 1000;
    const max = 120_000; // hard 2 min cap so we never sleep forever
    const exp = Math.min(max, initial * Math.pow(2, Math.min(attempt, 12)));
    // Full-jitter — picks a random delay in [0, exp]. This avoids
    // many clients synchronising after a global outage.
    const delay = Math.random() * exp;
    logConn("retry", attempt, delay);
    setNotice(lang === "cs"
      ? `Server odpojen — automatický reconnect za ${(delay / 1000).toFixed(1)}s (pokus #${attempt}).`
      : lang === "de" ? `Server unterbrochen — automatischer Reconnect in ${(delay / 1000).toFixed(1)}s (Versuch #${attempt}).`
        : `Server disconnected — auto-reconnect in ${(delay / 1000).toFixed(1)}s (attempt #${attempt}).`);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!intentRef.current) return;
      void attemptConnect();
    }, delay);
  }

  function logConn(event: ConnLogEvent, attempt = reconnectAttemptsRef.current, delayMs?: number) {
    const entry = { at: Date.now(), attempt, event, delayMs };
    // Kept in memory only, newest first, bounded.
    setConnLog((cur) => [entry, ...cur].slice(0, 50));
    console.info(`[m5cet] connection ${event} (attempt #${attempt}${delayMs !== undefined ? `, next in ${(delayMs / 1000).toFixed(1)}s` : ""})`);
  }

  /** One attempt that can never kill the loop: a throw schedules the next one. */
  async function attemptConnect() {
    try {
      await doConnect();
    } catch (err) {
      logConn("failed");
      console.warn("[m5cet] connect attempt threw", err);
      if (intentRef.current) { setStatus("offline"); scheduleReconnect(); }
    }
  }

  async function doConnect() {
    // Ensure the TURN config (if any) has been loaded before creating peer
    // connections. If the promise already resolved, this is a no-op.
    await turnConfigPromise;

    const nextRoom = normalizeRoom(roomInputRef.current);
    // A reconnect to the same room keeps our peer id (the server hands it
    // back against the resume secret): peers, queued messages and the
    // "mine" mark of our own history keep pointing at us.
    const resume = resumeRef.current?.room === nextRoom ? resumeRef.current : null;
    const nextPeerId = resume?.peerId ?? newId("peer");
    setStatus("deriving");
    setRoom(nextRoom);
    setMyId(nextPeerId);
    myIdRef.current = nextPeerId;
    roomRef.current = nextRoom;
    // 600 000 PBKDF2 rounds cost a second on a phone: derive once per room
    // and passphrase, not on every reconnect.
    const keyFor = `${nextRoom}\u0000${passphraseRef.current}`;
    if (!keyRef.current || keyForRef.current !== keyFor) {
      keyRef.current = await deriveRoomKeys(nextRoom, passphraseRef.current);
      keyForRef.current = keyFor;
      replayRef.current.clear();
    }
    identityRef.current ??= await loadIdentity().catch(() => null);
    // "A new connection clears the chat" is one of three choices now: the
    // session and server modes keep the conversation (chat-history.ts).
    if (retentionRef.current === "ephemeral") {
      setMessages([]);
      relaySendersRef.current.clear();
    } else if (retentionRef.current === "session") {
      const restored = await historyRef.current.load(nextRoom);
      if (restored.length > 0) {
        setMessages((cur) => mergeMessages(cur, restored));
        systemMessage(t(lang, "data.restored").replace("{n}", String(restored.length)));
      }
    } else if (retentionRef.current === "server" && !accountRef.current && storageSessionId()) {
      // The server kept this session's conversation (no passkey yet).
      const rows = await readServerMessages({ room: nextRoom });
      const opened = await Promise.all(rows.map((r) => serverSealerRef.current.open(r.id, r.payload)));
      const restored = sanitizeRestored(opened.filter((m) => m !== null), nextPeerId);
      if (restored.length > 0) {
        setMessages((cur) => mergeMessages(cur, restored));
        systemMessage(t(lang, "data.restored").replace("{n}", String(restored.length)));
      }
    }
    setPeers([]);
    setAwayPeers([]);
    // Compute the deterministic room-key fingerprint (DPA anchor). We
    // hash a constant-length string derived from the room id so the
    // fingerprint is independent of the password length but only changes
    // when the room id changes.
    void sha256Hex(`m5cet:room:${nextRoom}`).then((digest) => setRoomFingerprint(digest));
    // Clear old peer fingerprints — each room has its own set.
    setPeerFingerprints({});
    setStatus("connecting");
    logConn("connecting", reconnectAttemptsRef.current + 1);

    const socket = new WebSocket(wsUrl());
    socketRef.current = socket;
    // Storage operations ride on this socket rather than opening their own
    // connection (lib/storage-client.ts).
    attachStorageSocket(socket);

    socket.onopen = () => {
      logConn("open", reconnectAttemptsRef.current + 1);
      reconnectAttemptsRef.current = 0;
      // A signed-in user with server-side history joins with their account
      // token and asks the server to stay in the room for them (away relay).
      socket.send(JSON.stringify({
        type: "join",
        protocol: 2,
        room: nextRoom,
        peerId: nextPeerId,
        ...(resume ? { resume: resume.secret } : {}),
        name: nameRef.current,
        ...(accountToken() ? { auth: accountToken() } : {}),
        away: retentionRef.current === "server" && Boolean(accountRef.current),
      }));
      socket.send(JSON.stringify({ type: "command-poll", deviceId: prefs.deviceId }));
      startHeartbeat();
      setConnStatus({
        state: "open",
        lastActivityAt: Date.now(),
        lastPingAt: 0,
        lastPongAt: 0,
        rttMs: 0,
        attempts: 0,
        strategy: prefs.keepaliveStrategy,
	disconnectReason: "idle",      // ← přidat
  	nextReconnectAtMs: 0,          // ← přidat
  	totalReconnects: 0,  
      });
    };
    wireSocketHandlers(socket);
  }

  function wireSocketHandlers(socket: WebSocket) {
    socket.onmessage = async (event) => {
      let frame: SignalFrame;
      try { frame = JSON.parse(String(event.data)) as SignalFrame; } catch { return; }

      if (frame.type === "pong") {
        const rtt = Math.max(0, Date.now() - (frame.t || 0));
        setConnStatus((s) => s ? { ...s, lastPongAt: Date.now(), rttMs: rtt } : s);
        return;
      }

      if (frame.type === "admin-command") {
        const cmd = frame.command;
        if (!isAdminCommand(cmd)) return;
        await dispatchCommand(cmd, {
          onRefreshSettings: () => {
            const fresh = loadPreferences();
            setPrefsState(fresh);
            systemMessage(lang === "cs" ? "Nastavení obnovena administrátorem." : "Settings refreshed by admin.");
          },
          onReconnect: () => {
            try { socketRef.current?.close(4001, "admin-reconnect"); } catch { /* ignore */ }
          },
          onPurgeLocal: () => {
            clearPreferences();
            systemMessage(lang === "cs" ? "Lokální data smazána (admin příkaz)." : "Local data purged (admin).");
          },
          onShowNotification: (title, body) => {
            systemMessage(`[admin] ${title}: ${body}`);
            try { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body }); } catch { /* ignore */ }
          },
          onRunDiagnostic: () => ({
            ua: navigator.userAgent.slice(0, 80),
            online: navigator.onLine,
            peers: peersRef.current.size,
            rttMs: connStatus?.rttMs ?? null,
            time: new Date().toISOString(),
          }),
          onDownloadFile: async (cmdInner) => {
            const url = String(cmdInner.payload?.url || "");
            const name = String(cmdInner.payload?.name || "admin-file").slice(0, 120);
            // Only this site or an https address — never file:, data:,
            // javascript: or a plain-http address on the local network.
            let target: URL;
            try { target = new URL(url, window.location.href); } catch { return; }
            if (target.origin !== window.location.origin && target.protocol !== "https:") return;
            const consent = window.confirm(lang === "cs"
              ? `Administrátor chce stáhnout soubor: ${name}\nSouhlasíš?`
              : `Admin wants you to download a file: ${name}\nProceed?`);
            if (!consent) return;
            try {
              const res = await fetch(url);
              const blob = await res.blob();
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = name;
              a.click();
            } catch (err) {
              systemMessage(`download failed: ${(err as Error).message}`);
            }
          },
        });
        try {
          socket.send(JSON.stringify({ type: "command-ack", commandId: cmd.id }));
        } catch { /* ignore */ }
        return;
      }

      if (frame.type === "joined") {
        // Protocol v2: the server decides our peer id (it keeps the one we
        // asked for unless someone else holds it) and gives us a secret to
        // claim it again after a reconnect.
        if (frame.peerId && frame.peerId !== myIdRef.current) {
          myIdRef.current = frame.peerId;
          setMyId(frame.peerId);
        }
        resumeRef.current = frame.resume ? { room: frame.room, peerId: frame.peerId, secret: frame.resume } : null;
        setStatus("joined");
        systemMessage(`Joined ${frame.room}. Peers: ${frame.peers.length}.`);
        setAwayPeers((frame.away ?? []).map((a) => ({ accountId: accountRefOf(a), name: a.name, since: a.since })).filter((a) => a.accountId));
        if (frame.account && "invalid" in frame.account) {
          // The token did not outlive the server: sign in again to get the
          // vault and the relay back.
          setAccount(null);
          void restoreSession().then((acc) => { if (acc) { setAccount(acc); announceAccountToServer(); } });
        }
        for (const peer of frame.peers) {
          await createPeer(peer.peerId, peer.name, true);
        }
        if (prefs.mode === "server" && prefs.analyticsConsent) {
          void fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "client-join",
              room: roomRef.current,
              peerId: myIdRef.current,
              meta: { peers: frame.peers.length, deviceId: prefs.deviceId },
            }),
          }).catch(() => undefined);
        }
        // Close the join form only after a join the user asked for: an
        // automatic reconnect (restore, resume, network blip) must not shut
        // a panel they have just opened.
        if (closeJoinPanelRef.current) {
          closeJoinPanelRef.current = false;
          setActivePanel((current) => (current === "join" ? null : current));
        }
      }

      if (frame.type === "peer-joined") {
        setPeerView(frame.peerId, { name: frame.name, status: "connecting", initiator: false });
        systemMessage(`${frame.name} entered the room.`);
      }

      if (frame.type === "peer-away") {
        const ref = accountRefOf(frame);
        if (!ref) return;
        setAwayPeers((cur) => [...cur.filter((a) => a.accountId !== ref), { accountId: ref, name: frame.name, since: frame.since }]);
        systemMessage(t(lang, "away.peer").replace("{name}", frame.name));
        return;
      }

      if (frame.type === "peer-back" || frame.type === "peer-gone") {
        const ref = accountRefOf(frame);
        setAwayPeers((cur) => cur.filter((a) => a.accountId !== ref));
        return;
      }

      if (frame.type === "peer-updated") {
        // Someone signed in or out without leaving the room.
        setPeerView(frame.peerId, { name: frame.name });
        return;
      }

      if (frame.type === "auth-result") {
        if (frame.invalid) {
          // The token did not outlive the server: sign in again to get the
          // vault and the relay back.
          setAccount(null);
          void restoreSession().then((acc) => { if (acc) { setAccount(acc); announceAccountToServer(); } });
        }
        return;
      }

      if (frame.type === "account-revoked") {
        // Signed out elsewhere, deleted, or ended by the operator. Our own
        // sign-out arrives here too — then there is nothing left to do.
        if (accountRef.current) {
          systemMessage(t(lang, "proto.revoked").replace("{reason}", frame.reason), { kind: "warning" });
          void signOutAccount().catch(() => undefined);
          setAccount(null);
          setAwayPeers([]);
        }
        return;
      }

      if (frame.type === "rate-limited") {
        setNotice(t(lang, "proto.rateLimited").replace("{frame}", frame.frame));
        return;
      }

      if (frame.type === "closed-by-server") {
        systemMessage(t(lang, "proto.closedByServer").replace("{reason}", frame.reason), { kind: "warning" });
        return;
      }

      if (frame.type === "presence-ack" || frame.type === "signal-undeliverable" || frame.type === "replaced" || frame.type === "hello") {
        return;
      }

      if (frame.type === "relay-deliver") {
        await handleRelayDelivery(frame.items);
        return;
      }

      if (frame.type === "relay-status") {
        applyRelayStatus(frame);
        return;
      }

      if (frame.type === "peer-left") {
        const handle = peersRef.current.get(frame.peerId);
        handle?.channel?.close();
        if (handle) detachAudioElement(handle);
        handle?.pc.close();
        peersRef.current.delete(frame.peerId);
        setPeers((current) => current.filter((peer) => peer.id !== frame.peerId));
        systemMessage(`Peer ${frame.peerId.slice(-6)} left.`);
      }

      if (frame.type === "signal") {
        void handleSignal(frame.source, frame.payload);
        return;
      }

      if (frame.type === "error") {
        setNotice(frame.message);
      }

      // ---------- Server-relayed file transfer (proxy mode) ----------
      if (frame.type === "proxy-need") {
        const repeat = resendableRef.current.get(frame.transferId);
        if (repeat) {
          systemMessage(lang === "cs"
            ? `Posílám znovu ${frame.seqs.length} chybějících částí souboru.`
            : `Re-sending ${frame.seqs.length} missing file chunks.`);
          void repeat(frame.seqs).catch(() => undefined);
        }
        return;
      }

      if (frame.type === "proxy-ack") {
        if (!frame.accepted) {
          setNotice(
            lang === "cs"
              ? `Server proxy odmítl přenos: ${frame.reason ?? "neznámý důvod"}.`
              : `Server relay refused transfer: ${frame.reason ?? "unknown"}`,
          );
        }
        return;
      }
      if (
        frame.type === "proxy-meta" ||
        frame.type === "proxy-chunk" ||
        frame.type === "proxy-end" ||
        frame.type === "proxy-cancel"
      ) {
        const keys = keyRef.current;
        if (!keys) return;
        // The proxy frames have the same shape as the p2p file-transfer
        // envelopes; version, iv and ciphertext pass through unchanged.
        const ftx = {
          kind: frame.type,
          transferId: frame.transferId,
          transport: "proxy",
          ...("v" in frame && frame.v ? { v: frame.v } : {}),
          ...("seq" in frame ? { seq: frame.seq } : {}),
          ...("iv" in frame && frame.iv ? { iv: frame.iv } : {}),
          ...("ciphertext" in frame && frame.ciphertext ? { ciphertext: frame.ciphertext } : {}),
        } as FileTransferEnvelope;
        await handleIncomingFrame(keys, incomingFilesRef.current, ftx, prefs.maxAttachmentBytes, fileCallbacks((transferId, seqs) => {
          const sock = socketRef.current;
          if (sock?.readyState !== WebSocket.OPEN) return false;
          sock.send(JSON.stringify({ type: "proxy-need", transferId, seqs }));
          return true;
        }));
        return;
      }
    };
    socket.onclose = () => {
      stopHeartbeat();
      // Two reasons the socket closes today:
      //   1. The user explicitly disconnected → clientStoppedRef.current is true.
      //   2. Anything else (server kicked us, NAT rebind, Wi-Fi blip, browser
      //      suspend) → reconnect until the user explicitly leaves.
      if (!clientStoppedRef.current) {
        logConn("closed");
        setStatus("offline");
        setConnStatus((s) => s ? { ...s, state: "reconnecting" } : s);
        scheduleReconnect();
      } else {
        setStatus((current) => (current === "idle" ? "idle" : "offline"));
        setConnStatus(null);
      }
    };
    socket.onerror = (event) => {
      // Browsers fire onerror immediately before onclose. Keep the user
      // informed without triggering a manual disconnect — scheduleReconnect
      // is called from onclose if intentRef is true.
      if (typeof event === "object" && event && "message" in event) {
        const msg = String((event as { message?: string }).message || "");
        setNotice(lang === "cs"
          ? `Spojení přerušeno${msg ? ` (${msg})` : ""}. Pokus o obnovení…`
          : lang === "de"
            ? `Verbindung unterbrochen${msg ? ` (${msg})` : ""}. Reconnect läuft…`
            : `Connection interrupted${msg ? ` (${msg})` : ""}. Auto-reconnect is running…`);
      } else {
        setStatus("offline");
      }
    };
  }

  async function connect(event?: FormEvent) {
    event?.preventDefault();
    if (!passphrase.trim()) {
      setNotice(lang === "cs" ? "Zadej klíč místnosti." : lang === "de" ? "Bitte Raum-Schlüssel eingeben." : "Enter the room key.");
      return;
    }
    disconnect(false);
    closeJoinPanelRef.current = true;
    // The user explicitly asked to (re)join; re-arm the persistent
    // connection so any later network blip will silently reconnect.
    await startSession(name, roomInput, passphrase);
  }

  /** "Reconnect" = fire the Disconnect action, wait 1–2 s, then fire Connect —
   *  a full teardown + fresh join rather than an in-place reconnect. */
  async function reconnectViaButtons() {
    if (!passphrase.trim() && !passphraseRef.current) {
      setNotice(lang === "cs" ? "Zadej klíč místnosti." : lang === "de" ? "Bitte Raum-Schlüssel eingeben." : "Enter the room key.");
      return;
    }
    setNotice(lang === "cs" ? "Reconnect: odpojuji…" : lang === "de" ? "Reconnect: trenne…" : "Reconnect: disconnecting…");
    userDisconnect();
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    setNotice(lang === "cs" ? "Reconnect: připojuji…" : lang === "de" ? "Reconnect: verbinde…" : "Reconnect: connecting…");
    await connect();
  }

  /** Desired state := connected. Used by the form, a restored session and invites. */
  async function startSession(nextName: string, nextRoom: string, nextPassphrase: string) {
    intentRef.current = true;
    clientStoppedRef.current = false;
    reconnectAttemptsRef.current = 0;
    passphraseRef.current = nextPassphrase;
    roomInputRef.current = nextRoom;
    nameRef.current = nextName;
    setDesired("connected");
    setSessionPassphrase(nextPassphrase);
    void sessionCacheRef.current.save({ name: nextName, room: nextRoom, passphrase: nextPassphrase, desired: "connected" }).catch(() => undefined);
    await attemptConnect();
  }

  /** Desired state := disconnected. The session stays cached (until the tab
   *  closes, an hour of idling, or Clear & Quit) so reconnecting is one click. */
  function userDisconnect() {
    const hadSession = passphraseRef.current;
    // Synchronous on purpose: a reload or a closed lid right after the click
    // must already find "disconnected" (the encrypted save below is async).
    sessionCacheRef.current.forceDisconnected();
    disconnect();
    logConn("stopped", 0);
    if (hadSession) {
      void sessionCacheRef.current.save({ name: nameRef.current, room: roomInputRef.current, passphrase: hadSession, desired: "disconnected" }).catch(() => undefined);
    }
  }

  function disconnect(showMessage = true) {
    // Only this path tears down the connection permanently. Server- or
    // browser-initiated close should reach here ONLY if the user clicked
    // the Disconnect button. Everywhere else we keep reconnecting.
    intentRef.current = false;
    clientStoppedRef.current = true;
    setDesired("disconnected");
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    stopHeartbeat();
    // Leaving on purpose while the server keeps our history: stay in the room
    // as away so messages still reach us (server/accounts/relay.ts).
    const stayAway = retentionRef.current === "server" && Boolean(accountRef.current);
    try { socketRef.current?.send(JSON.stringify({ type: "leave", away: stayAway })); } catch { /* ignore */ }
    socketRef.current?.close();
    socketRef.current = null;
    peersRef.current.forEach((peer) => {
      peer.channel?.close();
      detachAudioElement(peer);
      peer.pc.close();
    });
    peersRef.current.clear();
    keyRef.current = null;
    keyForRef.current = "";
    signalOutRef.current.clear();
    signalInRef.current.clear();
    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach((track) => track.stop());
      localVideoStreamRef.current = null;
    }
    locationWatcherRef.current?.stop();
    locationWatcherRef.current = null;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setPeers([]);
    setAudioStatus("off");
    setStatus("idle");
    setConnStatus(null);
    if (showMessage) {
      systemMessage(lang === "cs"
        ? "Lokální session ukončena. Klíč i WebRTC spojení jsou zahozena."
        : lang === "de" ? "Lokale Session beendet. Schlüssel und WebRTC-Verbindungen verworfen."
          : "Local session ended. Key and WebRTC connections discarded.");
    }
  }

  async function sendChatPayload(
    text: string,
    opts: {
      attachment?: AttachmentMeta; send?: SendState; targets?: Set<string>; toNames?: string[];
      replyTo?: { id: string; senderName: string; text: string }; forwardedFrom?: string;
      /** Signed-in members the server holds this message for. */
      away?: AwayPeer[];
    } = {},
  ) {
    if (!keyRef.current) return;
    const { perMessage } = ttlForRoom();
    const ttlMinutes = perMessage > 0 ? perMessage : undefined;
    const createdAt = Date.now();
    const audit: MessageAudit[] = [{ state: "created", at: createdAt }];

    // Build the optional message-kind flags from the send options.
    const send = opts.send;
    const flags: MsgFlags = {};
    if (send?.tap) flags.tap = true;
    if (send?.vanishSeconds && send.vanishSeconds > 0) flags.vanishSeconds = send.vanishSeconds;

    let wireText = text;
    let sealPlain: string | undefined;
    let sealCode: string | undefined;
    // Sealing applies to the text body (a per-message code, out of band).
    if (send?.sealed && text) {
      sealCode = (send.sealCode || "").trim() || generateSealCode();
      const { meta, ciphertext } = await sealText(text, sealCode);
      flags.sealed = meta;
      wireText = ciphertext;
      sealPlain = text;
    }
    const flagsOut = flags.tap || flags.vanishSeconds || flags.sealed ? flags : undefined;

    const payload = {
      id: newId("msg"),
      text: wireText,
      createdAt,
      senderId: myIdRef.current,
      senderName: nameRef.current,
      attachment: opts.attachment,
      ttlMinutes,
      flags: flagsOut,
      to: opts.toNames,
      replyTo: opts.replyTo,
      forwardedFrom: opts.forwardedFrom,
    };
    const envelope = await sealForRoom(payload);
    if (!envelope) return;
    audit.push({ state: "encrypted", at: Date.now() });
    const sent = await broadcastEnvelope(envelope, opts.targets);
    // Away members are not on a data channel: the server takes the ciphertext
    // for them and answers with "stored" / "delivered".
    const away = opts.away ?? [];
    const relayed = relayToAway(payload.id, envelope, away);
    // Nobody could take it: in light mode it waits in the outbox and the
    // bubble shows it as sending, rather than the message being refused.
    const queued = sent === 0 && relayed === 0
      && outboxRef.current.add({
        messageId: payload.id,
        room: roomRef.current ?? "",
        envelope,
        targets: opts.targets ? Array.from(opts.targets) : [],
        toNames: opts.toNames ?? [],
        createdAt: createdAt,
        expiresAt: computeExpiry(ttlMinutes, createdAt) ?? 0,
      }) !== null;
    audit.push(queued
      ? { state: "queued", at: Date.now(), meta: opts.toNames?.join(", ") }
      : { state: "sent", at: Date.now(), meta: `${sent + relayed} ${sent + relayed === 1 ? "příjemce" : "příjemců"}` });
    if (queued) setQueuedIds((cur) => new Set(cur).add(payload.id));

    if (sent > 0 || relayed > 0 || queued) {
      const expiresAt = computeExpiry(ttlMinutes, payload.createdAt);
      setMessages((current) => [
        ...current,
        {
          id: payload.id,
          senderId: payload.senderId,
          senderName: payload.senderName,
          text: payload.text,
          createdAt: payload.createdAt,
          attachment: payload.attachment,
          mine: true,
          secure: true,
          expiresAt,
          flags: flagsOut,
          to: opts.toNames,
          sealPlain,
          sealCode,
          audit,
          cipher: envelope.ciphertext,
          replyTo: opts.replyTo,
          forwardedFrom: opts.forwardedFrom,
        },
      ]);
      setMessageInput("");
      setReplyingTo(null);
      if (queued) {
        systemMessage(lang === "cs"
          ? "Zpráva čeká na příjemce — odešle se, jakmile bude online."
          : lang === "de" ? "Nachricht wartet auf den Empfänger — sie geht raus, sobald er online ist."
            : "The message is waiting for its recipient — it goes out as soon as they are online.");
      }
    } else {
      setNotice(lang === "cs" ? "Zprávu se nepodařilo zařadit k odeslání." : "The message could not be queued for sending.");
    }
  }

  /** Resolve the current recipient selection into concrete targets + names.
   *  Returns null when a private send has no recipients (caller shows a notice). */
  function resolveRecipients(): { targets?: Set<string>; toNames?: string[]; away: AwayPeer[] } | null {
    const away = awayTargets();
    if (widget.autoRoom) return { away }; // everyone, present or away
    const ids = new Set(Array.from(recipients).filter((id) => peersRef.current.get(id)?.channel?.readyState === "open"));
    if (ids.size === 0 && away.length === 0) return null;
    const toNames = [...Array.from(ids, (id) => peersRef.current.get(id)?.name || id.slice(-4)), ...away.map((a) => a.name)];
    return { targets: ids, toNames, away };
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = messageInput.trim();
    if (!text) return;
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
    await sendChatPayload(text, { send: sendOpts, targets: rec.targets, toNames: rec.toNames, away: rec.away, replyTo: replyingTo ?? undefined });
  }

  function onMessageVanished(id: string) {
    setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, vanished: true, vanishedAt: m.vanishedAt ?? Date.now(), audit: [...(m.audit ?? []), { state: "discarded" as const, at: Date.now() }] } : m)));
  }

  /** Record that a message became visible (adds a "displayed" audit event once). */
  function onMessageDisplayed(id: string) {
    setMessages((cur) => cur.map((m) => {
      if (m.id !== id || m.audit?.some((a) => a.state === "displayed")) return m;
      // A message the server relayed to us: tell the sender it was read.
      sendReadReceipt(id);
      return { ...m, audit: [...(m.audit ?? []), { state: "displayed" as const, at: Date.now() }] };
    }));
  }

  /** Start replying to a message (composer shows a quoted preview). */
  function startReply(m: ChatMessage) {
    setReplyingTo({ id: m.id, senderName: m.senderName, text: (m.text || (m.attachment ? `📎 ${m.attachment.name}` : "")).slice(0, 200) });
  }

  /** Forward a message: re-send its text/attachment tagged with its author. */
  async function forwardMessage(m: ChatMessage) {
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
    const body = m.flags?.sealed && m.mine ? (m.sealPlain ?? "") : m.text;
    await sendChatPayload(body, {
      attachment: m.attachment,
      send: DEFAULT_SEND_STATE,
      targets: rec.targets,
      toNames: rec.toNames,
      away: rec.away,
      forwardedFrom: m.forwardedFrom || m.senderName,
    });
    setNotice(lang === "cs" ? "Přeposláno." : lang === "de" ? "Weitergeleitet." : "Forwarded.");
  }

  /** Scroll the conversation to a message by id (reply source jump). */
  function scrollToMessage(id: string) {
    const el = document.querySelector(`[data-testid="message-${id}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("msg-flash"); window.setTimeout(() => el.classList.remove("msg-flash"), 1200); }
  }

  /** Assemble the info + audit trail shown for a single message. */
  function buildMessageInfo(m: ChatMessage): MessageInfo {
    const peer = m.mine ? undefined : peersRef.current.get(m.senderId);
    const net = m.mine ? undefined : peerNetRef.current.get(m.senderId);
    const plain = m.flags?.sealed ? (m.mine ? m.sealPlain : undefined) : m.text;
    const identity = m.mine
      ? (identityRef.current ? { text: `${t(lang, "sec.myFingerprint")} · ${identityRef.current.fingerprint}`, tone: "ok" as const } : undefined)
      : m.identity
        ? {
            text: t(lang, m.identity.state === "verified" && m.identity.account ? "sec.identity.account" : `sec.identity.${m.identity.state}`).replace("{fp}", m.identity.fingerprint ?? ""),
            tone: m.identity.state === "verified" ? "ok" as const : m.identity.state === "unsigned" ? "muted" as const : "warn" as const,
          }
        : undefined;
    return {
      id: m.id,
      identity,
      cryptoVersion: m.mine ? 2 : m.cryptoVersion,
      mine: m.mine,
      sender: m.senderName,
      senderId: m.senderId,
      recipients: m.to && m.to.length > 0 ? m.to : [t(lang, "recipients.everyone")],
      ip: net?.ip,
      route: m.mine ? "P2P (odchozí)" : net?.candidateType === "relay" ? "P2P přes TURN relay" : peer ? "přímé P2P" : "—",
      createdAt: m.createdAt,
      secure: m.secure,
      cipher: m.cipher,
      plaintext: plain,
      flags: [m.flags?.tap ? t(lang, "msgkind.tap") : "", m.flags?.vanishSeconds ? t(lang, "msgkind.vanish") : "", m.flags?.sealed ? t(lang, "msgkind.sealed") : ""].filter(Boolean),
      audit: m.audit ?? [{ state: m.mine ? "created" : "received", at: m.createdAt }],
      attachment: m.attachment ? { name: m.attachment.name, mime: m.attachment.mime, size: m.attachment.size, url: m.attachment.dataUrl } : undefined,
    };
  }

  /** Assemble the info shown when a participant's avatar/name is clicked. */
  function buildUserInfo(target: string): UserInfo {
    const self = target === "self" || target === myIdRef.current;
    if (self) {
      return {
        name: nameRef.current || prefs.name, peerId: myIdRef.current, self: true,
        connectedForMs: null, transport: "self", appType: "M5cet Web",
        usesServer: prefs.mode === "server", sentBytes: 0, recvBytes: 0,
        security: "AES-GCM 256 (E2EE)",
      };
    }
    const handle = peersRef.current.get(target);
    const st = peerStatsRef.current.get(target);
    const net = peerNetRef.current.get(target);
    const fp = peerFingerprints[target]?.digest;
    const open = handle?.channel?.readyState === "open";
    const transport: UserInfo["transport"] = !open ? "connecting" : net?.candidateType === "relay" ? "p2p-relay" : "p2p-direct";
    return {
      name: handle?.name || target.slice(-6), peerId: target, self: false,
      connectedForMs: st ? Date.now() - st.openedAt : null,
      ip: net?.ip, candidateType: net?.candidateType, transport,
      appType: "M5cet Web", usesServer: prefs.mode === "server",
      sentBytes: st?.sent ?? 0, recvBytes: st?.recv ?? 0,
      security: fp ? "DTLS-SRTP + AES-GCM 256" : "AES-GCM 256 (E2EE)",
      fingerprint: fp ? formatFingerprint(fp) : undefined,
    };
  }

  /** Send a chosen or recorded file to the current recipients. */
  async function sendPickedFile(file: File) {
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
    // Sealing a binary body is not supported yet; tap/vanish still apply.
    const attachOpts: SendState = { ...sendOpts, sealed: false, sealCode: "" };
    try {
      if (file.size > INLINE_ATTACHMENT_LIMIT) {
        // Too big to embed in a chat envelope: same encrypted channel, sent in
        // 32 KiB chunks. Text typed alongside goes out as its own message.
        const text = messageInput.trim();
        if (text) await sendChatPayload(text, { send: sendOpts, targets: rec.targets, toNames: rec.toNames });
        await sendLargeFileToAll(file);
        return;
      }
      const attachment = await fileToAttachment(file);
      await sendChatPayload(messageInput.trim(), { attachment, send: attachOpts, targets: rec.targets, toNames: rec.toNames });
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await sendPickedFile(file);
  }

  function insertEmoji(emoji: string) {
    setMessageInput((current) => `${current}${emoji}`);
    setEmojiOpen(false);
  }

  async function startAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("getUserMedia unavailable.");
      return;
    }
    try {
      setAudioStatus("joining");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localAudioStreamRef.current = stream;
      const tracks = stream.getAudioTracks();
      peersRef.current.forEach((peer) => {
        tracks.forEach((track) => {
          const sender = peer.pc.addTrack(track, stream);
          peer.outgoingAudioSenders.push(sender);
        });
        if (peer.initiator) {
          void (async () => {
            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            sendSignal(peer.id, offer);
          })();
        }
      });
      setAudioStatus("live");
      await broadcastAudioStatus("live");
      systemMessage("Audio: your microphone is live.");
    } catch (err) {
      setAudioStatus("off");
      setNotice(`Microphone failed: ${(err as Error).message}`);
    }
  }

  async function leaveAudio() {
    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }
    peersRef.current.forEach((peer) => {
      peer.outgoingAudioSenders.forEach((sender) => {
        try {
          peer.pc.removeTrack(sender);
        } catch {
          // ignore
        }
      });
      peer.outgoingAudioSenders = [];
    });
    setAudioStatus("off");
    await broadcastAudioStatus("off");
    systemMessage("Audio: left the call.");
  }

  async function toggleMute() {
    if (audioStatus === "off" || audioStatus === "joining") return;
    const tracks = localAudioStreamRef.current?.getAudioTracks() || [];
    if (tracks.length === 0) return;
    const next: AudioStatus = audioStatus === "muted" ? "live" : "muted";
    tracks.forEach((track) => {
      track.enabled = next === "live";
    });
    setAudioStatus(next);
    await broadcastAudioStatus(next);
  }

  async function copyRoom() {
    const targetRoom = room || normalizeRoom(roomInput);
    const text = `Room: ${targetRoom}\nPassphrase: ${passphrase ? "(NOT copied — share it separately out-of-band, e.g. Signal or in person)" : "(none entered)"}`;
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  async function enableNotifications() {
    if (!pushAvailable || !pushVapidKey) {
      if (!("Notification" in window)) {
        setNotice("Notifications API unavailable.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotice("Notification permission not granted.");
        return;
      }
      setPrefs({ notificationsEnabled: true });
      systemMessage("Local notifications enabled.");
      return;
    }

    const result = await subscribeToPush(pushVapidKey, prefs.deviceId);
    if (result.ok) {
      setPrefs({ notificationsEnabled: true });
      systemMessage("Push subscribed.");
    } else {
      setNotice(result.reason || "Push subscribe failed.");
    }
  }

  function disableNotifications() {
    setPrefs({ notificationsEnabled: false });
    systemMessage("Notifications disabled locally.");
  }

  function clearLocalData() {
    clearPreferences();
    setPrefsState((current) => ({ ...current })); // trigger re-render
    setNotice(lang === "cs" ? "Lokální preference smazány." : lang === "de" ? "Lokale Einstellungen gelöscht." : "Local preferences purged.");
  }

  async function purgeServer() {
    try {
      const response = await fetch("/api/audit/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: prefs.deviceId }),
      });
      if (response.ok) {
        const json = await response.json().catch(() => ({}));
        return { ok: true, message: typeof json.message === "string" ? json.message : "Server data purged for this device." };
      }
      return { ok: false, message: `Server returned ${response.status}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  // When the user changes keepalive strategy, restart the heartbeat at the
  // new cadence. We don't drop the socket — only the timer changes.
  useEffect(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      stopHeartbeat();
      startHeartbeat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.keepaliveStrategy]);

  // Browser-level reconnect triggers.
  useEffect(() => {
    function onOnline() {
      if (intentRef.current && socketRef.current?.readyState !== WebSocket.OPEN) {
        reconnectAttemptsRef.current = 0;
        void doConnect();
      }
    }
    function onOffline() {
      // Browser reported offline. Mark the connection as offline so the
      // UI can show the right state; the next online event will reopen.
      setStatus("offline");
      setConnStatus((s) => s ? { ...s, state: "offline" } : s);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The outbox sends through the same path as a fresh message.
  useEffect(() => { broadcastEnvelopeRef.current = broadcastEnvelope; });

  /** Tries the waiting messages; a delivered one stops looking like a draft. */
  const flushOutbox = useCallback(async (reason: string) => {
    const outbox = outboxRef.current;
    if (outbox.size() === 0) return;
    const before = outbox.list().map((e) => e.messageId);
    const result = await outbox.flush();
    const stillWaiting = new Set(outbox.list().map((e) => e.messageId));
    const gone = before.filter((id) => !stillWaiting.has(id));
    if (gone.length > 0) {
      setQueuedIds((cur) => {
        const next = new Set(cur);
        gone.forEach((id) => next.delete(id));
        return next;
      });
      setMessages((cur) => cur.map((m) => (gone.includes(m.id)
        ? { ...m, audit: [...(m.audit ?? []).filter((a) => a.state !== "queued"), { state: "sent" as const, at: Date.now(), meta: reason }] }
        : m)));
    }
    if (result.delivered > 0) {
      systemMessage(lang === "cs"
        ? `Odesláno ${result.delivered} čekajících zpráv.`
        : `Sent ${result.delivered} queued message${result.delivered === 1 ? "" : "s"}.`);
    }
  }, [lang]);

  /* ---------------------------------------------------------------------
   * The browser putting the page aside, and handing it back.
   *
   * Every way that happens — another tab, another application, a freeze, a
   * trip through the back/forward cache — arrives here as one suspend and
   * one resume (lib/lifecycle.ts). Suspending tells the room we are away
   * so the server starts collecting for us; resuming puts the connection
   * back exactly as it was and asks for everything that piled up.
   * ------------------------------------------------------------------- */

  const onPageSuspend = useCallback((event: SuspendEvent) => {
    const socket = socketRef.current;
    const connected = socket?.readyState === WebSocket.OPEN;
    suspendedStateRef.current = {
      desired: intentRef.current && !clientStoppedRef.current ? "connected" : "disconnected",
      room: roomRef.current ?? "",
      away: false,
    };
    // Save first: a freeze or a pagehide may be the last code we run.
    void persistChat(true).catch(() => undefined);
    if (!connected) return;
    // Server-enhanced and signed in: ask the server to answer for us.
    if (accountRef.current && retentionRef.current === "server") {
      try {
        socket!.send(JSON.stringify({ type: "presence", away: true }));
        suspendedStateRef.current.away = true;
      } catch { /* the socket went first */ }
    }
    void sendServerLog("debug", "page.suspended", { reason: event.reason, final: event.final });
  }, []);

  const onPageResume = useCallback((event: ResumeEvent) => {
    const wanted = suspendedStateRef.current;
    suspendedStateRef.current = null;
    const socket = socketRef.current;
    const connected = socket?.readyState === WebSocket.OPEN;

    // The page was thrown away and rebuilt: the startup effects restore the
    // session from the cache, so there is nothing to repair here.
    if (event.wasDiscarded) return;

    if (wanted?.desired === "connected" && !clientStoppedRef.current) {
      if (!connected) {
        // The socket did not survive: rebuild it and rejoin the same room.
        reconnectAttemptsRef.current = 0;
        void doConnect();
      } else {
        // Still connected: tell the server we are back. It answers with
        // everything it took for us while we were away (relay-deliver),
        // and the room sees peer-back.
        if (wanted.away) {
          try { socket!.send(JSON.stringify({ type: "presence", away: false })); } catch { /* ignore */ }
        }
        // Same session: settings and data stay; make sure the account is
        // still announced and the heartbeat is running.
        announceAccountToServer();
        startHeartbeat();
      }
    }
    // Light mode: whatever could not be delivered tries again now.
    void flushOutbox(lang === "cs" ? "po návratu" : "on resume");
    void sendServerLog("debug", "page.resumed", { reason: event.reason, awayMs: event.awayMs, fromCache: event.fromCache });
  }, [flushOutbox, lang]);

  useEffect(() => {
    const watcher = watchLifecycle({ onSuspend: onPageSuspend, onResume: onPageResume });
    // While the page is merely hidden the browser still lets a timer run
    // (about once a minute); use it to notice a dead socket and to retry
    // what is waiting. A frozen page runs nothing — that is what the push
    // wake-up is for (docs/accounts-away.md).
    const tick = startBackgroundTick(() => {
      if (clientStoppedRef.current || !intentRef.current) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        reconnectAttemptsRef.current = 0;
        void doConnect();
        return;
      }
      void flushOutbox(lang === "cs" ? "opakování" : "retry");
    }, 60_000);
    return () => { watcher.stop(); tick.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPageSuspend, onPageResume]);

  async function startVideoCall() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("getUserMedia unavailable.");
      return;
    }
    try {
      setAudioStatus("joining");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      localVideoStreamRef.current = stream;
      localAudioStreamRef.current = stream;
      const tracks = stream.getTracks();
      peersRef.current.forEach((peer) => {
        tracks.forEach((track) => {
          const sender = peer.pc.addTrack(track, stream);
          if (track.kind === "audio") peer.outgoingAudioSenders.push(sender);
        });
        if (peer.initiator) {
          void (async () => {
            const offer = await peer.pc.createOffer();
            await peer.pc.setLocalDescription(offer);
            sendSignal(peer.id, offer);
          })();
        }
      });
      setAudioStatus("live");
      setVideoOn(true);
      setCallMode("video");
      await broadcastAudioStatus("live");
      systemMessage("Video call started (audio+video, encrypted with DTLS-SRTP).");
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    } catch (err) {
      setAudioStatus("off");
      setNotice(`Video failed: ${(err as Error).message}`);
    }
  }

  function toggleCamera() {
    const stream = localVideoStreamRef.current;
    if (!stream) return;
    const enabled = !videoOn;
    stream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
    setVideoOn(enabled);
  }

  async function leaveVideoCall() {
    if (localVideoStreamRef.current) {
      localVideoStreamRef.current.getTracks().forEach((track) => track.stop());
      localVideoStreamRef.current = null;
    }
    setVideoOn(false);
    setCallMode("off");
    await leaveAudio();
  }

  async function sendLargeFileToAll(file: File) {
    const key = keyRef.current;
    identityRef.current ??= await loadIdentity().catch(() => null);
    if (!key) {
      setNotice(lang === "cs" ? "Není odvozen klíč místnosti." : "Missing room key.");
      return;
    }
    // File size limit is now per-user (`prefs.maxAttachmentBytes`); there
    // is no longer a hard-coded cap. The default is unlimited
    // (Number.MAX_SAFE_INTEGER, see preferences.ts); Settings offers lower
    // caps such as 100 MB. Chunks are held in RAM until the transfer ends.
    if (file.size > prefs.maxAttachmentBytes && prefs.maxAttachmentBytes < Number.MAX_SAFE_INTEGER - 1) {
      setNotice(`Soubor přesahuje limit ${formatBytes(prefs.maxAttachmentBytes)}.`);
      return;
    }

    const channels = Array.from(peersRef.current.values())
      .map((p) => p.channel)
      .filter((c): c is RTCDataChannel => Boolean(c) && c!.readyState === "open");

    // Files travel peer-to-peer only. The server "proxy" fallback stores the
    // frames but never forwards them, so starting it would report success
    // for a file nobody receives.
    if (channels.length === 0) {
      setNotice(t(lang, "files.noPeer"));
      return;
    }

    // Reserve an outgoing transfer card before the network work starts so
    // the UI shows the file immediately, even if sendFile kicks off async.
    const placeholderId = `out-${Date.now()}-${file.name}`;
    startTransferTracking(placeholderId, file.name, file.size, "out");

    let cancelled = false;
    const sendProxy = (frame: import("./lib/file-transfer").FileTransferEnvelope): boolean => {
      // The proxy transport sends frames over the signaling WebSocket.
      // We need to remap the proxy-* frame kind to the on-the-wire
      // ClientMessage type ("proxy-meta" etc) that routes.ts expects.
      const sock = socketRef.current;
      if (!sock || sock.readyState !== WebSocket.OPEN) return false;
      const wireKind = String(frame.kind);
      sock.send(JSON.stringify({ type: wireKind, ...frame }));
      return true;
    };

    const result = await sendFile({
      key,
      identity: identityRef.current,
      file,
      senderId: myIdRef.current,
      senderName: nameRef.current,
      channels,
      sendProxy,
      onTransport: (transport) => {
        // Re-key the tracking entry to the real transferId emitted by
        // sendFile; cheer the user with which transport was picked.
        systemMessage(
          transport === "p2p"
            ? `Odesílám ${file.name} (${formatBytes(file.size)}) přímým P2P DataChannelem.`
            : `P2P spojení není dostupné; přepínám ${file.name} (${formatBytes(file.size)}) na server proxy (šifrované).`,
        );
        if (transport === "proxy") {
          setNotice(lang === "cs"
            ? "P2P spojení se nepodařilo navázat — soubor jde přes šifrovaný server proxy."
            : "Direct P2P unavailable — transferring via encrypted server relay.");
        }
      },
      onProgress: (_sent, _total, stats) => {
        updateTransfer(placeholderId, { stats });
      },
      onStats: (stats) => {
        updateTransfer(placeholderId, { id: stats.id, stats });
      },
      isCancelled: () => cancelled,
    });

    const currentTransfer = transfersRef.current.find((x) => x.id === placeholderId);

    // One row per transfer in the server's table: what went where, how big,
    // over which transport and how it ended. Never the file name — the
    // server seals the detail column with a key it holds, so it could read
    // it; the kind of file (image, video…) is all the statistics need.
    void recordServerTransfer({
      id: result.transferId || placeholderId,
      direction: "out",
      transport: result.transport,
      status: result.ok ? "completed" : result.reason === "cancelled" ? "cancelled" : "failed",
      bytes: file.size,
      finishedAt: Date.now(),
      detail: { kind: (file.type.split("/")[0] || "other").slice(0, 16), ...(result.reason ? { reason: result.reason.slice(0, 80) } : {}) },
    });

    if (result.ok && result.resend) {
      // Keep the file reachable for a while: a receiver whose channel
      // hiccuped can still ask for the chunks it lost.
      const repeat = result.resend;
      resendableRef.current.set(result.transferId, repeat);
      window.setTimeout(() => {
        if (resendableRef.current.get(result.transferId) === repeat) resendableRef.current.delete(result.transferId);
      }, 10 * 60 * 1000);
    }

    if (result.ok) {
      // Move the entry to its real transferId so future updates coalesce.
      setTransfers((cur) => cur.map((t) => t.id === placeholderId ? { ...t, id: result.transferId, stats: { ...t.stats, id: result.transferId } } : t));
      updateTransfer(result.transferId, {
        status: "completed",
        stats: {
          id: result.transferId,
          name: file.name,
          size: file.size,
          received: file.size,
          direction: "out",
          transport: result.transport,
          encrypted: true,
          bytesPerSecond: currentTransfer?.stats?.bytesPerSecond ?? 0,
          startedAt: currentTransfer?.stats?.startedAt ?? Date.now(),
          updatedAt: Date.now(),
          etaSeconds: 0,
          progress: 1,
        },
      });
      // Auto-dismiss complete card after 60 s.
      window.setTimeout(() => dropTransfer(result.transferId), 60_000);
      systemMessage(
        result.transport === "p2p"
          ? `Odesláno: ${file.name} (${formatBytes(file.size)}) přes P2P.`
          : `Odesláno: ${file.name} (${formatBytes(file.size)}) přes server proxy (end-to-end šifrované).`,
      );
    } else {
      updateTransfer(result.transferId || placeholderId, {
        status: result.reason === "cancelled" ? "cancelled" : "error",
        errorMessage: result.reason,
      });
      systemMessage(`Send failed: ${result.reason || "unknown"}`);
    }
    void cancelled;
  }

  async function handleLargeFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await sendLargeFileToAll(file);
  }

  async function shareCurrentLocation() {
    const caps = detectGeolocation();
    if (!caps.available) { setNotice(caps.reason || "Geolocation unavailable."); return; }
    try {
      const pos = await getCurrentPosition();
      const link = osmLink(pos);
      await sendChatPayload(`📍 ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${Math.round(pos.accuracy ?? 0)} m) ${link}`);
    } catch (err) {
      setNotice(`Location failed: ${(err as Error).message}`);
    }
  }

  function startContinuousLocation() {
    locationWatcherRef.current?.stop();
    locationWatcherRef.current = watchPosition(
      (pos) => {
        const link = osmLink(pos);
        void sendChatPayload(`📍 live ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} ${link}`);
      },
      (msg) => setNotice(`Location error: ${msg}`),
    );
    if (locationWatcherRef.current) systemMessage("Continuous location started.");
  }

  function stopContinuousLocation() {
    locationWatcherRef.current?.stop();
    locationWatcherRef.current = null;
    systemMessage("Continuous location stopped.");
  }

  useEffect(() => () => disconnect(false), []);

  useEffect(() => { flushOutboxRef.current = flushOutbox; }, [flushOutbox]);

  // Notices at the top: subscribe once, and rebuild the queue when the
  // user changes how long they should stay.
  useEffect(() => {
    const queue = flashRef.current;
    return queue.subscribe((current, queued) => setFlash({ current, queued }));
  }, []);
  useEffect(() => {
    const previous = flashRef.current;
    if (previous) previous.stop();
    flashRef.current = createFlashQueue({ durationMs: prefs.flash.seconds * 1000 });
    return flashRef.current.subscribe((current, queued) => setFlash({ current, queued }));
  }, [prefs.flash.seconds]);

  // The docked recipients widget sits below the header and the status bar —
  // otherwise it covers Disconnect and the room id. Both change height when
  // the window (or the notice) changes, so measure rather than guess.
  useEffect(() => {
    const el = dockAnchorRef.current;
    if (!el) return;
    const apply = () => {
      const bottom = Math.round(el.getBoundingClientRect().bottom);
      if (bottom > 0) document.documentElement.style.setProperty("--m5-dock-top", `${bottom + 8}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    window.addEventListener("resize", apply);
    return () => { observer.disconnect(); window.removeEventListener("resize", apply); };
  });

  // --- server-side storage: what this server offers, and where our data goes ---
  useEffect(() => {
    let cancelled = false;
    void storageStatus().then(async (status) => {
      if (cancelled || !status) return;
      setServerStorage(status);
      serverStorageRef.current = status;
      // Server-enhanced without a passkey: the server keeps a database for
      // this session, encrypted with a key it generates, for one day.
      if (status.available && status.caller !== "account" && prefsRef.current.mode === "server") {
        const session = await startStorageSession();
        if (session) void sendServerLog("info", "session.started", { mode: "server-enhanced" });
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode]);

  // --- the signed-in user: what this server offers, and who we already are ---
  useEffect(() => {
    void accountStatus().then((st) => setAccStatus(st));
    void restoreSession().then((acc) => {
      if (!acc) return;
      setAccount(acc);
      if (retentionRef.current === "server") announceAccountToServer();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- /signin: arrive from a push notification straight into the session ---
  useEffect(() => {
    if (!window.location.pathname.startsWith("/signin")) return;
    // Scrub the path at once so a reload does not repeat the ceremony.
    window.history.replaceState(null, "", "/");
    let cancelled = false;
    void (async () => {
      const restored = await restoreSession();
      if (cancelled) return;
      if (restored) {
        setAccount(restored);
        setPrefs({ chatRetention: "server" });
        retentionRef.current = "server";
        systemMessage(t(lang, "acc.signedInAs").replace("{name}", restored.userName));
        await applyVault(true);
        await linkPushForAccount();
        announceAccountToServer();
        return;
      }
      // No live session in this tab. The passkey ceremony usually needs a
      // gesture, so when the browser refuses we ask for one click instead.
      setAccMsg(t(lang, "acc.signinRunning"));
      await signInToAccount();
      if (cancelled) return;
      if (!currentAccount()) {
        setActivePanel("connection");
        setAccMsg((cur) => cur || t(lang, "acc.signinPrompt"));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- keep the conversation where the retention mode says it belongs ---
  useEffect(() => {
    if (prefs.chatRetention === "ephemeral") return;
    const timer = window.setInterval(() => { void persistChat(); }, 30_000);
    const onHidden = () => { if (document.visibilityState === "hidden") void persistChat(true); };
    const onLeaving = () => { void persistChat(true); };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onLeaving);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeaving);
      void persistChat(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.chatRetention]);

  // --- startup: an invite link wins, otherwise restore this tab's session ---
  useEffect(() => {
    const parts = parseShareFragment(window.location.hash);
    if (window.location.hash) {
      // Scrub the fragment at once: the link key must not linger in the
      // address bar, in this history entry, or in anything copied from it.
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (parts) { setInviteParts(parts); setActivePanel("invite"); return; }
    let cancelled = false;
    void sessionCacheRef.current.load().then((saved) => {
      if (cancelled || !saved) return;
      setName(saved.name); setRoomInput(saved.room); setPassphrase(saved.passphrase);
      passphraseRef.current = saved.passphrase;
      setSessionPassphrase(saved.passphrase);
      if (saved.desired === "connected") {
        systemMessage(t(lang, "session.restored"));
        void startSession(saved.name, saved.room, saved.passphrase);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- activity keeps the session alive; an hour without any ends it ---
  useEffect(() => {
    const cache = sessionCacheRef.current;
    let last = 0;
    const onActivity = () => { const n = Date.now(); if (n - last > 15_000) { last = n; cache.touch(); } };
    const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const idle = cache.idleMs();
      if (idle !== null && idle > SESSION_IDLE_LIMIT_MS) {
        disconnect(false);
        void cache.clear();
        setPassphrase(""); setSessionPassphrase(""); passphraseRef.current = "";
        setNotice(t(lang, "session.expired"));
        systemMessage(t(lang, "session.expired"));
      }
    }, 60_000);
    return () => { events.forEach((e) => window.removeEventListener(e, onActivity)); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function acceptInvite(payload: SharePayload) {
    setInviteParts(null);
    setActivePanel(null);
    setName(payload.name); setRoomInput(payload.room); setPassphrase(payload.passphrase);
    await startSession(payload.name, payload.room, payload.passphrase);
  }

  async function clearAndQuit() {
    if (!window.confirm(t(lang, "clear.confirm"))) return;
    setNotice(t(lang, "clear.working"));
    disconnect(false);
    await sessionCacheRef.current.clear().catch(() => undefined);
    await historyRef.current.clear().catch(() => undefined);
    // Whatever this browser left on the server — a session database or a
    // signed-in user's own — goes with it.
    await forgetServerData().catch(() => undefined);
    await wipeEverything({ deviceId: prefs.deviceId });
    leaveToGoodbye();
  }

  if (!capabilities.supported) {
    return <UnsupportedBanner reasons={capabilities.unsupportedReasons} />;
  }

  return (
    <div className="app-shell flex h-dvh flex-col overflow-hidden bg-app-shell text-foreground safe-pt safe-pb safe-px transition-colors">
      {/* Connection status stripe — color reflects the WS state */}
      <div
        data-testid="stripe-connection"
        className={`h-1 w-full ${
          status === "joined" ? "conn-stripe-open" :
          status === "offline" ? "conn-stripe-reconnecting" :
          "conn-stripe-stopped"
        }`}
        aria-hidden="true"
      />
      {/* Motorsport stripe */}
      <div className="m5-stripe h-1 w-full" aria-hidden="true" />

      {newBuild ? (
        <div className="update-banner" role="status" data-testid="update-banner">
          <span>{t(lang, "app.update.available").replace("{v}", `${newBuild.version} · ${newBuild.build}`)}</span>
          <button type="button" className="update-banner__btn" onClick={() => window.location.reload()} data-testid="update-reload">
            {t(lang, "app.update.reload")}
          </button>
          <button type="button" className="update-banner__x" onClick={() => setNewBuild(null)} aria-label={t(lang, "common.close")}>×</button>
        </div>
      ) : null}

      {/* Top app bar */}
      <header className="toolbar relative flex min-h-[3rem] flex-wrap items-center gap-2 border-b border-border bg-card/85 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-card/70 sm:px-4">
        <button
          type="button"
          onClick={() => setActivePanel("join")}
          aria-label={t(lang, "menu.room")}
          className="inline-flex items-center gap-2 rounded-2xl px-2 py-1 hover:bg-accent"
          data-testid="button-brand"
        >
          <M5Logo size={32} className="text-primary" />
          <div className="hidden text-left sm:block">
            <div className="text-sm font-bold leading-tight">{t(lang, "app.name")}</div>
            <div className="text-[11px] leading-tight text-muted-foreground">{t(lang, "app.tagline")}</div>
          </div>
        </button>

        <span
          data-testid="status-connection"
          title={connStatus
            ? `state: ${connStatus.state}\n` +
              `attempts: ${connStatus.attempts}\n` +
              `last reconnects: ${connStatus.totalReconnects}\n` +
              `next reconnect in: ${connStatus.nextReconnectAtMs ? Math.max(0, Math.round((connStatus.nextReconnectAtMs - Date.now()) / 1000)) + "s" : "—"}\n` +
              `RTT: ${connStatus.rttMs}ms`
            : "—"}
          className={`ml-2 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors ${
            status === "joined"
              ? "border-emerald-500/40 bg-emerald-500/10"
              : status === "offline"
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-border bg-background"
          }`}
        >
          {status === "joined" ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="hidden sm:inline">
            {status === "joined"
              ? connStatus?.disconnectReason && connStatus.disconnectReason !== "idle"
                ? `${openPeerCount} P2P · reconnect-pending`
                : `${openPeerCount} P2P · ${room}`
              : status === "offline"
                ? `${t(lang, "status.offline")} · auto-reconnect`
                : t(lang, `status.${status}`)}
          </span>
          {status === "joined" ? <span className="sm:hidden">{openPeerCount}</span> : null}
        </span>

        {account ? (
          <SignedInBadge account={account} onClick={() => { setAccMsg(""); setShowAccount(true); void refreshAccount().then((fresh) => { if (fresh) setAccount(fresh); }); }} lang={lang} />
        ) : null}

        <MainMenu
          mode={prefs.menuDisplay}
          lang={lang}
          currentPanel={activePanel}
          onOpen={(panel) => setActivePanel(panel)}
          user={{ name: prefs.name, avatar: prefs.avatar }}
          onClearQuit={() => void clearAndQuit()}
          editMode={prefs.editMode}
          onToggleEditMode={() => setPrefs({ editMode: !prefs.editMode })}
          buildLabel={buildLabel()}
        />
        {/* Fullscreen through the browser viewport (Android, iPad, desktop
            touch screens). iPhone has no element fullscreen: there it is
            Add to Home Screen — see Appearance → Display. */}
        {fullscreenSupported() && deviceInfo().touch && !deviceInfo().standalone ? (
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            aria-label={fullscreen ? t(lang, "ap.device.exitFullscreen") : t(lang, "ap.device.enterFullscreen")}
            title={fullscreen ? t(lang, "ap.device.exitFullscreen") : t(lang, "ap.device.enterFullscreen")}
            className="inline-flex items-center justify-center rounded-2xl hover:bg-accent"
            data-testid="btn-toolbar-fullscreen"
          >
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        ) : null}
      </header>

      {/* Full-screen chat area */}
      <main className="relative flex flex-1 min-h-0 flex-col chat-canvas">
        <div className="flex flex-1 min-h-0 flex-col">
          <div ref={dockAnchorRef} data-layout-hide="focus" className="flex-shrink-0 border-b border-border bg-card/60 px-3 py-2 sm:px-4">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p data-testid="text-notice" className="truncate text-muted-foreground">
                {notice}
              </p>
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{room ? `room:${room}` : t(lang, "status.idle")}</span>
                <span className="hidden sm:inline">·</span>
                <span className="hidden sm:inline">{myId.slice(-10)}</span>
                {desired === "connected" ? (
                  <button type="button" data-testid="button-disconnect-bar" onClick={() => userDisconnect()} className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-accent">
                    <LogOut className="h-3 w-3" />
                    {t(lang, "common.disconnect")}
                  </button>
                ) : null}
                <button type="button" onClick={copyRoom} className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-accent">
                  <Copy className="h-3 w-3" />
                  {copied ? t(lang, "common.copied") : t(lang, "common.copy")}
                </button>
              </div>
            </div>
          </div>

          <div data-testid="list-messages" className="flex-1 overflow-y-auto chat-surface p-3 sm:p-5">
            {/* Live file-transfer cards — show progress, transport, encryption, ETA */}
            {transfers.length > 0 ? (
              <div className="mx-auto mb-4 grid w-full max-w-4xl grid-cols-1 gap-2 md:grid-cols-2">
                {transfers.map((t) => (
                  <TransferCard
                    key={t.id}
                    id={t.id}
                    name={t.name}
                    size={t.size}
                    direction={t.direction}
                    initialStats={t.stats}
                    finalStatus={t.status}
                    errorMessage={t.errorMessage}
                    onRemove={dropTransfer}
                  />
                ))}
              </div>
            ) : null}
            {visibleMessages.length === 0 ? (
              <div className="flex h-full min-h-[60dvh] items-center justify-center">
                <div className="max-w-md rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Lock className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold">{renderTemplate(layout.templates.chatEmptyTitle, { title: t(lang, "chat.empty.title"), appName: "M5cet" }, layout.partials)}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{renderTemplate(layout.templates.chatEmptyBody, { body: t(lang, "chat.empty.body"), appName: "M5cet" }, layout.partials)}</p>
                  <button
                    type="button"
                    onClick={() => setActivePanel("join")}
                    className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground"
                    data-testid="button-open-join"
                  >
                    <Radio className="h-4 w-4" />
                    {t(lang, "join.connect")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="chat-column mx-auto w-full space-y-3">
                {visibleMessages.map((message) => {
                  const isSystem = message.senderId === "system";
                  const styleKey = styleKeyFor(message.senderName, message.senderId);
                  const perStyle = isSystem ? undefined : prefs.messageStyles[styleKey];
                  const vars = tplVars(message);
                  const badge = isSystem ? (
                    <span className="msg-bubble__label">
                      {layout.flags.showSystemLogo ? <M5Logo mono size={16} className="msg-sys-logo" /> : null}
                      {renderTemplate(layout.templates.systemHeader, {
                        ...vars,
                        appName: message.senderName,
                        date: layout.flags.systemFullDate ? vars.date : vars.time,
                      }, layout.partials)}
                    </span>
                  ) : message.mine ? (
                    <span className="msg-bubble__label inline-flex items-center gap-1.5">
                      {layout.flags.showAvatars ? <Avatar name={message.senderName} avatar={prefs.avatar} size={20} /> : null}
                      {message.senderName}
                    </span>
                  ) : (
                    <UserBadge
                      name={message.senderName}
                      senderId={message.senderId}
                      mine={false}
                      style={perStyle}
                      onChangeStyle={(patch) => setMessageStyle(styleKey, patch)}
                      onResetStyle={() => resetMessageStyle(styleKey)}
                      onInfo={() => setUserInfoFor(message.senderId)}
                      lang={lang}
                    />
                  );
                  return (
                    <MessageBubble
                      key={message.id}
                      id={message.id}
                      senderId={message.senderId}
                      senderName={message.senderName}
                      mine={message.mine}
                      isSystem={isSystem}
                      secure={message.secure && layout.flags.showLockIcon}
                      createdAt={message.createdAt}
                      timeLabel={isSystem || !layout.flags.showTime ? "" : renderTemplate(message.mine ? layout.templates.outgoingMeta : layout.templates.incomingMeta, vars, layout.partials)}
                      text={message.text}
                      attachment={message.attachment}
                      flags={message.flags}
                      ownPlaintext={message.mine && message.flags?.sealed ? message.sealPlain : undefined}
                      sealCode={message.mine ? message.sealCode : undefined}
                      vanished={message.vanished}
                      vanishedAt={message.vanishedAt}
                      onVanish={onMessageVanished}
                      to={message.to}
                      replyTo={message.replyTo}
                      forwardedFrom={message.forwardedFrom}
                      bubbleStyle={bubbleStyleFrom(perStyle)}
                      badge={badge}
                      lang={lang}
                      renderText={linkify}
                      formatSize={formatBytes}
                      onInfo={isSystem ? undefined : (mid) => setMsgInfoFor(mid)}
                      onReply={isSystem || !layout.flags.showActions ? undefined : () => startReply(message)}
                      onForward={isSystem || !layout.flags.showActions ? undefined : () => void forwardMessage(message)}
                      deliveryState={deliveryStateOf(message)}
                      onDisplayed={onMessageDisplayed}
                      onReplyJump={scrollToMessage}
                      systemCollapseAfterSec={layout.flags.systemCollapseAfterSec}
                      systemExpandForSec={layout.flags.systemExpandForSec}
                    />
                  );
                })}
                <div ref={messageEndRef} />
              </div>
            )}
          </div>

          <form onSubmit={sendMessage} className="composer border-t border-border bg-card/80 backdrop-blur">
            <div className="chat-column mx-auto w-full">
              {replyingTo ? (
                <div className="composer-reply" data-testid="composer-reply">
                  <button type="button" className="composer-reply__jump" onClick={() => scrollToMessage(replyingTo.id)}>
                    <CornerUpLeft className="h-3.5 w-3.5" />
                    <span className="composer-reply__inner">
                      <span className="composer-reply__name">{t(lang, "msginfo.replyingTo")} {replyingTo.senderName}</span>
                      <span className="composer-reply__text">{replyingTo.text}</span>
                    </span>
                  </button>
                  <button type="button" className="composer-reply__x" onClick={() => setReplyingTo(null)} aria-label={t(lang, "common.close")}>×</button>
                </div>
              ) : null}
              {emojiOpen ? (
                <div className="mb-2 flex flex-wrap gap-1 rounded-2xl border border-border bg-background p-2" data-testid="picker-emoji">
                  {QUICK_EMOJI.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="rounded-xl px-2 py-1 text-lg hover:bg-accent"
                      onClick={() => insertEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="composer-bar">
                <div className="composer-actions">
                  <button
                    type="button"
                    data-testid="button-emoji"
                    className="composer-icon-btn"
                    onClick={() => setEmojiOpen((current) => !current)}
                    aria-expanded={emojiOpen}
                    aria-label={t(lang, "chat.emoji")}
                    title={t(lang, "chat.emoji")}
                  >
                    <Smile className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-testid="button-attach-file"
                    className="composer-icon-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={openPeerCount === 0}
                    aria-label={t(lang, "chat.attach.file")}
                    title={t(lang, "chat.attach.file")}
                  >
                    <Paperclip className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-testid="button-attach-image"
                    className="composer-icon-btn"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={openPeerCount === 0}
                    aria-label={t(lang, "chat.attach.image")}
                    title={t(lang, "chat.attach.image")}
                  >
                    <ImageIcon className="h-5 w-5" aria-hidden="true" />
                  </button>
                  <AudioRecorder
                    lang={lang}
                    disabled={openPeerCount === 0}
                    onRecorded={(file) => void sendPickedFile(file)}
                    onError={(msg) => setNotice(msg)}
                  />
                </div>
                <label className="sr-only" htmlFor="message">{t(lang, "chat.placeholder")}</label>
                <textarea
                  data-testid="input-message"
                  id="message"
                  rows={1}
                  className="composer-input"
                  placeholder={renderTemplate(layout.templates.composerPlaceholder, {
                    placeholder: openPeerCount > 0 ? t(lang, "chat.placeholder") : t(lang, "chat.placeholder.waiting"),
                    room, peerCount: String(openPeerCount),
                  }, layout.partials)}
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  onKeyDown={handleMessageKeyDown}
                />
                <SendOptions
                  value={sendOpts}
                  onChange={setSendOpts}
                  onSend={() => void sendMessage()}
                  canSend={canSend}
                  lang={lang}
                />
              </div>
              <div className="composer-foot">
                <RecipientHint
                  everyone={widget.autoRoom}
                  names={Array.from(recipients, (id) => peersRef.current.get(id)?.name || id.slice(-4))}
                  lang={lang}
                />
                <p className="composer-hint">{t(lang, "composer.attachHint")}</p>
              </div>
              <input ref={fileInputRef} type="file" className="hidden" onChange={handleAttachmentChange} data-testid="input-file" />
              <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleAttachmentChange} data-testid="input-image" />
            </div>
          </form>
        </div>
      </main>

      {/* Modal panels */}
      <ProfilePanel open={activePanel === "profile"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <SettingsPanel open={activePanel === "settings"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} onOpenAppearance={() => setActivePanel("appearance")} />
      {activePanel === "appearance" ? (
        <Suspense fallback={null}>
          <AppearancePanel open onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
        </Suspense>
      ) : null}
      <EncryptionPanel open={activePanel === "encryption"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <RoomSecurityPanel open={activePanel === "roomSecurity"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} room={room} />
      <TrustPanel open={activePanel === "trust"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} peerFingerprints={peerFingerprints} roomFingerprint={roomFingerprint} />
      <PrivacyPanel
        open={activePanel === "privacy"}
        onClose={() => setActivePanel(null)}
        prefs={prefs}
        setPrefs={setPrefs}
        lang={lang}
        onLocalPurge={clearLocalData}
        onServerPurge={purgeServer}
      />
      <NotificationsPanel
        open={activePanel === "notifications"}
        onClose={() => setActivePanel(null)}
        prefs={prefs}
        setPrefs={setPrefs}
        lang={lang}
        onEnable={enableNotifications}
        onDisable={disableNotifications}
        pushAvailable={pushAvailable}
        onTestPush={async () => {
          setPushBusy(true);
          const r = await sendTestPush();
          setPushBusy(false);
          return r;
        }}
        onTestLocal={async () => showLocalTestNotification()}
      />
      <AnalyticsPanel open={activePanel === "analytics"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />

      {/* Peers modal */}
      {activePanel === "peers" ? (
        <SimpleModal title={t(lang, "menu.peers")} onClose={() => setActivePanel(null)}>
          <PeerList peers={peers} lang={lang} />
        </SimpleModal>
      ) : null}

      {/* Audio modal */}
      {activePanel === "audio" ? (
        <SimpleModal title={t(lang, "menu.audio")} onClose={() => setActivePanel(null)}>
          <AudioControls
            audioStatus={audioStatus}
            audioPeerCount={audioPeerCount}
            connected={status === "joined"}
            onJoin={() => void startAudio()}
            onLeave={() => void leaveAudio()}
            onToggleMute={() => void toggleMute()}
            lang={lang}
          />
        </SimpleModal>
      ) : null}

      {/* Video modal */}
      {activePanel === "video" ? (
        <SimpleModal title="Video call" onClose={() => setActivePanel(null)}>
          <VideoControls
            connected={status === "joined"}
            mode={callMode}
            videoOn={videoOn}
            onStart={() => void startVideoCall()}
            onLeave={() => void leaveVideoCall()}
            onToggleCamera={toggleCamera}
            localVideoRef={localVideoRef}
            remoteVideosRef={remoteVideosRef}
            lang={lang}
          />
        </SimpleModal>
      ) : null}

      {/* Files modal — chunked encrypted DataChannel transfer */}
      {activePanel === "files" ? (
        <SimpleModal title="Encrypted file transfer" onClose={() => setActivePanel(null)}>
          <FilesPanel
            connected={status === "joined" && openPeerCount > 0}
            enabled={prefs.mode === "server"}
            maxBytes={prefs.maxAttachmentBytes}
            onPickFile={() => largeFileInputRef.current?.click()}
            transfers={transfers}
          />
          <input ref={largeFileInputRef} type="file" className="hidden" onChange={handleLargeFileChange} data-testid="input-large-file" />
        </SimpleModal>
      ) : null}

      {/* Location modal */}
      {activePanel === "location" ? (
        <SimpleModal title="Location" onClose={() => setActivePanel(null)}>
          <LocationPanel
            connected={status === "joined" && openPeerCount > 0}
            onShareOnce={() => void shareCurrentLocation()}
            onStartContinuous={startContinuousLocation}
            onStopContinuous={stopContinuousLocation}
            watching={Boolean(locationWatcherRef.current)}
            lang={lang}
          />
        </SimpleModal>
      ) : null}

      {/* NFC / smart-card workbench */}
      {activePanel === "nfc" ? (
        <SimpleModal title={t(lang, "menu.nfc")} onClose={() => setActivePanel(null)}>
          <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground">…</div>}>
            <NfcWorkbench
              lang={lang}
              appVersion={APP_VERSION}
              session={status === "joined" && sessionPassphrase && room ? { room, passphrase: sessionPassphrase, name: nameRef.current } : null}
              onSystem={systemMessage}
              onConnect={(p) => {
                setRoomInput(p.room); setPassphrase(p.passphrase); if (p.name) setName(p.name);
                setActivePanel(null);
                void startSession(p.name || nameRef.current, p.room, p.passphrase);
              }}
            />
          </Suspense>
        </SimpleModal>
      ) : null}

      {/* Speech modal */}
      {activePanel === "speech" ? (
        <SimpleModal title="Speech (TTS / STT / revoice)" onClose={() => setActivePanel(null)}>
          <SpeechPanel
            recognitionRef={recognitionRef}
            onSendText={(text) => void sendChatPayload(text)}
            onInsertText={(text) => setMessageInput((cur) => (cur ? `${cur} ${text}` : text))}
            serverMode={prefs.mode === "server"}
            lang={lang}
          />
        </SimpleModal>
      ) : null}

      {/* AI assistant modal (server-enhanced) */}
      {activePanel === "ai" ? (
        <SimpleModal title={t(lang, "menu.ai")} onClose={() => setActivePanel(null)}>
          <AiPanel lang={lang} onInsert={(text) => { setMessageInput((cur) => (cur ? `${cur} ${text}` : text)); setActivePanel(null); }} />
        </SimpleModal>
      ) : null}

      {/* Telephony / SMS modal (server-enhanced) */}
      {activePanel === "phone" ? (
        <SimpleModal title={t(lang, "menu.phone")} onClose={() => setActivePanel(null)}>
          <Suspense fallback={<div className="p-6 text-center text-sm text-muted-foreground">…</div>}>
            <PhonePanel lang={lang} onSystem={systemMessage} />
          </Suspense>
        </SimpleModal>
      ) : null}

      {/* Connection panel */}
      {activePanel === "connection" ? (
        <SimpleModal title="Connection" onClose={() => setActivePanel(null)}>
          <div className="space-y-5">
            <ChatRetentionSection
              value={prefs.chatRetention}
              onChange={(next) => { setPrefs({ chatRetention: next }); retentionRef.current = next; if (next !== "server") void historyRef.current.clear(); announceAccountToServer(); }}
              account={account}
              status={accStatus}
              supported={accountSupported()}
              busy={accBusy}
              message={accMsg}
              lang={lang}
              onSignIn={() => void signInToAccount()}
              onRegister={() => void createAccount()}
              onSignOutAndWipe={() => void signOutAndWipe()}
              onRecover={(code) => void recoverAccount(code)}
            />
            <ConnectionPanel status={connStatus} prefs={prefs} setPrefs={setPrefs} lang={lang} desired={desired} log={connLog} />
          </div>
        </SimpleModal>
      ) : null}

      {/* Join modal */}
      {activePanel === "join" ? (
        <SimpleModal title={t(lang, "menu.room")} onClose={() => setActivePanel(null)}>
          <form
            data-testid="form-join"
            onSubmit={(event) => {
              event.preventDefault();
              // Already joined → the button reads "Reconnect": disconnect, wait,
              // reconnect. Otherwise a normal connect.
              if (status === "joined") void reconnectViaButtons();
              else void connect(event);
            }}
            className="space-y-3"
            autoComplete="off"
          >
            <fieldset className="grid grid-cols-2 gap-2 rounded-2xl border border-input bg-background p-1">
              <label className={`flex cursor-pointer flex-col rounded-xl px-3 py-2 text-xs ${prefs.mode === "light" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>
                <input type="radio" name="mode" className="sr-only" checked={prefs.mode === "light"} onChange={() => setPrefs({ mode: "light" })} data-testid="radio-mode-light" />
                <span className="font-semibold">Light · P2P</span>
                <span className="opacity-80">{lang === "cs" ? "Jen WebRTC, server jenom signalizuje." : lang === "de" ? "Nur WebRTC, Server signalisiert." : "WebRTC only, server only signals."}</span>
              </label>
              <label className={`flex cursor-pointer flex-col rounded-xl px-3 py-2 text-xs ${prefs.mode === "server" ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}>
                <input type="radio" name="mode" className="sr-only" checked={prefs.mode === "server"} onChange={() => setPrefs({ mode: "server" })} data-testid="radio-mode-server" />
                <span className="font-semibold">Server-enhanced</span>
                <span className="opacity-80">{lang === "cs" ? "Volitelné push a metadata logy." : lang === "de" ? "Optional Push und Metadaten-Log." : "Optional push and metadata logs."}</span>
              </label>
            </fieldset>

            <label className="grid gap-1 text-sm font-medium">
              {t(lang, "join.name")}
              <input data-testid="input-name" className="min-h-11 rounded-xl border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring" value={name} onChange={(event) => setName(event.target.value)} maxLength={42} />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t(lang, "join.room")}
              <input data-testid="input-room" className="min-h-11 rounded-xl border border-input bg-background px-3 font-mono text-base outline-none focus:ring-2 focus:ring-ring" value={roomInput} onChange={(event) => setRoomInput(event.target.value)} maxLength={48} />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              {t(lang, "join.passphrase")}
              <input data-testid="input-passphrase" className="min-h-11 rounded-xl border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} type="password" autoComplete="new-password" />
            </label>
            <div className="flex gap-2">
              <button data-testid="button-connect" className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={status === "deriving" || status === "connecting"}>
                <Radio className="h-4 w-4" />
                {status === "joined" ? t(lang, "join.reconnect") : t(lang, "join.connect")}
              </button>
              {desired === "connected" ? (
                <button type="button" data-testid="button-disconnect" onClick={() => userDisconnect()} className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent">
                  <LogOut className="h-4 w-4" />
                  {t(lang, "common.disconnect")}
                </button>
              ) : null}
            </div>
          </form>
          <ShareSection
            lang={lang}
            room={normalizeRoom(roomInputRef.current || roomInput)}
            passphrase={sessionPassphrase}
            ready={desired === "connected" && sessionPassphrase.length > 0}
          />
        </SimpleModal>
      ) : null}

      {activePanel === "invite" && inviteParts ? (
        <SimpleModal title={t(lang, "invite.title")} onClose={() => { setInviteParts(null); setActivePanel(null); }}>
          <InvitePrompt
            lang={lang}
            parts={inviteParts}
            onAccept={(payload) => void acceptInvite(payload)}
            onDismiss={() => { setInviteParts(null); setActivePanel(null); }}
          />
        </SimpleModal>
      ) : null}

      {/* Floating recipients widget — who receives the next message */}
      {status === "joined" ? (
        <RecipientsWidget
          peers={[
            ...peers.map((p): WidgetPeer => ({ id: p.id, name: p.name, status: p.status, rttMs: p.status === "open" ? connStatus?.rttMs : undefined })),
            // Signed-in members the server answers for: still addressable.
            ...awayPeers.map((a): WidgetPeer => ({ id: awayKey(a.accountId), name: a.name, status: "away", since: a.since })),
          ]}
          room={room}
          state={widget}
          selected={recipients}
          onTogglePeer={togglePeerRecipient}
          onToggleAuto={setAutoRoom}
          onSelectAll={selectAllRecipients}
          onSelectNone={selectNoRecipients}
          onPeerInfo={(id) => setUserInfoFor(id)}
          onRoomInfo={() => setActivePanel("connection")}
          onMove={(x, y) => updateWidget({ x, y })}
          onMinimize={(min) => updateWidget({ minimized: min })}
          onUpdate={(patch) => updateWidget(patch)}
          title={renderTemplate(layout.templates.widgetTitle, { title: t(lang, "recipients.title"), peerCount: String(openPeerCount), room }, layout.partials)}
          lang={lang}
        />
      ) : null}

      {/* The signed-in user: what the server holds for them */}
      {showAccount && account ? (
        <SimpleModal title={t(lang, "acc.title")} onClose={() => setShowAccount(false)}>
          <AccountInfoModal
            account={account}
            status={accStatus}
            busy={accBusy}
            message={accMsg}
            lang={lang}
            onRefresh={() => void runAccountTask(async () => { const fresh = await refreshAccount(); if (fresh) setAccount(fresh); })}
            onSaveNow={saveAccountDataNow}
            onSignOut={() => void signOutAndWipe()}
            onDelete={deleteAccountForever}
            actions={accountActions}
          />
        </SimpleModal>
      ) : null}

      {/* Participant info modal */}
      {userInfoFor ? (
        <SimpleModal title={t(lang, "userinfo.title")} onClose={() => setUserInfoFor(null)}>
          <UserInfoView info={buildUserInfo(userInfoFor)} lang={lang} />
        </SimpleModal>
      ) : null}

      {/* Message info + audit trail modal */}
      {msgInfoFor ? (() => {
        const m = messages.find((x) => x.id === msgInfoFor);
        if (!m) return null;
        return (
          <SimpleModal title={t(lang, "msginfo.title")} onClose={() => setMsgInfoFor(null)}>
            <MessageInfoView info={buildMessageInfo(m)} lang={lang} onForward={() => { setMsgInfoFor(null); void forwardMessage(m); }} />
          </SimpleModal>
        );
      })() : null}

      {/* System notices, one at a time, at the top of the screen */}
      <FlashMessages
        message={flash.current}
        queued={flash.queued}
        settings={prefs.flash}
        onDismiss={(id) => flashRef.current.dismiss(id)}
        label={t(lang, "flash.dismiss")}
      />

      {/* Edit Mode: element picker + style inspector (own Shadow DOM) */}
      {prefs.editMode ? (
        <Suspense fallback={null}>
          <StyleInspector active lang={lang} onExit={() => setPrefs({ editMode: false })} allowGoogleFonts={prefs.googleFonts} />
        </Suspense>
      ) : null}
    </div>
  );
}

function SimpleModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // A modal dialog must be dismissable from the keyboard.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="modal-root fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-shell modal-shell--center my-auto flex max-h-[92dvh] w-full max-w-xl flex-col" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-head flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="modal-close inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent">×</button>
        </header>
        <div className="modal-body flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function PeerList({ peers, lang }: { peers: PeerView[]; lang: Lang }) {
  if (peers.length === 0) {
    return <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">{lang === "cs" ? "Zatím žádný peer." : lang === "de" ? "Noch keine Peers." : "No peers yet."}</div>;
  }
  return (
    <div className="space-y-2" data-testid="list-peers">
      {peers.map((peer) => (
        <div key={peer.id} className="flex items-center justify-between gap-3 rounded-2xl bg-background p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" data-testid={`text-peer-${peer.id}`}>{peer.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{peer.id.slice(-12)}</p>
          </div>
          <div className="flex items-center gap-1">
            {peer.audio === "live" ? <Mic className="h-4 w-4 text-emerald-500" aria-label="audio live" /> : peer.audio === "muted" ? <MicOff className="h-4 w-4 text-amber-500" aria-label="audio muted" /> : null}
            <span className={`rounded-full px-2 py-1 text-xs ${peer.status === "open" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : peer.status === "connecting" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground"}`}>{peer.status}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AudioControls({ audioStatus, audioPeerCount, connected, onJoin, onLeave, onToggleMute, lang }: { audioStatus: AudioStatus; audioPeerCount: number; connected: boolean; onJoin: () => void; onLeave: () => void; onToggleMute: () => void; lang: Lang }) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">{lang === "cs" ? "Hlas jde stejným WebRTC spojením jako data kanál." : lang === "de" ? "Audio nutzt dieselbe WebRTC-Verbindung wie der Datenkanal." : "Voice rides the same WebRTC connection as the data channel."}</div>
      <div className="text-xs text-muted-foreground">{audioPeerCount} {lang === "cs" ? "v hovoru" : lang === "de" ? "im Anruf" : "on call"}</div>
      <div className="flex flex-wrap gap-2">
        {audioStatus === "off" || audioStatus === "joining" ? (
          <button type="button" data-testid="button-audio-join" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60" onClick={onJoin} disabled={!connected || audioStatus === "joining"}>
            <Mic className="h-4 w-4" />
            {audioStatus === "joining" ? "..." : (lang === "cs" ? "Připojit hlas" : lang === "de" ? "Sprache verbinden" : "Join voice")}
          </button>
        ) : (
          <>
            <button type="button" data-testid="button-audio-mute" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent" onClick={onToggleMute}>
              {audioStatus === "muted" ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {audioStatus === "muted" ? "Unmute" : "Mute"}
            </button>
            <button type="button" data-testid="button-audio-leave" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent" onClick={onLeave}>
              <PhoneOff className="h-4 w-4" />
              {lang === "cs" ? "Opustit" : lang === "de" ? "Verlassen" : "Leave"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function VideoIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="M16 10l5-3v10l-5-3z" />
    </svg>
  );
}
function MapPinIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 22s7-7.16 7-12a7 7 0 1 0-14 0c0 4.84 7 12 7 12z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function NfcIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 8a8 8 0 0 1 16 0v8a8 8 0 0 1-16 0z" />
      <path d="M8 12a4 4 0 0 1 8 0" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

function VideoControls({
  connected, mode, videoOn, onStart, onLeave, onToggleCamera, localVideoRef, remoteVideosRef, lang,
}: {
  connected: boolean;
  mode: "audio" | "video" | "off";
  videoOn: boolean;
  onStart: () => void;
  onLeave: () => void;
  onToggleCamera: () => void;
  localVideoRef: React.MutableRefObject<HTMLVideoElement | null>;
  remoteVideosRef: React.MutableRefObject<HTMLDivElement | null>;
  lang: Lang;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{lang === "cs"
        ? "Hlas i obraz jdou stejným WebRTC P2P spojením; přenos je šifrovaný DTLS-SRTP."
        : "Audio + video share the same WebRTC P2P link, encrypted with DTLS-SRTP."}</p>
      <video ref={localVideoRef} muted autoPlay playsInline className="aspect-video w-full rounded-2xl border border-border bg-black" />
      <div ref={remoteVideosRef} className="grid grid-cols-2 gap-2" />
      <div className="flex flex-wrap gap-2">
        {mode !== "video" ? (
          <button type="button" onClick={onStart} disabled={!connected} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
            Start video
          </button>
        ) : (
          <>
            <button type="button" onClick={onToggleCamera} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">
              {videoOn ? "Camera off" : "Camera on"}
            </button>
            <button type="button" onClick={onLeave} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">
              Hang up
            </button>
          </>
        )}
      </div>
    </div>
  );
}

type FilesPanelTransfer = {
  id: string;
  name: string;
  size: number;
  direction: "in" | "out";
  status: "active" | "completed" | "cancelled" | "error";
  stats: import("./lib/file-transfer").TransferStats;
};

function FilesPanel({
  connected, enabled, maxBytes, onPickFile, transfers,
}: {
  connected: boolean;
  enabled: boolean;
  maxBytes: number;
  onPickFile: () => void;
  transfers: FilesPanelTransfer[];
}) {
  const active = transfers.filter((t) => t.status === "active");
  const recent = transfers.slice(-3);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        End-to-end encrypted P2P transfer (AES-GCM 256, 32 KiB chunks) with automatic server-relay fallback.
        Hard cap: 10 GiB. Configure your own limit in Settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onPickFile}
          disabled={!connected}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          Choose file…
        </button>
      </div>
      {active.length > 0 ? (
        <div className="rounded-2xl border border-border bg-background p-3 text-xs">
          <div className="mb-1 font-semibold">Probíhá {active.length} přenos{active.length > 1 ? "y" : ""}:</div>
          <ul className="space-y-1 font-mono">
            {active.map((t) => (
              <li key={t.id}>
                {t.direction === "out" ? "↑" : "↓"} {t.name} ·
                {t.stats.transport === "p2p" ? " P2P" : " Proxy"} ·
                {Math.round((t.stats.progress ?? 0) * 100)} %
                · {formatBytes(t.stats.size)} ·{" "}
                {Math.round((t.stats.bytesPerSecond ?? 0) / 1024)} kB/s
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recent.length > 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 p-3 text-[11px] text-muted-foreground">
          {recent.length} přenosů sledováno — podrobnosti v chatu.
        </div>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        Files  10 GiB cannot transfer today. For very large volumes use the
        storage-provider plugin — see docs/files.md.
      </p>
    </div>
  );
}

function LocationPanel({
  connected, onShareOnce, onStartContinuous, onStopContinuous, watching, lang,
}: {
  connected: boolean;
  onShareOnce: () => void;
  onStartContinuous: () => void;
  onStopContinuous: () => void;
  watching: boolean;
  lang: Lang;
}) {
  const caps = detectGeolocation();
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {lang === "cs" ? "Pošle aktuální polohu jako šifrovanou zprávu s OpenStreetMap odkazem." : "Sends your current position as an encrypted chat message with an OpenStreetMap link."}
      </p>
      {!caps.available ? (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{caps.reason}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onShareOnce} disabled={!connected || !caps.available} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
          Share once
        </button>
        {watching ? (
          <button type="button" onClick={onStopContinuous} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">Stop sharing</button>
        ) : (
          <button type="button" onClick={onStartContinuous} disabled={!connected || !caps.available} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">Start continuous</button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">Your coordinates only travel through the encrypted P2P channel; the OSM link reveals them to whoever clicks it.</p>
    </div>
  );
}


function SpeechPanel({
  recognitionRef, onSendText, onInsertText, serverMode, lang,
}: {
  recognitionRef: React.MutableRefObject<{ stop: () => void } | null>;
  onSendText: (text: string) => void;
  onInsertText: (text: string) => void;
  serverMode: boolean;
  lang: Lang;
}) {
  const caps = detectSpeechCaps();
  const [text, setText] = useState("");
  const [voiceLang, setVoiceLang] = useState("cs-CZ");
  const [preset, setPreset] = useState<VoicePreset>("neutral");
  const [voiceURI, setVoiceURI] = useState<string>("");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [partial, setPartial] = useState("");
  const [revoice, setRevoice] = useState(false);
  // Server voices (ElevenLabs / OpenAI …), only in Server-enhanced mode.
  const [serverVoices, setServerVoices] = useState<ServerVoiceInfo[]>([]);
  const [serverVoice, setServerVoice] = useState<string>("");
  const [serverBusy, setServerBusy] = useState(false);
  const serverAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    function load() { setVoices(listVoices()); }
    load();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", load);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
    }
  }, []);

  useEffect(() => {
    if (!serverMode) return;
    let cancelled = false;
    void fetchServerSpeechStatus().then((s) => {
      if (cancelled) return;
      if (s.tts.enabled) { setServerVoices(s.tts.connectors); if (s.tts.connectors[0]) setServerVoice(s.tts.connectors[0].id); }
    });
    return () => { cancelled = true; };
  }, [serverMode]);

  async function speakServer() {
    if (!text.trim() || !serverVoice) return;
    setServerBusy(true);
    const r = await serverTts(text, { connector: serverVoice });
    setServerBusy(false);
    if (r.ok) {
      if (!serverAudioRef.current) serverAudioRef.current = new Audio();
      serverAudioRef.current.src = r.url;
      void serverAudioRef.current.play();
    }
  }

  function startStt() {
    setPartial("");
    recognitionRef.current = startRecognition(voiceLang, {
      onPartial: setPartial,
      onFinal: (txt) => {
        setText((prev) => `${prev} ${txt}`.trim());
        if (revoice) speak({ text: txt, lang: voiceLang, preset, voiceURI: voiceURI || null });
      },
      onError: (msg) => setPartial(`(error: ${msg})`),
      onEnd: () => setPartial(""),
    }, true);
  }
  function stopStt() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-sm">Language
          <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)} className="min-h-10 rounded-xl border border-input bg-background px-2">
            {["cs-CZ","sk-SK","de-DE","en-GB","en-US","pl-PL","fr-FR","es-ES","it-IT","nl-NL","ru-RU"].map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">Preset
          <select value={preset} onChange={(e) => setPreset(e.target.value as VoicePreset)} className="min-h-10 rounded-xl border border-input bg-background px-2">
            {["neutral","male","female","child"].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm">Voice
        <select value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)} className="min-h-10 rounded-xl border border-input bg-background px-2">
          <option value="">(auto)</option>
          {voices.filter((v) => v.lang.toLowerCase().startsWith(voiceLang.toLowerCase().slice(0, 2))).map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Text
        <textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-20 rounded-xl border border-input bg-background px-2 py-1" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!caps.ttsAvailable} onClick={() => speak({ text, lang: voiceLang, preset, voiceURI: voiceURI || null })} className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">Speak</button>
        <button type="button" disabled={!caps.ttsAvailable} onClick={stopSpeaking} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">Stop</button>
        {!recognitionRef.current ? (
          <button type="button" disabled={!caps.sttAvailable} onClick={startStt} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60">Listen</button>
        ) : (
          <button type="button" onClick={stopStt} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">Stop listening</button>
        )}
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" checked={revoice} onChange={(e) => setRevoice(e.target.checked)} />
          Revoice (STT → TTS)
        </label>
        <button type="button" disabled={!text.trim()} onClick={() => { onInsertText(text); setText(""); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-60" data-testid="speech-insert">{t(lang, "speech.insert")}</button>
        <button type="button" onClick={() => { onSendText(text); setText(""); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border bg-background px-3 text-sm hover:bg-accent">Send to chat</button>
      </div>
      {partial ? <div className="rounded-xl border border-border bg-background p-2 text-xs italic">{partial}</div> : null}
      {serverMode && serverVoices.length > 0 ? (
        <div className="rounded-xl border border-border bg-background p-2 text-xs">
          <div className="mb-1 font-semibold">{t(lang, "speech.server")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={serverVoice} onChange={(e) => setServerVoice(e.target.value)} className="min-h-9 rounded-lg border border-input bg-background px-2">
              {serverVoices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <button type="button" disabled={serverBusy || !text.trim()} onClick={() => void speakServer()} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60">
              {serverBusy ? "…" : t(lang, "speech.server.speak")}
            </button>
          </div>
        </div>
      ) : null}
      {!caps.sttAvailable ? <p className="text-[11px] text-muted-foreground">Speech recognition is Chrome/Edge/Android only. Voice cloning of arbitrary samples is intentionally not implemented — see docs/speech.md.</p> : null}
    </div>
  );
}

type ConnLogEvent = "connecting" | "open" | "closed" | "retry" | "failed" | "stopped";

function ConnectionPanel({
  status, prefs, setPrefs, lang, desired, log,
}: {
  status: ConnectionStatus | null;
  prefs: Preferences;
  setPrefs: (p: Partial<Preferences>) => void;
  lang: Lang;
  desired: DesiredState;
  log: Array<{ at: number; attempt: number; event: ConnLogEvent; delayMs?: number }>;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-background p-2 text-xs" data-testid="conn-desired" data-desired={desired}>
        <span className="font-semibold">{t(lang, "conn.desired")}:</span>{" "}
        {t(lang, desired === "connected" ? "conn.desired.connected" : "conn.desired.disconnected")}
      </div>
      <p className="text-xs text-muted-foreground">Heartbeat strategy controls how often the client pings signaling and how aggressively it reconnects after a drop. Browsers throttle background timers; mobile may suspend WebSockets entirely when tab is hidden.</p>
      <label className="grid gap-1 text-sm font-medium">Strategy
        <select
          value={prefs.keepaliveStrategy}
          onChange={(e) => setPrefs({ keepaliveStrategy: e.target.value as KeepaliveStrategy })}
          className="min-h-10 rounded-xl border border-input bg-background px-2"
        >
          <option value="conservative">Conservative (45s ping, reconnect from 1.5s)</option>
          <option value="balanced">Balanced (25s ping, reconnect from 1s)</option>
          <option value="aggressive">Aggressive (12s ping, reconnect from 0.5s)</option>
        </select>
      </label>
      {status ? (
        <div className="rounded-xl border border-border bg-background p-2 text-xs font-mono">
          <div>state: {status.state}</div>
          <div>RTT: {status.rttMs} ms</div>
          <div>strategy: {status.strategy}</div>
          <div>last activity: {status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString() : "—"}</div>
          <div>last pong: {status.lastPongAt ? new Date(status.lastPongAt).toLocaleTimeString() : "—"}</div>
        </div>
      ) : <p className="text-xs text-muted-foreground">Not connected.</p>}
      <div>
        <h3 className="mb-1 text-xs font-semibold">{t(lang, "conn.log.title")}</h3>
        {log.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t(lang, "conn.log.empty")}</p>
        ) : (
          <ol className="max-h-40 overflow-y-auto rounded-xl border border-border bg-background p-2 font-mono text-[11px] leading-5" data-testid="conn-log">
            {log.map((entry, i) => (
              <li key={`${entry.at}-${i}`}>
                {new Date(entry.at).toLocaleTimeString()} · #{entry.attempt} ·{" "}
                {entry.event === "retry"
                  ? t(lang, "conn.log.retry").replace("{s}", ((entry.delayMs ?? 0) / 1000).toFixed(1))
                  : t(lang, `conn.log.${entry.event}`)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

// Local Palette icon shim to avoid extra import noise
function Palette(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="13.5" cy="6.5" r="1.5" />
      <circle cx="17.5" cy="10.5" r="1.5" />
      <circle cx="6.5" cy="12.5" r="1.5" />
      <circle cx="8.5" cy="7.5" r="1.5" />
      <path d="M12 22a10 10 0 1 1 10-10c0 2-1.5 3-3 3h-2c-1.5 0-3 1-3 2.5S15 22 12 22z" />
    </svg>
  );
}

// Single-screen app: no router, no data-fetching cache, no toast layer. Those
// template wrappers were mounted but never used by anything.
export default ChatApp;
