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

import { LogOut } from "lucide-react";
import { ChangeEvent, FormEvent, KeyboardEvent, Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { detectCapabilities } from "./lib/capabilities";
import { clearPreferences, loadPreferences, savePreferences, DEFAULT_ROOM_SECURITY, type Preferences, type WidgetState } from "./lib/preferences";
import { linkify, tagsIn } from "./lib/linkify";
import { fetchPushStatus, subscribeToPush, ensureServiceWorker, sendTestPush, showLocalTestNotification } from "./lib/push";
import { forgetWorkerRoomNames, loadAccountNotify, mentionedAway, setCurrentNotifyPrefs, showLocalNotification, tellWorkerRoomName, unlinkPushSubscription } from "./lib/notify-client"; // 6.7 notify
import { dispatchInternal, installPublicAPI } from "./lib/cipherroom-api";
import { bootstrapDefine } from "./lib/define/client"; // 6.3 define
import { applyTheme, applyTypography, applyColorOverrides, applyEffects, applyChatSurface } from "./lib/themes";
import { ensureFonts, GOOGLE_FONTS } from "./lib/fonts";
import { applyDeviceAttributes, deviceInfo, fullscreenSupported, toggleFullscreen, watchFullscreen } from "./lib/device";
import { buildStylesheet } from "./lib/style-overrides";
import { useStyleOverrides } from "./lib/style-editor";
import { buildLabel, watchForNewVersion } from "./lib/build-info";
import { IntegrityCheck, type IntegrityHandle } from "./components/IntegrityCheck";
import { styleKeyFor, bubbleStyleFrom, sanitizePerUserStyle, isEmptyStyle, type PerUserStyle } from "./lib/message-styles";
import { sealText, generateSealCode, type FnMeta, type FnStatus, type MsgFlags } from "./lib/message-kinds";
import { MessageBubble } from "./components/MessageBubble";
import { UserBadge } from "./components/UserBadge";
import { SendOptions, DEFAULT_SEND_STATE, type SendState } from "./components/SendOptions";
import { RecipientsWidget, type WidgetPeer } from "./components/RecipientsWidget";
// 6.7 voice: dictation + recorder in the composer, the voice changer, speak and send.
import { ComposerVoice } from "./components/ComposerVoice";
import { useComposerSuggest } from "./components/CommandSuggest";
import { VoiceChangerPanel } from "./components/VoiceChangerPanel";
import { isProcessed, openMic, processStream, setVoiceFxAllowed, voiceFxActive } from "./lib/mic";
import { onVoiceFxChange } from "./lib/voice-fx-settings";
import { textToVoiceFile, sendFromComposer, voiceTooBigFor, SPEAK_SEND_MAX, serverVoiceConsent } from "./lib/speak-send";
import { attachmentKinds, forwardPlan, largeFileTargets, liveLocationTargets } from "./lib/send-plan";
import { fetchServerSpeechStatus, serverTtsBlob } from "./lib/speech";
import type { UserInfo } from "./components/UserInfoModal";
import type { MessageInfo } from "./components/MessageInfoModal";
import type { RegisterResult } from "./components/RegistrationDialog";
import type { RegistrationInput } from "./lib/registration/form";
// The NFC / smart-card workbench pulls in the transport + card-parsing tree;
// load it only when the panel opens so the initial bundle stays lean.
const NfcWorkbench = lazy(() => import("./components/NfcWorkbench").then((m) => ({ default: m.NfcWorkbench })));
const RegistrationDialog = lazy(() => import("./components/RegistrationDialog").then((m) => ({ default: m.RegistrationDialog })));
// Loaded on first use: the Appearance screen and the Edit Mode inspector.
const AppearancePanel = lazy(() => import("./components/AppearancePanel").then((m) => ({ default: m.AppearancePanel })));
const StyleInspector = lazy(() => import("./components/StyleInspector").then((m) => ({ default: m.StyleInspector })));
const PhonePanel = lazy(() => import("./components/PhonePanel").then((m) => ({ default: m.PhonePanel })));
// Dialogs load when first opened (SimpleModal waits for them): the account
// panel, participant and message details (QR code, scanner), sharing, AI.
const UserInfoView = lazy(() => import("./components/UserInfoModal").then((m) => ({ default: m.UserInfoView })));
const MessageInfoView = lazy(() => import("./components/MessageInfoModal").then((m) => ({ default: m.MessageInfoView })));
const AccountInfoModal = lazy(() => import("./components/AccountPanel").then((m) => ({ default: m.AccountInfoModal })));
const ChatRetentionSection = lazy(() => import("./components/AccountPanel").then((m) => ({ default: m.ChatRetentionSection })));
const AccountAccess = lazy(() => import("./components/AccountPanel").then((m) => ({ default: m.AccountAccess })));
const ShareSection = lazy(() => import("./components/SharePanel").then((m) => ({ default: m.ShareSection })));
const InvitePrompt = lazy(() => import("./components/SharePanel").then((m) => ({ default: m.InvitePrompt })));
const AiPanel = lazy(() => import("./components/AiPanel").then((m) => ({ default: m.AiPanel })));
const ConnectionsPanel = lazy(() => import("./components/ConnectionsPanel").then((m) => ({ default: m.ConnectionsPanel })));
import { detectLang, t, tf, type Lang } from "./lib/i18n";
import type { ConnectionStatus } from "./lib/connection-keeper";
import { dispatchCommand, isAdminCommand } from "./lib/admin-commands";
import {
  extractRemoteFingerprint,
  persistFingerprint,
  compareFingerprint,
  formatFingerprint,
  sha256Hex,
  type Fingerprint,
} from "./lib/fingerprint";
import {
  newIncomingRegistry,
  handleIncomingFrame,
  sendFile,
  binaryFrame,
  frameFromBinary,
  wireFrame,
  largeFileRoute,
  type FileKeyLookup,
  type FileTransferEnvelope,
  type IncomingCallbacks,
} from "./lib/file-transfer";
import { detectGeolocation, getCurrentPosition, watchPosition, osmLink, type LocationWatcher } from "./lib/maps";
import { toBase64 } from "./lib/crypto";
// Crypto v2: per-purpose keys, bound contexts, signed bodies (envelope.ts).
import {
  createReplayGuard, deriveRoomKeys, isSealedSignal, OldEnvelopeError, openMessage, openSignal, sealMessage, sealSignal,
  type Envelope as DataChannelEnvelope, type RoomKeys, type Signer,
} from "./lib/envelope";
import { createPinStore, keyId, loadIdentity, type Identity } from "./lib/identity";
import { envelopeKind, SenderKeyStore } from "./lib/sender-keys";
// 6.12: protocol 4 (docs/protocol-v4.md) — sessions, mailbox, hub proof, key transparency, replay, identity states.
import {
  buildHubProof, hubSeed, isMailboxItem, isMailboxSet, newFileKey, verifyAccount,
  type DirectoryDevice, type KtLookup, type Mailbox, type RatchetInner, type ReplayGuard,
} from "./lib/p4";
import { isP4RoomEnvelope, P4Room, type PeerInfo, type PeerProtocol } from "./lib/p4-session";
import { deviceReplay, LocalKtStore, PayloadSealer, type SealedPayload, type VaultReplayStore } from "./lib/p4-store";
import { acceptChanged, evaluateIdentity, markVerified, signerOf, TrustBook } from "./lib/p4-trust";
import { deviceMailbox, helloAccountOf, sealForAway, uploadBundle } from "./lib/p4-away";
import { fetchKtJson, KtClient, type KtStatus } from "./lib/p4-kt";
import type { SealedWith } from "./lib/chat-types";
import { MediaE2ee } from "./lib/media-e2ee";
import { validatePayload, type AudioStatusPayload, type ChatPayload } from "./lib/validate";
import { newId } from "./lib/id";
import { APP_BUILD, APP_VERSION } from "./lib/build-info";
import type { SignInProgress } from "./components/AccountPanel";
import { TransferCard } from "./components/TransferCard";
import { MainMenu } from "./components/MainMenu";
import { formatTime, formatFullDate, formatBytes } from "./lib/format";
import { fetchLayoutConfig, applyLayoutStyles, loadCachedLayout } from "./lib/layout-client";
import { layoutBlocks, layoutTree, renderTemplate, type LayoutConfig, type LayoutContext } from "./lib/layout-config";
import { renderLayout } from "./components/LayoutView";
import { LayoutProvider } from "./components/LayoutProvider";
import type { LNode } from "./lib/layout-tree";
import { freshRtcConfig, turnConfigPromise } from "./lib/rtc";
import { M5Logo } from "./components/M5Logo";

import { createSessionCache, SESSION_IDLE_LIMIT_MS, type DesiredState } from "./lib/session-cache";
import { parseShareFragment, type ShareLinkParts, type SharePayload } from "./lib/share-link";
import type { AttachmentMeta, ChatMessage, MessageAudit, MessageIdentity, MsgState } from "./lib/chat-types";
import type { ChatResult, ForwardBody, ForwardRoom, ForwardTarget, NfcChatBridge } from "./components/NfcTemplatePanel";
import { fetchCommandState, parseCommandLine, buildInputs, runCommandStream, answerInteraction, outputsToMarkdown, sendFnEventStream, sendFnReport, type Command, type FnEventBody, type Interaction, type RunDone } from "./lib/functions";
// 6.3 nfc: an "nfc" interaction is run on this device's NFC bridge, not shown as a dialog.
import { runNfcCommand } from "./lib/nfc/bridge";
import type { NfcCommand, NfcResult } from "./lib/nfc/command";
import { consentPrompt, maskNfcResult, nfcConsent, type NfcConsent } from "./lib/nfc/consent";
import { DOCUMENT_KEY_FIELDS, documentKeyValid, needsDocumentKey, withDocumentKey } from "./lib/nfc/document-key";
import { shareableOutputs } from "./lib/fn-outputs";
import { historyRoomsToRead, serverRoomId } from "./lib/room-privacy";
import { isSitePath } from "./lib/site-path";
import { FnHostContext, type FnHost } from "./components/fn/FnOutputs";
// 6.11: a model's answers from system-messenger, a guarded run (timeout, settles once), the usage card, typed questions.
import { SYSTEM_MESSENGER_ID, checkCommandInputs, cleanModelIcon, isModelSender, modelIdentity } from "./lib/system-messenger";
import { callFailure, callOutcome, guardRun, runFailure, type CallOutcome, type RunEnd, type RunGuard } from "./lib/fn-run";
import { modelAnswerView, usageCardOutputs } from "./lib/fn-answer";
import { ModelBadge } from "./components/fn/ModelBadge";
import { FnAskDialog } from "./components/fn/FnAskDialog";
import { isInlineImage } from "./lib/validate";
import { DEFAULT_PROXY_LIMITS, extractPeerAddress, normalizeRoom, proxyPacer, type ProxyLimits } from "./lib/app-helpers";
import { SignedInBadge } from "./components/SignedInBadge";
import { ConnectionsStore, findProfile, startupProfile, normalizeRoomName, type ConnectionEvent, type ConnectionProfile, type RecordExtra } from "./lib/connections";
import { DEFAULT_COMPOSER, effectiveAppearance, serverAllowed, signalingUrl } from "./lib/client-config";
import { fetchClientConfig, loadCachedClientConfig } from "./lib/client-config-client";
import { SimpleModal } from "./components/SimpleModal";
import { RoomDialog, RoomTabs, type RoomTab, type RoomTarget } from "./components/RoomDialog";
import { RoomBar, type RoomBarItem } from "./components/RoomBar";
import { PhoneBridgePanel } from "./components/PhoneBridgePanel";
import { StartScreen } from "./components/StartScreen";
import { PhoneBridgeClient, bridgeUrl, callFromFrame, withServer, type PhoneCall } from "./lib/phone-bridge";
import { createRoomHub, roomKeyOf, type HubTarget, type RoomHub } from "./lib/room-hub";
import { cleanUsername, sessionUsername } from "./lib/username";
import { clearCard, currentCard, loadCard, myRoomView, onCardChange } from "./lib/profile/client";
import { prefillNickname, type ProfileCard, type SharedProfile } from "./lib/profile/model";
import { FRAME_MAX_CHARS, PROFILE_CAP, ProfileExchange, RoomProfiles, type ProfileFrame } from "./lib/profile/room";
import { installNavigationGuard, releaseNavigationGuard, type BlockedBy } from "./lib/nav-guard";
import { moduleAllowed, moduleOfPanel } from "./lib/modules";
import { fetchMenuConfig, loadCachedMenuConfig } from "./lib/menu-config-client";
import { nodeModule, type MenuAction, type MenuNode } from "./lib/menu-config";
import type { TemplateVars } from "./lib/menu-template";
import { isThemeId } from "./lib/theme-catalog";
import { AudioControls, PeerList, VideoControls } from "./components/CallPanels";
import { ConnectionPanel, FilesPanel, LocationPanel, SpeechPanel, type ConnLogEvent } from "./components/ToolPanels";
import {
  accountStatus, accountSupported, accountToken, addPasskey, createRecoveryCode, currentAccount, deleteAccount as deleteServerAccount,
  endSession, linkPushSubscription, loadVault, logAccountEvent, recoverWithCode, refreshAccount, registerAccount, removePasskey, saveRegistration,
  removeRecoveryCode, restoreSession, saveVault, loadConnectionsVault, signInWithPasskey, signOutAccount, type AccountStatus, type AccountSummary,
  AccountError, type StepState,
} from "./lib/account";
import { createHistoryStore, createServerSealer, prepareHistory, sanitizeRestored, type ChatRetention } from "./lib/chat-history";
import {
  auditEntry, createAuditQueue, deleteMessage, endHides, hiddenCount, hideMessage, hideUntil, isDeleted, isHidden, mergeWithDeletions, nextHideEnd,
  postMessageAudit, unhideMessage, type HideChoice, type MessageAuditAction,
} from "./lib/message-hide";
import { messageKinds, messageSize, receiptsOf, timelineOf, withAudit } from "./lib/message-timeline";
import { forgetBlob, rememberBlob, releaseBlobUrl } from "./lib/attachment-media";
import { capMessages, withReleasedFiles } from "./lib/memory-caps";
import type { MapPreviewPolicy } from "./lib/client-config";
import { startBackgroundTick, watchLifecycle, type ResumeEvent, type SuspendEvent } from "./lib/lifecycle";
import { appInForeground, useRoomPresence } from "./lib/use-room-presence";
import { createFlashQueue, kindForText, type FlashMessage } from "./lib/flash";
import { createOutbox, queueTargets } from "./lib/outbox";
import { FlashMessages } from "./components/FlashMessages";
import {
  attachStorageSocket, forgetServerData, putMessages as putServerMessages,
  readMessages as readServerMessages, recordTransfer as recordServerTransfer, sendLog as sendServerLog,
  storageSessionId, storageStatus, type StorageStatus,
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

import type { AudioStatus, PeerView } from "./lib/app-types";

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
      /** 6.12 (§ 13): did our join prove the room key? */
      proven?: boolean;
      peers: Array<{ peerId: string; name: string; joinedAt: number; proven?: boolean } & AccountRefFields>;
      // Signed-in members the server answers for while they are gone.
      away?: Array<{ name: string; since: number } & AccountRefFields>;
      account?: ({ away: boolean } & AccountRefFields) | { invalid: true } | null;
    }
  | ({ type: "peer-joined"; peerId: string; name: string; joinedAt: number; proven?: boolean } & AccountRefFields)
  // 6.12: the key directory (§ 7.5) and key transparency (§ 14.3) for a member's room-scoped reference.
  | { type: "key-bundles"; ref: string; devices: DirectoryDevice[] }
  | { type: "kt-lookup"; ref: string; lookup: KtLookup | null }
  // Away relay (see server/signaling/relay.ts)
  | ({ type: "peer-away"; peerId?: string; name: string; since: number } & AccountRefFields)
  | ({ type: "peer-back"; peerId?: string; name?: string } & AccountRefFields)
  | ({ type: "peer-gone" } & AccountRefFields)
  | ({ type: "peer-updated"; peerId: string; name: string } & AccountRefFields)
  | { type: "relay-deliver"; items: RelayItem[] }
  | { type: "relay-status"; messageId: string; recipient: { name: string } & AccountRefFields; state: MsgState | "rejected" | "duplicate"; at: number; reason?: string }
  // 6.7 `held`: the connection went, they did not leave — still listed, as away (lib/presence-book.ts).
  | { type: "peer-left"; peerId: string; held?: boolean }
  | { type: "signal"; source: string; payload: unknown }
  | { type: "signal-undeliverable"; target: string }
  | { type: "hello"; peerId: string; protocol?: number; features?: string[]; limits?: { proxy?: ProxyLimits }; nonce?: string }
  | { type: "pong"; t: number; serverTs: number }
  | { type: "presence-ack"; away: boolean }
  | ({ type: "auth-result"; ok: boolean; invalid?: boolean; account: ({ away: boolean } & AccountRefFields) | null })
  | { type: "account-revoked"; reason: string }
  | { type: "rate-limited"; frame: string; retryAfterMs: number }
  | { type: "replaced"; reason: string }
  | { type: "closed-by-server"; reason: string }
  // 6.0: the operator speaks (the console, a function's m5room.wall_msg / user_msg / user_flash).
  | { type: "server-notice"; id: string; kind: "wall" | "message" | "flash" | "wake"; text: string; level: string; from: string; at: number; pinned?: boolean }
  // 6.0: a phone call for this member (m5.telephony's audio bridge).
  | { type: "phone-bridge"; event: string; session: string; [k: string]: unknown }
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
  /** Protocol 3: a room-key envelope; 6.12 protocol 4: an `mb` item or `mb-set` sealed for this device's mailbox. */
  envelope?: DataChannelEnvelope | Record<string, unknown>;
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
  /** Perfect negotiation (see createPeer): an offer of ours is in flight,
   *  and whether we ignored the peer's colliding one. */
  makingOffer?: boolean;
  ignoreOffer?: boolean;
};

const PORT_BASE = "__PORT_5000__";
const EXTERNAL_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL as string | undefined;
// Inline (data-URL) attachment cap. Anything larger goes through the
// chunked DataChannel transfer path (file-transfer.ts), which has its
// own user-configurable hard limit (Preferences.maxAttachmentBytes).
const INLINE_ATTACHMENT_LIMIT = 512 * 1024;
const QUICK_EMOJI = ["😀", "😂", "🥳", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❓"];

/** Messages rendered at once; "show earlier" adds as many again. */
const MESSAGE_WINDOW = 200;

/** The signaling socket: a saved connection's own server, or this one. */
function wsUrl(server = "") {
  if (server) {
    const url = signalingUrl(server);
    if (url) return url;
  }
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

/** The panels a function may open (m5.out.window). */
const FN_PANELS = ["profile", "settings", "appearance", "privacy", "encryption", "notifications", "roomSecurity", "trust", "invite", "join", "peers", "audio", "video", "files", "location", "nfc", "speech", "ai", "phone", "connections"] as const;

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
  | "connections"
  | "voiceChanger"
  | null;

type RowActions = {
  setMessageStyle: (key: string, patch: PerUserStyle) => void;
  resetMessageStyle: (key: string) => void;
  showUser: (id: string) => void;
  showInfo: (id: string) => void;
  reply: (m: ChatMessage) => void;
  forward: (m: ChatMessage) => void;
  vanished: (id: string) => void;
  displayed: (id: string) => void;
  jump: (id: string) => void;
  /** 6.2: timeline steps from the bubble, and its short notices. */
  revealed: (id: string) => void;
  opened: (id: string) => void;
  notice: (text: string) => void;
  /** 6.12 (§ 12.1): accept a sender's changed key — their held messages show. */
  acceptKey: (m: ChatMessage) => void;
};

type MessageRowProps = {
  message: ChatMessage;
  perStyle: PerUserStyle | undefined;
  layout: LayoutConfig;
  /** 4.13: who is looking (groups, GUI template) — picks a layout's variant. */
  layoutCtx: LayoutContext;
  lang: Lang;
  timezone: string;
  room: string;
  avatar: string;
  /** 6.7: the sender's profile photo (what they share with the room). */
  peerAvatar?: string;
  delivery: MsgState | undefined;
  /** 6.2: the operator's map preview (client config › map). */
  mapPolicy: MapPreviewPolicy;
  act: { current: RowActions };
};

/** 6.12: what a message of mine shows as its sealing — the strongest way it went out. */
const SEALING_ORDER: SealedWith[] = ["p4-pair", "p4-sk", "p4-mailbox", "pair", "sender-key", "room"];
function bestSealing(kinds: Set<SealedWith>): SealedWith | undefined {
  return SEALING_ORDER.find((k) => kinds.has(k));
}

/** The layout config's reusable templates, one object per config (so the
 *  memoized rows below do not see a new object on every render). */
const blocksCache = new WeakMap<LayoutConfig, Record<string, LNode>>();
function layoutBlocksOf(cfg: LayoutConfig): Record<string, LNode> {
  let b = blocksCache.get(cfg);
  if (!b) { b = layoutBlocks(cfg); blocksCache.set(cfg, b); }
  return b;
}

/** One message in the conversation. Memoized: typing in the composer, a
 *  peer's status or a new message elsewhere leave it alone. */
const MessageRow = memo(function MessageRow({ message, perStyle, layout, layoutCtx, lang, timezone, room, avatar, peerAvatar, delivery, mapPolicy, act }: MessageRowProps) {
  // 6.12 (docs/protocol-v4.md § 12.1): a sender whose key changed — the message
  // is held behind a warning until the user accepts the new key.
  if (!message.mine && message.identity?.state === "changed") {
    return (
      <div className="msg-row flex justify-start" data-testid={`message-${message.id}`} data-held="true">
        <div className="max-w-[85%] rounded-2xl border border-destructive/50 bg-destructive/10 p-3 text-sm" role="alert">
          <p className="font-semibold text-destructive">{tf(lang, "p4.held.title", { name: message.senderName })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(lang, message.identity.revoked ? "sec.identity.revoked" : "p4.held.text").replace("{fp}", message.identity.fingerprint ?? "")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="acc-btn acc-btn--small" onClick={() => act.current.showUser(message.senderId)}>{t(lang, "p4.held.check")}</button>
            {!message.identity.revoked && (
              <button type="button" className="acc-btn acc-btn--small acc-btn--danger" data-testid={`held-accept-${message.id}`} onClick={() => act.current.acceptKey(message)}>{t(lang, "p4.held.accept")}</button>
            )}
          </div>
        </div>
      </div>
    );
  }
  const isSystem = message.senderId === "system";
  const styleKey = styleKeyFor(message.senderName, message.senderId);
  const vars = {
    sender: message.senderName,
    time: formatTime(message.createdAt, lang, timezone),
    date: formatFullDate(message.createdAt, lang, timezone),
    room,
    appName: "M5cet",
  };
  // 6.11: a model's answer is an incoming message from system-messenger, shown
  // as the model (its icon and name) — a room answer with who sent it ("via …").
  const model = isSystem ? null : modelAnswerView(message);
  // Others get the user badge (a live part of the layout); my own and system
  // messages draw their head from the layout with these values.
  const badge = model ? (
    <ModelBadge identity={model.identity} via={model.via} lang={lang} onVia={() => act.current.showUser(message.senderId)} />
  ) : isSystem || message.mine ? null : (
    <UserBadge
      name={message.senderName}
      senderId={message.senderId}
      avatar={peerAvatar}
      mine={false}
      style={perStyle}
      onChangeStyle={(patch) => act.current.setMessageStyle(styleKey, patch)}
      onResetStyle={() => act.current.resetMessageStyle(styleKey)}
      onInfo={() => act.current.showUser(message.senderId)}
      lang={lang}
    />
  );
  const head = isSystem
    ? {
        showLogo: layout.flags.showSystemLogo,
        headerText: renderTemplate(layout.templates.systemHeader, { ...vars, appName: message.senderName, date: layout.flags.systemFullDate ? vars.date : vars.time }, layout.partials),
      }
    : message.mine && !model ? { showAvatar: layout.flags.showAvatars, avatar } : undefined;
  const incoming = !message.mine || Boolean(model);
  return (
    <MessageBubble
      id={message.id}
      sealedWith={message.sealedWith}
      senderId={message.senderId}
      senderName={message.senderName}
      mine={message.mine}
      isSystem={isSystem}
      secure={message.secure && layout.flags.showLockIcon}
      createdAt={message.createdAt}
      timeLabel={isSystem || !layout.flags.showTime ? "" : renderTemplate(incoming ? layout.templates.incomingMeta : layout.templates.outgoingMeta, vars, layout.partials)}
      text={message.text}
      attachment={message.attachment}
      flags={message.flags}
      ownPlaintext={message.mine && message.flags?.sealed ? message.sealPlain : undefined}
      sealCode={message.mine ? message.sealCode : undefined}
      vanished={message.vanished}
      vanishedAt={message.vanishedAt}
      onVanish={(id) => act.current.vanished(id)}
      to={message.to}
      replyTo={message.replyTo}
      // 6.11: a room answer's "/keyword" is in its head already (the model's identity).
      forwardedFrom={model && message.forwardedFrom === `/${model.identity.keyword}` ? undefined : message.forwardedFrom}
      loc={message.loc}
      mapPolicy={mapPolicy}
      hidden={Boolean(message.hidden)}
      onRevealed={(id) => act.current.revealed(id)}
      onOpened={(id) => act.current.opened(id)}
      onNotice={(text) => act.current.notice(text)}
      bubbleStyle={model ? undefined : bubbleStyleFrom(perStyle)}
      badge={badge}
      head={head}
      model={model}
      tree={layoutTree(layout, isSystem ? "message.sys" : incoming ? "message.in" : "message.out", layoutCtx)}
      blocks={layoutBlocksOf(layout)}
      lang={lang}
      renderText={linkify}
      formatSize={formatBytes}
      onInfo={isSystem ? undefined : (mid) => act.current.showInfo(mid)}
      onReply={isSystem || !layout.flags.showActions ? undefined : () => act.current.reply(message)}
      // 6.10 (G-13): a sealed message whose code this app does not have cannot be forwarded (send-plan.ts › forwardPlan).
      onForward={isSystem || !layout.flags.showActions || !forwardPlan(message).ok ? undefined : () => act.current.forward(message)}
      deliveryState={delivery}
      onDisplayed={(id) => act.current.displayed(id)}
      onReplyJump={(id) => act.current.jump(id)}
      systemCollapseAfterSec={layout.flags.systemCollapseAfterSec}
      systemExpandForSec={layout.flags.systemExpandForSec}
    />
  );
});

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
  // Chat commands (4.15): the "/keyword" functions this user may run.
  const [commands, setCommands] = useState<Command[]>([]);
  // 5.2: whether the Functions module is on for this user (null: not asked yet).
  const [commandsEnabled, setCommandsEnabled] = useState<boolean | null>(null);
  const commandsAtRef = useRef(0);
  // 5.2: a "#tag" the conversation is filtered by (clicked in a message).
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // A running command's live question (m5.prompt / m5.form) and its run token.
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  // 6.11: the command's run (guarded: a clock, ends once — a newer command cancels it), and which run each open question belongs to.
  const runGuardRef = useRef<RunGuard | null>(null);
  const askGuardsRef = useRef(new Map<string, RunGuard>());
  // 5.3: what a function's outputs (buttons, forms, browser code) reach — the latest handlers, through refs.
  const fnEventRef = useRef<(meta: FnMeta, ev: Exclude<FnEventBody, { type: "error" | "log" }>) => Promise<boolean>>(async () => false);
  const fnReportRef = useRef<(meta: FnMeta, ev: Extract<FnEventBody, { type: "error" | "log" }>) => Promise<void>>(async () => undefined);
  const runCmdTokenRef = useRef<string | null>(null);
  const runCmdRunIdRef = useRef<string | null>(null);
  /** 6.5: the id of the call's own pending bubble, updated in place when the model answers. */
  const runCmdMsgIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>("");
  // The state the user asked for. "connected" is enforced: the app keeps
  // retrying until it holds; only the Disconnect button (or the idle limit,
  // or Clear & Quit) sets it back. Mirrors intentRef for rendering.
  const [desired, setDesired] = useState<DesiredState>("disconnected");
  const desiredRef = useRef<DesiredState>("disconnected");
  desiredRef.current = desired;
  /** The version check (IntegrityCheck): `check(true)` runs it now. */
  const integrityRef = useRef<IntegrityHandle | null>(null);
  const [connLog, setConnLog] = useState<Array<{ at: number; attempt: number; event: ConnLogEvent; delayMs?: number }>>([]);
  const [inviteParts, setInviteParts] = useState<ShareLinkParts | null>(null);
  const [sessionPassphrase, setSessionPassphrase] = useState("");
  const sessionCacheRef = useRef(createSessionCache());
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushVapidKey, setPushVapidKey] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [voiceBusy, setVoiceBusy] = useState(false); // 6.7: a text being turned into a voice message
  const [now, setNow] = useState(Date.now());

  // --- message kinds + recipient selection ---
  const [sendOpts, setSendOpts] = useState<SendState>(DEFAULT_SEND_STATE);
  // Selected private recipients (peerIds). Empty + autoRoom off => nothing sends.
  const [recipients, setRecipients] = useState<Set<string>>(new Set());
  const [widget, setWidget] = useState<WidgetState>(initialPrefs.widget);

  // --- signed-in user (passkey account) + away relay ---
  const [account, setAccount] = useState<AccountSummary | null>(null);
  /** The startup check for this tab's account session has finished. */
  const [accountResolved, setAccountResolved] = useState(false);
  // The operator's addon configuration (saved connections, templates).
  const [clientConfig, setClientConfig] = useState(loadCachedClientConfig);
  // 4.0: the menu as the operator built it (console › Menu builder).
  const [menuConfig, setMenuConfig] = useState(loadCachedMenuConfig);
  // Saved connections: sealed into the account vault (lib/connections.ts).
  const connectionsReadyRef = useRef(false);
  const connectionsRef = useRef<ConnectionsStore | null>(null);
  if (!connectionsRef.current) {
    connectionsRef.current = new ConnectionsStore(async (state) => {
      // Never write before the vault was read: an empty list would replace the real one.
      if (!connectionsReadyRef.current) return;
      await saveVault({ connections: { value: state, count: state.profiles.length } });
    }, loadCachedClientConfig().connections);
  }
  const [cxState, setCxState] = useState(() => connectionsRef.current!.get());
  const [cxReady, setCxReady] = useState(false);
  /** The saved connection this tab is using; "" server = this one. */
  const activeProfileRef = useRef<ConnectionProfile | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const activeServerRef = useRef("");
  /** 4.0: who this session is — the account's username, or (P2P) one made from the nickname. */
  const sessionUserRef = useRef("");
  const [sessionUser, setSessionUser] = useState("");
  /** The usernames peers told us in their hello. */
  const peerUsersRef = useRef(new Map<string, string>());
  /** 6.7: my profile card (signed in), and what the room's members share with me (end-to-end encrypted). */
  const [card, setCard] = useState<ProfileCard | null>(() => currentCard());
  const roomProfilesRef = useRef(new RoomProfiles());
  const [peerProfiles, setPeerProfiles] = useState<Record<string, SharedProfile>>({});
  /** The account key that signed a peer's messages (a public profile's is compared with it). */
  const peerAccountKeysRef = useRef(new Map<string, string>());
  /** The name field was typed in this session: the public nickname no longer pre-fills it. */
  const nameTypedRef = useRef(false);
  const profileExchangeRef = useRef<ProfileExchange | null>(null);
  /** A restored session's saved connection, bound once the vault opens. */
  const pendingProfileIdRef = useRef<string | null>(null);
  /** The Room window's tab when the user picked one; otherwise it follows the session. */
  const [roomTabPick, setRoomTabPick] = useState<RoomTab | null>(null);
  /** My connections opened from the Room window, above it ("new" = straight to the form). */
  const [manageFromRoom, setManageFromRoom] = useState<null | "list" | "new">(null);
  /** The last few rooms' derived keys (memory only; Argon2id costs ~1 s on a phone). */
  const derivedKeysRef = useRef(new Map<string, RoomKeys>());
  /** Names the room told us, by peer id (a signal can arrive before the name). */
  const peerNamesRef = useRef(new Map<string, string>());
  const autoConnectDoneRef = useRef(false);
  const [accStatus, setAccStatus] = useState<AccountStatus | null>(null);
  const [accBusy, setAccBusy] = useState(false);
  /** 6.4: the registration form dialog. */
  const [showRegistration, setShowRegistration] = useState(false);
  const [accMsg, setAccMsg] = useState("");
  /** 4.0: the sign-in / registration in progress (or just finished) — its checked steps. */
  const [signin, setSignin] = useState<SignInProgress | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  /** Signed-in members of the room the server is currently answering for. */
  const [awayPeers, setAwayPeers] = useState<AwayPeer[]>([]);
  const accountRef = useRef<AccountSummary | null>(null);
  const awayPeersRef = useRef<AwayPeer[]>([]);
  /** 6.7: who is online, away or far away — and members whose connection went (held). */
  const presence = useRoomPresence(() => socketRef.current);
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
  // What a message row may do: read through a ref, so a row that did not
  // change is not re-rendered for a new function identity (MessageRow).
  const rowActionsRef = useRef<RowActions>(null as unknown as RowActions);
  rowActionsRef.current = {
    setMessageStyle: (key, patch) => setMessageStyle(key, patch),
    resetMessageStyle: (key) => resetMessageStyle(key),
    showUser: (id) => setUserInfoFor(id),
    showInfo: (id) => setMsgInfoFor(id),
    reply: (m) => startReply(m),
    forward: (m) => void forwardMessage(m),
    vanished: (id) => onMessageVanished(id),
    displayed: (id) => onMessageDisplayed(id),
    jump: (id) => scrollToMessage(id),
    revealed: (id) => addStep(id, "revealed"),
    opened: (id) => addStep(id, "opened"),
    notice: (text) => setNotice(text),
    acceptKey: (m) => acceptChangedKey(m),
  };

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
  /** Pair keys with each peer and the sender-key ratchets (3.1) — protocol 3, for older peers. */
  const senderKeysRef = useRef(new SenderKeyStore());
  /*
   * 6.12 — protocol 4 (docs/protocol-v4.md). The room's session layer
   * (p4-session.ts: hello v4, pair ratchets, sender keys v4) made with the room
   * keys; what the device remembers about peers (p4-trust.ts: verified
   * accounts, downgrade markers, mailbox bundles); the persistent replay
   * window; this device's mailbox (bundles, private keys encrypted at rest);
   * key transparency for this server; outbox payloads under a page-only key.
   */
  const p4Ref = useRef<P4Room | null>(null);
  const trustRef = useRef(new TrustBook());
  const replayStoreRef = useRef<VaultReplayStore | null>(null);
  const replayGuardRef = useRef<ReplayGuard | null>(null);
  const mailboxRef = useRef<Mailbox | null>(null);
  const ktRef = useRef<KtClient | null>(null);
  const [ktStatus, setKtStatus] = useState<KtStatus>({ state: "unknown" });
  const payloadSealerRef = useRef(new PayloadSealer());
  /** Protocol-4 file keys peers handed us (§ 8): `${peerId}\0${transferId}` → FK. */
  const fileKeysRef = useRef(new Map<string, { fk: string; at: number }>());
  /** Answers of the hub's `key-bundles` / `kt-lookup` by reference (§ 7.5, § 14.3). */
  const hubAsksRef = useRef(new Map<string, Array<(answer: unknown) => void>>());
  const bundleCacheRef = useRef(new Map<string, { at: number; devices: DirectoryDevice[] }>());
  /** Room-scoped account references of the peers here (joined / peer-joined). */
  const peerRefsRef = useRef(new Map<string, string>());
  /** Per peer: the protocol it speaks (the trust panel, the bubbles). */
  const [p4Peers, setP4Peers] = useState<Record<string, PeerProtocol>>({});
  /** 6.12 (§ 13): our join proved the room key (null: the server did not say — before 6.12). */
  const [hubProven, setHubProven] = useState<boolean | null>(null);
  /** The server's join nonce per socket, and whether that socket sent its join. */
  const joinOfRef = useRef(new WeakMap<WebSocket, (nonce: string | null) => Promise<void>>());
  const joinSentRef = useRef(new WeakSet<WebSocket>());
  const hubSeedRef = useRef(new WeakMap<RoomKeys, Promise<Uint8Array>>());
  /** The id of the call our media keys belong to (§ 9). */
  const callIdRef = useRef(newId("call"));
  /** KT lookups already made this session (account key | device key). */
  const ktCheckedRef = useRef(new Set<string>());
  /** The last bundle uploaded to the key directory this session. */
  const uploadedBundleRef = useRef("");
  // Call frames sealed with per-direction pair keys (lib/media-e2ee.ts).
  const mediaE2eeRef = useRef(new MediaE2ee());
  const [mediaStates, setMediaStates] = useState<Record<string, "e2ee" | "partial" | "off">>({});
  useEffect(() => mediaE2eeRef.current.onStats((stats) => {
    const next: Record<string, "e2ee" | "partial" | "off"> = {};
    for (const peerId of Object.keys(stats)) next[peerId] = mediaE2eeRef.current.stateFor(peerId);
    setMediaStates((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }), []);
  /** Device keys this user excluded from the conversation (this session). */
  const excludedRef = useRef(new Set<string>());
  // Binary file chunks (lib/binary-frames.ts): data channels whose peer said
  // it reads them, and whether this server does.
  const binaryChannelsRef = useRef(new WeakSet<RTCDataChannel>());
  const serverBinaryRef = useRef(false);
  const proxyLimitsRef = useRef<ProxyLimits>(DEFAULT_PROXY_LIMITS);
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
  /** Light mode has no server to hold a message: it waits here instead.
   *  6.12: what waits is the PAYLOAD, encrypted under a key of this page only
   *  (p4-store.ts › PayloadSealer) — sealed for each recipient when it goes,
   *  with the best they speak (protocol 4, else 3), never kept as room-key
   *  ciphertext for peers that will speak protocol 4. */
  const outboxRef = useRef(createOutbox<SealedPayload>(async (entry) => {
    const targets = entry.targets.length > 0 ? new Set(entry.targets) : undefined;
    return deliverQueuedRef.current(entry.messageId, entry.envelope, targets);
  }));
  /** Set once deliverToPeers exists (it is declared further down). */
  const deliverQueuedRef = useRef<(id: string, sealed: SealedPayload, targets?: Set<string>) => Promise<number>>(async () => 0);
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
  // 6.0: several rooms at once — the others run headless in the hub
  // (lib/room-hub.ts); messages a room collected there come with it when it
  // is put on screen (carryRef, merged in doConnect).
  const hubRef = useRef<RoomHub | null>(null);
  if (!hubRef.current) hubRef.current = createRoomHub(wsUrl, () => freshRtcConfig());
  const hub = hubRef.current;
  const hubRooms = useSyncExternalStore(hub.subscribe, hub.list, hub.list);
  const carryRef = useRef(new Map<string, ChatMessage[]>());
  // 6.10: the NFC workbench's chat side (Forward / To myself) — a stable object
  // whose calls reach this render's functions (set where they are defined).
  const statusRef = useRef(status);
  statusRef.current = status;
  type NfcLatest = { sendChatPayload: typeof sendChatPayload; sendLargeFileToAll: typeof sendLargeFileToAll; currentHubTarget: typeof currentHubTarget; switchRoom: typeof switchRoom };
  const nfcLatestRef = useRef<NfcLatest>(null as unknown as NfcLatest);
  const nfcChatImplRef = useRef<NfcChatBridge | null>(null);
  const nfcChat = useMemo<NfcChatBridge>(() => ({
    rooms: () => nfcChatImplRef.current?.rooms() ?? [],
    forward: (target, body) => nfcChatImplRef.current?.forward(target, body) ?? Promise.resolve({ ok: false }),
    noteRoom: () => nfcChatImplRef.current?.noteRoom() ?? null,
    noteToSelf: (body) => nfcChatImplRef.current?.noteToSelf(body) ?? Promise.resolve({ ok: false }),
  }), []);
  const [multiSel, setMultiSel] = useState<Set<string>>(() => new Set());
  // 6.0: phone calls offered to this member (the audio bridge) and the ones taken here.
  const [phoneCalls, setPhoneCalls] = useState<PhoneCall[]>([]);
  const phoneClientsRef = useRef(new Map<string, PhoneBridgeClient>());
  const audioPeerCount = useMemo(
    () => peers.filter((peer) => peer.audio === "live" || peer.audio === "muted").length,
    [peers],
  );

  // 6.2: messages I hid stay out until their time is up — or while I ask to see them.
  const [showHidden, setShowHidden] = useState(false);
  const hiddenNow = useMemo(() => hiddenCount(messages, now), [messages, now]);
  useEffect(() => { if (hiddenNow === 0) setShowHidden(false); }, [hiddenNow]);
  const visibleMessages = useMemo(() => {
    const filtered = messages.filter((message) => !isDeleted(message) && (showHidden || !isHidden(message, now)) && (!message.expiresAt || message.expiresAt > now) && (!tagFilter || tagsIn(message.text || "").includes(tagFilter)));
    const sec = (room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY;
    if (sec.sort === "desc") return [...filtered].reverse();
    return filtered;
  }, [messages, now, prefs.roomSecurity, room, tagFilter, showHidden]);

  // A long conversation renders its newest MESSAGE_WINDOW messages; older
  // ones come in steps on request. (Off-screen bubbles also skip layout and
  // paint: content-visibility in index.css.)
  const [messageWindow, setMessageWindow] = useState(MESSAGE_WINDOW);
  useEffect(() => { setMessageWindow(MESSAGE_WINDOW); }, [room]);
  const newestFirst = ((room && prefs.roomSecurity[room]) || DEFAULT_ROOM_SECURITY).sort === "desc";
  const hiddenMessages = Math.max(0, visibleMessages.length - messageWindow);
  const renderedMessages = useMemo(
    () => (hiddenMessages === 0 ? visibleMessages : newestFirst ? visibleMessages.slice(0, messageWindow) : visibleMessages.slice(-messageWindow)),
    [visibleMessages, hiddenMessages, newestFirst, messageWindow],
  );

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
  // The template shown: the user's, unless the operator locked one, left it
  // out of the allowed list, or the user never picked any.
  const appearancePolicy = clientConfig.appearance;
  const { theme: effectiveTheme, tone: effectiveTone, icons: effectiveIcons } = effectiveAppearance(prefs, appearancePolicy);
  useEffect(() => {
    applyTheme(effectiveTheme, prefs.accent, prefs.layout, { tone: effectiveTone, icons: effectiveIcons });
  }, [effectiveTheme, prefs.accent, prefs.layout, effectiveTone, effectiveIcons]);

  // ---------------------------------------------------- saved connections
  useEffect(() => {
    let live = true;
    // Same config again (the usual case) keeps the old object: no re-render.
    const load = () => {
      void fetchClientConfig().then((cfg) => {
        if (live) setClientConfig((prev) => (JSON.stringify(prev) === JSON.stringify(cfg) ? prev : cfg));
      });
      void fetchMenuConfig().then((cfg) => {
        if (live) setMenuConfig((prev) => (JSON.stringify(prev) === JSON.stringify(cfg) ? prev : cfg));
      });
    };
    load();
    const id = window.setInterval(load, 5 * 60_000);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  useEffect(() => connectionsRef.current!.subscribe(setCxState), []);
  useEffect(() => { connectionsRef.current!.setPolicy(clientConfig.connections); }, [clientConfig.connections]);
  // Signed in: open the saved connections from the vault; signed out: forget them.
  useEffect(() => {
    const store = connectionsRef.current!;
    if (!account) {
      if (connectionsReadyRef.current) { void store.flush(); store.reset(); }
      connectionsReadyRef.current = false;
      setCxReady(false);
      autoConnectDoneRef.current = false;
      return;
    }
    if (!clientConfig.connections.enabled || connectionsReadyRef.current) return;
    let live = true;
    void loadConnectionsVault<unknown>().then((raw) => {
      if (!live) return;
      store.load(raw ?? {});
      connectionsReadyRef.current = true;
      setCxReady(true);
      // A session restored after a reload came from this saved connection.
      const pending = pendingProfileIdRef.current;
      pendingProfileIdRef.current = null;
      const bound = pending && !activeProfileRef.current ? findProfile(store.get(), pending) : null;
      if (bound) { activeProfileRef.current = bound; setActiveProfileId(bound.id); }
    }).catch(() => { /* not readable (wrong key, offline): stay read-only, never overwrite */ });
    return () => { live = false; };
  }, [account?.id, clientConfig.connections.enabled]);
  // 4.0: modules the operator switched off, or keeps from this user's groups.
  const myGroups = useMemo(() => (account ? account.groups ?? ["user"] : ["guest"]), [account]);
  // 4.13: the operator may design a layout of its own for some groups or GUI templates.
  const layoutCtx = useMemo<LayoutContext>(() => ({ groups: myGroups, theme: effectiveTheme }), [myGroups, effectiveTheme]);
  const moduleOn = useCallback((id: string) => moduleAllowed(clientConfig.modules, id, myGroups), [clientConfig.modules, myGroups]);
  const panelVisible = useCallback((panel: PanelKey) => { const m = moduleOfPanel(String(panel)); return !m || moduleOn(m); }, [moduleOn]);
  // 6.7: the voice changer may be on (the operator's module). Switched on while a
  // call runs: its microphone goes through it from now on (the senders get the new track).
  useEffect(() => { setVoiceFxAllowed(moduleOn("voiceChanger")); }, [moduleOn]);
  useEffect(() => onVoiceFxChange(() => {
    const raw = localAudioStreamRef.current;
    if (!raw || isProcessed(raw) || !voiceFxActive()) return;
    void processStream(raw).then((next) => {
      const track = next.getAudioTracks()[0];
      if (next === raw || !track || localAudioStreamRef.current !== raw) return;
      track.enabled = raw.getAudioTracks()[0]?.enabled ?? true; // muted stays muted
      peersRef.current.forEach((peer) => peer.outgoingAudioSenders.forEach((sender) => { void sender.replaceTrack(track).catch(() => undefined); }));
      localAudioStreamRef.current = next;
      if (localVideoStreamRef.current === raw) localVideoStreamRef.current = next;
    });
  }), []);
  const fnHost = useMemo<FnHost>(() => ({
    lang,
    event: (meta, ev) => fnEventRef.current(meta, ev),
    report: (meta, ev) => { void fnReportRef.current(meta, ev); },
    flash: (text, level) => { if (prefsRef.current.flash.enabled) flashRef.current.push({ text, kind: level }); },
    // m5.out.window / m5.browser.open: a panel of the app, when this viewer has it.
    openWindow: (id) => { if (!(FN_PANELS as readonly string[]).includes(id) || !panelVisible(id as PanelKey)) return false; setActivePanel(id as PanelKey); return true; },
    tone: () => (document.documentElement.getAttribute("data-tone") === "dark" ? "dark" : "light"),
  }), [lang, panelVisible]);
  const connectionsOn = clientConfig.connections.enabled && moduleOn("connections");
  // A panel of a module that is not (or no longer) available closes; Edit Mode switches off.
  useEffect(() => { if (activePanel && !panelVisible(activePanel)) setActivePanel(null); }, [activePanel, panelVisible]);
  useEffect(() => { if (prefs.editMode && !moduleOn("editMode")) setPrefs({ editMode: false }); }, [prefs.editMode, moduleOn]); // eslint-disable-line react-hooks/exhaustive-deps
  // 4.0.5: what every layout of the Layout builder is drawn with.
  const layoutEnvBase = useMemo(() => ({
    lang,
    translate: (key: string) => t(lang, key),
    blocks: layoutBlocksOf(layout),
    formats: { links: (text: string) => linkify(text) },
  }), [lang, layout]);

  // 4.0: the menu's live values ({$session.username}, {$room.peers}… in its
  // labels and HTML blocks), its rules (module, when) and its functions.
  const menuLive = useMemo(() => JSON.stringify(menuConfig).includes("{"), [menuConfig]);
  const [menuClock, setMenuClock] = useState(() => Date.now());
  useEffect(() => {
    if (!menuLive) return;
    const id = window.setInterval(() => setMenuClock(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [menuLive]);
  /** When this room session began ($session.since); a reconnect keeps it. */
  const [joinedSince, setJoinedSince] = useState<number | null>(null);
  useEffect(() => {
    if (status === "joined") setJoinedSince((prev) => prev ?? Date.now());
    else if (desired !== "connected") setJoinedSince(null);
  }, [status, desired]);
  const menuVars = useMemo<TemplateVars>(() => {
    const time = Math.max(menuClock, now);
    const host = (url: string) => { try { return url ? new URL(url).host : location.host; } catch { return location.host; } };
    const active = activeProfileId ? cxState.profiles.find((p) => p.id === activeProfileId) : undefined;
    const fallback = cxState.settings.defaultId ? cxState.profiles.find((p) => p.id === cxState.settings.defaultId) : undefined;
    const username = account ? account.username ?? account.userName ?? "" : "";
    return {
      app: { name: "M5cet", version: APP_VERSION, build: APP_BUILD, lang, online: typeof navigator === "undefined" || navigator.onLine },
      global: { server: location.host, time },
      now: time,
      user: { signedIn: Boolean(account), username, nickname: name, avatar: prefs.avatar || (Array.from(name.trim())[0] ?? "").toUpperCase(), groups: myGroups, keyVerified: Boolean(account?.keyVerified) },
      session: {
        username: sessionUser, current_username: sessionUser, nickname: name, connected: desired === "connected", status, room,
        mode: prefs.mode, server: host(activeServerRef.current), peers: peers.length, rtt: connStatus?.rttMs ?? null, since: joinedSince,
      },
      room: { name: room, peers: peers.length, people: peers.map((p) => p.name) },
      connection: { active: active?.label ?? "", default: fallback?.label ?? "", saved: cxState.profiles.length },
      settings: {
        theme: effectiveTheme, tone: effectiveTone, accent: prefs.accent, lang,
        notifications: prefs.notificationsEnabled, editMode: prefs.editMode, retention: prefs.chatRetention,
      },
    };
  }, [menuClock, now, activeProfileId, cxState, account, lang, name, prefs.avatar, prefs.mode, prefs.accent, prefs.notificationsEnabled, prefs.editMode, prefs.chatRetention, myGroups, sessionUser, desired, status, room, peers, connStatus, joinedSince, effectiveTheme, effectiveTone]);
  const menuNodeVisible = useCallback((node: MenuNode) => {
    const module = nodeModule(node, moduleOfPanel);
    if (module && !moduleOn(module)) return false;
    switch (node.when) {
      case "signedIn": return Boolean(account);
      case "signedOut": return !account;
      case "connected": return desired === "connected";
      case "disconnected": return desired !== "connected";
      case "phone": return typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches === true;
      case "desktop": return !(typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches === true);
      default: return true;
    }
  }, [moduleOn, account, desired]);
  const shownTone = (): "light" | "dark" => (document.documentElement.getAttribute("data-tone") === "dark" ? "dark" : "light");
  function runMenuAction(action: MenuAction) {
    if (action.type === "url") {
      // sanitizeMenuConfig keeps only https:// and this site's paths.
      if (!/^https:\/\/\S+$/i.test(action.href) && !(isSitePath(action.href) && !/\s/.test(action.href))) return; // 6.7 (N22)
      if (action.newTab) window.open(action.href, "_blank", "noopener,noreferrer");
      else window.location.assign(action.href);
      return;
    }
    if (action.type !== "fn") return;
    switch (action.fn) {
      case "openRoom": setActivePanel("join"); break;
      case "signIn": setActivePanel("connection"); break;
      case "connectDefault": {
        const target = startupProfile(cxState);
        if (target && account) void connectProfile(target.id);
        else setActivePanel(account ? "join" : "connection");
        break;
      }
      case "disconnect": if (desired === "connected") userDisconnect(); break;
      case "toggleEditMode": if (moduleOn("editMode")) setPrefs({ editMode: !prefs.editMode }); break;
      case "toggleTone": if (moduleOn("appearance")) setPrefs({ theme: effectiveTheme, themeSet: true, themeTone: shownTone() === "dark" ? "light" : "dark" }); break;
      case "setTheme": if (moduleOn("appearance") && action.param && isThemeId(action.param)) setPrefs({ theme: action.param, themeSet: true }); break;
      case "setLang": if (action.param === "cs" || action.param === "en" || action.param === "de") setPrefs({ lang: action.param }); break;
      case "toggleNotifications":
        if (!moduleOn("notifications")) break;
        if (prefs.notificationsEnabled) disableNotifications(); else void enableNotifications();
        break;
      case "clearQuit": void clearAndQuit(); break;
      case "register": if (!account) setShowRegistration(true); break;
      default: break;
    }
  }
  // Server-enhanced picked — or a saved connection in use (its own mode may be light).
  const cxServerSide = prefs.mode === "server" || activeProfileId !== null;
  const cxEligible = Boolean(account) && cxReady && cxServerSide && connectionsOn;
  // The Room window: its tab follows the session — a saved connection lives on
  // Server-enhanced, whatever its own mode — until the user picks one. While a
  // connection is up (or on its way) nothing in it can be switched.
  const roomLocked = desired === "connected";
  // 4.0: while connected, leaving the page (back, reload, another address)
  // asks to disconnect from the room first.
  const [navBlocked, setNavBlocked] = useState<BlockedBy | null>(null);
  useEffect(() => {
    if (desired !== "connected") { setNavBlocked(null); return; }
    return installNavigationGuard((by) => setNavBlocked(by));
  }, [desired]);
  // 4.0: Server-enhanced needs a passkey sign-in. Signed out (once the
  // startup check is done), the mode falls back to Light · P2P; the retention
  // that keeps chat on the server goes with it.
  useEffect(() => {
    if (!accountResolved || account || desired === "connected") return;
    if (prefs.mode === "server") setPrefs({ mode: "light" });
    if (prefs.chatRetention === "server") { setPrefs({ chatRetention: "session" }); retentionRef.current = "session"; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountResolved, account, desired, prefs.mode, prefs.chatRetention]);
  const roomTab: RoomTab = roomTabPick ?? (activeProfileId ? "server" : prefs.mode);
  useEffect(() => { if (activePanel !== "join") setRoomTabPick(null); }, [activePanel]);
  // Signed in: the default connection (or the last one) connects by itself —
  // once per page, and only when nothing else is connected or on its way.
  useEffect(() => {
    if (!cxEligible || autoConnectDoneRef.current) return;
    autoConnectDoneRef.current = true;
    const st = connectionsRef.current!.get();
    if (!st.settings.autoConnect || desired === "connected" || intentRef.current) return;
    const target = startupProfile(st);
    if (!target) return;
    setNotice(tf(lang, "cx.autoConnecting", { name: target.label }));
    void connectProfile(target.id, { auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cxEligible]);

  // Unsaved counters go to the vault when the page is put away.
  useEffect(() => {
    const flush = () => { void connectionsRef.current?.flush(); };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", flush); };
  }, []);
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
  // A new deploy on the server: the version check (IntegrityCheck) looks at
  // everything this browser runs and offers the fix.
  useEffect(() => watchForNewVersion(() => { void integrityRef.current?.check(true); }), []);
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
  // 6.7 (S20): the newest messages within MESSAGE_CAP stay; the files of those that fall off are released.
  useEffect(() => {
    const { dropped } = capMessages(messages);
    if (!dropped.length) return;
    for (const m of dropped) if (m.attachment?.dataUrl) releaseBlobUrl(m.attachment.dataUrl);
    const gone = new Set(dropped.map((m) => m.id));
    setMessages((cur) => cur.filter((m) => !gone.has(m.id)));
  }, [messages]);
  useEffect(() => { retentionRef.current = prefs.chatRetention; }, [prefs.chatRetention]);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  /** Away members appear in the recipients list under this id. */
  const awayKey = (accountId: string) => `away:${accountId}`;

  /** Merge restored / relayed messages into the conversation, by id and time.
   *  6.2: a message deleted here stays deleted, whichever copy comes back (message-hide.ts). */
  function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
    return mergeWithDeletions(current, incoming);
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
        const blind = serverRoomId(keyRef.current); // 6.7 (S21): never the plain name
        return payload && blind ? { id: m.id, room: blind, createdAt: m.createdAt, senderId: "", senderName: "", mine: m.mine, expiresAt: m.expiresAt ?? 0, payload } : null;
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
      // Opened at a sign-in: the hides "until the next sign-in" end (6.2).
      const restored = chat ? sanitizeRestored(chat.messages, myIdRef.current, { signIn: true }) : [];
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
      // 6.7: only when notifications are on in this browser (it used to link any subscription it found).
      if (!prefsRef.current.notificationsEnabled) return;
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
    if (socket?.readyState !== WebSocket.OPEN || !roomRef.current || !onHomeServer()) return;
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

  /** Collects the steps of one sign-in or registration for the Connection window. */
  function startSignInProgress(kind: SignInProgress["kind"]) {
    let steps: SignInProgress["steps"] = [];
    setSignin({ kind, steps, error: null });
    const report = (id: string, state: StepState, detail?: string) => {
      const next = { id, state, ...(detail ? { detail } : {}) };
      steps = steps.some((x) => x.id === id) ? steps.map((x) => (x.id === id ? next : x)) : [...steps, next];
      setSignin((cur) => ({ kind, steps, error: cur?.error ?? null, done: cur?.done }));
    };
    const fail = (err: unknown) => {
      const e = err instanceof AccountError ? err : new AccountError("server", (err as Error)?.message ?? String(err));
      setSignin((cur) => ({ kind, steps: cur?.steps ?? steps, error: { code: e.code, message: e.message, ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}) } }));
      setAccMsg("");
    };
    const done = (text: string) => setSignin((cur) => ({ kind, steps: cur?.steps ?? steps, error: null, done: text }));
    return { report, fail, done };
  }

  /**
   * After the passkey, key, database and vault checks (account.ts): is the
   * server there and quick, does this app match what it deploys, load the
   * user's settings and data, link notifications, and say what connects by
   * itself. Every result is reported to the Connection window and the whole
   * run goes to the server's log.
   */
  async function afterSignIn(acc: AccountSummary, report: (id: string, state: StepState, detail?: string) => void, kind: SignInProgress["kind"], started: number) {
    setAccount(acc);
    // 6.2: a sign-in ends the hides "until the next sign-in".
    setMessages((cur) => endHides(cur, Date.now(), true));
    // Server-enhanced is now available; a live P2P session keeps its mode.
    setPrefs(desiredRef.current === "connected" ? { chatRetention: "server" } : { chatRetention: "server", mode: "server" });
    retentionRef.current = "server";

    report("server", "run");
    let rtt = -1;
    let versionOk = true;
    try {
      const t0 = performance.now();
      const res = await fetch("/api/health", { cache: "no-store" });
      const health = await res.json() as { ok?: boolean; version?: string; build?: string };
      rtt = Math.round(performance.now() - t0);
      report("server", res.ok && health.ok !== false ? (rtt < 800 ? "ok" : "warn") : "fail", `${rtt} ms`);
      versionOk = APP_BUILD === "dev" || !health.build || health.build === APP_BUILD;
      report("version", versionOk ? "ok" : "warn", `${APP_VERSION} · ${APP_BUILD}${versionOk ? "" : ` ≠ ${health.version ?? "?"} · ${health.build}`}`);
      if (!versionOk) {
        void logAccountEvent("version-mismatch", { local: APP_BUILD, server: String(health.build) });
        void integrityRef.current?.check(true);
      }
    } catch (err) {
      report("server", "fail", (err as Error).message);
    }

    report("settings", "run");
    let messages = 0;
    try {
      if (kind === "register") {
        await saveVault({ profile: profileFromPrefs(prefsRef.current), chat: chatVaultPayload() });
        setAccount(currentAccount());
      } else {
        messages = await applyVault(true);
      }
      report("settings", "ok", kind === "register" ? undefined : tf(lang, "acc.loaded", { n: messages }));
    } catch (err) {
      report("settings", "fail", (err as Error).message);
    }

    report("push", "run");
    await linkPushForAccount();
    report("push", "ok");
    announceAccountToServer();
    // 6.12 (§ 7.5): the device's bundle and its new v2 certificate go to the key directory.
    void syncKeyDirectory().catch(() => undefined);

    // What connects by itself: the saved connections open once the vault is read.
    report("connect", "run");
    for (let i = 0; i < 50 && clientConfig.connections.enabled && !connectionsReadyRef.current; i++) await new Promise((r) => setTimeout(r, 100));
    const st = connectionsRef.current!.get();
    const target = st.settings.autoConnect && desiredRef.current !== "connected" ? startupProfile(st) : null;
    report("connect", "ok", target ? target.label : t(lang, "id.step.connect.none"));

    void logAccountEvent("signin-complete", { kind, ms: Math.round(performance.now() - started), rtt, versionOk, messages });
  }

  function signInToAccount() {
    return runAccountTask(async () => {
      const started = performance.now();
      const progress = startSignInProgress("signin");
      let acc: AccountSummary;
      try {
        acc = await signInWithPasskey(progress.report);
      } catch (err) {
        progress.fail(err);
        return;
      }
      const name = acc.username ?? acc.id;
      systemMessage(tf(lang, "acc.signedInAs", { name }));
      await afterSignIn(acc, progress.report, "signin", started);
      progress.done(t(lang, "id.done.signin"));
    });
  }

  function createAccount() {
    return runAccountTask(async () => {
      const started = performance.now();
      const progress = startSignInProgress("register");
      let acc: AccountSummary;
      try {
        acc = await registerAccount(progress.report);
      } catch (err) {
        progress.fail(err);
        return;
      }
      const username = acc.username ?? acc.id;
      systemMessage(tf(lang, "id.done.register", { username }));
      await afterSignIn(acc, progress.report, "register", started);
      progress.done(tf(lang, "id.done.register", { username }));
    });
  }

  /**
   * 6.4: registration with the form. The server checked the fields; /start
   * issues the username and the passkey options, registerAccount runs the
   * same passkey / key / database steps as "Create an account", the profile
   * goes into its own sealed vault slot, and afterSignIn straightens and
   * syncs this device's data into the new account. Field errors go back to
   * the dialog instead of the Connection window.
   */
  async function registerWithForm(form: RegistrationInput): Promise<RegisterResult> {
    const { start } = await import("./lib/registration/client");
    const started = performance.now();
    setAccBusy(true);
    setAccMsg("");
    try {
      const issued = await start(form);
      if (!issued.ok) {
        return { ok: false, fields: issued.errors, message: issued.status === 429 ? t(lang, "reg.err.rate") : Object.keys(issued.errors).length ? "" : tf(lang, "reg.err.server", { message: issued.message }) };
      }
      const progress = startSignInProgress("register");
      let acc: AccountSummary;
      try {
        acc = await registerAccount(progress.report, issued.preset);
      } catch (err) {
        progress.fail(err);
        const e = err instanceof AccountError ? err : null;
        if (e?.code === "cancelled") return { ok: false };
        return { ok: false, fields: e?.fields, message: e?.code === "taken" ? "" : tf(lang, "reg.err.server", { message: (err as Error).message }) };
      }
      const username = acc.username ?? acc.id;
      // The account exists either way; a failed save leaves the profile to the
      // next attempt from the account window rather than undoing the registration.
      await saveRegistration({ ...issued.normalized, registeredAt: Date.now() }).catch((err) => {
        setAccMsg(tf(lang, "reg.saveFailed", { message: (err as Error).message }));
      });
      systemMessage(tf(lang, "reg.done", { username }));
      await afterSignIn(acc, progress.report, "register", started);
      progress.done(tf(lang, "reg.done", { username }));
      return { ok: true };
    } finally {
      setAccBusy(false);
    }
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
      const started = performance.now();
      const progress = startSignInProgress("signin");
      let acc: AccountSummary;
      try {
        progress.report("passkey", "run");
        acc = await recoverWithCode(code, navigator.platform || "recovered");
        progress.report("passkey", "ok", acc.username ?? acc.id);
        progress.report("key", "ok");
      } catch (err) {
        progress.report("passkey", "fail", (err as Error).message);
        progress.fail(err);
        return;
      }
      systemMessage(t(lang, "acc.recover.done"));
      await afterSignIn(acc, progress.report, "signin", started);
      progress.done(t(lang, "acc.recover.done"));
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

  /**
   * Hands a message to the server for away members. 6.12 (docs/protocol-v4.md
   * § 7.4, F-09): sealed per member to the mailboxes of their devices (known
   * from their hellos or the key directory) as `per[ref]`; only members
   * without any known bundle get the protocol-3 room envelope — `roomKeyFor`
   * names them (the info view says so).
   */
  async function relayToAway(payload: { id: string }, roomEnvelope: () => Promise<DataChannelEnvelope | null>, targets: AwayPeer[], text?: string): Promise<{ count: number; roomKeyFor: string[]; mailbox: boolean }> {
    const socket = socketRef.current;
    const keys = keyRef.current;
    const none = { count: 0, roomKeyFor: [], mailbox: false };
    if (!socket || socket.readyState !== WebSocket.OPEN || targets.length === 0 || !keys) return none;
    const refs = targets.map((a) => a.accountId);
    let per: Record<string, unknown> = {};
    let without = refs;
    const identity = identityRef.current;
    const mailbox = await ensureMailbox();
    if (mailbox && identity && keys.version === 3) {
      const sealed = await sealForAway({
        roomId: keys.roomId, id: payload.id, payload, refs, mailbox, senderPk: identity.publicKey, sacc: helloAccountOf(identity.attestation),
        known: (ref) => trustRef.current.devicesOfRef(keys.roomId, ref),
        directory: onHomeServer() ? (ref) => hubAsk<DirectoryDevice[]>("key-bundles", ref).then((d) => (Array.isArray(d) ? d : [])) : undefined,
        pinnedAccount: (ref) => trustRef.current.devicesOfRef(keys.roomId, ref).find((d) => d.apk)?.apk ?? null,
      }).catch(() => ({ per: {}, withoutBundle: refs, devices: 0 }));
      per = sealed.per;
      without = sealed.withoutBundle;
    }
    const envelope = without.length > 0 ? await roomEnvelope() : null;
    const to = envelope ? refs : refs.filter((r) => per[r]);
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || to.length === 0) return none;
    // 6.7: "@name" makes their notification a mention (only that reaches the server).
    const mention = mentionedAway(text, targets);
    socket.send(JSON.stringify({ type: "relay", messageId: payload.id, to, ...(envelope ? { envelope } : {}), ...(Object.keys(per).length ? { per } : {}), ...(mention.length ? { mention } : {}) }));
    const names = (list: string[]) => targets.filter((a) => list.includes(a.accountId)).map((a) => a.name);
    return { count: to.length, roomKeyFor: envelope ? names(without) : [], mailbox: Object.keys(per).length > 0 };
  }

  /** 6.12: asks the hub about a member's reference (`key-bundles`, `kt-lookup`); null after 4 s. */
  function hubAsk<T>(type: "key-bundles" | "kt-lookup", ref: string): Promise<T | null> {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !ref) return Promise.resolve(null);
    if (type === "key-bundles") {
      const cached = bundleCacheRef.current.get(ref);
      if (cached && Date.now() - cached.at < 5 * 60_000) return Promise.resolve(cached.devices as T);
    }
    const slot = `${type}|${ref}`;
    return new Promise<T | null>((resolve) => {
      const waiting = hubAsksRef.current.get(slot);
      let done = false;
      const finish = (answer: unknown) => { if (done) return; done = true; resolve((answer ?? null) as T | null); };
      if (waiting) { waiting.push(finish); } else {
        hubAsksRef.current.set(slot, [finish]);
        try { socket.send(JSON.stringify({ type, ref })); } catch { /* closing */ }
      }
      window.setTimeout(() => {
        const list = hubAsksRef.current.get(slot);
        if (list) { const rest = list.filter((f) => f !== finish); if (rest.length) hubAsksRef.current.set(slot, rest); else hubAsksRef.current.delete(slot); }
        finish(null);
      }, 4000);
    });
  }

  function hubAnswer(type: "key-bundles" | "kt-lookup", ref: string, answer: unknown) {
    if (type === "key-bundles" && Array.isArray(answer)) bundleCacheRef.current.set(ref, { at: Date.now(), devices: answer as DirectoryDevice[] });
    const slot = `${type}|${ref}`;
    const waiting = hubAsksRef.current.get(slot) ?? [];
    hubAsksRef.current.delete(slot);
    for (const finish of waiting) finish(answer);
  }

  /** 6.12 (§ 7.1): this device's mailbox — bundles renewed as due, private keys encrypted at rest. */
  async function ensureMailbox(): Promise<Mailbox | null> {
    if (mailboxRef.current) return mailboxRef.current;
    const identity = identityRef.current ?? (identityRef.current = await loadIdentity().catch(() => null));
    if (!identity) return null;
    mailboxRef.current = deviceMailbox(identity);
    return mailboxRef.current;
  }

  /** 6.12 (§ 7.5): signed in on this server — the current bundle and the v2 device certificate go to the key directory. */
  async function syncKeyDirectory() {
    const token = accountToken();
    const identity = identityRef.current;
    const att = identity?.attestation;
    if (!token || !identity || !att?.v2 || !onHomeServer()) return;
    const mailbox = await ensureMailbox();
    const current = await mailbox?.current().catch(() => null);
    const slot = current ? `${current.bundle.id}|${att.v2.exp}` : "";
    if (!current || uploadedBundleRef.current === slot) return;
    const result = await uploadBundle(token, identity.publicKey, att, current.bundle);
    if (result.ok || result.code === "stale-bundle") uploadedBundleRef.current = slot;
    else void sendServerLog("warn", "keys.upload-failed", { code: result.code });
  }

  /** 6.12 (§ 14): this server's key log — its key pinned, its newest head checked on connect and every 10 minutes. */
  function startKeyTransparency() {
    if (ktRef.current) { void ktRef.current.refresh(); return; }
    const kt = new KtClient(window.location.origin, new LocalKtStore(), fetchKtJson());
    kt.subscribe((s) => {
      setKtStatus(s);
      if (s.state === "alert" && s.alert) warnOnce(`kt:${s.alert.kind}:${s.alert.at}`, tf(lang, `p4.kt.alert.${s.alert.kind}`, { detail: s.alert.detail }), "error");
    });
    ktRef.current = kt;
    kt.start();
  }

  /** 6.12 (§ 11): the persistent replay window of this device. */
  function replayGuard(): ReplayGuard {
    if (!replayGuardRef.current) {
      const shared = deviceReplay();
      replayStoreRef.current = shared.store;
      replayGuardRef.current = shared.guard;
    }
    return replayGuardRef.current;
  }

  /** A message id seen for the first time, fresh (§ 11): live, relayed and queued messages alike. */
  async function freshMessage(id: string, createdAt: unknown): Promise<boolean> {
    const roomId = keyRef.current?.roomId;
    if (!roomId || !replayRef.current.accept(id)) return false;
    const verdict = await replayGuard().check(roomId, id, createdAt).catch(() => "ok" as const);
    return verdict === "ok";
  }

  /** A status the server reports for a message we sent to an away member. */
  function applyRelayStatus(frame: { messageId: string; recipient: { name: string } & AccountRefFields; state: MsgState | "rejected" | "duplicate"; at: number; reason?: string }) {
    if (frame.state === "duplicate") return; // the server already had it
    if (frame.state === "rejected") {
      systemMessage(tf(lang, "app.relayRejected", { name: frame.recipient.name || "?", reason: frame.reason ?? t(lang, "app.relayRejected.default") }));
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

  /** What the sender's key says, and how it compares with the key we pinned
   *  for that name in this room — or for their account, everywhere (trust on
   *  first use). 6.12 (docs/protocol-v4.md § 12): a first-seen key is "new —
   *  not verified", never "verified" by itself; "changed" is held. */
  async function identityFor(signer: Signer | null, senderName: string, opts: { protocol: 3 | 4; certVersion?: 1 | 2 } = { protocol: 3 }): Promise<MessageIdentity> {
    const identity = await evaluateIdentity({ signer, protocol: opts.protocol, certVersion: opts.certVersion, room: roomRef.current, name: senderName }, pinsRef.current, trustRef.current);
    if (identity.state === "invalid") warnOnce(`invalid:${identity.kid}`, t(lang, "sec.identity.invalidFlash").replace("{name}", senderName), "error");
    if (identity.state === "changed") warnOnce(`changed:${identity.kid}`, t(lang, identity.revoked ? "p4.kt.revoked" : "sec.identity.changedFlash").replace("{name}", senderName), "error");
    return identity;
  }

  /** A security notice, once per subject per session. */
  function warnOnce(subject: string, text: string, kind: FlashMessage["kind"] = "warning") {
    if (warnedPeersRef.current.has(subject)) return;
    warnedPeersRef.current.add(subject);
    if (kind === "error") cx("error", subject.split(":")[0]);
    systemMessage(text, { kind });
  }

  /** Counts / logs an event for the saved connection in use (connections.ts). */
  function cx(event: ConnectionEvent, detail?: string, extra?: RecordExtra) {
    connectionsRef.current?.record(activeProfileRef.current?.id, event, detail, extra);
  }

  /** True while this tab talks to its own server (not a saved connection's other one). */
  function onHomeServer(): boolean {
    return !activeServerRef.current;
  }

  /** A tab in the Room window picks the connection type (= the mode). */
  function pickRoomTab(tab: RoomTab) {
    if (roomLocked) return;
    setRoomTabPick(tab);
    // Signed out, the Server-enhanced tab only shows where to sign in.
    if (prefs.mode !== tab && (tab === "light" || account)) setPrefs({ mode: tab });
  }

  /* ------------------------------------------ 6.0: several rooms at once */

  /** The room on screen as the hub would keep it (null when there is none). */
  function currentHubTarget(): HubTarget | null {
    const room = roomRef.current;
    const pass = passphraseRef.current;
    if (!room || !pass || !intentRef.current) return null;
    const server = activeServerRef.current || "";
    const profile = activeProfileRef.current;
    return { key: roomKeyOf(room, server), room, label: profile?.label ?? room, name: nameRef.current || name, passphrase: pass, server, profileId: profile?.id };
  }

  /** The hub's key of a saved connection that runs in the background. */
  function hubKeyOfProfile(id: string): string | null {
    return hubRooms.find((r) => r.profileId === id)?.key ?? null;
  }

  /** Smart switching: the room chosen comes on screen with what it collected; the one there goes to the background. */
  async function switchRoom(key: string) {
    const current = currentHubTarget();
    if (current?.key === key) return;
    const taken = hub.take(key);
    if (!taken) return;
    const { target, messages: collected } = taken;
    if (collected.length) carryRef.current.set(target.room, collected);
    disconnect(false);
    if (current) hub.add(current);
    setNotice(tf(lang, "rooms.switched", { room: target.label }));
    const store = connectionsRef.current;
    if (target.profileId && store && findProfile(store.get(), target.profileId)) {
      await connectProfile(target.profileId, { auto: true });
      return;
    }
    activeProfileRef.current = null;
    setActiveProfileId(null);
    activeServerRef.current = target.server ?? "";
    setName(target.name);
    setRoomInput(target.room);
    setPassphrase(target.passphrase);
    await startSession(target.name, target.room, target.passphrase);
  }
  const switchRoomRef = useRef(switchRoom);
  switchRoomRef.current = switchRoom;

  // A message in a background room: a notification that brings the room on screen.
  // 6.7: by the operator's template and the user's choice (kinds, privacy, quiet hours).
  useEffect(() => hub.onMessage((e) => {
    if (!notificationsEnabledRef.current) return;
    const note = showLocalNotification({ kind: "message", room: e.label, sender: e.message.senderName, text: e.message.flags?.sealed ? "🔒" : e.message.text || "📎", tag: `m5cet-room-${e.key}` }, { lang: lang === "cs" || lang === "de" ? lang : "en" });
    if (note) note.onclick = () => { window.focus(); note.close(); void switchRoomRef.current(e.key); };
  }), [hub, lang]);
  // 6.7: local notifications follow the account's choice once signed in, this browser's otherwise.
  useEffect(() => {
    if (!account) { setCurrentNotifyPrefs(null); forgetWorkerRoomNames(); return; }
    void loadAccountNotify().catch(() => undefined);
  }, [account?.id]);
  // Unread elsewhere in the tab's title: "(3) M5cet".
  const unreadElsewhere = hubRooms.reduce((n, r) => n + r.unread, 0);
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = unreadElsewhere > 0 ? `(${unreadElsewhere}) ${base}` : base;
  }, [unreadElsewhere]);
  // Alt+← / Alt+→ move between the connected rooms.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const keys = [currentHubTarget()?.key, ...hub.list().map((r) => r.key)].filter((k): k is string => Boolean(k));
      if (keys.length < 2) return;
      e.preventDefault();
      void switchRoomRef.current(e.key === "ArrowRight" ? keys[1] : keys[keys.length - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub]);
  useEffect(() => () => hub.clear(), [hub]);

  /* ------------------------------------------ 6.0: the phone bridge */

  const setCall = (session: string, patch: Partial<PhoneCall> | ((c: PhoneCall) => Partial<PhoneCall>)) =>
    setPhoneCalls((cur) => cur.map((c) => (c.session === session ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c)));

  /** A "phone-bridge" frame — from the room on screen, or (6.9) from a room kept in the background. */
  function onPhoneFrame(f: Record<string, unknown>, socketUrl: string) {
    const session = String(f.session ?? "");
    setPhoneCalls((cur) => {
      const prev = cur.find((c) => c.session === session);
      const made = callFromFrame(f, prev);
      if (!made) return cur;
      // The media socket goes to the server whose signaling offered the call
      // (6.10 G-11: a re-offer keeps it too — withServer).
      const next = withServer(made, prev, socketUrl);
      return prev ? cur.map((c) => (c.session === next.session ? next : c)) : [...cur, next].slice(-3);
    });
    if (f.event === "incoming") {
      // 6.9: a call a TSA routed into the room (by a route code) is the room's, not "for you".
      const key = f.route === "room" ? "phone.incomingRoom" : "phone.incoming";
      const text = tf(lang, key, { from: String(f.from || t(lang, "phone.unknown")) });
      flashRef.current.push({ text, detail: String(f.label || f.number || ""), kind: "info" });
      if (notificationsEnabledRef.current && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification(text, { body: String(f.label || f.number || ""), tag: `m5cet-phone-${session}` }); } catch { /* not allowed here */ }
      }
    }
    if (f.event === "ended") { phoneClientsRef.current.get(session)?.close(); phoneClientsRef.current.delete(session); }
  }
  const onPhoneFrameRef = useRef(onPhoneFrame);
  onPhoneFrameRef.current = onPhoneFrame;
  // 6.9: a room kept in the background is offered a phone call too (a call routed into it).
  useEffect(() => hub.onPhone((e) => onPhoneFrameRef.current(e.frame, e.socketUrl)), [hub]);

  function phoneClient(session: string): PhoneBridgeClient | null {
    const existing = phoneClientsRef.current.get(session);
    if (existing) return existing;
    const call = phoneCalls.find((c) => c.session === session);
    const socketUrl = call?.socketUrl || socketRef.current?.url;
    if (!call || !socketUrl) return null;
    const client = new PhoneBridgeClient(bridgeUrl(socketUrl, call.token), {
      onTranscript: (text) => setCall(session, (c) => ({ transcripts: [...c.transcripts, { text, at: Date.now(), mine: false }].slice(-50) })),
      onEnded: (reason) => { setCall(session, { state: "ended", reason, level: 0 }); phoneClientsRef.current.delete(session); },
      onError: (message) => setNotice(message),
      // 6.9: a routed call — how many are in its audio, the level meter.
      onMembers: (members) => setCall(session, { members }),
      onLevel: (level) => setCall(session, { level }),
    });
    phoneClientsRef.current.set(session, client);
    return client;
  }

  async function takePhoneCall(session: string, how: "audio" | "text") {
    const client = phoneClient(session);
    if (!client) return;
    const call = phoneCalls.find((c) => c.session === session);
    setCall(session, { state: "connecting" });
    try {
      if (how === "audio") await client.takeAudio(); else await client.takeText();
      setCall(session, { state: how });
    } catch (err) {
      setNotice(tf(lang, "phone.failed", { reason: (err as Error).message }));
      // 6.9: a room's routed call has no private text fallback — the card offers Join again.
      if (call?.route === "room") { client.close(); phoneClientsRef.current.delete(session); setCall(session, { state: call.state === "text" ? "text" : "ringing" }); return; }
      // Audio refused (no microphone): text still works.
      if (how === "audio") { try { await client.takeText(); setCall(session, { state: "text" }); } catch { setCall(session, { state: "ringing" }); } }
      else setCall(session, { state: "ringing" });
    }
  }

  /** The room bar's chips: the room on screen first, then the background ones. Mid-switch the
   *  room leaving the screen is briefly in both places: it shows once (React needs unique keys). */
  function roomBarItems(): RoomBarItem[] {
    const onScreen: RoomBarItem[] = desired === "connected" && room
      ? [{ key: roomKeyOf(room, activeServerRef.current || ""), label: activeProfileRef.current?.label ?? room, users: status === "joined" ? openPeerCount + 1 : 0, unread: 0, active: true, status }]
      : [];
    const seen = new Set(onScreen.map((r) => r.key));
    return [
      ...onScreen,
      ...hubRooms.filter((r) => !seen.has(r.key)).map((r): RoomBarItem => ({ key: r.key, label: r.label, users: r.users, unread: r.unread, active: false, status: r.status })),
    ];
  }

  /** × on a room: a background room just goes; the room on screen gives its place to the most recently active one. */
  async function closeRoom(key: string) {
    if (currentHubTarget()?.key !== key) { hub.remove(key); return; }
    userDisconnect();
    const next = hub.list()[0];
    if (next) {
      setNotice(tf(lang, "rooms.promoted", { room: next.label }));
      await switchRoom(next.key);
    }
  }

  /** + in the room bar: one more room, in the background (or on screen when none is). */
  async function addRoom(roomName: string, pass: string) {
    const room = normalizeRoom(roomName);
    const server = activeServerRef.current || "";
    const who = nameRef.current || name || prefs.name;
    if (!currentHubTarget()) {
      setName(who);
      setRoomInput(room);
      setPassphrase(pass);
      await startSession(who, room, pass);
      return;
    }
    const target: HubTarget = { key: roomKeyOf(room, server), room, label: roomName.trim() || room, name: who, passphrase: pass, server };
    if (target.key === currentHubTarget()?.key) return;
    if (!hub.add(target)) { setNotice(t(lang, "rooms.bar.full")); return; }
    setNotice(tf(lang, "rooms.background", { room: target.label }));
  }

  /** The Room window's checked connections: the first on screen (unless one is), the others in the background. */
  async function connectSelected() {
    const store = connectionsRef.current;
    if (!store) return;
    const profiles = [...multiSel].map((id) => findProfile(store.get(), id)).filter((p): p is ConnectionProfile => Boolean(p));
    setMultiSel(new Set());
    if (!profiles.length) return;
    const onScreen = currentHubTarget();
    const [first, ...rest] = onScreen ? [null, ...profiles] : profiles;
    for (const p of rest) {
      if (!p || p.id === activeProfileRef.current?.id) continue;
      if (!serverAllowed(clientConfig.connections, p.server)) continue;
      hub.add({ key: roomKeyOf(p.room, p.server ?? ""), room: p.room, label: p.label, name: p.userName || nameRef.current || name, passphrase: p.passphrase, server: p.server ?? "", profileId: p.id });
    }
    if (first) await connectProfile(first.id);
    else setActivePanel(null);
  }

  /** Connect in the Room window: the saved connection picked, or the room typed in. */
  async function connectRoomTarget(target: RoomTarget) {
    if (target.kind === "profile") { await connectProfile(target.id); return; }
    // Typed in: the tab says which mode (a saved connection may have left another).
    if (roomTab === "server" && !account) { setActivePanel("connection"); return; }
    if (prefs.mode !== roomTab) {
      setPrefs({ mode: roomTab });
      prefsRef.current = { ...prefsRef.current, mode: roomTab };
    }
    await connect();
  }

  /** Joins a saved connection: its room, key and name, and how the session behaves. */
  async function connectProfile(id: string, opts: { auto?: boolean } = {}) {
    const store = connectionsRef.current!;
    const profile = findProfile(store.get(), id);
    if (!profile) return;
    if (!serverAllowed(clientConfig.connections, profile.server)) { setNotice(t(lang, "cx.err.server")); return; }
    const current = activeProfileRef.current;
    const busy = desired === "connected" && roomRef.current;
    if (!opts.auto && busy && current?.id !== profile.id && store.get().settings.confirmSwitch) {
      const from = current?.label ?? roomRef.current;
      if (!window.confirm(tf(lang, "cx.switch.confirm", { from, to: profile.label }))) return;
    }
    if (busy) cx("disconnected");
    const userName = profile.userName || nameRef.current || name;
    retentionRef.current = profile.retention;
    setPrefs({
      mode: profile.mode,
      chatRetention: profile.retention,
      keepaliveStrategy: profile.keepalive,
      roomTtl: { ...prefs.roomTtl, [profile.room]: { defaultMinutes: profile.ttlMinutes, absoluteMinutes: prefs.roomTtl[profile.room]?.absoluteMinutes ?? 0 } },
      ...(profile.userName ? { name: profile.userName } : {}),
    });
    activeProfileRef.current = profile;
    activeServerRef.current = profile.server;
    setActiveProfileId(profile.id);
    setName(userName);
    setRoomInput(profile.room);
    setPassphrase(profile.passphrase);
    store.record(profile.id, "connect", profile.server ? new URL(profile.server).host : undefined);
    disconnect(false);
    closeJoinPanelRef.current = true;
    setActivePanel(null);
    setManageFromRoom(null);
    await startSession(userName, profile.room, profile.passphrase);
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
      loc: p.loc,
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
      let opened: { payload: unknown; version: 1 | 2 | 3 | 4; signer: Signer | null; certVersion?: 1 | 2; sealedWith: SealedWith };
      const env = item.envelope as Record<string, unknown>;
      if (isMailboxItem(env) || isMailboxSet(env)) {
        // 6.12 (§ 7.3): sealed for one of this device's mailbox bundles.
        const mailbox = await ensureMailbox();
        let got: Awaited<ReturnType<Mailbox["open"]>> = null;
        try { got = mailbox ? await mailbox.open(env, keys.roomId) : null; } catch { handled.push(item.id); continue; } // broken: drop it
        if (!got) continue; // for another device of the account (or keys we no longer have)
        const account = await verifyAccount(got.sacc, got.spk);
        trustRef.current.rememberDevice(got.spk, { mb: got.senderBundle, apk: account?.valid ? account.publicKey : null });
        const ref = accountRefOf(item.from);
        if (ref) trustRef.current.rememberRef(keys.roomId, ref, got.spk);
        opened = { payload: got.payload, version: 4, signer: signerOf(got.spk, account), certVersion: account?.v, sealedWith: "p4-mailbox" };
      } else {
        try {
          const o = await openMessage<unknown>(keys, item.envelope as DataChannelEnvelope);
          opened = { ...o, sealedWith: "room" };
        } catch (err) {
          // F-20: a very old client's envelope is said and dropped; another key
          // (another passphrase) — leave it: it expires on the server, or opens
          // once we join with the right key.
          if (err instanceof OldEnvelopeError) { handled.push(item.id); warnOnce(`old-env:${item.from.peerId}`, t(lang, "p4.oldEnvelope")); }
          continue;
        }
      }
      handled.push(item.id);
      // The payload must name the peer the server says relayed it, and
      // never us; anything malformed is dropped.
      const plaintext = validatePayload(opened.payload, { transportSender: item.from.peerId, myId: myIdRef.current });
      if (!plaintext || plaintext.kind === "audio-status" || plaintext.kind === "receipt") continue;
      if (messagesRef.current.some((m) => m.id === plaintext.id) || !(await freshMessage(plaintext.id, (opened.payload as { createdAt?: unknown }).createdAt))) continue;
      relaySendersRef.current.set(plaintext.id, { peerId: item.from.peerId, accountId: accountRefOf(item.from) });
      incoming.push(chatMessageFrom(plaintext, {
        cryptoVersion: opened.version,
        sealedWith: opened.sealedWith,
        identity: await identityFor(opened.signer, plaintext.senderName, { protocol: opened.version === 4 ? 4 : 3, certVersion: opened.certVersion }),
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

  /*
   * 6.1: receipts between online peers (the Android app sends and shows
   * them too). A sealed payload {kind: "receipt", state, ids} to that one
   * peer with the pair key — never the room key — batched for 400 ms.
   */
  const receiptQueueRef = useRef(new Map<string, { delivered: string[]; read: string[] }>());
  const receiptTimerRef = useRef<number | null>(null);

  function queueReceipt(peerId: string, state: "delivered" | "read", messageId: string) {
    const q = receiptQueueRef.current.get(peerId) ?? { delivered: [], read: [] };
    q[state].push(messageId);
    receiptQueueRef.current.set(peerId, q);
    if (receiptTimerRef.current === null) receiptTimerRef.current = window.setTimeout(() => { receiptTimerRef.current = null; void flushReceipts(); }, 400);
  }

  async function flushReceipts() {
    const keys = keyRef.current;
    const store = senderKeysRef.current;
    const queued = [...receiptQueueRef.current.entries()];
    receiptQueueRef.current.clear();
    if (!keys) return;
    for (const [peerId, q] of queued) {
      const channel = peersRef.current.get(peerId)?.channel;
      if (channel?.readyState !== "open") continue;
      for (const state of ["delivered", "read"] as const) {
        for (let at = 0; at < q[state].length; at += 50) {
          const payload = { kind: "receipt", id: newId("rcpt"), createdAt: Date.now(), senderId: myIdRef.current, senderName: nameRef.current, state, ids: q[state].slice(at, at + 50) };
          const sealed = await sealForOnePeer(keys, store, peerId, payload);
          if (!sealed) continue;
          try { channel.send(sealed.text); } catch { /* closing */ }
        }
      }
    }
  }

  /** A payload for one peer only: its pair ratchet (protocol 4) or the pair key (protocol 3); null without either. */
  async function sealForOnePeer(keys: RoomKeys, store: SenderKeyStore, peerId: string, payload: { id: string }): Promise<{ text: string; cipher: string; kind: SealedWith } | null> {
    const p4 = p4Ref.current;
    const proto = p4?.protocolOf(peerId);
    if (proto === "refused") return null;
    if (p4?.isP4(peerId)) {
      const frame = await p4.sealPrivate(peerId, payload.id, payload);
      return frame ? { text: JSON.stringify(frame), cipher: frame.c, kind: "p4-pair" } : null;
    }
    if (proto !== 3 || !store.hasPair(peerId)) return null;
    const envelope = await store.sealPrivate(keys, payload.id, payload, myIdRef.current, peerId, identityRef.current);
    return envelope ? { text: JSON.stringify(envelope), cipher: envelope.ciphertext, kind: "pair" } : null;
  }

  /**
   * 6.7: profiles in the room (profile/room.ts) — a frame to one peer at a
   * time, sealed with the pair key: never the room key, never via the server.
   * False when it cannot go, or would not fit one data channel message.
   */
  async function sendProfileFrame(peerId: string, frame: ProfileFrame): Promise<boolean> {
    const keys = keyRef.current;
    const store = senderKeysRef.current;
    const channel = peersRef.current.get(peerId)?.channel;
    if (!keys || channel?.readyState !== "open") return false;
    const payload = { kind: "profile", id: newId("prof"), createdAt: Date.now(), senderId: myIdRef.current, senderName: nameRef.current, ...frame };
    const sealed = await sealForOnePeer(keys, store, peerId, payload);
    if (!sealed) return false;
    const text = sealed.text;
    if (text.length > FRAME_MAX_CHARS) return false;
    try { channel.send(text); return true; } catch { return false; }
  }

  function profileExchange(): ProfileExchange {
    return profileExchangeRef.current ??= new ProfileExchange(roomProfilesRef.current, {
      send: (peerId, frame) => sendProfileFrame(peerId, frame),
      myView: () => myRoomView(),
      ownerOf: (peerId) => p4Ref.current?.info(peerId)?.pk ?? senderKeysRef.current.pairOf(peerId)?.peerPublicKey ?? null,
    });
  }

  /** A peer's receipt for messages of mine: a delivered / read audit entry per peer (the bubble shows the highest). */
  function applyReceipt(who: string, state: "delivered" | "read", ids: string[]) {
    const wanted = new Set(ids);
    setMessages((cur) => cur.map((m) => {
      if (!m.mine || !wanted.has(m.id)) return m;
      if (m.audit?.some((a) => a.state === state && a.meta === who)) return m;
      return { ...m, audit: [...(m.audit ?? []), { state, at: Date.now(), meta: who }] };
    }));
  }

  useEffect(() => {
    if (!notice) setNotice(t(lang, "chat.empty.body"));
    // intentionally no deps for first render only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  // 6.7: the profile card follows the account — opened from the vault at a
  // sign-in, gone from memory at a sign-out (it stays sealed in the vault).
  useEffect(() => onCardChange(setCard), []);
  useEffect(() => roomProfilesRef.current.subscribe(() => setPeerProfiles(roomProfilesRef.current.snapshot())), []);
  useEffect(() => {
    if (!account) { clearCard(); return; }
    void loadCard().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);
  // The public nickname pre-fills the room's name field — not in a room, and
  // not once the user typed a name there (they can always change it).
  useEffect(() => {
    if (!card || nameTypedRef.current || status !== "idle") return;
    const next = prefillNickname(card, nameRef.current);
    if (next !== nameRef.current) setName(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.nickname.value]);
  // What room members may see of me changed: everyone who speaks profiles learns the new version.
  const myRoomRev = card ? myRoomView(card)?.rev ?? "" : "";
  useEffect(() => { void profileExchange().changed(); }, [myRoomRev]); // eslint-disable-line react-hooks/exhaustive-deps

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
    bootstrapDefine(); // 6.3 define: publish window.m5mobile = { define } and fetch it
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [visibleMessages.length]);

  // Expired messages leave at the moment they expire. One timer for the
  // earliest expiry — not a re-render of the whole screen every second.
  // 6.2: the same timer brings a hidden message back when its hide ends.
  useEffect(() => {
    let next = Infinity;
    for (const m of messages) if (m.expiresAt && m.expiresAt < next) next = m.expiresAt;
    next = Math.min(next, nextHideEnd(messages, Date.now()) ?? Infinity);
    if (next === Infinity) return;
    const id = window.setTimeout(() => {
      const t = Date.now();
      setNow(t);
      setMessages((current) => {
        const kept = endHides(current.filter((message) => !message.expiresAt || message.expiresAt > t), t);
        return kept.length === current.length && kept.every((m, i) => m === current[i]) ? current : kept;
      });
    }, Math.max(50, Math.min(next - Date.now() + 20, 2_147_000_000)));
    return () => window.clearTimeout(id);
  }, [messages]);

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
      // A placeholder ("peer-1a2b", from a signal that came first) never
      // replaces the name the room told us.
      const placeholder = update.name?.startsWith("peer-") && !existing.name.startsWith("peer-");
      const next = placeholder ? { ...update, name: existing.name } : update;
      return current.map((peer) => (peer.id === id ? { ...peer, ...next } : peer));
    });
    // The handle names the peer in notices; give it the real name too.
    if (update.name && !update.name.startsWith("peer-")) {
      peerNamesRef.current.set(id, update.name);
      const handle = peersRef.current.get(id);
      if (handle) handle.name = update.name;
    }
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

  /**
   * Hands a chat message to the open peers (or `targets`) with the best key
   * each can open: our sender key for a room message (forward secret), a
   * pair key for a private one, the room key for a peer without a pair yet.
   * Returns how many took it and the ciphertext to show in the info view.
   */
  async function deliverToPeers(payload: { id: string }, roomEnvelope: () => Promise<DataChannelEnvelope | null>, targets?: Set<string>): Promise<{ sent: number; cipher: string; kinds: Set<SealedWith> }> {
    const keys = keyRef.current;
    const store = senderKeysRef.current;
    const me = myIdRef.current;
    const identity = identityRef.current;
    const p4 = p4Ref.current;
    const privateSend = Boolean(targets);
    let live: DataChannelEnvelope | null = null;
    let sent = 0;
    let cipher = "";
    const kinds = new Set<SealedWith>();
    const open = [...peersRef.current.values()].filter((peer) => (!targets || targets.has(peer.id)) && peer.channel?.readyState === "open");
    // 6.12: a channel that has just opened is still saying hello — wait a moment
    // for the protocol it speaks rather than fall back to the room key.
    if (p4) await Promise.all(open.map((peer) => (p4.protocolOf(peer.id) === "pending" ? p4.settled(peer.id, 2500) : null)));
    // Protocol 4 (§ 6): one sender-key message for every protocol-4 peer; each got our chain first.
    const room4 = !privateSend && p4 ? await p4.sealRoom(payload.id, payload, open.map((peer) => peer.id)).catch(() => null) : null;
    for (const peer of open) {
      const channel = peer.channel!;
      const proto = p4?.protocolOf(peer.id);
      if (proto === "refused") continue; // a downgrade, an excluded device, a broken session: nothing goes
      let text: string | null = null;
      let kind: SealedWith = "room";
      let c = "";
      if (p4?.isP4(peer.id)) {
        if (privateSend) {
          const frame = await p4.sealPrivate(peer.id, payload.id, payload).catch(() => null);
          if (frame) { text = JSON.stringify(frame); kind = "p4-pair"; c = frame.c; }
        } else if (room4?.to.includes(peer.id)) {
          text = JSON.stringify(room4.envelope); kind = "p4-sk"; c = room4.envelope.c;
        }
        if (!text) continue; // never the room key to a protocol-4 peer
      } else if (keys && proto === 3 && store.hasPair(peer.id)) {
        if (privateSend) {
          const envelope = await store.sealPrivate(keys, payload.id, payload, me, peer.id, identity);
          if (envelope) { text = JSON.stringify(envelope); kind = "pair"; c = envelope.ciphertext; }
        } else {
          // A peer that has not got our current chain gets it first (the
          // channel is ordered, so it arrives before the message).
          if (!store.hasOurKey(peer.id)) {
            const sk = await store.senderKeyFor(keys, me, peer.id);
            if (sk) { try { channel.send(JSON.stringify(sk)); } catch { /* closing */ } }
          }
          live ??= await store.sealLive(keys, payload.id, payload, identity);
          text = JSON.stringify(live); kind = "sender-key"; c = live.ciphertext;
        }
      }
      if (!text) {
        // No session of either protocol (yet): the room key, as before.
        const envelope = await roomEnvelope();
        if (!envelope) continue;
        text = JSON.stringify(envelope); kind = "room"; c = envelope.ciphertext;
      }
      try {
        channel.send(text);
        sent += 1;
        kinds.add(kind);
        if (!cipher || kind !== "room") cipher = c;
        const st = peerStatsRef.current.get(peer.id);
        if (st) st.sent += text.length;
      } catch { /* the next channel */ }
    }
    return { sent, cipher, kinds };
  }

  /** 6.12: the outbox's flush — a waiting payload, opened from its page-only seal, sealed now for whoever can take it. */
  deliverQueuedRef.current = async (id, sealed, targets) => {
    let payload: { id: string };
    try { payload = await payloadSealerRef.current.open<{ id: string }>(id, sealed); } catch { return 0; }
    let room: DataChannelEnvelope | null | undefined;
    const delivered = await deliverToPeers(payload, async () => (room === undefined ? (room = await sealForRoom(payload)) : room), targets);
    return delivered.sent;
  };

  async function broadcastAudioStatus(next: AudioStatus) {
    const payload = {
      kind: "audio-status",
      id: newId("audio"),
      createdAt: Date.now(),
      senderId: myIdRef.current,
      senderName: nameRef.current,
      status: next,
    } as { id: string };
    // 6.12: like a message — protocol 4 / 3 sessions, the room key only without one.
    await deliverToPeers(payload, () => sealForRoom(payload));
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
        systemMessage(tf(lang, "app.chunksMissing", { n: seqs.length, round }));
      },
      onProgress: (id, recv, total, stats) => {
        updateTransfer(id, { stats: { ...stats, received: recv, size: total } });
      },
      onComplete: (id, blob, meta, transport, proof) => {
        cx("file-received", meta.name, { bytes: meta.size });
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
        // 6.7 (S20): older received files may make room (their messages say the file is gone).
        const released = rememberBlob(url, blob);
        if (released.length) setMessages((cur) => withReleasedFiles(cur, released));
        systemMessage(t(lang, proof.verified ? "file.verified" : "file.unverified").replace("{name}", meta.name), { kind: proof.verified ? "success" : "info" });
        const p4File = proof.version === 4;
        void identityFor(proof.signer, meta.senderName, { protocol: p4File ? 4 : 3, certVersion: p4File ? p4Ref.current?.info(meta.senderId)?.account?.v : undefined }).then((identity) => {
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
              ...(p4File ? { sealedWith: "p4-pair" as const } : {}),
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
        systemMessage(tf(lang, "app.fileFailed", { msg }), { kind: "error" });
      },
    };
  }

  /**
   * 6.12: the room's protocol-4 session layer (p4-session.ts), made for the
   * current room keys — hellos v4 (with the protocol-3 fields for an older
   * peer), pair ratchets, sender keys v4; protocol 3 for older peers through
   * the same SenderKeyStore as before.
   */
  function p4Room(): P4Room | null {
    const keys = keyRef.current;
    const identity = identityRef.current;
    if (!keys || !identity) return null;
    if (p4Ref.current && p4Ref.current.keys === keys) return p4Ref.current;
    p4Ref.current?.clear();
    const nameOf = (peerId: string) => peersRef.current.get(peerId)?.name || `peer-${peerId.slice(-4)}`;
    const closeChannel = (peerId: string) => { try { peersRef.current.get(peerId)?.channel?.close(); } catch { /* closed */ } };
    p4Ref.current = new P4Room({
      keys, identity, v3: senderKeysRef.current,
      selfId: () => myIdRef.current,
      send: (peerId, text) => {
        const channel = peersRef.current.get(peerId)?.channel;
        if (channel?.readyState !== "open") return false;
        try { channel.send(text); } catch { return false; }
        const st = peerStatsRef.current.get(peerId);
        if (st) st.sent += text.length;
        return true;
      },
      // `user`: this session's username (the peer's claim, like its nickname).
      helloExtra: () => ({ caps: [...(mediaE2eeRef.current.supported ? ["bin", "media"] : ["bin"]), PROFILE_CAP], ...(sessionUserRef.current ? { user: sessionUserRef.current } : {}) }),
      local: async () => {
        const mailbox = keys.version === 3 ? await ensureMailbox() : null;
        const current = await mailbox?.current().catch(() => null);
        return { mb: current?.bundle ?? null, acc: helloAccountOf(identityRef.current?.attestation), sth: onHomeServer() ? ktRef.current?.newest() ?? null : null };
      },
      book: trustRef.current,
      excluded: (pk) => excludedRef.current.has(pk),
      events: {
        ready: (peerId, info) => onPeerReady(peerId, info),
        downgrade: (peerId) => {
          setP4Peers((cur) => ({ ...cur, [peerId]: "refused" }));
          warnOnce(`downgrade:${peerId}`, tf(lang, "p4.downgrade", { name: nameOf(peerId) }), "error");
          closeChannel(peerId);
        },
        refused: (peerId, why) => {
          if (why === "key-mismatch") warnOnce(`mismatch:${peerId}`, t(lang, "sec.keyMismatch").replace("{name}", nameOf(peerId)), "error");
          else if (why === "bad-signature") warnOnce(`badhello:${peerId}`, t(lang, "sec.identity.invalidFlash").replace("{name}", nameOf(peerId)), "error");
          else closeChannel(peerId);
        },
        inner: (peerId, inner, cipher) => onP4Inner(peerId, inner, cipher),
        reset: (peerId) => setNotice(tf(lang, "p4.reset", { name: nameOf(peerId) })),
        close: (peerId) => {
          setP4Peers((cur) => ({ ...cur, [peerId]: "refused" }));
          warnOnce(`reset-closed:${peerId}`, tf(lang, "p4.resetClosed", { name: nameOf(peerId) }), "error");
          closeChannel(peerId);
        },
        chainRefused: (peerId) => warnOnce(`chain:${peerId}`, tf(lang, "p4.chainRefused", { name: nameOf(peerId) }), "error"),
      },
    });
    return p4Ref.current;
  }

  /** 6.12: a peer's hello was accepted — protocol 3 at once, protocol 4 once the session exists. */
  function onPeerReady(peerId: string, info: PeerInfo) {
    setP4Peers((cur) => ({ ...cur, [peerId]: info.protocol }));
    const keys = keyRef.current;
    if (info.protocol === 3) {
      warnOnce(`legacy:${info.pk}`, tf(lang, "p4.legacyPeer", { name: peersRef.current.get(peerId)?.name || `peer-${peerId.slice(-4)}` }), "info");
      // Both sides seal call frames with the protocol-3 pair's media keys.
      const pair = senderKeysRef.current.pairOf(peerId);
      if (pair && info.caps.includes("media")) mediaE2eeRef.current.setKeys(peerId, pair.mediaSend, pair.mediaRecv);
    } else {
      // § 7.1 / 12.2: the device's bundle and account go with its pin; behind its room reference too (it may come back away).
      const apk = info.account?.valid ? info.account.publicKey : null;
      trustRef.current.rememberDevice(info.pk, { mb: info.mb, apk });
      const ref = peerRefsRef.current.get(peerId);
      if (ref && keys) trustRef.current.rememberRef(keys.roomId, ref, info.pk);
      if (apk) peerAccountKeysRef.current.set(peerId, apk);
      // § 14.4: their tree head against ours (split view), the account in the log.
      if (info.sth && onHomeServer()) void ktRef.current?.gossip(info.sth);
      void checkPeerInLog(peerId, info);
      // § 9: our media key for this peer (a fresh one again with every negotiation).
      void rotateMediaKey(peerId);
    }
    // 6.7: a session exists now — they learn my profile's version.
    void profileExchange().hello(peerId, info.caps);
  }

  /** § 14.4: an account-attested peer, first seen this session — is its device in the server's key log, not revoked? */
  async function checkPeerInLog(peerId: string, info: PeerInfo) {
    const kt = ktRef.current;
    const ref = peerRefsRef.current.get(peerId);
    if (!kt || !onHomeServer() || !info.account?.valid || !ref) return;
    const slot = `${info.account.publicKey}|${info.pk}`;
    if (ktCheckedRef.current.has(slot)) return;
    ktCheckedRef.current.add(slot);
    const lookup = await hubAsk<KtLookup>("kt-lookup", ref);
    const verdict = await kt.checkDevice(lookup, info.account.publicKey, info.pk, info.user).catch(() => "unverified" as const);
    if (verdict === "revoked") {
      trustRef.current.markRevoked(info.pk);
      warnOnce(`revoked:${info.pk}`, tf(lang, "p4.kt.revoked", { name: peersRef.current.get(peerId)?.name || `peer-${peerId.slice(-4)}` }), "error");
    }
  }

  /** § 9 (F-19): a fresh media key for our direction to this protocol-4 peer, sent over its ratchet, then used. */
  async function rotateMediaKey(peerId: string) {
    const p4 = p4Ref.current;
    const info = p4?.info(peerId);
    if (!p4 || info?.protocol !== 4 || !info.caps.includes("media") || !mediaE2eeRef.current.supported) return;
    const key = await p4.sendMediaKey(peerId, callIdRef.current).catch(() => null);
    if (key) mediaE2eeRef.current.setSendKey4(peerId, key.raw, key.epoch);
  }

  /** A pair-ratchet message the app handles (§ 5.7): a private message, a media key, a file key. */
  async function onP4Inner(peerId: string, inner: RatchetInner, cipher: string) {
    if (inner.t === "msg") {
      const m = inner as { id?: unknown; p?: unknown };
      if (typeof m.id !== "string" || !m.p || typeof m.p !== "object" || (m.p as { id?: unknown }).id !== m.id) return;
      const info = p4Ref.current?.info(peerId);
      await acceptOpened(peerId, { payload: m.p, signer: p4Ref.current?.signer(peerId) ?? null, version: 4, certVersion: info?.account?.v }, "p4-pair", cipher, Date.now());
      return;
    }
    if (inner.t === "media") {
      if (mediaE2eeRef.current.supported) mediaE2eeRef.current.addRecvKey4(peerId, inner);
      return;
    }
    if (inner.t === "file") {
      const f = inner as { transferId?: unknown; key?: unknown };
      if (typeof f.transferId !== "string" || typeof f.key !== "string" || f.transferId.length > 96) return;
      const keys = fileKeysRef.current;
      keys.set(`${peerId}\u0000${f.transferId}`, { fk: f.key, at: Date.now() });
      while (keys.size > 64) keys.delete(keys.keys().next().value!);
    }
  }

  /** § 8: the FK of a protocol-4 transfer, as the sender's session handed it to us (used once). */
  const fileKeyLookup: FileKeyLookup = (transferId, from) => {
    if (!from) return null;
    const slot = `${from}\u0000${transferId}`;
    const got = fileKeysRef.current.get(slot);
    if (!got) return null;
    fileKeysRef.current.delete(slot);
    return { fk: got.fk, signer: p4Ref.current?.signer(from) ?? null };
  };

  /**
   * An opened payload from a peer's channel, whatever sealed it: checked,
   * bounded and bound to this channel's peer, fresh (§ 11), then shown — or,
   * for a receipt / profile (only when sealed for us alone), applied.
   */
  async function acceptOpened(peerId: string, opened: { payload: unknown; signer: Signer | null; version: 1 | 2 | 3 | 4; certVersion?: 1 | 2 }, sealedWith: SealedWith, cipher: string, receivedAt: number) {
    const peerName = peersRef.current.get(peerId)?.name || `peer-${peerId.slice(-4)}`;
    if (opened.signer?.valid && opened.signer.account?.valid) peerAccountKeysRef.current.set(peerId, opened.signer.account.publicKey);
    // Checked, bounded, and bound to this channel's peer: a payload
    // naming another sender (or us) is not shown.
    const plaintext = validatePayload(opened.payload, { transportSender: peerId, myId: myIdRef.current, receipts: true, profiles: true });
    if (!plaintext) {
      warnOnce(`dropped:${peerId}`, t(lang, "proto.dropped").replace("{name}", peerName));
      return;
    }
    if (!(await freshMessage(plaintext.id, (opened.payload as { createdAt?: unknown }).createdAt))) return; // a replay, or too old / ahead
    const forUsAlone = sealedWith === "pair" || sealedWith === "p4-pair";

    if (plaintext.kind === "audio-status") {
      setPeerView(peerId, { audio: plaintext.status });
      return;
    }
    if (plaintext.kind === "receipt") {
      // Only sealed for us alone counts: a receipt is not a room-wide claim.
      if (forUsAlone) applyReceipt(peerName, plaintext.state, plaintext.ids);
      return;
    }
    if (plaintext.kind === "profile") {
      // 6.7: only sealed for us alone — a profile goes to one member at a time.
      if (forUsAlone) void profileExchange().receive(peerId, plaintext);
      return;
    }
    if (messagesRef.current.some((m) => m.id === plaintext.id)) return;

    const identity = await identityFor(opened.signer, plaintext.senderName, { protocol: opened.version === 4 ? 4 : 3, certVersion: opened.certVersion });
    setMessages((current) => [
      ...current,
      chatMessageFrom(plaintext, {
        cipher,
        cryptoVersion: opened.version,
        sealedWith,
        identity,
        audit: [
          { state: "created", at: plaintext.createdAt },
          { state: "received", at: receivedAt, meta: peerId.slice(-6) },
          { state: "decrypted", at: Date.now() },
        ],
      }),
    ]);
    dispatchInternal("message", { senderId: plaintext.senderId });
    const roomSec = (roomRef.current && prefsRef.current.roomSecurity[roomRef.current]) || DEFAULT_ROOM_SECURITY;
    if (roomSec.deliveryReceipts) queueReceipt(peerId, "delivered", plaintext.id);
    cx("received");
    if (plaintext.attachment) cx("file-received", plaintext.attachment.name, { bytes: plaintext.attachment.size });

    if (
      notificationsEnabledRef.current &&
      activeProfileRef.current?.notifications !== false &&
      typeof document !== "undefined" &&
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      // 6.7: by the template and the user's choice; the page decrypted it, so it may show the text.
      showLocalNotification(
        { kind: "message", room: roomRef.current || undefined, sender: plaintext.senderName, text: plaintext.flags?.sealed ? "🔒" : plaintext.text || "📎", tag: "m5cet" },
        { lang: lang === "cs" || lang === "de" ? lang : "en" },
      );
    }
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
      setNotice(t(lang, "app.channelOpen"));
      // 6.12: a hello v4 — the protocol-3 hello (key check value, device key,
      // DH key; a 6.11 peer reads only that) plus fresh ephemeral P-256 and
      // ML-KEM keys, our mailbox bundle, account and newest key-log head
      // (p4-session.ts). A wrong passphrase shows up as exactly that.
      void (async () => {
        identityRef.current ??= await loadIdentity().catch(() => null);
        await p4Room()?.open(peerId);
      })().catch(() => undefined);
      void broadcastAudioStatus(audioStatusRef.current);
    };
    channel.onclose = () => {
      setPeerView(peerId, { status: "closed", audio: "off" });
      // Its session goes with it (a new channel says hello again).
      const current = peersRef.current.get(peerId)?.channel;
      if (!current || current === channel) p4Ref.current?.channelClosed(peerId);
    };
    // Someone came online: whatever was waiting for them can go now.
    channel.addEventListener("open", () => { void flushOutboxRef.current("kanál otevřen"); });
    channel.onerror = () => {
      setPeerView(peerId, { status: "closed" });
      systemMessage(tf(lang, "app.connectionDropped", { name: peerName() }));
    };
    // 6.12: frames of one channel are handled one after another, in the order
    // they came — a ratchet frame installing a chain or a file key must be
    // done before the message or the file it is for.
    let inbox: Promise<void> = Promise.resolve();
    channel.onmessage = (event) => {
      inbox = inbox.then(() => onChannelMessage(event)).catch((err) => console.warn("[m5cet] frame from", peerId.slice(-6), "failed:", (err as Error)?.message ?? err));
    };
    const askAgain = (transferId: string, seqs: number[]) => {
      try {
        channel.send(JSON.stringify({ kind: "file-need", transferId, seqs, transport: "p2p" }));
        return true;
      } catch { return false; } // channel gone: the end-of-transfer error follows
    };
    const onChannelMessage = async (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // A binary file chunk; nothing else travels as binary.
        const st = peerStatsRef.current.get(peerId);
        if (st) st.recv += event.data.byteLength;
        const chunk = frameFromBinary(event.data);
        const keys = keyRef.current;
        if (!chunk || chunk.kind !== "file-chunk" || !keys) return;
        // 6.7 (S19): bound to this channel's peer.
        await handleIncomingFrame(keys, incomingFilesRef.current, chunk, prefs.maxAttachmentBytes, fileCallbacks(askAgain), peerId, fileKeyLookup);
        return;
      }
      const dataStr = String(event.data);
      const st = peerStatsRef.current.get(peerId);
      if (st) st.recv += dataStr.length;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(dataStr) as Record<string, unknown>; } catch { return; }
      if (!raw || typeof raw !== "object") return;
      const keys = keyRef.current;
      if (!keys) return;

      if (raw.kind === "key-check") {
        // A 3.0 peer (PBKDF2 keys): it cannot share keys with a 3.1 one.
        if (raw.check !== keys.check) warnOnce(`mismatch:${peerId}`, t(lang, "sec.keyMismatch").replace("{name}", peerName()), "error");
        return;
      }

      if (raw.kind === "hello") {
        const user = cleanUsername(raw.user);
        if (user) peerUsersRef.current.set(peerId, user);
        if (excludedRef.current.has(String(raw.pk))) { try { channel.close(); } catch { /* ignore */ } return; }
        if (Array.isArray(raw.caps) && raw.caps.includes("bin")) binaryChannelsRef.current.add(channel);
        identityRef.current ??= await loadIdentity().catch(() => null);
        // Protocol 4 or 3, the downgrade rule, our chain: p4-session.ts (events → onPeerReady).
        await p4Room()?.handle(peerId, raw);
        return;
      }

      const p4 = p4Room();
      // p4-kem, p4 (ratchet frames), p4-reset, a protocol-3 sender key.
      if (p4 && (await p4.handle(peerId, raw))) return;
      // A refused peer (a downgrade, a broken session) gets nothing through.
      if (p4?.protocolOf(peerId) === "refused") return;

      // The receiver lost a few chunks and asks for them again.
      if (raw.kind === "file-need") {
        const transferId = String(raw.transferId ?? "");
        const seqs = Array.isArray(raw.seqs) ? raw.seqs.filter((n): n is number => Number.isInteger(n)).slice(0, 5_000) : [];
        const repeat = resendableRef.current.get(transferId);
        if (repeat && seqs.length) {
          systemMessage(tf(lang, "app.resendingChunks", { n: seqs.length }));
          void repeat(seqs).catch(() => undefined);
        }
        return;
      }

      // File transfer frames bypass the normal envelope decode.
      if (typeof raw.kind === "string" && /^file-(meta|chunk|end|cancel)$/.test(raw.kind) && typeof raw.transferId === "string") {
        // 6.7 (S19): bound to this channel's peer; 6.12: a protocol-4 file opens only with the FK its session gave us.
        await handleIncomingFrame(keys, incomingFilesRef.current, raw as unknown as FileTransferEnvelope, prefs.maxAttachmentBytes, fileCallbacks(askAgain), peerId, fileKeyLookup);
        return;
      }

      const receivedAt = Date.now();
      // 6.12 (§ 6): a protocol-4 room message, with this peer's chain.
      if (isP4RoomEnvelope(raw)) {
        if (!p4) return;
        try {
          const opened = await p4.openRoom<unknown>(peerId, raw);
          await acceptOpened(peerId, { ...opened, version: 4, certVersion: p4.info(peerId)?.account?.v }, "p4-sk", raw.c, receivedAt);
        } catch {
          systemMessage(t(lang, "app.undecryptable"));
        }
        return;
      }

      const envelope = raw as unknown as DataChannelEnvelope;
      const sealedWith = envelopeKind(envelope);
      // A protocol-4 peer never seals with protocol-3 session keys: such a frame is not theirs to send.
      if (sealedWith !== "room" && p4?.protocolOf(peerId) === 4) return;
      let opened: Awaited<ReturnType<typeof openMessage<unknown>>>;
      try {
        // A sender key (live, forward secret), a pair key (private), or the room key.
        opened = sealedWith === "sender-key"
          ? { ...(await senderKeysRef.current.openLive<unknown>(keys, envelope, peerId)), version: 3 }
          : sealedWith === "pair"
            ? { ...(await senderKeysRef.current.openPrivate<unknown>(keys, envelope, peerId, myIdRef.current)), version: 3 }
            : await openMessage<unknown>(keys, envelope);
      } catch (err) {
        // F-20: envelopes of clients before 3.1 are not opened any more.
        if (err instanceof OldEnvelopeError) warnOnce(`old-env:${peerId}`, t(lang, "p4.oldEnvelope"));
        else systemMessage(t(lang, "app.undecryptable"));
        return;
      }
      await acceptOpened(peerId, opened, sealedWith, envelope.ciphertext, receivedAt);
    };
  }

  async function createPeer(peerId: string, peerName: string, initiator: boolean) {
    if (peersRef.current.has(peerId) || peerId === myIdRef.current) return;

    // TURN credentials may be short-lived (TURN_SECRET): refreshed here if close to expiry.
    const pc = new RTCPeerConnection(await freshRtcConfig());
    if (peersRef.current.has(peerId)) { pc.close(); return; } // raced by another signal meanwhile
    const handle: PeerHandle = {
      id: peerId,
      name: peerNamesRef.current.get(peerId) ?? peerName,
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
      mediaE2eeRef.current.protectTransceiver(event.transceiver, peerId);
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
        mediaE2eeRef.current.protectSender(pc, sender, peerId);
        handle.outgoingAudioSenders.push(sender);
      });
    }

    // Perfect negotiation: whichever side changes the session (the data
    // channel, a microphone, a camera) makes the offer; when both do at
    // once, the initiator's wins and the other side rolls back.
    pc.onnegotiationneeded = async () => {
      // 6.12 (§ 9): every renegotiation of a protocol-4 peer's call gets a fresh media key.
      void rotateMediaKey(peerId);
      try {
        handle.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) sendSignal(peerId, pc.localDescription.toJSON() as RTCSessionDescriptionInit);
      } catch (err) {
        console.warn("[m5cet] negotiation with", peerId.slice(-6), "failed:", (err as Error)?.message ?? err);
      } finally {
        handle.makingOffer = false;
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel("m5cet", { ordered: true });
      wireDataChannel(peerId, channel);
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
      // Both offered at once: the initiator ignores the other offer, the
      // other side rolls its own back (setRemoteDescription does that).
      const collision = desc.type === "offer" && (handle.makingOffer || handle.pc.signalingState !== "stable");
      handle.ignoreOffer = handle.initiator && collision;
      if (handle.ignoreOffer) return;
      await handle.pc.setRemoteDescription(desc);
      if (desc.type === "offer") {
        // 6.12 (§ 9): answering a renegotiation — our direction gets a fresh media key too.
        void rotateMediaKey(source);
        await handle.pc.setLocalDescription();
        if (handle.pc.localDescription) sendSignal(source, handle.pc.localDescription.toJSON() as RTCSessionDescriptionInit);
      }
      return;
    }

    if ("candidate" in desc && desc.candidate) {
      try {
        await handle.pc.addIceCandidate(desc);
      } catch (err) {
        if (!handle.ignoreOffer) throw err; // candidates of an offer we ignored
      }
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
    cx("reconnect", `#${attempt}`);
    const initial = prefs.keepaliveStrategy === "aggressive" ? 500 : prefs.keepaliveStrategy === "conservative" ? 1500 : 1000;
    const max = 120_000; // hard 2 min cap so we never sleep forever
    const exp = Math.min(max, initial * Math.pow(2, Math.min(attempt, 12)));
    // Full-jitter — picks a random delay in [0, exp]. This avoids
    // many clients synchronising after a global outage.
    const delay = Math.random() * exp;
    logConn("retry", attempt, delay);
    setNotice(tf(lang, "app.reconnectIn", { s: (delay / 1000).toFixed(1), n: attempt }));
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
      cx("failed", (err as Error)?.message?.slice(0, 120));
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
      // Argon2id in a worker (kdf.ts): the page stays responsive meanwhile.
      // Switching back to a recent room (saved connections) reuses its keys.
      const cached = derivedKeysRef.current.get(keyFor);
      keyRef.current = cached ?? await deriveRoomKeys(nextRoom, passphraseRef.current);
      derivedKeysRef.current.delete(keyFor);
      derivedKeysRef.current.set(keyFor, keyRef.current);
      while (derivedKeysRef.current.size > 4) derivedKeysRef.current.delete(derivedKeysRef.current.keys().next().value!);
      keyForRef.current = keyFor;
      replayRef.current.clear();
      senderKeysRef.current.clear();
      p4Ref.current?.clear();
      p4Ref.current = null;
    }
    identityRef.current ??= await loadIdentity().catch(() => null);
    // 6.12: this device's mailbox bundle (renewed as due; signed in: in the key
    // directory too) and this server's key-transparency log.
    void ensureMailbox().then((m) => m?.maintain()).then(() => syncKeyDirectory()).catch(() => undefined);
    if (onHomeServer()) startKeyTransparency();
    // "A new connection clears the chat" is one of three choices now: the
    // session and server modes keep the conversation (chat-history.ts).
    if (retentionRef.current === "ephemeral") {
      setMessages([]);
      relaySendersRef.current.clear();
    } else if (retentionRef.current === "session") {
      // 6.2: for a guest this is the next page load (in this page the live copy wins the merge).
      const restored = endHides(await historyRef.current.load(nextRoom), Date.now(), !accountRef.current);
      if (restored.length > 0) {
        setMessages((cur) => mergeMessages(cur, restored));
        systemMessage(t(lang, "data.restored").replace("{n}", String(restored.length)));
      }
    } else if (retentionRef.current === "server" && !accountRef.current && storageSessionId()) {
      // The server kept this session's conversation (no passkey yet).
      // 6.7 (S21): by the blind id only — never the room's name (the KDF salt).
      const rows = (await Promise.all(historyRoomsToRead(keyRef.current).map((r) => readServerMessages({ room: r })))).flat();
      const opened = await Promise.all(rows.map((r) => serverSealerRef.current.open(r.id, r.payload)));
      const restored = sanitizeRestored(opened.filter((m) => m !== null), nextPeerId, { signIn: true });
      if (restored.length > 0) {
        setMessages((cur) => mergeMessages(cur, restored));
        systemMessage(t(lang, "data.restored").replace("{n}", String(restored.length)));
      }
    }
    // 6.0: what this room collected while it ran in the background.
    const carried = carryRef.current.get(nextRoom);
    if (carried?.length) {
      carryRef.current.delete(nextRoom);
      setMessages((cur) => mergeMessages(cur, carried));
    }
    setPeers([]);
    setAwayPeers([]);
    presence.reset();
    // Compute the deterministic room-key fingerprint (DPA anchor). We
    // hash a constant-length string derived from the room id so the
    // fingerprint is independent of the password length but only changes
    // when the room id changes.
    void sha256Hex(`m5cet:room:${nextRoom}`).then((digest) => setRoomFingerprint(digest));
    // Clear old peer fingerprints — each room has its own set.
    setPeerFingerprints({});
    setStatus("connecting");
    logConn("connecting", reconnectAttemptsRef.current + 1);

    const socket = new WebSocket(wsUrl(activeServerRef.current));
    socket.binaryType = "arraybuffer";
    serverBinaryRef.current = false;
    socketRef.current = socket;
    // Storage operations ride on this socket rather than opening their own
    // connection (lib/storage-client.ts).
    // Only our own server gets storage frames: they carry the account token.
    attachStorageSocket(onHomeServer() ? socket : null);

    socket.onopen = () => {
      // Replaced before it opened (a quick switch): not ours any more.
      if (socketRef.current !== socket) { try { socket.close(); } catch { /* closing */ } return; }
      logConn("open", reconnectAttemptsRef.current + 1);
      reconnectAttemptsRef.current = 0;
      // 6.12 (§ 13): the join waits for the server's hello — its nonce is what
      // our proof of the room key signs (a server before 6.12 has none, and
      // one that says nothing within 3 s gets the join without a proof).
      joinOfRef.current.set(socket, (nonce) => sendJoin(socket, nonce, { nextRoom, nextPeerId, resume }));
      window.setTimeout(() => { void joinOfRef.current.get(socket)?.(null); }, 3000);
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

  /** The join frame, once per socket — 6.12 with the proof that we hold the room key, over the socket's nonce (§ 13). */
  async function sendJoin(socket: WebSocket, nonce: string | null, at: { nextRoom: string; nextPeerId: string; resume: { secret: string } | null }) {
    if (joinSentRef.current.has(socket)) return;
    joinSentRef.current.add(socket);
    const keys = keyRef.current;
    const proof = nonce && keys && keys.version === 3 && keys.roomId.startsWith("r3.") ? await hubProofFor(keys, nonce) : null;
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
    // A signed-in user with server-side history joins with their account
    // token and asks the server to stay in the room for them (away relay).
    // 6.7: and says whether the app is in the foreground (presence).
    const foreground = appInForeground();
    presence.signal.reset({ away: false, foreground });
    socket.send(JSON.stringify({
      type: "join",
      protocol: 2,
      // The server routes by the blind id and never learns the room's name.
      room: keyRef.current?.roomId ?? at.nextRoom,
      peerId: at.nextPeerId,
      ...(at.resume ? { resume: at.resume.secret } : {}),
      name: nameRef.current,
      // Another server never sees the account: no token, no away relay.
      ...(onHomeServer() && accountToken() ? { auth: accountToken() } : {}),
      away: onHomeServer() && retentionRef.current === "server" && Boolean(accountRef.current) && activeProfileRef.current?.away !== false,
      features: ["bin"],
      foreground,
      ...(proof ? { proof } : {}),
    }));
    if (onHomeServer()) socket.send(JSON.stringify({ type: "command-poll", deviceId: prefs.deviceId }));
    // 6.7: the service worker may name this room in a push (memory only, never sent anywhere).
    if (onHomeServer()) tellWorkerRoomName(keyRef.current?.roomId, at.nextRoom);
  }

  /** § 13: Ed25519 over join("m5cet/hub-join/4", roomId, nonce) with the key derived from the room secret; null when the browser cannot. */
  async function hubProofFor(keys: RoomKeys, nonce: string): Promise<{ pub: string; sig: string } | null> {
    let seed = hubSeedRef.current.get(keys);
    if (!seed) { seed = hubSeed(keys); hubSeedRef.current.set(keys, seed); }
    try { return await buildHubProof(await seed, keys.roomId, nonce); } catch { return null; }
  }

  function wireSocketHandlers(socket: WebSocket) {
    // 6.0: a socket that is no longer the current one (a switch of rooms or
    // saved connections closes it while the next one opens) is ignored: its
    // late close used to count as a drop and start a reconnect that replaced
    // the new connection (4001), whose close started the next one — a loop.
    const stale = () => socketRef.current !== socket;
    socket.onmessage = async (event) => {
      if (stale()) return;
      if (event.data instanceof ArrayBuffer) {
        // A relayed file chunk in binary form (the only binary frame).
        const chunk = frameFromBinary(event.data);
        const keys = keyRef.current;
        if (!chunk || chunk.kind !== "proxy-chunk" || !keys) return;
        await handleIncomingFrame(keys, incomingFilesRef.current, chunk, prefs.maxAttachmentBytes, fileCallbacks((transferId, seqs) => {
          const sock = socketRef.current;
          if (sock?.readyState !== WebSocket.OPEN) return false;
          sock.send(JSON.stringify({ type: "proxy-need", transferId, seqs }));
          return true;
        }));
        return;
      }
      let frame: SignalFrame;
      try { frame = JSON.parse(String(event.data)) as SignalFrame; } catch { return; }
      presence.onFrame(frame); // 6.7: foreground, last seen, held members

      if (frame.type === "pong") {
        const rtt = Math.max(0, Date.now() - (frame.t || 0));
        setConnStatus((s) => s ? { ...s, lastPongAt: Date.now(), rttMs: rtt } : s);
        return;
      }

      // Operator commands only from our own server.
      if (frame.type === "admin-command" && onHomeServer()) {
        const cmd = frame.command;
        if (!isAdminCommand(cmd)) return;
        await dispatchCommand(cmd, {
          onRefreshSettings: () => {
            const fresh = loadPreferences();
            setPrefsState(fresh);
            systemMessage(t(lang, "app.admin.refreshed"));
          },
          onReconnect: () => {
            try { socketRef.current?.close(4001, "admin-reconnect"); } catch { /* ignore */ }
          },
          onPurgeLocal: () => {
            clearPreferences();
            systemMessage(t(lang, "app.admin.purged"));
          },
          onShowNotification: (title, body) => {
            systemMessage(tf(lang, "app.admin.notice", { title, body }));
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
            const consent = window.confirm(tf(lang, "app.admin.download", { name }));
            if (!consent) return;
            try {
              const res = await fetch(url);
              const blob = await res.blob();
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = name;
              a.click();
            } catch (err) {
              systemMessage(tf(lang, "app.admin.downloadFailed", { msg: (err as Error).message }));
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
        resumeRef.current = frame.resume ? { room: roomRef.current, peerId: frame.peerId, secret: frame.resume } : null;
        // 6.7: a reload comes back as this member (the server keeps us listed meanwhile), not as a second one.
        if (resumeRef.current && passphraseRef.current && intentRef.current) {
          void sessionCacheRef.current.save({ name: nameRef.current, room: roomInputRef.current, passphrase: passphraseRef.current, desired: "connected", ...sessionOrigin(), resume: resumeRef.current }).catch(() => undefined);
        }
        setStatus("joined");
        systemMessage(tf(lang, "app.joined", { room: roomRef.current, n: frame.peers.length }));
        cx("connected", tf(lang, "app.joined", { room: roomRef.current, n: frame.peers.length }), { peers: frame.peers.length + 1 });
        setAwayPeers((frame.away ?? []).map((a) => ({ accountId: accountRefOf(a), name: a.name, since: a.since })).filter((a) => a.accountId));
        if (frame.account && "invalid" in frame.account) {
          // The token did not outlive the server: sign in again to get the
          // vault and the relay back.
          setAccount(null);
          void restoreSession().then((acc) => { if (acc) { setAccount(acc); announceAccountToServer(); } });
        }
        // 6.12 (§ 13): whether our join proved the room key, and who else did.
        setHubProven(typeof frame.proven === "boolean" ? frame.proven : null);
        for (const peer of frame.peers) {
          const ref = accountRefOf(peer);
          if (ref) peerRefsRef.current.set(peer.peerId, ref);
          await createPeer(peer.peerId, peer.name, true);
          if (typeof peer.proven === "boolean") setPeerView(peer.peerId, { proven: peer.proven });
        }
        if (prefs.mode === "server" && prefs.analyticsConsent) {
          void fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "client-join",
              room: serverRoomId(keyRef.current), // 6.7 (S21): the blind id, not the name
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
        const ref = accountRefOf(frame);
        if (ref) peerRefsRef.current.set(frame.peerId, ref);
        setPeerView(frame.peerId, { name: frame.name, status: "connecting", initiator: false, ...(typeof frame.proven === "boolean" ? { proven: frame.proven } : {}) });
        systemMessage(tf(lang, "app.peerEntered", { name: frame.name }));
        cx("peer-joined", frame.name, { peers: peersRef.current.size + 2 });
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
        const ref = accountRefOf(frame);
        if (ref) peerRefsRef.current.set(frame.peerId, ref); else peerRefsRef.current.delete(frame.peerId);
        setPeerView(frame.peerId, { name: frame.name });
        return;
      }

      // 6.12: the hub's answers about a member's reference — the key directory (§ 7.5), key transparency (§ 14.3).
      if (frame.type === "key-bundles") { hubAnswer("key-bundles", String(frame.ref ?? ""), Array.isArray(frame.devices) ? frame.devices : []); return; }
      if (frame.type === "kt-lookup") { hubAnswer("kt-lookup", String(frame.ref ?? ""), frame.lookup ?? null); return; }

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

      // 6.0: a phone call offered to this member, or its end.
      if (frame.type === "phone-bridge") {
        onPhoneFrame(frame as unknown as Record<string, unknown>, socketRef.current?.url ?? "");
        return;
      }

      // 6.0: a notice from the operator — plain text from the server, not in the room's
      // encryption, and said so. A wall or a private message stays in the conversation.
      if (frame.type === "server-notice") {
        const from = frame.from && frame.from !== "operator" ? frame.from : t(lang, "notice.operator");
        const kind: FlashMessage["kind"] = frame.level === "error" || frame.level === "warning" || frame.level === "success" ? frame.level : "info";
        const text = String(frame.text ?? "").slice(0, 2000);
        if (!text) return;
        if (frame.kind === "flash" || frame.kind === "wake") {
          flashRef.current.push({ text, detail: from, kind });
          return;
        }
        const label = tf(lang, frame.kind === "wall" ? (frame.pinned ? "notice.pinned" : "notice.wall") : "notice.private", { from });
        setMessages((current) => current.some((m) => m.id === `notice-${frame.id}`) ? current : [
          ...current,
          { id: `notice-${frame.id}`, senderId: "system", senderName: label, text, createdAt: Number(frame.at) || Date.now(), mine: false, secure: false },
        ]);
        if (prefsRef.current.flash.enabled) flashRef.current.push({ text, detail: label, kind });
        return;
      }

      if (frame.type === "hello") {
        serverBinaryRef.current = Array.isArray(frame.features) && frame.features.includes("bin");
        const pl = frame.limits?.proxy;
        proxyLimitsRef.current = pl && [pl.bytesPerSec, pl.burstBytes, pl.framesPerSec, pl.burstFrames].every((n) => typeof n === "number" && n > 0)
          ? pl : DEFAULT_PROXY_LIMITS;
        // 6.12 (§ 13): now the join can go — with a proof over this socket's nonce.
        await joinOfRef.current.get(socket)?.(typeof frame.nonce === "string" ? frame.nonce : null);
        return;
      }
      if (frame.type === "presence-ack" || frame.type === "signal-undeliverable" || frame.type === "replaced") {
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
        // They take no key with them: our next message starts a new chain
        // (6.12: both protocols — p4-session.ts › peerLeft).
        if (p4Ref.current) p4Ref.current.peerLeft(frame.peerId); else senderKeysRef.current.forgetPeer(frame.peerId);
        peerRefsRef.current.delete(frame.peerId);
        setP4Peers((cur) => { const { [frame.peerId]: _gone, ...rest } = cur; return rest; });
        mediaE2eeRef.current.forget(frame.peerId);
        const handle = peersRef.current.get(frame.peerId);
        handle?.channel?.close();
        if (handle) detachAudioElement(handle);
        handle?.pc.close();
        peersRef.current.delete(frame.peerId);
        profileExchange().forget(frame.peerId);
        peerAccountKeysRef.current.delete(frame.peerId);
        setPeers((current) => current.filter((peer) => peer.id !== frame.peerId));
        systemMessage(tf(lang, frame.held ? "presence.wentAway" : "app.peerLeft", { name: handle?.name && !handle.name.startsWith("peer-") ? handle.name : `peer-${frame.peerId.slice(-4)}` }));
        cx("peer-left", handle?.name);
      }

      if (frame.type === "signal") {
        void handleSignal(frame.source, frame.payload);
        return;
      }

      if (frame.type === "error") {
        // 6.0: the operator closed the room, or it is full — not a network problem to retry.
        if (frame.code === "room-blocked" || frame.code === "room-full") {
          systemMessage(tf(lang, frame.code === "room-blocked" ? "notice.roomBlocked" : "notice.roomFull", { reason: frame.message }), { kind: "warning" });
          userDisconnect();
          return;
        }
        // 6.12 (§ 13): the join's proof of the room key was refused, or one is required — retrying would not help.
        if (frame.code === "room-proof" || frame.code === "room-proof-required") {
          systemMessage(t(lang, frame.code === "room-proof" ? "p4.roomProof" : "p4.roomProofRequired"), { kind: "error" });
          userDisconnect();
          return;
        }
        setNotice(frame.message);
      }

      // ---------- Server-relayed file transfer (proxy mode) ----------
      if (frame.type === "proxy-need") {
        const repeat = resendableRef.current.get(frame.transferId);
        if (repeat) {
          systemMessage(tf(lang, "app.resendingChunks", { n: frame.seqs.length }));
          void repeat(frame.seqs).catch(() => undefined);
        }
        return;
      }

      if (frame.type === "proxy-ack") {
        if (!frame.accepted) {
          setNotice(
            tf(lang, "app.proxyRefused", { reason: frame.reason ?? t(lang, "app.unknownReason") }),
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
        }), typeof frame.from === "string" && frame.from ? frame.from : undefined); // 6.7 (S19): the sender the server relayed it from
        return;
      }
    };
    socket.onclose = () => {
      if (stale()) return;
      stopHeartbeat();
      // Two reasons the socket closes today:
      //   1. The user explicitly disconnected → clientStoppedRef.current is true.
      //   2. Anything else (server kicked us, NAT rebind, Wi-Fi blip, browser
      //      suspend) → reconnect until the user explicitly leaves.
      if (!clientStoppedRef.current) {
        logConn("closed");
        cx("disconnected");
        setStatus("offline");
        const profile = activeProfileRef.current;
        if (profile && (!profile.autoReconnect || !connectionsRef.current!.get().settings.autoReconnect)) {
          // This saved connection asked not to reconnect by itself.
          intentRef.current = false;
          setConnStatus(null);
          setNotice(t(lang, "cx.reconnectOff"));
          return;
        }
        setConnStatus((s) => s ? { ...s, state: "reconnecting" } : s);
        scheduleReconnect();
      } else {
        setStatus((current) => (current === "idle" ? "idle" : "offline"));
        setConnStatus(null);
      }
    };
    socket.onerror = (event) => {
      if (stale()) return;
      // Browsers fire onerror immediately before onclose. Keep the user
      // informed without triggering a manual disconnect — scheduleReconnect
      // is called from onclose if intentRef is true.
      if (typeof event === "object" && event && "message" in event) {
        const msg = String((event as { message?: string }).message || "");
        setNotice(tf(lang, "app.connectionLost", { detail: msg ? ` (${msg})` : "" }));
      } else {
        setStatus("offline");
      }
    };
  }

  async function connect(event?: FormEvent) {
    event?.preventDefault();
    if (!passphrase.trim()) {
      setNotice(t(lang, "app.enterRoomKey"));
      return;
    }
    disconnect(false);
    closeJoinPanelRef.current = true;
    // The same room and key as a saved connection: its statistics count it.
    const match = cxState.profiles.find((p) => p.room === normalizeRoomName(roomInput) && p.passphrase === passphrase && !p.server) ?? null;
    activeProfileRef.current = match;
    activeServerRef.current = "";
    setActiveProfileId(match?.id ?? null);
    if (match) connectionsRef.current?.record(match.id, "connect");
    // The user explicitly asked to (re)join; re-arm the persistent
    // connection so any later network blip will silently reconnect.
    await startSession(name, roomInput, passphrase);
  }

  /** "Reconnect" = fire the Disconnect action, wait 1–2 s, then fire Connect —
   *  a full teardown + fresh join rather than an in-place reconnect. */
  async function reconnectViaButtons() {
    const profile = activeProfileRef.current;
    if (!profile && !passphrase.trim() && !passphraseRef.current) {
      setNotice(t(lang, "app.enterRoomKey"));
      return;
    }
    setNotice(t(lang, "app.reconnect.disconnecting"));
    userDisconnect();
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    setNotice(t(lang, "app.reconnect.connecting"));
    // A saved connection comes back as itself — on its own server too.
    if (profile) await connectProfile(profile.id, { auto: true });
    else await connect();
  }

  /** Desired state := connected. Used by the form, a restored session and invites. */
  async function startSession(nextName: string, nextRoom: string, nextPassphrase: string) {
    // Signed in: the account's username. P2P: a username from the nickname,
    // for this session only (the nickname stays just the name shown).
    const acc = accountRef.current;
    const user = acc ? (acc.username ?? acc.id) : sessionUsername(nextName);
    sessionUserRef.current = user;
    setSessionUser(user);
    intentRef.current = true;
    clientStoppedRef.current = false;
    reconnectAttemptsRef.current = 0;
    passphraseRef.current = nextPassphrase;
    roomInputRef.current = nextRoom;
    nameRef.current = nextName;
    setDesired("connected");
    setSessionPassphrase(nextPassphrase);
    void sessionCacheRef.current.save({ name: nextName, room: nextRoom, passphrase: nextPassphrase, desired: "connected", ...sessionOrigin() }).catch(() => undefined);
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
      void sessionCacheRef.current.save({ name: nameRef.current, room: roomInputRef.current, passphrase: hadSession, desired: "disconnected", ...sessionOrigin() }).catch(() => undefined);
    }
  }

  /** Where the session came from, for the session cache: another server, a saved connection. */
  function sessionOrigin(): { server?: string; profileId?: string } {
    return {
      ...(activeServerRef.current ? { server: activeServerRef.current } : {}),
      ...(activeProfileRef.current ? { profileId: activeProfileRef.current.id } : {}),
    };
  }

  /** 6.7 `goodbye` false: end the session here without leaving the room — the server keeps us listed as away. */
  function disconnect(showMessage = true, goodbye = true) {
    if (status === "joined") cx("disconnected");
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
    if (goodbye) try { socketRef.current?.send(JSON.stringify({ type: "leave", away: stayAway })); } catch { /* ignore */ }
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
    senderKeysRef.current.clear();
    // 6.12: every protocol-4 session and chain goes; the replay window is written now.
    p4Ref.current?.clear();
    p4Ref.current = null;
    fileKeysRef.current.clear();
    peerRefsRef.current.clear();
    setP4Peers({});
    setHubProven(null);
    void replayStoreRef.current?.flush();
    mediaE2eeRef.current.close();
    setMediaStates({});
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
      systemMessage(t(lang, "app.sessionEnded"));
    }
  }

  async function sendChatPayload(
    text: string,
    opts: {
      attachment?: AttachmentMeta; send?: SendState; targets?: Set<string>; toNames?: string[];
      replyTo?: { id: string; senderName: string; text: string }; forwardedFrom?: string;
      /** Signed-in members the server holds this message for. */
      away?: AwayPeer[];
      /** 4.15: this message carries the Markdown output of a chat command (5.3: and its outputs, session…). */
      fn?: FnMeta;
      /** 5.3: the sender's own copy keeps the full outputs (the room's may leave large media out). */
      fnLocal?: FnMeta;
      /** 6.10: sent from elsewhere (the NFC workbench) — the composer's draft and its reply stay. */
      keepComposer?: boolean;
      /** 6.11: the message's id, when the caller needs it up front (a model's answer quotes it). */
      id?: string;
      /** 6.11: the sender's own copy quotes this instead (a room answer: the whole call here, only "/keyword" for the room). */
      replyToLocal?: { id: string; senderName: string; text: string };
    } = {},
  ): Promise<boolean> {
    // 6.10: true when it went (sent, relayed or queued) — the NFC forward says so.
    if (!keyRef.current) return false;
    const { perMessage } = ttlForRoom();
    const ttlMinutes = perMessage > 0 ? perMessage : undefined;
    const createdAt = Date.now();
    const audit: MessageAudit[] = [{ state: "created", at: createdAt }];

    // Build the optional message-kind flags from the send options.
    const send = opts.send;
    const flags: MsgFlags = {};
    if (send?.tap) flags.tap = true;
    if (send?.vanishSeconds && send.vanishSeconds > 0) flags.vanishSeconds = send.vanishSeconds;
    if (opts.fn) flags.fn = opts.fn;

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
    const flagsOut = flags.tap || flags.vanishSeconds || flags.sealed || flags.fn ? flags : undefined;

    const payload = {
      id: opts.id ?? newId("msg"),
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
    // 6.12: each peer gets the strongest copy it can open (deliverToPeers:
    // protocol 4, else 3); away members theirs, sealed to their devices'
    // mailboxes (relayToAway). The room-key copy is made only when somebody
    // has nothing better — a peer without a session, an away member without
    // a known mailbox — and the info view names who that was.
    let roomCopy: Promise<DataChannelEnvelope | null> | null = null;
    const roomEnvelope = () => (roomCopy ??= sealForRoom(payload));
    audit.push({ state: "encrypted", at: Date.now() });
    const delivered = await deliverToPeers(payload, roomEnvelope, opts.targets);
    const sent = delivered.sent;
    // Away members are not on a data channel: the server takes the ciphertext
    // for them and answers with "stored" / "delivered".
    const away = opts.away ?? [];
    const relay = await relayToAway(payload, roomEnvelope, away, send?.sealed ? undefined : text);
    const relayed = relay.count;
    if (relay.mailbox) delivered.kinds.add("p4-mailbox");
    if (relay.roomKeyFor.length) {
      delivered.kinds.add("room");
      audit.push({ state: "encrypted", at: Date.now(), meta: tf(lang, "sec.sealedHow.roomFor", { names: relay.roomKeyFor.join(", ") }) });
    }
    // Nobody could take it: in light mode it waits in the outbox and the
    // bubble shows it as sending, rather than the message being refused.
    // 6.10 (G-10): a private send whose chosen people are all unreachable is
    // refused instead — the outbox reads "no targets" as the whole room.
    // 6.12: what waits is the payload under a key of this page only; it is
    // sealed for each peer when it goes (deliverQueuedRef).
    const queueFor = queueTargets(opts.targets);
    const queued = sent === 0 && relayed === 0 && queueFor !== null
      && outboxRef.current.add({
        messageId: payload.id,
        room: roomRef.current ?? "",
        envelope: await payloadSealerRef.current.seal(payload.id, payload),
        targets: queueFor,
        toNames: opts.toNames ?? [],
        createdAt: createdAt,
        expiresAt: computeExpiry(ttlMinutes, createdAt) ?? 0,
      }) !== null;
    audit.push(queued
      ? { state: "queued", at: Date.now(), meta: opts.toNames?.join(", ") }
      : { state: "sent", at: Date.now(), meta: tf(lang, sent + relayed === 1 ? "app.recipients.one" : "app.recipients.many", { n: sent + relayed }) });
    if (queued) setQueuedIds((cur) => new Set(cur).add(payload.id));

    if (sent > 0 || relayed > 0 || queued) {
      cx("sent");
      if (payload.attachment) cx("file-sent", payload.attachment.name, { bytes: payload.attachment.size });
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
          flags: flagsOut && opts.fnLocal ? { ...flagsOut, fn: opts.fnLocal } : flagsOut,
          to: opts.toNames,
          sealPlain,
          sealCode,
          audit,
          cipher: delivered.cipher,
          sealedWith: bestSealing(delivered.kinds),
          sealedHow: [...delivered.kinds],
          replyTo: opts.replyToLocal ?? opts.replyTo,
          forwardedFrom: opts.forwardedFrom,
        },
      ]);
      if (!opts.keepComposer) {
        setMessageInput("");
        setReplyingTo(null);
      }
      if (queued) {
        systemMessage(t(lang, "app.waitingForRecipient"));
      }
      return true;
    }
    setNotice(t(lang, queueFor === null ? "app.privateNobody" : "app.queueFailed"));
    return false;
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

  /** 5.2: the characters that start a command, from the console (Modules & groups › Message input). */
  const composerTriggers = clientConfig.composer?.triggers ?? DEFAULT_COMPOSER.triggers;
  const commandChars = composerTriggers.filter((x) => x.action === "functions").map((x) => x.char);

  /** Asks the server for the commands (at most every 10 s unless forced). */
  async function refreshCommands(force: boolean): Promise<Command[]> {
    if (!force && Date.now() - commandsAtRef.current < 10_000) return commands;
    commandsAtRef.current = Date.now();
    const st = await fetchCommandState(accountToken() ?? null);
    setCommandsEnabled(st.enabled);
    setCommands(st.commands);
    return st.commands;
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = messageInput.trim();
    if (!text) return;
    // A "/keyword" that matches a known command runs a function instead of
    // sending text; an unknown slash word is sent as an ordinary message.
    const parsed = parseCommandLine(text, commandChars);
    const command = parsed ? commands.find((c) => c.keyword === parsed.keyword) : undefined;
    if (parsed && command) { await runChatCommand(command, parsed.argText); return; }
    // A command we do not know yet (the list is a minute old): ask the server again, then run it.
    if (parsed && commandsEnabled !== false) {
      const fresh = await refreshCommands(true);
      const late = fresh.find((c) => c.keyword === parsed.keyword);
      if (late) { await runChatCommand(late, parsed.argText); return; }
    }
    // 5.3: a reply to a model's message goes to its response entry point (in that message's processing session).
    const replied = replyingTo ? messages.find((m) => m.id === replyingTo.id) : undefined;
    const target = replied?.flags?.fn;
    if (replyingTo && replied && target?.chain && (target.events ? target.events.includes("response") : commands.find((c) => c.keyword === target.keyword)?.events?.includes("response"))) {
      // 6.10 (G-14): the reply is the function's input — the server reads it (and the quote); a seal would only pretend.
      if (sendOpts.sealed) { setNotice(t(lang, "app.fnReply.sealed")); return; }
      const quote = { id: replyingTo.id, senderName: replyingTo.senderName, text: replyingTo.text };
      // 6.11: the model's answer to this reply quotes it.
      const replyId = newId(isModelSender(replied.senderId) ? "fnreply" : "msg");
      if (isModelSender(replied.senderId)) {
        // The model's message was only here (caller-only): so is the reply.
        setMessages((cur) => [...cur, { id: replyId, senderId: myIdRef.current || "me", senderName: nameRef.current || "me", text, createdAt: Date.now(), mine: true, secure: true, replyTo: quote, audit: [{ state: "displayed" as const, at: Date.now() }] }]);
        setMessageInput("");
        setReplyingTo(null);
      } else {
        const rec = resolveRecipients();
        if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
        await sendChatPayload(text, { send: sendOpts, targets: rec.targets, toNames: rec.toNames, away: rec.away, replyTo: quote, id: replyId });
      }
      await fnEvent(target, { type: "response", text, message: { text: replyingTo.text } }, { id: replyId, senderName: nameRef.current || "me", text: text.slice(0, 200) });
      return;
    }
    // 6.8: "Send as voice" ticked in the send options — the text goes as a voice
    // message instead (sealed or too long: neither, with the reason). Commands
    // and replies to a function's message above stay text: they are input for it.
    await sendFromComposer(text, sendOpts, {
      text: async () => {
        const rec = resolveRecipients();
        if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
        await sendChatPayload(text, { send: sendOpts, targets: rec.targets, toNames: rec.toNames, away: rec.away, replyTo: replyingTo ?? undefined });
      },
      voice: () => sendTextAsVoice(text, true, replyingTo ?? undefined),
      refuse: (error) => setNotice(tf(lang, `speakSend.err.${error}`, { max: SPEAK_SEND_MAX })),
    });
  }

  /** 5.2 / 6.11: what typing a trigger character offers — "/" commands and models (at the start),
   *  "@" the people in the room, "#" tags (at the start of a word), a command argument's values —
   *  ranked, in sections, with the argument hint (lib/suggest.ts, components/CommandSuggest.tsx). */
  const suggestPeople = useMemo(() => [
    ...peers.map((p) => ({ name: p.name, avatar: peerProfiles[p.id]?.avatar })),
    ...awayPeers.map((a) => ({ name: a.name, away: true })),
  ], [peers, awayPeers, peerProfiles]);
  const suggestTags = useMemo(() => {
    const seen = new Set<string>(clientConfig.composer?.tags ?? []);
    for (const msg of messages.slice(-300)) for (const tag of tagsIn(msg.text || "")) seen.add(tag);
    return [...seen];
  }, [messages, clientConfig.composer?.tags]);
  const composerSuggest = useComposerSuggest({
    lang,
    text: messageInput,
    setText: setMessageInput,
    inputId: "message",
    triggers: composerTriggers,
    commands,
    commandsEnabled,
    people: suggestPeople,
    tags: suggestTags,
    user: account?.username ?? account?.id ?? "local",
  });
  /** A command that runs closes the list (runChatCommand). */
  const setCmdOpen = (open: boolean) => { if (!open) composerSuggest.dismiss(); };

  /** 6.3 nfc: a running model asked to drive this device's NFC hardware. An
   *  "nfc" interaction is not a dialog — run the command on the caller's NFC
   *  bridge (bridge.ts; the web workbench or the Android service registers the
   *  executor) and answer with the NfcResult; other interactions open the dialog.
   *  6.11: the run's clock (`guard`) stands still while the question is open. */
  function handleFnInteraction(i: Interaction, guard?: RunGuard) {
    if (i.kind === "nfc") {
      const runId = i.runId || runCmdRunIdRef.current || "";
      const token = runCmdTokenRef.current;
      void (async () => {
        let command = (i.spec.command ?? { op: "scan" }) as NfcCommand;
        // 6.6: an e-ID read without the key — the holder types it HERE; it is used for
        // this read only and never goes to the server (run inputs are kept there).
        if (needsDocumentKey(command)) {
          const values = await askDocumentKey();
          if (!values) { await answerInteraction(runId, i.id, { status: "timeout", message: "Cancelled" }, token); return; }
          command = withDocumentKey(command, values);
        }
        const result: NfcResult = await runNfcCommand(command).catch((e) => ({ status: "error" as const, message: e instanceof Error ? e.message : String(e) }));
        // 6.10 (G-17): what the read found goes to the server and the model only with the
        // holder's yes — the dialog names it and the model; masked unless they send it all.
        const consent = nfcConsent(result);
        if (consent.sensitive) {
          const choice = await askNfcConsent(consent, fnRunRef.current);
          if (!choice) { await answerInteraction(runId, i.id, { status: "denied", ...(result.card ? { card: result.card } : {}), message: "The holder did not send the card's data to the model." }, token); return; }
          await answerInteraction(runId, i.id, choice === "full" ? result : maskNfcResult(result), token);
          return;
        }
        await answerInteraction(runId, i.id, result, token);
      })().catch(() => undefined).finally(() => guard?.resume());
      return;
    }
    if (guard) askGuardsRef.current.set(i.id, guard);
    setInteraction(i);
  }

  /** 6.10 (G-17): which model's run is asking (named in the consent dialog). */
  const fnRunRef = useRef("");
  /** 6.10 (G-17): asks the holder, locally, whether a model may have what an NFC read found — "masked", "full" or null. */
  function askNfcConsent(c: NfcConsent, model: string): Promise<"masked" | "full" | null> {
    const p = consentPrompt(c, model, (key, vars) => tf(lang, key, vars ?? {}));
    return new Promise((resolve) => {
      const id = `local_consent_${Date.now().toString(36)}`;
      localAskRef.current = { id, resolve: (v) => resolve(p.pick(v)) };
      setInteraction({ runId: "", id, kind: "prompt", spec: { title: p.title, text: p.text, choices: p.choices } as unknown as Interaction["spec"] });
    });
  }

  /** 6.6: asks for the document key in the interaction dialog, locally (nothing is sent). */
  const localAskRef = useRef<{ id: string; resolve: (v: unknown) => void } | null>(null);
  function askDocumentKey(invalid = false): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const id = `local_${Date.now().toString(36)}`;
      localAskRef.current = { id, resolve: (raw) => { const v = raw && typeof raw === "object" ? raw as Record<string, unknown> : null; if (v && !documentKeyValid(v)) { void askDocumentKey(true).then(resolve); return; } resolve(v); } };
      setInteraction({
        runId: "", id, kind: "form",
        spec: {
          title: t(lang, "nfc.eid.formTitle"),
          text: `${t(lang, "nfc.eid.askText")}${invalid ? `\n${t(lang, "nfc.eid.askInvalid")}` : ""}`,
          submit: t(lang, "nfc.eid.askSubmit"),
          fields: DOCUMENT_KEY_FIELDS.map((f) => ({ name: f.name, label: t(lang, f.labelKey), placeholder: f.placeholder })),
        } as unknown as Interaction["spec"],
      });
    });
  }

  /** 6.11: what a model's answer replies to (a quote: the call, a reply, the message whose button / form it was). */
  type FnQuote = { id: string; senderName: string; text: string };
  /** 6.11: the model as its answers show it (the icon cleaned: a lucide name or an emoji). */
  const fnIdentity = (keyword: string, name: string, icon?: string) => modelIdentity({ keyword, name, icon: cleanModelIcon(icon ?? commands.find((c) => c.keyword === keyword)?.icon) });

  /**
   * Runs a chat command (6.5; 6.11). The call shows at once as the sender's own
   * bubble: the query, a pulse and a loading (with what the run says of its
   * progress), then a short status — answered, sent to the room, cancelled, or
   * an error with its reason. The model's answer is a SEPARATE incoming message
   * from system-messenger under the model's identity (its name, its icon), a
   * reply to the call: shown just here for a caller-only model, sent to the
   * room end-to-end encrypted for a room model. Inputs that cannot go to the
   * server as typed never do — system-messenger answers what is wrong and how
   * to call the model. A run without a sign of life for 30 s fails
   * (fn-run.ts); a newer command cancels the older one.
   */
  async function runChatCommand(command: Command, argText: string) {
    const inputs = buildInputs(command, argText);
    const queryText = `/${command.keyword}${argText.trim() ? ` ${argText.trim()}` : ""}`;
    setMessageInput("");
    setReplyingTo(null);
    setCmdOpen(false);
    const identity = fnIdentity(command.keyword, command.name, command.icon);
    const fn = { keyword: command.keyword, name: command.name, icon: identity.icon };
    const msgId = `fncall_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const quote: FnQuote = { id: msgId, senderName: nameRef.current || "me", text: queryText };
    // 6.11: inputs that are missing or wrong (and not left to the model's own form) stop here.
    const problems = checkCommandInputs(command, inputs);
    // 6.5: the call shows at once as the sender's own bubble — pulsing, with a loading under it.
    setMessages((cur) => [...cur, {
      id: msgId, senderId: myIdRef.current || "me", senderName: nameRef.current || "me",
      text: queryText, createdAt: Date.now(), mine: true, secure: true,
      flags: { fn: { ...fn, query: queryText, ...(problems.length ? { status: { kind: "error" as const, label: "", code: "bad-input" } } : { pending: true }) } },
      audit: [{ state: "displayed" as const, at: Date.now() }],
    }]);
    if (problems.length) {
      // Nothing goes to the server: system-messenger answers with what is wrong and how to call the model.
      addModelAnswer({ ...fn, outputs: usageCardOutputs(lang, command, { problems }) }, quote);
      return;
    }
    fnRunRef.current = `${command.name} (/${command.keyword})`;
    const token = accountToken() ?? null;
    // A newer command ends the older run: its call says "cancelled".
    runGuardRef.current?.cancel();
    runCmdTokenRef.current = token;
    runCmdMsgIdRef.current = msgId;
    const guard: RunGuard = guardRun({
      onStart: (id) => { runCmdRunIdRef.current = id; },
      onInteraction: (i) => handleFnInteraction(i, guard), // 6.3 nfc: routes "nfc" to the device bridge
      onProgress: (p, text) => patchFnCall(msgId, { progress: { p, text: text.slice(0, 200) } }),
      onEnd: (end) => {
        if (runGuardRef.current === guard) runGuardRef.current = null;
        closeAsks(guard);
        if (end.kind === "done") {
          const r = end.result;
          if (r.error && !r.handled) { failFnCall(msgId, command.keyword, r.error.message || t(lang, "functions.fail.unknown"), r.error.type); return; }
          showFnResult({ ...r, visibility: r.visibility ?? command.visibility }, fn, { ...(r.handled ? { origin: "error" as const } : {}), call: { id: msgId, query: queryText } });
          return;
        }
        if (end.kind === "cancelled") { settleFnCall(msgId, callOutcome(lang, command.keyword, end).status); return; }
        fnRunFailed(end, fn, { callId: msgId, quote });
      },
    });
    runGuardRef.current = guard;
    await guard.run((h, signal) => runCommandStream({ keyword: command.keyword, inputs, room: serverRoomId(keyRef.current), client: prefs.deviceId || null, lang, token, signal }, h));
  }

  /** 6.11: a run that failed (no sign of life, the connection lost, refused…): the call's error chip
   *  (no more loading), a flash naming the model and why — and for inputs the server refused, system-messenger's card. */
  function fnRunFailed(end: Exclude<RunEnd, { kind: "done" | "cancelled" }>, fn: { keyword: string; name: string; icon?: string }, at: { callId?: string; quote?: FnQuote }) {
    if (end.kind === "failed" && end.error.code === "bad-input") {
      const command = commands.find((c) => c.keyword === fn.keyword) ?? { keyword: fn.keyword, name: fn.name, inputs: [] };
      addModelAnswer({ ...fn, outputs: usageCardOutputs(lang, command, { server: end.error }) }, at.quote);
    }
    showCallOutcome(at.callId, callOutcome(lang, fn.keyword, end));
  }

  /** Replaces a call bubble's loading with an error status (the call stays visible); 6.11: and says so in a flash. */
  function failFnCall(msgId: string | undefined, keyword: string, reason: string, code?: string) {
    showCallOutcome(msgId, callFailure(lang, keyword, reason, code));
  }

  /** 6.11: a call's end without an answer — its bubble's chip, and the flash (when there is one). */
  function showCallOutcome(msgId: string | undefined, out: CallOutcome) {
    if (msgId) settleFnCall(msgId, out.status);
    if (!out.flash) return;
    if (prefsRef.current.flash.enabled) flashRef.current.push({ text: out.flash.text, detail: out.flash.detail, kind: "error" });
    else setNotice(`${out.flash.text}: ${out.flash.detail}`);
  }

  /** 6.11: a run that ended takes its open question with it. */
  function closeAsks(guard: RunGuard) {
    const ids = [...askGuardsRef.current].filter(([, g]) => g === guard).map(([id]) => id);
    for (const id of ids) askGuardsRef.current.delete(id);
    if (ids.length) setInteraction((cur) => (cur && ids.includes(cur.id) ? null : cur));
  }

  /**
   * 5.3: a model's answer as a message — its outputs rendered (buttons, forms,
   * sound, browser code…), their Markdown as the text. A model posting to the
   * room sends it end-to-end encrypted (large media stay with the caller); a
   * caller-only model shows it just here — as does a room model with nobody to send to.
   * 6.11: either way an incoming message from system-messenger under the
   * model's identity, a reply to `call` (the command's bubble, which gets a
   * short status) or to `quote`; the room's copy quotes only the "/keyword"
   * of the call (the room never saw its arguments) and names who sent it.
   */
  function showFnResult(r: RunDone, fallback: { keyword: string; name: string; icon?: string }, opts: { origin?: "error"; call?: { id: string; query: string }; quote?: FnQuote } = {}) {
    const outputs = r.outputs ?? [];
    const keyword = r.keyword || fallback.keyword;
    const name = r.name || fallback.name;
    const meta: FnMeta = {
      keyword, name, icon: fnIdentity(keyword, name, fallback.icon).icon,
      ...(r.model ? { model: r.model } : {}), ...(r.chain ? { chain: r.chain } : {}), ...(typeof r.call === "number" ? { call: r.call } : {}),
      ...(r.events?.length ? { events: r.events } : {}), ...(opts.origin ? { origin: opts.origin } : {}),
    };
    // The Markdown is the message's text (older apps, search, forwarding); only browser code or a panel has none — then the command's name.
    const text = outputsToMarkdown(outputs) || (outputs.length ? `/${keyword}` : tf(lang, "functions.empty", { name: meta.name }));
    const quote: FnQuote | undefined = opts.call ? { id: opts.call.id, senderName: nameRef.current || "me", text: opts.call.query } : opts.quote;
    const roomRec = r.visibility === "room" ? resolveRecipients() : null;
    if (roomRec) {
      // 6.5: the answer goes to the room as its own message; the caller's own
      // call bubble shows it was sent (its loading becomes a short status).
      if (opts.call) settleFnCall(opts.call.id, { kind: "ok", label: t(lang, "functions.sentToRoom") });
      const wireQuote = quote && opts.call ? { ...quote, text: `/${keyword}` } : quote;
      void sendChatPayload(text, {
        targets: roomRec.targets, toNames: roomRec.toNames, away: roomRec.away, forwardedFrom: `/${keyword}`,
        fn: { ...meta, outputs: shareableOutputs(outputs) }, fnLocal: { ...meta, outputs },
        ...(wireQuote ? { replyTo: wireQuote, replyToLocal: quote } : {}), keepComposer: true,
      }).catch(() => false).then((sent) => {
        if (sent) return;
        // Nobody could take it: the answer stays here.
        if (opts.call) settleFnCall(opts.call.id, { kind: "info", label: t(lang, "functions.shownHere") });
        addModelAnswer({ ...meta, outputs }, quote, text);
      });
      return;
    }
    if (r.visibility === "room") setNotice(tf(lang, "functions.localOnly", { name: meta.name }));
    if (opts.call) settleFnCall(opts.call.id, { kind: "ok", label: t(lang, "functions.answered") });
    addModelAnswer({ ...meta, outputs }, quote, text);
  }

  /** 6.11: a model's answer shown here — an incoming message from system-messenger, the model's name as its nickname, a reply to `quote`. */
  function addModelAnswer(meta: FnMeta, quote?: FnQuote, text?: string) {
    const at = Date.now();
    const body = text ?? (outputsToMarkdown(meta.outputs ?? []) || `/${meta.keyword}`);
    setMessages((cur) => [...cur, {
      id: newId("fn"), senderId: SYSTEM_MESSENGER_ID, senderName: meta.name,
      text: body, createdAt: at, mine: false, secure: true,
      flags: { fn: meta }, ...(quote ? { replyTo: quote } : {}), audit: [{ state: "displayed" as const, at }],
    }]);
  }

  /** 6.11: changes a call bubble's fn flag (its progress; settled: no more loading or progress). */
  function patchFnCall(msgId: string, patch: Partial<FnMeta>) {
    setMessages((cur) => cur.map((m) => {
      if (m.id !== msgId || !m.flags?.fn) return m;
      const { progress: _progress, ...settled } = m.flags.fn;
      return { ...m, flags: { ...m.flags, fn: { ...(patch.pending === false ? settled : m.flags.fn), ...patch } } };
    }));
  }

  /** 6.5: ends a call bubble's loading with a short status (no inline result). */
  function settleFnCall(msgId: string, status: FnStatus) {
    patchFnCall(msgId, { pending: false, status });
  }

  /** 6.11: the model's message a click / form / report came from (what its answer quotes). */
  function fnSourceQuote(meta: FnMeta): FnQuote | undefined {
    const m = [...messagesRef.current].reverse().find((x) => x.flags?.fn && x.flags.fn.chain === meta.chain && x.flags.fn.call === meta.call && x.flags.fn.query === undefined);
    if (!m) return undefined;
    // The quote is plain text: the message's Markdown without its marks.
    return { id: m.id, senderName: modelAnswerView(m) ? m.flags!.fn!.name : m.senderName, text: (m.text || "").replace(/[*_`#>|[\]]+/g, "").replace(/\s+/g, " ").trim().slice(0, 200) };
  }

  /** 5.3: a click, a form or a reply for a model's message — its entry point answers in that message's processing session.
   *  6.11: guarded like a command (the clock, ends once); the answer quotes `quote` (the reply) or the message it came from. */
  async function fnEvent(meta: FnMeta, ev: Exclude<FnEventBody, { type: "error" | "log" }>, quote?: FnQuote): Promise<boolean> {
    if (!meta.chain) return false;
    fnRunRef.current = `${meta.name} (/${meta.keyword})`;
    const token = accountToken() ?? null;
    const source = quote ?? fnSourceQuote(meta);
    const fn = { keyword: meta.keyword, name: meta.name, icon: meta.icon };
    let ok = false;
    const guard: RunGuard = guardRun({
      onStart: (id) => { runCmdRunIdRef.current = id; runCmdTokenRef.current = token; },
      onInteraction: (i) => handleFnInteraction(i, guard), // 6.3 nfc: routes "nfc" to the device bridge
      onEnd: (end) => {
        closeAsks(guard);
        if (end.kind === "done") {
          const r = end.result;
          if (r.error && !r.handled) {
            failFnCall(undefined, meta.keyword, r.error.message || t(lang, "functions.fail.unknown"));
            systemMessage(tf(lang, "fnui.eventFailed", { keyword: meta.keyword, message: r.error.message }), { kind: "error", chatOnly: true });
            return;
          }
          ok = true;
          showFnResult({ ...r, visibility: r.visibility ?? "caller" }, fn, { ...(r.handled ? { origin: "error" as const } : {}), ...(source ? { quote: source } : {}) });
          return;
        }
        if (end.kind === "cancelled") return;
        if (end.kind === "failed" && end.error.code === "expired") { systemMessage(tf(lang, "fnui.expired", { keyword: meta.keyword }), { kind: "warning" }); return; }
        fnRunFailed(end, fn, { quote: source });
        systemMessage(tf(lang, "fnui.eventFailed", { keyword: meta.keyword, message: runFailure(lang, end).reason }), { kind: "error", chatOnly: true });
      },
    });
    await guard.run((h, signal) => sendFnEventStream({ model: meta.model, keyword: meta.keyword, chain: meta.chain!, call: meta.call, room: serverRoomId(keyRef.current), client: prefs.deviceId || null, lang, token, signal }, ev, h));
    return ok;
  }

  fnEventRef.current = fnEvent;
  fnReportRef.current = fnReport;

  /** 5.3: an output the browser could not show, or a line from browser code — logged with the run; the error entry point may answer. */
  async function fnReport(meta: FnMeta, ev: Extract<FnEventBody, { type: "error" | "log" }>): Promise<void> {
    if (!meta.chain) return;
    const r = await sendFnReport({ model: meta.model, keyword: meta.keyword, chain: meta.chain, call: meta.call, room: serverRoomId(keyRef.current), client: prefs.deviceId || null, lang, token: accountToken() ?? null }, ev);
    if (r && ev.type === "error" && !ev.fromError) {
      const source = fnSourceQuote(meta);
      showFnResult({ ...r, visibility: r.visibility ?? "caller" }, meta, { origin: "error", ...(source ? { quote: source } : {}) });
    }
  }

  /** Sends the caller's answer to a running command's question. */
  async function answerCurrentInteraction(value: unknown) {
    const i = interaction;
    if (!i) return;
    setInteraction(null);
    // 6.6: a local question (the document key) is answered here, never sent.
    const local = localAskRef.current;
    if (local && local.id === i.id) { localAskRef.current = null; local.resolve(value ?? null); return; }
    // 6.11: answered (or dismissed) — the run's clock runs again.
    const guard = askGuardsRef.current.get(i.id);
    askGuardsRef.current.delete(i.id);
    guard?.resume();
    await answerInteraction(i.runId || runCmdRunIdRef.current || "", i.id, value, runCmdTokenRef.current);
  }

  function onMessageVanished(id: string) {
    const at = Date.now();
    setMessages((cur) => cur.map((m) => (m.id === id ? { ...withAudit(m, "expired", at), vanished: true, vanishedAt: m.vanishedAt ?? at } : m)));
  }

  /** 6.2: a step of a message's timeline (revealed, opened…). */
  function addStep(id: string, state: MsgState, meta?: string) {
    const at = Date.now();
    setMessages((cur) => {
      let changed = false;
      const next = cur.map((m) => {
        if (m.id !== id) return m;
        const out = withAudit(m, state, at, meta);
        if (out !== m) changed = true;
        return out;
      });
      return changed ? next : cur;
    });
  }

  /*
   * 6.2: hide and delete, in this browser's view only (message-hide.ts). The
   * stored history follows (persistTick), and the server's audit journal is
   * told that it happened — the action, the message id, the room's blind id,
   * kinds, mine, a hide's end; never the text, a file or a key. Only to this
   * site's own server: a room on another server stays unknown here.
   */
  const auditQueueRef = useRef<ReturnType<typeof createAuditQueue> | null>(null);
  if (!auditQueueRef.current) {
    auditQueueRef.current = createAuditQueue((body) => postMessageAudit(body, accountToken()), { client: () => prefsRef.current.deviceId || undefined });
  }
  const [persistTick, setPersistTick] = useState(0);
  useEffect(() => { if (persistTick > 0) void persistChat(true).catch(() => undefined); }, [persistTick]); // eslint-disable-line react-hooks/exhaustive-deps

  function journal(action: MessageAuditAction, m: ChatMessage, at: number, until?: number) {
    const blindRoom = keyRef.current?.roomId;
    if (!blindRoom || !onHomeServer()) return;
    auditQueueRef.current!.push(auditEntry(action, m, blindRoom, at, until));
  }

  function hideMsg(id: string, choice: HideChoice) {
    const at = Date.now();
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m || isDeleted(m)) return;
    const until = hideUntil(choice, at);
    setMessages((cur) => cur.map((x) => (x.id === id ? hideMessage(x, until, at) : x)));
    setMsgInfoFor(null);
    setPersistTick((n) => n + 1);
    journal("hide", m, at, until);
  }

  function unhideMsg(id: string) {
    const at = Date.now();
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m?.hidden) return;
    setMessages((cur) => cur.map((x) => (x.id === id ? unhideMessage(x, at) : x)));
    setPersistTick((n) => n + 1);
    journal("unhide", m, at);
  }

  function deleteMsg(id: string) {
    const at = Date.now();
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m || isDeleted(m)) return;
    // A received big file lives in this page's memory as a blob: URL — let it go.
    const url = m.attachment?.dataUrl ?? "";
    if (url.startsWith("blob:")) { forgetBlob(url); try { URL.revokeObjectURL(url); } catch { /* already gone */ } }
    setMessages((cur) => cur.map((x) => (x.id === id ? deleteMessage(x, at) : x)));
    setMsgInfoFor(null);
    if (replyingTo?.id === id) setReplyingTo(null);
    setPersistTick((n) => n + 1);
    journal("delete", m, at);
  }

  /** Record that a message became visible (adds a "displayed" audit event once). */
  function onMessageDisplayed(id: string) {
    setMessages((cur) => cur.map((m) => {
      if (m.id !== id || m.audit?.some((a) => a.state === "displayed")) return m;
      // A message the server relayed to us: tell the sender it was read.
      sendReadReceipt(id);
      // 6.1: one that came over a channel: a read receipt to its sender (room setting readReceipts).
      const cameDirect = m.audit?.some((a) => a.state === "received" && a.meta !== "relay");
      const sec = (roomRef.current && prefsRef.current.roomSecurity[roomRef.current]) || DEFAULT_ROOM_SECURITY;
      if (!m.mine && cameDirect && sec.readReceipts) queueReceipt(m.senderId, "read", m.id);
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
    // 6.10 (G-13): forwarded as it was — tap / vanish kept, an own sealed message sealed again with its code; one without the code is refused.
    const plan = forwardPlan(m);
    if (!plan.ok) { setNotice(t(lang, "app.forward.sealed")); return; }
    await sendChatPayload(plan.text, {
      attachment: m.attachment,
      send: plan.send,
      targets: rec.targets,
      toNames: rec.toNames,
      away: rec.away,
      forwardedFrom: m.forwardedFrom || m.senderName,
    });
    setNotice(t(lang, "app.forwarded"));
  }

  /** Scroll the conversation to a message by id (reply source jump). */
  function scrollToMessage(id: string) {
    const el = document.querySelector(`[data-testid="message-${id}"]`);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("msg-flash"); window.setTimeout(() => el.classList.remove("msg-flash"), 1200); return; }
    // Older than the rendered window: widen it, then jump once it is drawn.
    const at = visibleMessages.findIndex((m) => m.id === id);
    if (at < 0) return;
    const needed = newestFirst ? at + 1 : visibleMessages.length - at;
    setMessageWindow((n) => Math.max(n, Math.ceil(needed / MESSAGE_WINDOW) * MESSAGE_WINDOW));
    window.setTimeout(() => { if (document.querySelector(`[data-testid="message-${id}"]`)) scrollToMessage(id); }, 60);
  }

  /** 6.12 (§ 12.1): the sender's identity, worded honestly — "verified" only when the user compared. */
  function identityLine(id: MessageIdentity): { text: string; tone: "ok" | "warn" | "muted" } {
    const key = id.accepted && id.state !== "verified" ? "sec.identity.accepted"
      : id.state === "verified"
        // Stored before 6.12, "verified" without `checked` meant only "the same key as before".
        ? (id.checked ? "sec.identity.checked" : "sec.identity.known")
        : id.state === "new"
          ? (id.account ? "sec.identity.newAccount" : id.firstSeen ? "sec.identity.new" : "sec.identity.known")
          : id.state === "changed"
            ? (id.revoked ? "sec.identity.revoked" : "sec.identity.changed")
            : `sec.identity.${id.state}`;
    const extra = [id.certV1 ? t(lang, "sec.identity.certV1") : "", id.protocol === 3 ? t(lang, "sec.identity.legacy") : ""].filter(Boolean);
    const text = t(lang, key).replace("{fp}", id.fingerprint ?? "") + (extra.length ? ` · ${extra.join(" · ")}` : "");
    const tone = id.state === "verified" && id.checked ? "ok" as const
      : id.state === "unsigned" || id.state === "new" || (id.state === "verified" && !id.checked) || id.accepted ? "muted" as const
      : "warn" as const;
    return { text, tone };
  }

  /** Assemble the info + audit trail shown for a single message. */
  function buildMessageInfo(m: ChatMessage): MessageInfo {
    const peer = m.mine ? undefined : peersRef.current.get(m.senderId);
    const net = m.mine ? undefined : peerNetRef.current.get(m.senderId);
    const plain = m.flags?.sealed ? (m.mine ? m.sealPlain : undefined) : m.text;
    const identity = m.mine
      ? (identityRef.current ? { text: `${t(lang, "sec.myFingerprint")} · ${identityRef.current.fingerprint}`, tone: "ok" as const } : undefined)
      : m.identity ? identityLine(m.identity) : undefined;
    const p4Sealed = (m.sealedHow ?? (m.sealedWith ? [m.sealedWith] : [])).some((k) => k.startsWith("p4-"));
    return {
      id: m.id,
      identity,
      cryptoVersion: m.mine ? (p4Sealed ? 4 : 3) : m.cryptoVersion,
      sealedWith: m.sealedWith,
      sealedHow: m.mine && m.sealedHow && m.sealedHow.length > 1 ? m.sealedHow.map((k) => t(lang, `sec.sealed.${k}`)) : undefined,
      mine: m.mine,
      sender: m.senderName,
      senderId: m.senderId,
      recipients: m.to && m.to.length > 0 ? m.to : [t(lang, "recipients.everyone")],
      ip: net?.ip,
      route: m.mine ? t(lang, "app.route.outgoing") : net?.candidateType === "relay" ? t(lang, "app.route.turn") : peer ? t(lang, "app.route.direct") : "—",
      createdAt: m.createdAt,
      secure: m.secure,
      cipher: m.cipher,
      plaintext: plain,
      flags: [m.flags?.tap ? t(lang, "msgkind.tap") : "", m.flags?.vanishSeconds ? t(lang, "msgkind.vanish") : "", m.flags?.sealed ? t(lang, "msgkind.sealed") : ""].filter(Boolean),
      // 6.2: every state with its time, every kind, the size, receipts by recipient, a hide.
      audit: timelineOf(m),
      kinds: messageKinds(m).map((k) => t(lang, `msgkind.k.${k}`)),
      size: messageSize(m),
      expiresAt: m.expiresAt || undefined,
      receipts: receiptsOf(m),
      hiddenUntil: m.hidden && isHidden(m, Date.now()) ? m.hidden.until : undefined,
      attachment: m.attachment && m.attachment.dataUrl ? { name: m.attachment.name, mime: m.attachment.mime, size: m.attachment.size, url: m.attachment.dataUrl } : undefined,
    };
  }

  /** Assemble the info shown when a participant's avatar/name is clicked. */
  function buildUserInfo(target: string): UserInfo {
    const self = target === "self" || target === myIdRef.current;
    if (self) {
      return {
        name: nameRef.current || prefs.name, peerId: myIdRef.current, self: true,
        username: sessionUserRef.current || (account ? account.username ?? account.id : undefined),
        connectedForMs: null, transport: "self", appType: "M5cet Web",
        usesServer: prefs.mode === "server", sentBytes: 0, recvBytes: 0,
        security: "AES-GCM 256 (E2EE)",
        // 6.7: how room members see me.
        ...(card ? { avatar: card.avatar.value || undefined, profile: { room: myRoomView(card), self: true } } : {}),
      };
    }
    const handle = peersRef.current.get(target);
    const st = peerStatsRef.current.get(target);
    const net = peerNetRef.current.get(target);
    const fp = peerFingerprints[target]?.digest;
    const pair = senderKeysRef.current.pairOf(target);
    const p4Info = p4Ref.current?.info(target) ?? null;
    const theirPk = p4Info?.pk || pair?.peerPublicKey || "";
    const theirApk = p4Info?.account?.valid ? p4Info.account.publicKey : null;
    const myApk = identityRef.current?.attestation?.accountKey ?? null;
    const open = handle?.channel?.readyState === "open";
    const transport: UserInfo["transport"] = !open ? "connecting" : net?.candidateType === "relay" ? "p2p-relay" : "p2p-direct";
    return {
      name: handle?.name || presence.book.heldEntry(target)?.name || awayPeers.find((a) => awayKey(a.accountId) === target)?.name || target.slice(-6), peerId: target, self: false,
      presence: presence.factsOf(target),
      username: peerUsersRef.current.get(target),
      connectedForMs: st ? Date.now() - st.openedAt : null,
      ip: net?.ip, candidateType: net?.candidateType, transport,
      appType: "M5cet Web", usesServer: prefs.mode === "server",
      sentBytes: st?.sent ?? 0, recvBytes: st?.recv ?? 0,
      security: fp ? "DTLS-SRTP + AES-GCM 256" : "AES-GCM 256 (E2EE)",
      fingerprint: fp ? formatFingerprint(fp) : undefined,
      // 6.7: what they share with the room, and the account key that signed their messages.
      avatar: peerProfiles[target]?.avatar,
      profile: { room: peerProfiles[target] ?? null, accountKey: peerAccountKeysRef.current.get(target) },
      ...(theirPk && identityRef.current ? {
        // 6.12 (§ 12.2): from the two ACCOUNT keys when both are attested (valid on every device), else the device keys.
        safety: {
          mine: theirApk && myApk ? myApk : identityRef.current.publicKey,
          theirs: theirApk && myApk ? theirApk : theirPk,
          verified: safetyVerified[theirPk] === true || Boolean(theirApk && trustRef.current.accountVerified(theirApk)),
          // The pin to mark: their account when attested (protocol 3: the account that signed their messages).
          onVerified: () => { void markSafetyVerified(handle?.name || target, theirPk, theirApk ?? peerAccountKeysRef.current.get(target) ?? null); },
          onExclude: () => excludePeer(target),
        },
      } : {}),
    };
  }

  const [safetyVerified, setSafetyVerified] = useState<Record<string, boolean>>({});

  /** Safety numbers compared (or the QR code scanned): pin as verified — an attested peer's account everywhere, else the device key for the name. */
  async function markSafetyVerified(name: string, publicKey: string, accountKey?: string | null) {
    await markVerified(pinsRef.current, trustRef.current, roomRef.current, name, { pk: publicKey, apk: accountKey });
    setSafetyVerified((cur) => ({ ...cur, [publicKey]: true }));
    // Messages already here from them now show as verified.
    const kid = await keyId(accountKey || publicKey);
    setMessages((cur) => cur.map((m) => (!m.mine && m.senderName === name && m.identity?.kid === kid && m.identity.state === "new" ? { ...m, identity: { ...m.identity, state: "verified" as const, checked: true } } : m)));
  }

  /** 6.12 (§ 12.1): the user accepted a changed key — the held messages show (not as verified). */
  function acceptChangedKey(m: ChatMessage) {
    const kid = m.identity?.kid;
    if (!kid || m.identity?.state !== "changed") return;
    void acceptChanged(pinsRef.current, roomRef.current, m.senderName, kid).then(() => {
      setMessages((cur) => cur.map((x) => (x.senderName === m.senderName && x.identity?.state === "changed" && x.identity.kid === kid && !x.identity.revoked ? { ...x, identity: { ...x.identity, state: "new" as const, accepted: true } } : x)));
    });
  }

  /** "Exclude from my messages": end the connection, remember the device key
   *  for this session, and start a new sender chain they will not get. */
  function excludePeer(peerId: string) {
    const pair = senderKeysRef.current.pairOf(peerId);
    const handle = peersRef.current.get(peerId);
    const pk = p4Ref.current?.info(peerId)?.pk ?? pair?.peerPublicKey;
    if (pk) excludedRef.current.add(pk);
    // 6.12 (§ 6): their chains and session go, ours start over (both protocols).
    if (p4Ref.current) { p4Ref.current.peerLeft(peerId); p4Ref.current.rotate(); }
    else { senderKeysRef.current.forgetPeer(peerId); senderKeysRef.current.rotate(); }
    mediaE2eeRef.current.forget(peerId);
    try { handle?.channel?.close(); } catch { /* ignore */ }
    try { handle?.pc.close(); } catch { /* ignore */ }
    if (handle) detachAudioElement(handle);
    peersRef.current.delete(peerId);
    profileExchange().forget(peerId);
    setPeers((current) => current.filter((p) => p.id !== peerId));
    setUserInfoFor(null);
    systemMessage(t(lang, "sec.excluded").replace("{name}", handle?.name || peerId.slice(-6)), { kind: "warning" });
  }

  /**
   * Send a chosen or recorded file to the current recipients. 6.7: `caption` —
   * the text that goes along ("" for a voice message made from that text); true when it went.
   * 6.8: `replyTo` — the message it answers (a voice message sent from the composer).
   */
  async function sendPickedFile(file: File, caption = messageInput.trim(), replyTo?: { id: string; senderName: string; text: string }): Promise<boolean> {
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return false; }
    // Sealing a binary body is not supported; tap/vanish apply inline, nothing applies to a large file.
    // 6.10 (G-13): what cannot apply is said and asked before the file goes — never sent plainer in silence.
    const kinds = attachmentKinds(sendOpts, file.size > INLINE_ATTACHMENT_LIMIT);
    if (kinds.dropped.length && !window.confirm(tf(lang, "app.send.kindsDropped", { what: kinds.dropped.map((k) => t(lang, `msgkind.${k}`)).join(", ") }))) return false;
    const attachOpts: SendState = kinds.send;
    try {
      if (file.size > INLINE_ATTACHMENT_LIMIT) {
        // Too big to embed in a chat envelope: same encrypted channel, sent in
        // 32 KiB chunks. Text typed alongside goes out as its own message.
        const text = caption;
        // 6.8: only to the chosen people when someone was chosen (before, a
        // large file went to the whole room whatever the selection).
        if (rec.targets && rec.targets.size === 0) { setNotice(t(lang, "files.chosenAway")); return false; }
        if (text) await sendChatPayload(text, { send: sendOpts, targets: rec.targets, toNames: rec.toNames });
        await sendLargeFileToAll(file, rec.targets);
        return true;
      }
      const attachment = await fileToAttachment(file);
      await sendChatPayload(caption, { attachment, send: attachOpts, targets: rec.targets, toNames: rec.toNames, replyTo });
      return true;
    } catch (err) {
      setNotice((err as Error).message);
      return false;
    }
  }

  /**
   * 6.7: speak and send — the text by the server's voice, sent as an E2EE voice message (no caption).
   * 6.8: also the composer's Send while "Send as voice" is ticked (`fromComposer`, with the reply it quotes).
   */
  async function sendTextAsVoice(text: string, fromComposer: boolean, replyTo?: { id: string; senderName: string; text: string }): Promise<boolean> {
    if (voiceBusy) return false;
    // Nobody to send it to: say so before the server is asked to speak the text.
    if (!resolveRecipients()) { setNotice(t(lang, "recipients.noneNotice")); return false; }
    setVoiceBusy(true);
    try {
      const made = await textToVoiceFile(text, {
        status: fetchServerSpeechStatus, tts: serverTtsBlob,
        // 6.10 (G-14): the first time in a room, say who reads the text (the server's speech provider) and ask.
        confirm: (provider) => serverVoiceConsent(roomRef.current ?? "", () => window.confirm(tf(lang, "speakSend.confirm", { provider }))),
      });
      if (!made.ok && made.error === "declined") return false;
      if (!made.ok) {
        const why = made.error === "tts-failed" ? tf(lang, "speakSend.err.tts-failed", { msg: made.message ?? "" }) : t(lang, `speakSend.err.${made.error}`);
        // From the composer the way out is the option itself: say where it is.
        setNotice(fromComposer && made.error === "no-tts" ? `${why} ${t(lang, "speakSend.offHint")}` : why);
        return false;
      }
      // A big voice message would go as a file transfer — to everyone, without tap / vanish.
      if (voiceTooBigFor(made.file.size, INLINE_ATTACHMENT_LIMIT, { toChosen: !widget.autoRoom, tap: sendOpts.tap, vanish: sendOpts.vanishSeconds > 0 })) {
        setNotice(t(lang, "speakSend.err.too-big"));
        return false;
      }
      const sent = await sendPickedFile(made.file, "", replyTo);
      if (sent && fromComposer) setMessageInput("");
      return sent;
    } finally {
      setVoiceBusy(false);
    }
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await sendPickedFile(file);
  }

  /* ------------------------------------------ 6.10: NFC outputs into the chat */
  // The NFC workbench's template output (NfcTemplatePanel): Forward — a room I
  // am in, then everyone or one member, as a message or a file — and To myself:
  // a note in the history of the room on screen that only I see and that is
  // never sent (ChatMessage.kind = "note" — the kind Android has; new in 6.10). A
  // background room only receives (room-hub.ts), so forwarding there brings it
  // on screen first (the smart switch) and waits until it has joined.
  nfcLatestRef.current = { sendChatPayload, sendLargeFileToAll, currentHubTarget, switchRoom };

  function nfcRooms(): ForwardRoom[] {
    const out: ForwardRoom[] = [];
    const cur = nfcLatestRef.current.currentHubTarget();
    if (cur && statusRef.current === "joined") {
      const members = [
        ...[...peersRef.current.values()].filter((p) => p.channel?.readyState === "open").map((p) => ({ id: p.id, name: p.name || p.id.slice(-4) })),
        ...awayPeersRef.current.map((a) => ({ id: awayKey(a.accountId), name: a.name })),
      ];
      out.push({ key: cur.key, label: cur.label, current: true, members });
    }
    for (const r of hub.list()) if (!out.some((o) => o.key === r.key) && r.status === "joined") out.push({ key: r.key, label: r.label, current: false, members: r.members ?? [] });
    return out;
  }

  async function nfcForward(target: ForwardTarget, body: ForwardBody): Promise<ChatResult> {
    const L = nfcLatestRef.current;
    const until = async (cond: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() >= end) return false; await new Promise((r) => window.setTimeout(r, 250)); }
      return true;
    };
    const open = (id: string) => peersRef.current.get(id)?.channel?.readyState === "open";
    let switched = false;
    if (L.currentHubTarget()?.key !== target.roomKey) {
      const bg = hub.list().find((r) => r.key === target.roomKey);
      if (!bg) return { ok: false, message: t(lang, "nfc.tpl.fwd.notJoined") };
      await L.switchRoom(target.roomKey);
      switched = true;
      if (!(await until(() => statusRef.current === "joined" && Boolean(keyRef.current) && roomRef.current === bg.room, 30_000))) return { ok: false, message: t(lang, "nfc.tpl.fwd.notJoined") };
    }
    let targets: Set<string> | undefined;
    let toNames: string[] | undefined;
    let away: AwayPeer[] = [];
    if (target.member) {
      // The room on screen knows the member by id; after a switch the ids are new — by name.
      const m = target.member;
      const peerId = () => (open(m.id) ? m.id : [...peersRef.current.values()].find((p) => p.name === m.name && open(p.id))?.id);
      const awayOne = () => awayPeersRef.current.find((a) => awayKey(a.accountId) === m.id || a.name === m.name);
      await until(() => Boolean(peerId() || awayOne()), switched ? 10_000 : 0);
      const id = peerId();
      const a = id ? undefined : awayOne();
      if (!id && !a) return { ok: false, message: m.name };
      targets = new Set(id ? [id] : []);
      toNames = [id ? peersRef.current.get(id)?.name || m.name : a!.name];
      away = a ? [a] : [];
    } else {
      // Everyone, present or away (whatever the recipients widget says).
      if (switched) await until(() => [...peersRef.current.values()].some((p) => open(p.id)) || awayPeersRef.current.length > 0, 8_000);
      away = awayPeersRef.current;
    }
    try {
      if (body.kind === "text") return { ok: await L.sendChatPayload(body.text, { targets, toNames, away, forwardedFrom: "NFC", keepComposer: true }) };
      if (body.file.size > INLINE_ATTACHMENT_LIMIT) {
        // Too big for a message: the chunked transfer, to the people online (as a file picked by hand).
        if (targets && targets.size === 0) return { ok: false, message: t(lang, "files.chosenAway") };
        await L.sendChatPayload(body.caption, { targets, toNames, forwardedFrom: "NFC", keepComposer: true });
        await L.sendLargeFileToAll(body.file, targets);
        return { ok: true };
      }
      const attachment = await fileToAttachment(body.file);
      return { ok: await L.sendChatPayload(body.caption, { attachment, targets, toNames, forwardedFrom: "NFC", keepComposer: true }) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async function nfcNoteToSelf(body: { text: string; file?: File }): Promise<ChatResult> {
    const room = roomRef.current;
    if (!room) return { ok: false, message: t(lang, "nfc.tpl.self.noRoom") };
    let attachment: AttachmentMeta | undefined;
    try { if (body.file) attachment = await fileToAttachment(body.file); } catch (err) { return { ok: false, message: (err as Error).message }; }
    const at = Date.now();
    setMessages((cur) => [...cur, {
      id: newId("note"), senderId: myIdRef.current || "me", senderName: nameRef.current || "me",
      text: body.text, createdAt: at, mine: true, secure: true, ...(attachment ? { attachment } : {}),
      kind: "note", to: [t(lang, "nfc.note.onlyMe")],
      audit: [{ state: "created", at, meta: "note to self — kept here, never sent" }],
    }]);
    setPersistTick((n) => n + 1);
    return { ok: true, message: tf(lang, "nfc.tpl.self.saved", { room: activeProfileRef.current?.label ?? room }) };
  }

  nfcChatImplRef.current = { rooms: nfcRooms, forward: nfcForward, noteRoom: () => (roomRef.current ? activeProfileRef.current?.label ?? roomRef.current : null), noteToSelf: nfcNoteToSelf };

  function insertEmoji(emoji: string) {
    setMessageInput((current) => `${current}${emoji}`);
    setEmojiOpen(false);
  }

  async function startAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice(t(lang, "app.media.unavailable"));
      return;
    }
    try {
      setAudioStatus("joining");
      callIdRef.current = newId("call"); // 6.12 (§ 9): the media keys of this call are its own
      const stream = await openMic({ audio: true, video: false }); // 6.7: through the voice changer when it is on
      localAudioStreamRef.current = stream;
      const tracks = stream.getAudioTracks();
      peersRef.current.forEach((peer) => {
        tracks.forEach((track) => {
          const sender = peer.pc.addTrack(track, stream);
          mediaE2eeRef.current.protectSender(peer.pc, sender, peer.id);
          peer.outgoingAudioSenders.push(sender);
        });
        // Either side may add a track: negotiationneeded sends the offer.
      });
      setAudioStatus("live");
      await broadcastAudioStatus("live");
      systemMessage(t(lang, "app.audio.live"));
    } catch (err) {
      setAudioStatus("off");
      setNotice(tf(lang, "app.audio.failed", { msg: (err as Error).message }));
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
    systemMessage(t(lang, "app.audio.left"));
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
        setNotice(t(lang, "app.notify.unavailable"));
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotice(t(lang, "app.notify.denied"));
        return;
      }
      setPrefs({ notificationsEnabled: true });
      systemMessage(t(lang, "app.notify.local"));
      return;
    }

    const result = await subscribeToPush(pushVapidKey, prefs.deviceId);
    if (result.ok) {
      setPrefs({ notificationsEnabled: true });
      // 6.7: signed in already — the account gets this browser now, not at the next sign-in.
      prefsRef.current = { ...prefsRef.current, notificationsEnabled: true };
      if (accountRef.current) await linkPushForAccount();
      systemMessage(t(lang, "app.notify.push"));
    } else {
      setNotice(result.reason || t(lang, "app.notify.pushFailed"));
    }
  }

  function disableNotifications() {
    setPrefs({ notificationsEnabled: false });
    prefsRef.current = { ...prefsRef.current, notificationsEnabled: false };
    // 6.7: and the server stops waking this browser (it kept the link until the subscription died).
    if (accountRef.current && "serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistration()
        .then((reg) => reg?.pushManager.getSubscription())
        .then((sub) => (sub ? unlinkPushSubscription(sub.endpoint) : false))
        .catch(() => false);
    }
    systemMessage(t(lang, "app.notify.off"));
  }

  function clearLocalData() {
    clearPreferences();
    setPrefsState((current) => ({ ...current })); // trigger re-render
    setNotice(t(lang, "app.prefsPurged"));
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
    // 6.11: while the suggester is open, ↑ ↓ PageUp PageDown Home End, Enter / Tab and Esc drive it; Ctrl+Space opens it.
    if (composerSuggest.onKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composerSuggest.noteSent(messageInput);
      void sendMessage();
    }
  }

  // The chat commands this user may run ("/keyword"): fetched when signed in
  // or connected changes, refreshed as the operator adds models. 6.0: only a
  // new account forces it — a connection that flaps (connecting, offline,
  // joined…) no longer asks the server on every step (at most every 10 s).
  const commandsAccountRef = useRef<unknown>(undefined);
  useEffect(() => {
    const accountChanged = commandsAccountRef.current !== account;
    commandsAccountRef.current = account;
    void refreshCommands(accountChanged);
    // 5.2: refreshed every minute and when the tab comes back, so new models show up.
    const timer = window.setInterval(() => void refreshCommands(false), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refreshCommands(false); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, status]);

  // 5.2: a "#tag" clicked in a message filters the conversation (again: clears it).
  useEffect(() => {
    const onTag = (e: Event) => { const tag = String((e as CustomEvent).detail || ""); setTagFilter((cur) => (cur === tag ? null : tag || null)); };
    window.addEventListener("m5:tag", onTag);
    return () => window.removeEventListener("m5:tag", onTag);
  }, []);
  useEffect(() => { setTagFilter(null); }, [room]);

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
      // A saved connection can opt out of "reconnect when the network returns".
      const allowed = !activeProfileRef.current || connectionsRef.current!.get().settings.reconnectOnResume;
      if (allowed && intentRef.current && socketRef.current?.readyState !== WebSocket.OPEN) {
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
      systemMessage(tf(lang, "app.outboxSent", { n: result.delivered }));
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
    hubRef.current?.setForeground(false);
    if (!connected) return;
    // 6.7: the room sees us go to the background (presence, last seen) — and,
    // server-enhanced and signed in, the server answers for us meanwhile.
    const coverMe = Boolean(accountRef.current && retentionRef.current === "server");
    presence.signal.set({ away: coverMe, foreground: false }, event.final);
    suspendedStateRef.current.away = coverMe;
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
    hubRef.current?.setForeground(true);

    const resumeAllowed = !activeProfileRef.current || connectionsRef.current!.get().settings.reconnectOnResume;
    if (wanted?.desired === "connected" && !clientStoppedRef.current && resumeAllowed) {
      if (!connected) {
        // The socket did not survive: rebuild it and rejoin the same room.
        reconnectAttemptsRef.current = 0;
        void doConnect();
      } else {
        // Still connected: tell the server we are back. It answers with
        // everything it took for us while we were away (relay-deliver),
        // and the room sees peer-back — and (6.7) peer-presence.
        presence.signal.set({ away: false, foreground: true }, wanted.away);
        // Same session: settings and data stay; make sure the account is
        // still announced and the heartbeat is running.
        announceAccountToServer();
        startHeartbeat();
      }
    }
    // Light mode: whatever could not be delivered tries again now.
    void flushOutbox(t(lang, "app.outbox.resume"));
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
      void flushOutbox(t(lang, "app.outbox.retry"));
    }, 60_000);
    return () => { watcher.stop(); tick.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPageSuspend, onPageResume]);

  async function startVideoCall() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice(t(lang, "app.media.unavailable"));
      return;
    }
    try {
      setAudioStatus("joining");
      callIdRef.current = newId("call"); // 6.12 (§ 9): the media keys of this call are its own
      const stream = await openMic({ // 6.7: the voice through the voice changer when it is on
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      localVideoStreamRef.current = stream;
      localAudioStreamRef.current = stream;
      const tracks = stream.getTracks();
      peersRef.current.forEach((peer) => {
        tracks.forEach((track) => {
          const sender = peer.pc.addTrack(track, stream);
          mediaE2eeRef.current.protectSender(peer.pc, sender, peer.id);
          if (track.kind === "audio") peer.outgoingAudioSenders.push(sender);
        });
      });
      setAudioStatus("live");
      setVideoOn(true);
      setCallMode("video");
      await broadcastAudioStatus("live");
      systemMessage(t(lang, "app.video.started"));
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    } catch (err) {
      setAudioStatus("off");
      setNotice(tf(lang, "app.video.failed", { msg: (err as Error).message }));
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

  /** A file in chunks — to everyone in the room, or (6.8) only to `targets` (peer ids), then only over their direct channels. */
  async function sendLargeFileToAll(file: File, targets?: Set<string>) {
    const key = keyRef.current;
    identityRef.current ??= await loadIdentity().catch(() => null);
    if (!key) {
      setNotice(t(lang, "app.noRoomKey"));
      return;
    }
    // File size limit is now per-user (`prefs.maxAttachmentBytes`); there
    // is no longer a hard-coded cap. The default is unlimited
    // (Number.MAX_SAFE_INTEGER, see preferences.ts); Settings offers lower
    // caps such as 100 MB. Chunks are held in RAM until the transfer ends.
    if (file.size > prefs.maxAttachmentBytes && prefs.maxAttachmentBytes < Number.MAX_SAFE_INTEGER - 1) {
      setNotice(tf(lang, "app.fileTooLarge", { limit: formatBytes(prefs.maxAttachmentBytes) }));
      return;
    }

    // Files go peer-to-peer. When no direct channel came up (a strict NAT
    // without TURN) but somebody is in the room, the server relays the
    // encrypted chunks instead (proxy transport; it cannot read them). The
    // relay reaches the whole room, so a file for chosen people never takes it.
    const route = largeFileRoute<RTCDataChannel>(peersRef.current.entries(), targets);
    if (route.refused) {
      setNotice(t(lang, "files.chosenNoChannel"));
      return;
    }
    const channels = route.channels;
    const relayed = route.relay;
    if (relayed && (peersRef.current.size === 0 || socketRef.current?.readyState !== WebSocket.OPEN)) {
      setNotice(t(lang, "files.noPeer"));
      return;
    }

    // 6.12 (§ 8): protocol-4 peers get the file under a random key of its own
    // (FK), sent to each over its pair ratchet BEFORE the meta (the channel is
    // ordered); older peers — and the server's relay, which only carries a
    // file when no direct channel (so no session) exists — the protocol-3 key
    // derived from the room key, in a transfer of their own.
    if (relayed) { await sendFileTo(file, key, channels, true, null); return; }
    const p4 = p4Ref.current;
    const p4Channels: RTCDataChannel[] = [];
    const p4Ids: string[] = [];
    const legacyChannels: RTCDataChannel[] = [];
    for (const [id, p] of peersRef.current.entries()) {
      if (!p.channel || !channels.includes(p.channel)) continue;
      if (p4?.isP4(id)) { p4Channels.push(p.channel); p4Ids.push(id); }
      else if (p4?.protocolOf(id) !== "refused") legacyChannels.push(p.channel);
    }
    if (p4 && p4Channels.length) {
      const transferId = `xfer-${crypto.randomUUID()}`;
      const { inner, fk } = newFileKey(transferId);
      const keyed: RTCDataChannel[] = [];
      for (let i = 0; i < p4Ids.length; i++) if (await p4.sendInner(p4Ids[i], inner).catch(() => false)) keyed.push(p4Channels[i]);
      if (keyed.length) await sendFileTo(file, key, keyed, false, { transferId, fk });
      fk.fill(0);
    }
    if (legacyChannels.length) await sendFileTo(file, key, legacyChannels, false, null);
  }

  /** One transfer of a file to these channels (or the server's relay) — 6.12 under a protocol-4 FK when `p4` is given. */
  async function sendFileTo(file: File, key: RoomKeys, channels: RTCDataChannel[], relayed: boolean, p4: { transferId: string; fk: Uint8Array } | null) {
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
      const binary = serverBinaryRef.current ? binaryFrame(frame) : null;
      if (binary) sock.send(binary);
      else sock.send(JSON.stringify({ type: String(frame.kind), ...wireFrame(frame) }));
      return true;
    };

    const result = await sendFile({
      key,
      identity: identityRef.current,
      file,
      senderId: myIdRef.current,
      senderName: nameRef.current,
      channels,
      binary: (channel) => binaryChannelsRef.current.has(channel),
      sendProxy,
      paceProxy: relayed ? proxyPacer(proxyLimitsRef.current, () => socketRef.current) : undefined,
      ...(p4 ? { p4 } : {}),
      onTransport: (transport) => {
        // Re-key the tracking entry to the real transferId emitted by
        // sendFile; cheer the user with which transport was picked.
        systemMessage(
          transport === "p2p"
            ? tf(lang, "app.file.sendingP2p", { name: file.name, size: formatBytes(file.size) })
            : tf(lang, "app.file.sendingProxy", { name: file.name, size: formatBytes(file.size) }),
        );
        if (transport === "proxy") {
          setNotice(t(lang, "app.file.proxyNotice"));
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
      cx("file-sent", file.name, { bytes: file.size });
      systemMessage(
        result.transport === "p2p"
          ? tf(lang, "app.file.sentP2p", { name: file.name, size: formatBytes(file.size) })
          : tf(lang, "app.file.sentProxy", { name: file.name, size: formatBytes(file.size) }),
      );
    } else {
      updateTransfer(result.transferId || placeholderId, {
        status: result.reason === "cancelled" ? "cancelled" : "error",
        errorMessage: result.reason,
      });
      systemMessage(tf(lang, "app.file.sendFailed", { reason: result.reason || t(lang, "app.unknownReason") }));
    }
    void cancelled;
  }

  async function handleLargeFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // 6.10 (G-12): to the chosen people like a message (6.9: the whole room, whatever was chosen).
    const to = largeFileTargets(resolveRecipients());
    if (!to.ok) { setNotice(t(lang, to.error === "none" ? "recipients.noneNotice" : "files.chosenAway")); return; }
    await sendLargeFileToAll(file, to.targets);
  }

  async function shareCurrentLocation() {
    const caps = detectGeolocation();
    if (!caps.available) { setNotice(caps.reason || "Geolocation unavailable."); return; }
    // 6.10 (G-12): a location goes to the chosen people like a message (6.9: always the whole room).
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
    try {
      const pos = await getCurrentPosition();
      const link = osmLink(pos);
      await sendChatPayload(`📍 ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} (±${Math.round(pos.accuracy ?? 0)} m) ${link}`, { targets: rec.targets, toNames: rec.toNames, away: rec.away });
    } catch (err) {
      setNotice(tf(lang, "app.location.failed", { msg: (err as Error).message }));
    }
  }

  function startContinuousLocation() {
    // 6.10 (G-12): the recipients are fixed now and never widen; only those connected get an update.
    const rec = resolveRecipients();
    if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
    if (rec.targets && rec.targets.size === 0) { setNotice(t(lang, "app.location.chosenAway")); return; }
    locationWatcherRef.current?.stop();
    locationWatcherRef.current = watchPosition(
      (pos) => {
        const link = osmLink(pos);
        const to = liveLocationTargets(rec, (id) => peersRef.current.get(id)?.channel?.readyState === "open");
        if (to.send) void sendChatPayload(`📍 live ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} ${link}`, { targets: to.targets, toNames: rec.toNames });
      },
      (msg) => setNotice(tf(lang, "app.location.error", { msg })),
    );
    if (locationWatcherRef.current) systemMessage(rec.targets ? tf(lang, "app.location.startedTo", { names: (rec.toNames ?? []).join(", ") }) : t(lang, "app.location.started"));
  }

  function stopContinuousLocation() {
    locationWatcherRef.current?.stop();
    locationWatcherRef.current = null;
    systemMessage(t(lang, "app.location.stopped"));
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
      // 4.0: Server-enhanced needs a passkey sign-in, so a browser without
      // one no longer gets a day-long anonymous database on the server.
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode]);

  // --- the signed-in user: what this server offers, and who we already are ---
  useEffect(() => {
    void accountStatus().then((st) => setAccStatus(st));
    void restoreSession().then((acc) => {
      setAccountResolved(true);
      if (!acc) return;
      setAccount(acc);
      if (retentionRef.current === "server") announceAccountToServer();
      void syncKeyDirectory().catch(() => undefined); // 6.12 (§ 7.5)
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- /signin and /signup ---
  //   /signin  (also where a push notification points) back into the account:
  //            this tab's session if it has one, else the passkey ceremony
  //   /signup  a new account: the server names it, the passkey stores it, and
  //            it is signed in and active straight away
  // Both open the Connection window, where the checked steps show.
  useEffect(() => {
    const path = window.location.pathname;
    const route = path.startsWith("/signin") ? "signin" : path.startsWith("/signup") ? "signup" : null;
    if (!route) return;
    // Scrub the path at once so a reload does not repeat the ceremony.
    window.history.replaceState(null, "", "/");
    setActivePanel("connection");
    let cancelled = false;
    void (async () => {
      const restored = await restoreSession();
      if (cancelled) return;
      if (restored) {
        setAccount(restored);
        setPrefs({ chatRetention: "server", mode: "server" });
        retentionRef.current = "server";
        systemMessage(tf(lang, "acc.signedInAs", { name: restored.username ?? restored.id }));
        await applyVault(true);
        await linkPushForAccount();
        announceAccountToServer();
        return;
      }
      // The passkey ceremony may need a gesture: when the browser refuses,
      // the Connection window shows the buttons (and why) instead.
      setAccMsg(t(lang, route === "signin" ? "acc.signinRunning" : "id.register"));
      if (route === "signin") await signInToAccount();
      else await createAccount();
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
      // The same server as before the reload — if the operator still allows it.
      const serverOk = !saved.server || serverAllowed(clientConfig.connections, saved.server);
      if (saved.server && serverOk) activeServerRef.current = saved.server;
      if (saved.profileId) pendingProfileIdRef.current = saved.profileId;
      if (saved.resume) resumeRef.current = saved.resume; // 6.7: the same member as before the reload
      if (!serverOk) { setNotice(t(lang, "cx.err.server")); return; }
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
        // 6.7: the room key leaves this tab, but nobody asked to leave the
        // room — no goodbye, so the server keeps us listed as away.
        disconnect(false, false);
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
    // An invitation to a saved connection on another signaling server joins
    // there — only when this server's operator allows that server.
    if (payload.server && !serverAllowed(clientConfig.connections, payload.server)) {
      setNotice(t(lang, "cx.err.server"));
      return;
    }
    setInviteParts(null);
    setActivePanel(null);
    disconnect(false);
    activeProfileRef.current = null;
    setActiveProfileId(null);
    activeServerRef.current = payload.server ?? "";
    setName(payload.name); setRoomInput(payload.room); setPassphrase(payload.passphrase);
    await startSession(payload.name, payload.room, payload.passphrase);
  }

  async function clearAndQuit() {
    if (!window.confirm(t(lang, "clear.confirm"))) return;
    setNotice(t(lang, "clear.working"));
    hub.clear();
    disconnect(false);
    await sessionCacheRef.current.clear().catch(() => undefined);
    await historyRef.current.clear().catch(() => undefined);
    // Whatever this browser left on the server — a session database or a
    // signed-in user's own — goes with it.
    await forgetServerData().catch(() => undefined);
    await wipeEverything({ deviceId: prefs.deviceId });
    // Leaving on purpose: the lock's history entry goes first, so nothing of
    // the chat is left to go back to.
    await releaseNavigationGuard();
    leaveToGoodbye();
  }

  if (!capabilities.supported) {
    return <UnsupportedBanner reasons={capabilities.unsupportedReasons} />;
  }

  return (
    // 4.13: the windows, the Room window, dialogs and panels draw the operator's layouts for this viewer.
    <LayoutProvider config={layout} ctx={layoutCtx}>
    <FnHostContext.Provider value={fnHost}>
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

      {navBlocked ? (
        <SimpleModal title={t(lang, "nav.leave.title")} onClose={() => setNavBlocked(null)} testId="nav-guard">
          <div className="space-y-4" data-blocked={navBlocked}>
            <p className="text-sm font-semibold" data-testid="nav-guard-text">{t(lang, "nav.leave")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="acc-btn acc-btn--primary" data-testid="nav-guard-disconnect" onClick={() => { setNavBlocked(null); userDisconnect(); }}>
                <LogOut className="h-4 w-4" />{t(lang, "nav.leave.disconnect")}
              </button>
              <button type="button" className="acc-btn" data-testid="nav-guard-stay" onClick={() => setNavBlocked(null)}>{t(lang, "nav.leave.stay")}</button>
            </div>
          </div>
        </SimpleModal>
      ) : null}

      <IntegrityCheck
        lang={lang}
        handle={integrityRef}
        onMismatch={(found) => {
          console.warn("[m5cet] version check:", found);
          if (accountRef.current) void logAccountEvent("version-mismatch", { items: found.length, first: `${found[0].kind}:${found[0].item}`.slice(0, 60) });
        }}
      />

      {/* Top app bar, the chat window and the composer: layouts of the
          console's Layout builder (lib/layouts/app.ts), drawn with the app's
          data, actions and live parts. */}
      {renderLayout(layoutTree(layout, "header", layoutCtx), {
        ...layoutEnvBase,
        data: {
          status,
          room,
          openPeerCount,
          // 6.12 (§ 13): did the server accept our proof of the room key? ("" before 6.12 servers)
          hubProven: hubProven === null ? "" : String(hubProven),
          reconnectPending: Boolean(connStatus?.disconnectReason && connStatus.disconnectReason !== "idle"),
          statusTitle: connStatus
            ? `state: ${connStatus.state}\n` +
              `attempts: ${connStatus.attempts}\n` +
              `last reconnects: ${connStatus.totalReconnects}\n` +
              `next reconnect in: ${connStatus.nextReconnectAtMs ? Math.max(0, Math.round((connStatus.nextReconnectAtMs - Date.now()) / 1000)) + "s" : "—"}\n` +
              `RTT: ${connStatus.rttMs}ms`
            : "—",
          showSwitcher: cxEligible && cxState.settings.quickSwitch && cxState.profiles.length > 0,
          profiles: cxState.profiles.map((p) => ({ id: p.id, label: p.label })),
          activeProfileId: activeProfileId ?? "",
          showFullscreen: fullscreenSupported() && deviceInfo().touch && !deviceInfo().standalone,
          fullscreen,
          signedIn: Boolean(account),
          username: account ? account.username ?? account.userName ?? "" : "",
        },
        actions: {
          openRoom: () => setActivePanel("join"),
          switchProfile: (e) => { const v = (e as ChangeEvent<HTMLSelectElement>).target.value; if (v) void connectProfile(v); },
          toggleFullscreen: () => void toggleFullscreen(),
        },
        slots: {
          signedIn: () => (account ? (
            <SignedInBadge account={account} onClick={() => { setAccMsg(""); setShowAccount(true); void refreshAccount().then((fresh) => { if (fresh) setAccount(fresh); }); }} lang={lang} />
          ) : null),
          menu: () => (
            <MainMenu
              mode={prefs.menuDisplay}
              lang={lang}
              currentPanel={activePanel}
              onOpen={(panel) => setActivePanel(panel)}
              user={{ name: prefs.name, avatar: prefs.avatar }}
              onClearQuit={() => void clearAndQuit()}
              editMode={prefs.editMode}
              onToggleEditMode={moduleOn("editMode") ? () => setPrefs({ editMode: !prefs.editMode }) : undefined}
              buildLabel={buildLabel()}
              visible={panelVisible}
              config={menuConfig}
              vars={menuVars}
              nodeVisible={menuNodeVisible}
              onAction={runMenuAction}
              states={{ tone: shownTone(), notifications: prefs.notificationsEnabled, signedIn: Boolean(account), username: account ? account.username ?? account.userName ?? "" : "" }}
            />
          ),
        },
      })}

      {/* 6.0: phone calls offered to this member (layout "phone.bridge") */}
      <PhoneBridgePanel
        lang={lang}
        calls={phoneCalls}
        onTakeAudio={(s) => void takePhoneCall(s, "audio")}
        onTakeText={(s) => void takePhoneCall(s, "text")}
        onReply={(s, text) => { void phoneClient(s)?.say(text); setCall(s, (c) => ({ transcripts: [...c.transcripts, { text, at: Date.now(), mine: true }].slice(-50) })); }}
        onMute={(s) => { const cl = phoneClientsRef.current.get(s); if (cl) { cl.muted = !cl.muted; setCall(s, { muted: cl.muted }); } }}
        onHangup={(s) => { phoneClientsRef.current.get(s)?.hangup(); phoneClientsRef.current.delete(s); setCall(s, { state: "ended", reason: "" }); }}
        onDismiss={(s) => setPhoneCalls((cur) => cur.filter((c) => c.session !== s))}
        onJoin={(s) => void takePhoneCall(s, "audio")}
        onIgnore={(s) => setCall(s, { state: "ignored" })}
        onLeave={(s) => { phoneClientsRef.current.get(s)?.leave(); phoneClientsRef.current.delete(s); setCall(s, { state: "ignored", level: 0, muted: false }); }}
      />

      {/* 6.0: the rooms kept connected at once (layout "room.bar") */}
      {moduleOn("rooms") && (hubRooms.length > 0 || (desired === "connected" && room)) ? (
        <RoomBar
          lang={lang}
          rooms={roomBarItems()}
          canAdd={hubRooms.length < hub.limit}
          onSwitch={(key) => void switchRoom(key)}
          onClose={(key) => void closeRoom(key)}
          onAdd={(r, p) => void addRoom(r, p)}
        />
      ) : null}

      {renderLayout(layoutTree(layout, "chat", layoutCtx), {
        ...layoutEnvBase,
        data: {
          notice,
          room,
          myIdShort: myId.slice(-10),
          connected: desired === "connected",
          copied,
          transfers,
          empty: visibleMessages.length === 0,
          emptyTitle: renderTemplate(layout.templates.chatEmptyTitle, { title: t(lang, "chat.empty.title"), appName: "M5cet" }, layout.partials),
          emptyBody: renderTemplate(layout.templates.chatEmptyBody, { body: t(lang, "chat.empty.body"), appName: "M5cet" }, layout.partials),
          hiddenMessages,
          newestFirst,
          showEarlierText: t(lang, "chat.showEarlier").replace("{n}", String(hiddenMessages)),
          messages: renderedMessages,
          hiddenCount: hiddenNow,
          showHidden,
          showHiddenText: t(lang, showHidden ? "chat.hidden.hide" : "chat.hidden.show").replace("{n}", String(hiddenNow)),
        },
        actions: {
          disconnect: () => userDisconnect(),
          copyRoom: () => void copyRoom(),
          openRoom: () => setActivePanel("join"),
          showEarlier: () => setMessageWindow((n) => n + MESSAGE_WINDOW),
          toggleHidden: () => setShowHidden((v) => !v),
        },
        refs: { dock: dockAnchorRef as never, end: messageEndRef as never },
        slots: {
          transfer: (tr) => {
            const x = tr as (typeof transfers)[number];
            return (
              <TransferCard
                id={x.id}
                name={x.name}
                size={x.size}
                direction={x.direction}
                initialStats={x.stats}
                finalStatus={x.status}
                errorMessage={x.errorMessage}
                onRemove={dropTransfer}
              />
            );
          },
          message: (m) => {
            const message = m as ChatMessage;
            return (
              <MessageRow
                message={message}
                perStyle={message.senderId === "system" ? undefined : prefs.messageStyles[styleKeyFor(message.senderName, message.senderId)]}
                layout={layout}
                layoutCtx={layoutCtx}
                lang={lang}
                timezone={prefs.timezone}
                room={room}
                avatar={card?.avatar.value || prefs.avatar}
                peerAvatar={message.mine ? undefined : peerProfiles[message.senderId]?.avatar}
                delivery={deliveryStateOf(message)}
                mapPolicy={clientConfig.map}
                act={rowActionsRef}
              />
            );
          },
          // 6.7: no message yet — the start screen, its own layout ("start").
          start: () => (
            <StartScreen
              lang={lang}
              title={renderTemplate(layout.templates.chatEmptyTitle, { title: t(lang, "chat.empty.title"), appName: "M5cet" }, layout.partials)}
              body={renderTemplate(layout.templates.chatEmptyBody, { body: t(lang, "chat.empty.body"), appName: "M5cet" }, layout.partials)}
              status={status}
              connected={desired === "connected"}
              room={room}
              signedIn={Boolean(account)}
              username={account ? account.username ?? account.userName ?? "" : ""}
              serverMode={prefs.mode === "server"}
              profiles={cxEligible ? cxState.profiles.map((p) => ({ id: p.id, label: p.label })) : []}
              onOpenRoom={() => setActivePanel("join")}
              onConnectProfile={(id) => void connectProfile(id)}
              onSignIn={() => setActivePanel("connection")}
            />
          ),
          composer: () => renderLayout(layoutTree(layout, "composer", layoutCtx), {
            ...layoutEnvBase,
            data: {
              replyTo: replyingTo ? { id: replyingTo.id, senderName: replyingTo.senderName, text: replyingTo.text } : null,
              emojiOpen,
              emojis: QUICK_EMOJI,
              filesOn: moduleOn("files"),
              openPeerCount,
              room,
              placeholder: renderTemplate(layout.templates.composerPlaceholder, {
                placeholder: openPeerCount > 0 ? t(lang, "chat.placeholder") : t(lang, "chat.placeholder.waiting"),
                room, peerCount: String(openPeerCount),
              }, layout.partials),
              messageInput,
              everyone: widget.autoRoom,
              recipientNames: Array.from(recipients, (id) => peersRef.current.get(id)?.name || id.slice(-4)).join(", "),
              // 6.8: Send sends the text as a voice message (the send options' checkbox)
              sendAsVoice: sendOpts.asVoice,
              voiceBusy,
            },
            actions: {
              submit: (e) => void sendMessage(e as FormEvent),
              replyJump: () => { if (replyingTo) scrollToMessage(replyingTo.id); },
              cancelReply: () => setReplyingTo(null),
              insertEmoji: (_e, emoji) => insertEmoji(String(emoji)),
              toggleEmoji: () => setEmojiOpen((current) => !current),
              pickFile: () => fileInputRef.current?.click(),
              pickImage: () => imageInputRef.current?.click(),
              input: (e) => { setMessageInput((e as ChangeEvent<HTMLTextAreaElement>).target.value); composerSuggest.onInput(); },
              keydown: (e) => handleMessageKeyDown(e as KeyboardEvent<HTMLTextAreaElement>),
              attachment: (e) => void handleAttachmentChange(e as ChangeEvent<HTMLInputElement>),
            },
            refs: { fileInput: fileInputRef as never, imageInput: imageInputRef as never },
            slots: {
              // 6.7: dictation into the field next to the voice-message recorder
              recorder: () => (
                <ComposerVoice
                  lang={lang}
                  disabled={openPeerCount === 0}
                  text={messageInput}
                  setText={setMessageInput}
                  onRecorded={(file) => void sendPickedFile(file)}
                  onError={(msg) => setNotice(msg)}
                  serverMode={prefs.mode === "server"}
                />
              ),
              sendOptions: () => (
                <SendOptions
                  value={sendOpts}
                  onChange={setSendOpts}
                  onSend={() => void sendMessage()}
                  canSend={canSend}
                  lang={lang}
                  voiceOption
                  voiceBusy={voiceBusy}
                />
              ),
            },
          }),
        },
      })}

      {/* 4.15 / 5.2 / 6.11: what the trigger characters offer ("/" commands, "@" people, "#" tags, argument values) and the argument hint, above the composer. */}
      {composerSuggest.view}

      {/* 5.2: the conversation filtered by a #tag. */}
      {tagFilter ? (
        <div className="tag-filter" role="status" data-testid="tag-filter">
          <span>{tf(lang, "composer.tagFilter", { tag: tagFilter })}</span>
          <button type="button" onClick={() => setTagFilter(null)} aria-label={t(lang, "composer.tagClear")}>×</button>
        </div>
      ) : null}

      {/* 4.15: a running command's live question (m5.prompt / m5.form); 6.11: its fields keep their types. */}
      {interaction ? <FnAskDialog interaction={interaction} lang={lang} onAnswer={(v) => void answerCurrentInteraction(v)} /> : null}

      {/* Modal panels */}
      <ProfilePanel open={activePanel === "profile"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} onOpenConnection={() => setActivePanel("connection")} />
      <SettingsPanel open={activePanel === "settings"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} onOpenAppearance={() => setActivePanel("appearance")} />
      {activePanel === "appearance" ? (
        <Suspense fallback={null}>
          <AppearancePanel open onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang}
            policy={{ themes: appearancePolicy.themes.length ? appearancePolicy.themes : [], lockTheme: appearancePolicy.lockTheme, shown: effectiveTheme }} />
        </Suspense>
      ) : null}
      <EncryptionPanel open={activePanel === "encryption"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <RoomSecurityPanel open={activePanel === "roomSecurity"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} room={room} />
      <TrustPanel
        open={activePanel === "trust"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} peerFingerprints={peerFingerprints} roomFingerprint={roomFingerprint}
        // 6.12: key transparency (a persistent alert) and the protocol each member speaks.
        p4={{
          kt: ktStatus,
          onKtDismiss: () => { void ktRef.current?.dismiss(); },
          peers: peers.filter((p) => p.status === "open" || p4Peers[p.id] !== undefined).map((p) => ({ id: p.id, name: p.name, protocol: p4Peers[p.id] ?? "pending", proven: p.proven })),
        }}
      />
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
        signedIn={Boolean(account)}
        onOpenConnection={() => setActivePanel("connection")}
      />
      <AnalyticsPanel open={activePanel === "analytics"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />

      {/* Peers modal */}
      {activePanel === "peers" ? (
        <SimpleModal title={t(lang, "menu.peers")} onClose={() => setActivePanel(null)}>
          <PeerList peers={peers} lang={lang} presence={presence} onInfo={(id) => setUserInfoFor(id)} />
        </SimpleModal>
      ) : null}

      {/* Audio modal */}
      {activePanel === "audio" ? (
        <SimpleModal title={t(lang, "menu.audio")} onClose={() => setActivePanel(null)}>
          <AudioControls
            audioStatus={audioStatus}
            audioPeerCount={audioPeerCount}
            media={mediaE2eeRef.current.supported ? mediaStates : null}
            mediaDetail={Object.keys(mediaStates).map((id) => { const r = mediaE2eeRef.current.recentFor(id); return `${id.slice(-4)}: sealed ${r.sealed}, opened ${r.opened}, clear in ${r.clearIn}, clear out ${r.clearOut}, failed ${r.failed}`; }).join("; ")}
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
        <SimpleModal title={t(lang, "app.video.title")} onClose={() => setActivePanel(null)}>
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
              chat={nfcChat}
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
            onSendText={(text) => {
              // 6.10 (G-12): to the chosen people like a message (6.9: always the whole room).
              const rec = resolveRecipients();
              if (!rec) { setNotice(t(lang, "recipients.noneNotice")); return; }
              void sendChatPayload(text, { targets: rec.targets, toNames: rec.toNames, away: rec.away });
            }}
            onInsertText={(text) => setMessageInput((cur) => (cur ? `${cur} ${text}` : text))}
            onSendVoice={(text) => sendTextAsVoice(text, false)}
            serverMode={prefs.mode === "server"}
            lang={lang}
          />
        </SimpleModal>
      ) : null}

      {/* 6.7: the voice changer (the operator's module; on / off per client) */}
      {activePanel === "voiceChanger" ? (
        <SimpleModal title={t(lang, "vfx.title")} onClose={() => setActivePanel(null)}>
          <VoiceChangerPanel lang={lang} allowed={moduleOn("voiceChanger")} />
        </SimpleModal>
      ) : null}

      {/* AI assistant modal (server-enhanced) */}
      {activePanel === "ai" ? (
        <SimpleModal title={t(lang, "menu.ai")} onClose={() => setActivePanel(null)}>
          <AiPanel lang={lang} onInsert={(text) => { setMessageInput((cur) => (cur ? `${cur} ${text}` : text)); setActivePanel(null); }} onSignIn={() => setActivePanel("connection")} />
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
      {activePanel === "connections" || manageFromRoom ? (
        <SimpleModal title={t(lang, "cx.title")} onClose={() => { if (manageFromRoom) setManageFromRoom(null); else setActivePanel(null); }}>
          <ConnectionsPanel
            startWith={manageFromRoom === "new" ? "new" : undefined}
            lang={lang}
            timezone={prefs.timezone}
            state={cxState}
            policy={clientConfig.connections}
            eligible={{ enabled: connectionsOn, signedIn: Boolean(account) && cxReady, serverMode: cxServerSide || manageFromRoom !== null }}
            canShare={moduleOn("invites")}
            activeId={activeProfileId}
            connected={status === "joined"}
            current={status === "joined" && sessionPassphrase ? { room, passphrase: sessionPassphrase, userName: nameRef.current } : null}
            storedBytes={account?.vault.connectionsBytes ?? 0}
            onConnect={(id) => void connectProfile(id)}
            onDisconnect={() => userDisconnect()}
            onSave={(input) => {
              const result = connectionsRef.current!.save(input);
              if (result.ok) setNotice(tf(lang, "cx.saved", { name: result.profile.label }));
              return result;
            }}
            onDelete={(id) => { connectionsRef.current!.remove(id); if (activeProfileRef.current?.id === id) { activeProfileRef.current = null; setActiveProfileId(null); } }}
            onDefault={(id) => connectionsRef.current!.makeDefault(id)}
            onSettings={(patch) => connectionsRef.current!.settings(patch)}
            onClearLog={(id) => connectionsRef.current!.clearLog(id)}
            onSignIn={() => setActivePanel("connection")}
            onEnableServerMode={() => setPrefs({ mode: "server" })}
          />
        </SimpleModal>
      ) : null}

      {activePanel === "connection" ? (
        <SimpleModal title={t(lang, "app.connection.title")} onClose={() => setActivePanel(null)}>
          <div className="space-y-5">
            <AccountAccess
              account={account}
              status={accStatus}
              supported={accountSupported()}
              busy={accBusy}
              message={accMsg}
              lang={lang}
              nickname={name}
              progress={signin}
              onSignIn={() => void signInToAccount()}
              onRegister={() => void createAccount()}
              onRegisterForm={() => setShowRegistration(true)}
              onSignOutAndWipe={() => void signOutAndWipe()}
              onRecover={(code) => void recoverAccount(code)}
              actions={accountActions}
            />
            <ChatRetentionSection
              value={prefs.chatRetention}
              onChange={(next) => { setPrefs({ chatRetention: next }); retentionRef.current = next; if (next !== "server") void historyRef.current.clear(); announceAccountToServer(); }}
              account={account}
              lang={lang}
            />
            <ConnectionPanel status={connStatus} prefs={prefs} setPrefs={setPrefs} lang={lang} desired={desired} log={connLog} />
          </div>
        </SimpleModal>
      ) : null}

      {/* The Room window: connection type as tabs in the header, the tab's
          content, and Connect / Disconnect / Share always underneath. */}
      {activePanel === "join" ? (
        <SimpleModal
          title={t(lang, "menu.room")}
          onClose={() => setActivePanel(null)}
          testId="room-dialog"
          className="room-dialog"
          header={<RoomTabs lang={lang} tab={roomTab} locked={roomLocked} onTab={pickRoomTab} />}
        >
          <RoomDialog
            lang={lang}
            tab={roomTab}
            locked={roomLocked}
            joined={status === "joined"}
            busy={status === "deriving" || status === "connecting"}
            fields={{ name, room: roomInput, passphrase }}
            onField={(patch) => {
              if (patch.name !== undefined) { nameTypedRef.current = true; setName(patch.name); }
              if (patch.room !== undefined) setRoomInput(patch.room);
              if (patch.passphrase !== undefined) setPassphrase(patch.passphrase);
            }}
            saved={{
              enabled: connectionsOn,
              signedIn: Boolean(account),
              ready: cxReady,
              state: cxState,
              activeId: activeProfileId,
            }}
            onConnect={(target) => {
              // A connection running in the background comes on screen (smart switching).
              const bg = target.kind === "profile" ? hubKeyOfProfile(target.id) : null;
              void (bg ? switchRoom(bg) : connectRoomTarget(target));
            }}
            onReconnect={() => void reconnectViaButtons()}
            onDisconnect={() => userDisconnect()}
            onManage={() => setManageFromRoom("list")}
            onCreate={() => setManageFromRoom("new")}
            onSignIn={() => setActivePanel("connection")}
            onWeakKey={(text) => setNotice(text)}
            multi={moduleOn("rooms") ? {
              on: true,
              selected: multiSel,
              background: new Set(hubRooms.map((r) => r.profileId).filter((x): x is string => Boolean(x))),
              counts: Object.fromEntries([
                ...hubRooms.filter((r) => r.profileId).map((r) => [r.profileId as string, { users: r.users, unread: r.unread }] as const),
                ...(activeProfileId && status === "joined" ? [[activeProfileId, { users: openPeerCount + 1, unread: 0 }] as const] : []),
              ]),
              onToggle: (id) => setMultiSel((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; }),
              onConnect: () => void connectSelected(),
            } : undefined}
            share={moduleOn("invites") ? (
              <ShareSection
                lang={lang}
                room={normalizeRoom(roomInputRef.current || roomInput)}
                passphrase={sessionPassphrase}
                ready={desired === "connected" && sessionPassphrase.length > 0}
                server={activeServerRef.current || undefined}
              />
            ) : null}
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
            ...peers.filter((p) => !presence.isHeld(p.id)).map((p): WidgetPeer => ({ id: p.id, name: p.name, status: p.status, rttMs: p.status === "open" ? connStatus?.rttMs : undefined, presence: presence.factsOf(p.id), avatar: peerProfiles[p.id]?.avatar, unproven: p.proven === false })),
            // Signed-in members the server answers for: still addressable.
            ...awayPeers.map((a): WidgetPeer => ({ id: awayKey(a.accountId), name: a.name, status: "away", since: a.since, presence: presence.factsOf(awayKey(a.accountId)) })),
            // 6.7: their connection went, they did not leave: listed as away until they are back.
            ...presence.held([], awayPeers.map((a) => a.accountId)).map((h): WidgetPeer => ({ id: h.peerId, name: h.name, status: "closed", presence: presence.factsOf(h.peerId) })),
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
          tree={layoutTree(layout, "widget", layoutCtx)}
          fabTree={layoutTree(layout, "widget.fab", layoutCtx)}
          blocks={layoutEnvBase.blocks}
        />
      ) : null}

      {/* The signed-in user: what the server holds for them */}
      {showRegistration ? (
        <Suspense fallback={null}>
          <RegistrationDialog lang={lang} signedIn={Boolean(account)} onClose={() => setShowRegistration(false)} onRegister={registerWithForm} />
        </Suspense>
      ) : null}
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
            onOpenConnection={() => { setShowAccount(false); setActivePanel("connection"); }}
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
            <MessageInfoView
              info={buildMessageInfo(m)}
              lang={lang}
              onForward={() => { setMsgInfoFor(null); void forwardMessage(m); }}
              actions={{ onHide: (choice) => hideMsg(m.id, choice), onUnhide: () => unhideMsg(m.id), onDelete: () => deleteMsg(m.id) }}
            />
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
    </FnHostContext.Provider>
    </LayoutProvider>
  );
}

// Single-screen app: no router, no data-fetching cache, no toast layer. Those
// template wrappers were mounted but never used by anything.
export default ChatApp;
