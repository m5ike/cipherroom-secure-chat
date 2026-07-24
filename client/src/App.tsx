import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import {
  Activity,
  Bell,
  BellOff,
  CheckCheck,
  Copy,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Mic,
  MicOff,
  Moon,
  Paperclip,
  PhoneOff,
  Radio,
  Send,
  ShieldCheck,
  Smile,
  Sun,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { detectCapabilities } from "./lib/capabilities";
import {
  clearPreferences,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./lib/preferences";
import { linkify } from "./lib/linkify";
import { fetchPushStatus, subscribeToPush, ensureServiceWorker } from "./lib/push";
import { dispatchInternal, installPublicAPI } from "./lib/cipherroom-api";
import {
  deriveRoomKey,
  encryptEnvelope,
  decryptEnvelope,
  evaluatePassphrase,
  getDtlsFingerprint,
  newId,
  normalizeRoom,
  type DataChannelEnvelope,
} from "./lib/crypto";
import {
  sendFile,
  handleFileControl,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  CHUNK_SIZE,
} from "./lib/fileTransfer";
import { ReconnectController, type ReconnectPhase } from "./lib/reconnect";

// ─────────────────────────────────────────────────────────────────────────────
// Typy
// ─────────────────────────────────────────────────────────────────────────────

type PeerStatus = "connecting" | "open" | "closed";
type AudioStatus = "off" | "joining" | "live" | "muted";

type PeerView = {
  id: string;
  name: string;
  status: PeerStatus;
  initiator: boolean;
  audio: AudioStatus;
  safetyCode?: string;
};

type AttachmentMeta = {
  kind: "file" | "image";
  fileId: string;
  name: string;
  mime: string;
  size: number;
  /** Lokální blob URL na přijatý soubor; u vlastní zprávy se generuje on-the-fly */
  blobUrl?: string;
};

type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
  mine: boolean;
  secure: boolean;
  attachment?: AttachmentMeta;
  progress?: number; // 0..1 — pro probíhající upload
};

type SignalFrame =
  | {
      type: "joined";
      peerId: string;
      room: string;
      peers: Array<{ peerId: string; name: string; joinedAt: number }>;
      resume?: boolean;
      limits?: { maxPeersPerRoom: number; frameBudgetPerSec: number; maxFrameBytes: number };
    }
  | { type: "peer-joined"; peerId: string; name: string; joinedAt: number }
  | { type: "peer-left"; peerId: string }
  | {
      type: "signal";
      source: string;
      payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
    }
  | { type: "hello"; peerId: string; heartbeatMs?: number }
  | { type: "pong"; ts: number; serverTs: number }
  | { type: "error"; message: string };

type DecryptedPayload =
  | {
      kind?: "text";
      id: string;
      text: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      attachment?: AttachmentMeta;
    }
  | {
      kind: "audio-status";
      id: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      status: AudioStatus;
    }
  | {
      kind: "safety";
      senderId: string;
      senderName?: string;
      fingerprint: string;
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

type InFlightTransfer = {
  transferId: string;
  fileId: string;
  name: string;
  mime: string;
  size: number;
  msgId: string;
  abortController: AbortController;
  // last received/total
  received: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Konfigurace
// ─────────────────────────────────────────────────────────────────────────────

const EXTERNAL_SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL as string | undefined;
const TURN_URL = (import.meta.env.VITE_TURN_URL as string | undefined)?.trim();
const TURN_USER = (import.meta.env.VITE_TURN_USERNAME as string | undefined)?.trim();
const TURN_CRED = (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined)?.trim();
const SERVER_MAX_ATTACHMENT_BYTES = Number(
  (import.meta.env.VITE_MAX_ATTACHMENT_BYTES as string | undefined) ||
    DEFAULT_MAX_ATTACHMENT_BYTES,
);

function buildRtcConfig(): RTCConfiguration {
  const ice: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  if (TURN_URL && TURN_USER && TURN_CRED) {
    ice.push({ urls: TURN_URL, username: TURN_USER, credential: TURN_CRED });
  }
  return {
    iceServers: ice,
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  };
}

const QUICK_EMOJI = ["😀", "😂", "🥳", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❓"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTime(value: number) {
  return new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WS URL helper
// ─────────────────────────────────────────────────────────────────────────────

function wsUrl() {
  if (EXTERNAL_SIGNALING_URL?.trim()) {
    return EXTERNAL_SIGNALING_URL.trim();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Globální komponenty
// ─────────────────────────────────────────────────────────────────────────────

function CipherLogo() {
  return (
    <svg aria-label="CipherRoom logo" viewBox="0 0 36 36" className="h-9 w-9" fill="none">
      <rect x="6" y="11" width="24" height="18" rx="6" stroke="currentColor" strokeWidth="2.2" />
      <path
        d="M12 11V8.8C12 5.6 14.6 3 17.8 3h.4C21.4 3 24 5.6 24 8.8V11"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path
        d="M13.5 19h9M13.5 23h5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="26" cy="23" r="2" fill="currentColor" />
    </svg>
  );
}

function UnsupportedBanner({ reasons }: { reasons: string[] }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-lg rounded-3xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">CipherRoom — prohlížeč není podporován</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tato aplikace potřebuje moderní šifrování a P2P přenos přímo v prohlížeči. Internet Explorer
          není podporován. Použij prosím Edge, Chrome, Firefox nebo Safari.
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

// ─────────────────────────────────────────────────────────────────────────────
// Hlavní chat komponenta
// ─────────────────────────────────────────────────────────────────────────────

function ChatApp() {
  const capabilitiesRef = useRef(detectCapabilities());
  const capabilities = capabilitiesRef.current;
  const initialPrefs = useMemo<Preferences>(() => loadPreferences(), []);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (initialPrefs.theme === "dark") return "dark";
    if (initialPrefs.theme === "light") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [mode, setMode] = useState<"light" | "server">(initialPrefs.mode);
  const [name, setName] = useState(
    () => initialPrefs.name || `peer-${Math.floor(1000 + Math.random() * 9000)}`,
  );
  const [roomInput, setRoomInput] = useState(initialPrefs.lastRoom || "brno-secure");
  const [passphrase, setPassphrase] = useState("");
  const [maxPeersFromServer, setMaxPeersFromServer] = useState<number | null>(null);
  const [wsPhase, setWsPhase] = useState<ReconnectPhase>("idle");
  const [room, setRoom] = useState("");
  const [myId, setMyId] = useState(() => newId("peer"));
  const [messageInput, setMessageInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState(
    "Zprávy se neukládají. Server dělá pouze signalizaci pro WebRTC.",
  );
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushVapidKey, setPushVapidKey] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    initialPrefs.notificationsEnabled,
  );
  const [transfers, setTransfers] = useState<Record<string, InFlightTransfer>>({});

  // Verifikované safety-number (TOFU fingerprint)
  const peerCodesRef = useRef<Map<string, { mine: string; theirs: string }>>(new Map());
  const [peerSafetyChecked, setPeerSafetyChecked] = useState<Set<string>>(new Set());

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReconnectController | null>(null);
  const peersRef = useRef<Map<string, PeerHandle>>(new Map());
  const keyRef = useRef<CryptoKey | null>(null);
  const roomRef = useRef("");
  const nameRef = useRef(name);
  const myIdRef = useRef(myId);
  const localAudioStreamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const audioStatusRef = useRef<AudioStatus>("off");
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const activeFileTransfersRef = useRef<
    Map<
      string,
      {
        transferId: string;
        manifest: import("./lib/fileTransfer").FileManifest;
        chunks: Uint8Array[];
        receivedCount: number;
        totalReceived: number;
      }
    >
  >(new Map());

  const openPeerCount = useMemo(
    () => peers.filter((peer) => peer.status === "open").length,
    [peers],
  );
  const audioPeerCount = useMemo(
    () =>
      peers.filter((peer) => peer.audio === "live" || peer.audio === "muted").length,
    [peers],
  );
  const canSend =
    wsPhase === "joined" &&
    openPeerCount > 0 &&
    (messageInput.trim().length > 0 || true); // att může být bez textu

  const passStrength = useMemo(() => evaluatePassphrase(passphrase), [passphrase]);
  const hasTURN = Boolean(TURN_URL);

  // ───────────────────────────────────────────────────────────────────────────
  // Effects
  // ───────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  useEffect(() => {
    audioStatusRef.current = audioStatus;
  }, [audioStatus]);
  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);

  useEffect(() => {
    if (!capabilities.localStorage) return;
    savePreferences({ theme, mode, name, lastRoom: roomInput, notificationsEnabled });
  }, [theme, mode, name, roomInput, notificationsEnabled, capabilities.localStorage]);

  useEffect(() => {
    if (mode !== "server") return;
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
  }, [mode, capabilities.serviceWorker]);

  useEffect(() => {
    installPublicAPI();
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers — peer view, system messages, signaling sender
  // ───────────────────────────────────────────────────────────────────────────

  function setPeerView(
    id: string,
    update: Partial<PeerView> & { name?: string; initiator?: boolean },
  ) {
    setPeers((current) => {
      const existing = current.find((peer) => peer.id === id);
      if (!existing) {
        const newPeer: PeerView = {
          id,
          name: update.name || `peer-${id.slice(-4)}`,
          status: update.status || "connecting",
          initiator: update.initiator ?? false,
          audio: update.audio || "off",
          safetyCode: update.safetyCode,
        };
        return [...current, newPeer];
      }
      return current.map((peer) =>
        peer.id === id
          ? {
              ...peer,
              ...update,
              safetyCode: update.safetyCode ?? peer.safetyCode,
            }
          : peer,
      );
    });
  }

  function systemMessage(text: string) {
    setMessages((current) => [
      ...current,
      {
        id: newId("system"),
        senderId: "system",
        senderName: "CipherRoom",
        text,
        createdAt: Date.now(),
        mine: false,
        secure: false,
      },
    ]);
  }

  function sendSignal(
    target: string,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ) {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "signal", target, payload }));
    }
  }

  async function broadcastEnvelope(envelope: DataChannelEnvelope) {
    const serialized = JSON.stringify(envelope);
    let sent = 0;
    peersRef.current.forEach((peer) => {
      if (peer.channel?.readyState === "open") {
        try {
          peer.channel.send(serialized);
          sent += 1;
        } catch {
          // ignore individual peer send errors
        }
      }
    });
    return sent;
  }

  async function broadcastAudioStatus(next: AudioStatus) {
    const key = keyRef.current;
    if (!key) return;
    const envelope = await encryptEnvelope(key, {
      kind: "audio-status",
      id: newId("audio"),
      createdAt: Date.now(),
      senderId: myIdRef.current,
      senderName: nameRef.current,
      status: next,
    });
    await broadcastEnvelope(envelope);
  }

  // Bezpečnostní výměna — po prvním úspěšném spojení obě strany zobrazí safety kód.
  async function exchangeSafetyCode(peerId: string) {
    const handle = peersRef.current.get(peerId);
    if (!handle || !keyRef.current) return;
    const fingerprint = await getDtlsFingerprint(handle.pc);
    setPeerView(peerId, { safetyCode: fingerprint });
    peerCodesRef.current.set(peerId, {
      mine: fingerprint,
      theirs: peerCodesRef.current.get(peerId)?.theirs ?? "",
    });

    // Odešli druhé straně náš fingerprint. Identitu peera doplní recipient z
    // vlastní tabulky peers — neposíláme ji, aby to nemohl podvrhnout útočník.
    const envelope = await encryptEnvelope(keyRef.current, {
      kind: "safety",
      senderId: myIdRef.current,
      senderName: nameRef.current,
      fingerprint,
    });
    try {
      handle.channel?.send(JSON.stringify(envelope));
    } catch {
      // ignore
    }
  }

  function handleAudioStatusFrame(frame: Extract<DecryptedPayload, { kind: "audio-status" }>) {
    setPeerView(frame.senderId, { audio: frame.status });
  }

  function handleSafetyFrame(
    frame: Extract<DecryptedPayload, { kind: "safety" }>,
    peerId: string,
  ) {
    const handle = peersRef.current.get(peerId);
    if (!handle) return;
    const mine = peerCodesRef.current.get(handle.id)?.mine || "????-????-????";
    setPeerSafetyChecked(
      (set) =>
        new Set(
          set.add(
            handle.id + ":" + (mine === frame.fingerprint ? "verified" : "mismatch"),
          ),
        ),
    );
    peerCodesRef.current.set(handle.id, {
      mine,
      theirs: frame.fingerprint,
    });
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
    audio.setAttribute("aria-hidden", "true");
    document.body.appendChild(audio);
    handle.audioElement = audio;
  }

  function detachAudioElement(handle: PeerHandle) {
    if (!handle.audioElement) return;
    handle.audioElement.srcObject = null;
    handle.audioElement.remove();
    handle.audioElement = undefined;
  }

  function wireDataChannel(peerId: string, channel: RTCDataChannel) {
    const handle = peersRef.current.get(peerId);
    if (handle) {
      handle.channel = channel;
    }

    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;

    channel.onopen = () => {
      setPeerView(peerId, { status: "open" });
      setNotice("P2P data kanál je otevřený. Texty i soubory už nejdou přes server.");
      void broadcastAudioStatus(audioStatusRef.current);
      void exchangeSafetyCode(peerId);
    };
    channel.onclose = () => setPeerView(peerId, { status: "closed", audio: "off" });
    channel.onerror = () => {
      setPeerView(peerId, { status: "closed" });
      systemMessage(`Spojení s ${handle?.name || peerId.slice(-6)} spadlo.`);
    };
    channel.onmessage = async (event) => {
      // 1) Pokud je to file-chunk/manifest/abort → handler
      const rawData = event.data;
      const rawString = typeof rawData === "string" ? rawData : String(rawData ?? "");
      if (rawString.includes('"file-chunk"') || rawString.includes('"file-manifest"')) {
        try {
          await handleFileControl(
            rawString,
            keyRef.current!,
            {
              onManifest: () => {
                // Mute — UI zobrazí progress z onProgress
              },
              onProgress: (received, total, state) => {
                setTransfers((tx) => ({
                  ...tx,
                  [state.transferId]: {
                    transferId: state.transferId,
                    fileId: state.manifest.fileId,
                    name: state.manifest.name,
                    mime: state.manifest.mime,
                    size: state.manifest.size,
                    msgId: state.transferId,
                    abortController:
                      tx[state.transferId]?.abortController ?? new AbortController(),
                    received,
                  },
                }));
              },
              onComplete: (blob, manifest) => {
                const url = URL.createObjectURL(blob);
                const msg: ChatMessage = {
                  id: newId("msg"),
                  senderId: "remote",
                  senderName: handle?.name || peerId.slice(-6),
                  text: manifest.name,
                  createdAt: Date.now(),
                  mine: false,
                  secure: true,
                  attachment: {
                    kind: manifest.mime.startsWith("image/") ? "image" : "file",
                    fileId: manifest.fileId,
                    name: manifest.name,
                    mime: manifest.mime,
                    size: manifest.size,
                    blobUrl: url,
                  },
                  progress: 1,
                };
                setMessages((cur) => [...cur, msg]);
              },
              onAbort: (reason) => {
                systemMessage(`Soubor ${reason}.`);
              },
            },
            activeFileTransfersRef.current,
          );
          return;
        } catch {
          // fall-through: zkusíme to dekódovat jako text
        }
      }

      // 2) Textová obálka (zpráva / audio-status / safety)
      try {
        const envelope = JSON.parse(rawString) as DataChannelEnvelope;
        const key = keyRef.current;
        if (!key) throw new Error("Missing room key");
        if (!envelope || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
          return;
        }
        const plaintext = await decryptEnvelope<DecryptedPayload>(key, envelope);

        if (plaintext.kind === "audio-status") {
          handleAudioStatusFrame(plaintext);
          return;
        }
        if (plaintext.kind === "safety") {
          // Bezpečnostní výměna: druhá strana poslala svůj DTLS fingerprint.
          if (handle) {
            handleSafetyFrame(plaintext, handle.id);
          }
          return;
        }

        setMessages((current) => [
          ...current,
          {
            id: plaintext.id,
            senderId: plaintext.senderId,
            senderName: plaintext.senderName,
            text: plaintext.text,
            createdAt: plaintext.createdAt,
            attachment: plaintext.attachment,
            mine: plaintext.senderId === myIdRef.current,
            secure: true,
          },
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
            new Notification(`CipherRoom · ${plaintext.senderName}`, {
              body: plaintext.text || "(příloha)",
              tag: "cipherroom",
            });
          } catch {
            // some browsers require ServiceWorkerRegistration.showNotification — ignore
          }
        }
      } catch {
        systemMessage("Přišla zpráva, ale nejde dešifrovat. Druhá strana má pravděpodobně jiný klíč místnosti.");
      }
    };
  }

  async function createPeer(peerId: string, peerName: string, initiator: boolean) {
    if (peersRef.current.has(peerId) || peerId === myIdRef.current) return;

    if ((peersRef.current.size + 1) > (maxPeersFromServer ?? 16)) {
      systemMessage("V místnosti je již maximální počet peerů.");
      return;
    }

    const pc = new RTCPeerConnection(buildRtcConfig());
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
    };
    pc.ondatachannel = (event) => wireDataChannel(peerId, event.channel);
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) attachAudioTrack(handle, stream);
    };

    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getAudioTracks().forEach((track) => {
        const sender = pc.addTrack(track, localAudioStreamRef.current!);
        handle.outgoingAudioSenders.push(sender);
      });
    }

    if (initiator) {
      const channel = pc.createDataChannel("cipherroom", { ordered: true });
      wireDataChannel(peerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peerId, offer);
    }
  }

  async function handleSignal(
    source: string,
    payload: RTCSessionDescriptionInit | RTCIceCandidateInit,
  ) {
    let handle = peersRef.current.get(source);
    if (!handle) {
      await createPeer(source, `peer-${source.slice(-4)}`, false);
      handle = peersRef.current.get(source);
    }
    if (!handle) return;

    if ("type" in payload && (payload.type === "offer" || payload.type === "answer")) {
      await handle.pc.setRemoteDescription(payload);
      if (payload.type === "offer") {
        const answer = await handle.pc.createAnswer();
        await handle.pc.setLocalDescription(answer);
        sendSignal(source, answer);
      }
      return;
    }

    if ("candidate" in payload && payload.candidate) {
      try {
        await handle.pc.addIceCandidate(payload);
      } catch {
        // ignore
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Connect — public API, voláno z formuláře
  // ───────────────────────────────────────────────────────────────────────────

  const connect = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      if (!passphrase.trim()) {
        setNotice("Zadej klíč místnosti. Bez něj by šifrování nemělo smysl.");
        return;
      }

      // Manuální reconnect — vždy smaž starý controller
      reconnectRef.current?.stop("manual-replaced");
      closeAllPeerConnections();

      const nextRoom = normalizeRoom(roomInput);
      const nextPeerId = newId("peer");
      setRoom(nextRoom);
      setMyId(nextPeerId);
      myIdRef.current = nextPeerId;
      roomRef.current = nextRoom;
      setMessages([]);
      setPeers([]);

      try {
        setWsPhase("connecting");
        setNotice("Klíč je odvozený lokálně v prohlížeči. Připojuji WebSocket signalizaci.");
        keyRef.current = await deriveRoomKey(nextRoom, passphrase);

        const controller = new ReconnectController(wsUrl(), {
          onPhase: (phase, detail) => {
            setWsPhase(phase);
            if (phase === "offline") {
              setNotice(`Signaling spadl: ${detail ?? "?"}. Automaticky obnovuji…`);
            }
            if (phase === "reconnecting") {
              setNotice(`Obnovuji signaling: ${detail ?? ""}`);
            }
          },
          onAttempt: (attempt, delayMs) => {
            setNotice(`Reconnect pokus #${attempt} za ${Math.round(delayMs / 1000)}s …`);
          },
          onSocket: (socket) => attachSocketHandlers(socket, nextRoom, nextPeerId),
        });
        reconnectRef.current = controller;
        controller.start();
      } catch (err) {
        setWsPhase("offline");
        setNotice(`Klíč nelze odvodit: ${(err as Error).message}`);
      }
    },
    [passphrase, roomInput],
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Socket handlers — bind z ReconnectController pokaždé, když se vytvoří socket
  // ───────────────────────────────────────────────────────────────────────────

  function attachSocketHandlers(socket: WebSocket, nextRoom: string, nextPeerId: string) {
    socketRef.current = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      // Reconnect → znovu pošli join
      socket.send(
        JSON.stringify({
          type: "join",
          room: nextRoom,
          peerId: nextPeerId,
          name: nameRef.current,
          resume: true,
        }),
      );
      setNotice("Signaling otevřen. Posílám JOIN.");
    };

    socket.onmessage = async (event) => {
      let frame: SignalFrame;
      try {
        frame = JSON.parse(String(event.data)) as SignalFrame;
      } catch {
        return;
      }

      if (frame.type === "joined") {
        if (maxPeersFromServer == null && frame.limits?.maxPeersPerRoom) {
          setMaxPeersFromServer(frame.limits.maxPeersPerRoom);
        }
        setWsPhase("joined");
        const resume = frame.resume === true;
        if (resume) {
          systemMessage(`Signaling obnoven. Peerů: ${frame.peers.length}.`);
        } else {
          systemMessage(`Připojeno do místnosti ${frame.room}. Nalezeno peerů: ${frame.peers.length}.`);
        }
        for (const peer of frame.peers) {
          await createPeer(peer.peerId, peer.name, true);
        }
      }

      if (frame.type === "peer-joined") {
        setPeerView(frame.peerId, {
          name: frame.name,
          status: "connecting",
          initiator: false,
        });
        systemMessage(`${frame.name} vstoupil do místnosti.`);
      }

      if (frame.type === "peer-left") {
        const handle = peersRef.current.get(frame.peerId);
        handle?.channel?.close();
        if (handle) detachAudioElement(handle);
        handle?.pc.close();
        peersRef.current.delete(frame.peerId);
        setPeers((current) => current.filter((peer) => peer.id !== frame.peerId));
        systemMessage(`Peer ${frame.peerId.slice(-6)} odešel.`);
      }

      if (frame.type === "signal") {
        await handleSignal(frame.source, frame.payload);
      }

      if (frame.type === "error") {
        setNotice(frame.message);
      }
    };

    socket.onclose = () => {
      // ReconnectController to řídí, tady jen vyčistíme UI
    };
    socket.onerror = () => {
      // ReconnectController to řídí
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Manual disconnect — nastaví manualDisconnect; reconnect loop se zastaví
  // ───────────────────────────────────────────────────────────────────────────

  function closeAllPeerConnections() {
    socketRef.current?.send(JSON.stringify({ type: "leave" }));
    socketRef.current?.close();
    socketRef.current = null;
    peersRef.current.forEach((peer) => {
      peer.channel?.close();
      detachAudioElement(peer);
      try {
        peer.pc.close();
      } catch {
        // ignore
      }
    });
    peersRef.current.clear();
    peerCodesRef.current.clear();
    setPeerSafetyChecked(new Set());
    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }
    setPeers([]);
    setAudioStatus("off");
    Object.values(transfers).forEach((t) => t.abortController.abort());
    setTransfers({});
  }

  function disconnectManual() {
    reconnectRef.current?.stop("manual");
    closeAllPeerConnections();
    keyRef.current = null;
    setWsPhase("idle");
    systemMessage("Lokální session ukončena. Klíč i WebRTC spojení jsou zahozena.");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Send messages / file
  // ───────────────────────────────────────────────────────────────────────────

  async function sendChatPayload(text: string, attachment?: AttachmentMeta) {
    const key = keyRef.current;
    if (!key) return;
    const payload = {
      kind: "text" as const,
      id: newId("msg"),
      text,
      createdAt: Date.now(),
      senderId: myIdRef.current,
      senderName: nameRef.current,
      attachment,
    };
    const envelope = await encryptEnvelope(key, payload);
    const sent = await broadcastEnvelope(envelope);

    if (sent > 0) {
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
        },
      ]);
      setMessageInput("");
    } else {
      setNotice("Zatím není otevřený žádný P2P data kanál.");
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = messageInput.trim();
    if (!text) return;
    await sendChatPayload(text);
  }

  async function handleFileAttachment(file: File) {
    if (!keyRef.current) {
      setNotice("Nejprve se připoj do místnosti.");
      return;
    }
    if (peersRef.current.size === 0) {
      setNotice("Žádný otevřený peer.");
      return;
    }
    const maxBytes = Math.min(
      DEFAULT_MAX_ATTACHMENT_BYTES,
      SERVER_MAX_ATTACHMENT_BYTES || DEFAULT_MAX_ATTACHMENT_BYTES,
    );
    if (file.size > maxBytes) {
      setNotice(
        `Soubor je větší než ${(maxBytes / (1024 * 1024 * 1024)).toFixed(2)} GB limit.`,
      );
      return;
    }

    // Odešli text zprávy s placeholderem (jméno souboru) pro UI
    const placeholderId = newId("msg");
    const placeholder: ChatMessage = {
      id: placeholderId,
      senderId: myIdRef.current,
      senderName: nameRef.current,
      text: `📎 ${file.name}`,
      createdAt: Date.now(),
      mine: true,
      secure: true,
      attachment: {
        kind: file.type.startsWith("image/") ? "image" : "file",
        fileId: newId("file"),
        name: file.name.slice(0, 96),
        mime: file.type || "application/octet-stream",
        size: file.size,
      },
      progress: 0,
    };
    setMessages((cur) => [...cur, placeholder]);

    const ac = new AbortController();
    const transferId = newId("xfer");

    setTransfers((tx) => ({
      ...tx,
      [transferId]: {
        transferId,
        fileId: placeholder.attachment!.fileId,
        name: placeholder.attachment!.name,
        mime: placeholder.attachment!.mime,
        size: file.size,
        msgId: placeholderId,
        abortController: ac,
        received: 0,
      },
    }));

    const updateProgress = (sent: number, total: number) => {
      setMessages((cur) =>
        cur.map((m) =>
          m.id === placeholderId
            ? {
                ...m,
                progress: total ? sent / total : 1,
              }
            : m,
        ),
      );
    };

    // Odešli přes všechny otevřené kanály (první peer, ale pokud je víc,
    // broadcastíme nezávisle).
    const tasks: Promise<void>[] = [];
    peersRef.current.forEach((handle) => {
      if (handle.channel?.readyState !== "open") return;
      tasks.push(
        sendFile({
          key: keyRef.current!,
          channel: handle.channel,
          file,
          maxBytes: SERVER_MAX_ATTACHMENT_BYTES || DEFAULT_MAX_ATTACHMENT_BYTES,
          onProgress: updateProgress,
          onComplete: () => {
            setTransfers((tx) => {
              const next = { ...tx };
              delete next[transferId];
              return next;
            });
          },
          onAbort: (reason) => {
            systemMessage(`Soubor "${file.name}" zrušen: ${reason}`);
            setTransfers((tx) => {
              const next = { ...tx };
              delete next[transferId];
              return next;
            });
          },
          signal: ac.signal,
        }).catch((err) => {
          systemMessage(`Chyba při posílání souboru: ${(err as Error).message}`);
        }),
      );
    });

    await Promise.all(tasks);
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await handleFileAttachment(file);
  }

  function insertEmoji(emoji: string) {
    setMessageInput((current) => `${current}${emoji}`);
    setEmojiOpen(false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Audio
  // ───────────────────────────────────────────────────────────────────────────

  async function startAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice("getUserMedia není dostupné v tomto prohlížeči.");
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
      systemMessage("Audio konference: tvůj mikrofon je živý.");
    } catch (err) {
      setAudioStatus("off");
      setNotice(`Mikrofon selhal: ${(err as Error).message}`);
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
    systemMessage("Audio konference: opustil/a jsi hovor.");
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

  // ───────────────────────────────────────────────────────────────────────────
  // UI helpers
  // ───────────────────────────────────────────────────────────────────────────

  async function copyRoomInfo() {
    const text = [
      `Room: ${room || normalizeRoom(roomInput)}`,
      "Passphrase: ⚠️ NEbyla zkopírována — pošli ji jiným kanálem (telefonicky, osobně, jiným messengerem). Passphrase nikdy neputuje přes tento chat ani přes server.",
    ].join("\n");
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setNotice("Schránka není dostupná.");
    }
  }

  async function enableNotifications() {
    if (!pushAvailable || !pushVapidKey) {
      if (!("Notification" in window)) {
        setNotice("Notifikace nejsou v tomto prohlížeči dostupné.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotice("Oprávnění k notifikacím nebylo uděleno.");
        return;
      }
      setNotificationsEnabled(true);
      systemMessage("Lokální notifikace zapnuty (server-side push není konfigurován).");
      return;
    }
    const result = await subscribeToPush(pushVapidKey);
    if (result.ok) {
      setNotificationsEnabled(true);
      systemMessage("Push notifikace přihlášené (delivery vyžaduje separátní worker).");
    } else {
      setNotice(result.reason || "Push subscribe selhal.");
    }
  }

  function disableNotifications() {
    setNotificationsEnabled(false);
    systemMessage("Notifikace lokálně vypnuté.");
  }

  function clearLocalData() {
    clearPreferences();
    setNotice("Lokální preference smazány. Klíč i zprávy zůstávají jen v paměti tabu.");
  }

  function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    } else if (event.key === "Escape" && emojiOpen) {
      setEmojiOpen(false);
    }
  }

  useEffect(() => {
    const onUnload = () => {
      // Nechceme reconnect po refreshi, jen uklidit
      try {
        socketRef.current?.send(JSON.stringify({ type: "leave" }));
      } catch {
        // ignore
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  if (!capabilities.supported) {
    return <UnsupportedBanner reasons={capabilities.unsupportedReasons} />;
  }

  return (
    <main className="min-h-screen bg-background text-foreground lg:h-dvh lg:overflow-hidden">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:h-dvh lg:min-h-0 lg:box-border lg:px-8">
        <header className="flex flex-col gap-4 rounded-3xl border border-border/70 bg-card/90 p-4 shadow-sm backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-primary/10 p-2 text-primary">
              <CipherLogo />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">CipherRoom</h1>
              <p className="text-sm text-muted-foreground">
                P2P místnostní chat, žádné ukládání, žádné soubory přes server.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="status-connection"
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm ${
                wsPhase === "joined"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : wsPhase === "reconnecting" || wsPhase === "offline"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "border-border bg-background text-muted-foreground"
              }`}
            >
              {wsPhase === "joined" ? (
                <Wifi className="h-4 w-4" />
              ) : wsPhase === "reconnecting" || wsPhase === "offline" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <WifiOff className="h-4 w-4" />
              )}
              {wsPhase === "joined"
                ? `${openPeerCount} P2P · ${peers.length} peer`
                : wsPhase === "reconnecting"
                  ? `reconnect…`
                  : wsPhase === "offline"
                    ? `offline · auto-reconnect`
                    : wsPhase === "connecting"
                      ? `connecting`
                      : wsPhase === "manual-disconnected"
                        ? `odpojeno`
                        : `idle`}
            </span>
            <button
              data-testid="button-theme"
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-3 py-2 text-sm hover:bg-accent"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              type="button"
              aria-label="Přepnout motiv"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <div className="grid flex-1 gap-4 py-4 lg:min-h-0 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
            <form
              data-testid="form-join"
              onSubmit={connect}
              className="rounded-3xl border border-border bg-card p-4 shadow-sm"
              autoComplete="off"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Místnost</h2>
                  <p className="text-sm text-muted-foreground">
                    Identita a klíč žijí jen v paměti tabu.
                  </p>
                </div>
                <Lock className="h-5 w-5 text-primary" />
              </div>

              <fieldset className="mb-3 grid grid-cols-2 gap-2 rounded-2xl border border-input bg-background p-1">
                <label
                  className={`flex cursor-pointer flex-col rounded-xl px-3 py-2 text-xs ${
                    mode === "light" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    className="sr-only"
                    checked={mode === "light"}
                    onChange={() => setMode("light")}
                    data-testid="radio-mode-light"
                  />
                  <span className="font-semibold">Light · P2P</span>
                  <span className="opacity-80">Jen WebRTC, server jenom signalizuje.</span>
                </label>
                <label
                  className={`flex cursor-pointer flex-col rounded-xl px-3 py-2 text-xs ${
                    mode === "server" ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    className="sr-only"
                    checked={mode === "server"}
                    onChange={() => setMode("server")}
                    data-testid="radio-mode-server"
                  />
                  <span className="font-semibold">Server-enhanced</span>
                  <span className="opacity-80">Volitelné push a metadata logy.</span>
                </label>
              </fieldset>

              <label className="grid gap-2 text-sm font-medium">
                Jméno
                <input
                  data-testid="input-name"
                  className="min-h-11 rounded-2xl border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={42}
                />
              </label>

              <label className="mt-3 grid gap-2 text-sm font-medium">
                Room ID
                <input
                  data-testid="input-room"
                  className="min-h-11 rounded-2xl border border-input bg-background px-3 font-mono text-base outline-none focus:ring-2 focus:ring-ring"
                  value={roomInput}
                  onChange={(event) => setRoomInput(event.target.value)}
                  maxLength={48}
                />
              </label>

              <label className="mt-3 grid gap-2 text-sm font-medium">
                Klíč místnosti
                <input
                  data-testid="input-passphrase"
                  className={`min-h-11 rounded-2xl border bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring ${
                    passStrength.level === "weak"
                      ? "border-rose-500/60"
                      : passStrength.level === "warn"
                        ? "border-amber-500/60"
                        : "border-emerald-500/60"
                  }`}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  type="password"
                  placeholder="sdílej bokem, neposílá se serveru"
                  autoComplete="new-password"
                />
                {passStrength.message ? (
                  <span
                    className={`text-xs ${passStrength.level === "weak" ? "text-rose-600 dark:text-rose-400" : passStrength.level === "warn" ? "text-amber-600 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-300"}`}
                  >
                    {passStrength.message}
                  </span>
                ) : null}
              </label>

              <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                <button
                  data-testid="button-connect"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  type="submit"
                  disabled={
                    wsPhase === "connecting" ||
                    !passStrength.ok ||
                    Object.keys(transfers).length > 0
                  }
                >
                  <Radio className="h-4 w-4" />
                  {wsPhase === "joined"
                    ? "Reconnect"
                    : wsPhase === "connecting"
                      ? "Připojuji…"
                      : "Připojit"}
                </button>
                <button
                  data-testid="button-copy-room"
                  className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-border bg-background px-3 hover:bg-accent"
                  type="button"
                  onClick={copyRoomInfo}
                  aria-label="Kopírovat informace o místnosti"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              {copied ? (
                <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
                  Room info zkopírováno. Passphrase NEBYLA vložena (pošli ji jinudy).
                </p>
              ) : null}
              {wsPhase === "joined" || wsPhase === "reconnecting" || wsPhase === "offline" ? (
                <button
                  data-testid="button-disconnect"
                  className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-border bg-background px-4 text-sm font-semibold hover:bg-accent"
                  type="button"
                  onClick={disconnectManual}
                >
                  <LogOut className="h-4 w-4" /> Manuální odpojení (zastaví auto-reconnect)
                </button>
              ) : null}
            </form>

            <section className="rounded-3xl border border-border bg-card p-4 shadow-sm" data-testid="section-audio">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Audio konference</h2>
                <span className="text-xs text-muted-foreground">{audioPeerCount} v hovoru</span>
              </div>
              <p className="mb-3 text-sm text-muted-foreground">
                Hlas jde stejným WebRTC spojením jako data kanál. Server hlas neslyší.
              </p>
              <div className="flex flex-wrap gap-2">
                {audioStatus === "off" || audioStatus === "joining" ? (
                  <button
                    type="button"
                    data-testid="button-audio-join"
                    className="inline-flex min-h-11 items-center gap-2 rounded-2xl bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                    onClick={() => void startAudio()}
                    disabled={wsPhase !== "joined" || audioStatus === "joining"}
                  >
                    <Mic className="h-4 w-4" />
                    {audioStatus === "joining" ? "Připojuji..." : "Připojit hlas"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid="button-audio-mute"
                      className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent"
                      onClick={() => void toggleMute()}
                    >
                      {audioStatus === "muted" ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                      {audioStatus === "muted" ? "Unmute" : "Mute"}
                    </button>
                    <button
                      type="button"
                      data-testid="button-audio-leave"
                      className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent"
                      onClick={() => void leaveAudio()}
                    >
                      <PhoneOff className="h-4 w-4" />
                      Opustit hovor
                    </button>
                  </>
                )}
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Peers</h2>
                <Users className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-2" data-testid="list-peers">
                {peers.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                    Připoj druhý tab nebo pošli Room ID dalšímu uživateli. Zprávy se zobrazí až po otevření P2P kanálu.
                  </div>
                ) : (
                  peers.map((peer) => {
                    const codes = peerCodesRef.current.get(peer.id);
                    const verified = peerSafetyChecked.has(peer.id + ":verified");
                    return (
                      <div
                        key={peer.id}
                        className="flex items-center justify-between gap-3 rounded-2xl bg-background p-3"
                      >
                        <div className="min-w-0">
                          <p
                            className="truncate text-sm font-medium"
                            data-testid={`text-peer-${peer.id}`}
                          >
                            {peer.name}
                          </p>
                          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                            <span>{peer.id.slice(-12)}</span>
                            {peer.safetyCode ? (
                              <span className="rounded bg-foreground/5 px-1 py-0.5">
                                🔐 {peer.safetyCode}
                                {codes?.theirs && codes.theirs === peer.safetyCode ? (
                                  verified ? (
                                    <CheckCheck className="ml-1 inline h-3 w-3 text-emerald-600" />
                                  ) : (
                                    <CheckCheck className="ml-1 inline h-3 w-3 text-amber-500" />
                                  )
                                ) : codes?.theirs && codes.theirs !== peer.safetyCode ? (
                                  <X className="ml-1 inline h-3 w-3 text-rose-600" />
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {peer.audio === "live" ? (
                            <Mic className="h-4 w-4 text-emerald-600" aria-label="audio live" />
                          ) : peer.audio === "muted" ? (
                            <MicOff className="h-4 w-4 text-amber-600" aria-label="audio muted" />
                          ) : null}
                          <span
                            className={`rounded-full px-2 py-1 text-xs ${
                              peer.status === "open"
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                : peer.status === "connecting"
                                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                  : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {peer.status}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold">Předvolby</h2>
              <div className="space-y-2 text-sm">
                <button
                  type="button"
                  data-testid="button-notifications"
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-border bg-background px-3 hover:bg-accent"
                  onClick={() =>
                    notificationsEnabled ? disableNotifications() : void enableNotifications()
                  }
                >
                  {notificationsEnabled ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                  {notificationsEnabled ? "Vypnout notifikace" : "Zapnout notifikace"}
                </button>
                <p className="text-xs text-muted-foreground">
                  {pushAvailable
                    ? "Server-side push je nakonfigurován (VAPID). Delivery worker je samostatná služba."
                    : "Server-side push není konfigurován. Budou se používat lokální notifikace v tabu."}
                </p>
                <button
                  type="button"
                  data-testid="button-clear-prefs"
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-border bg-background px-3 hover:bg-accent"
                  onClick={clearLocalData}
                >
                  <Trash2 className="h-4 w-4" />
                  Smazat lokální předvolby
                </button>
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold">Bezpečnost</h2>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  AES-GCM přes WebRTC DataChannel. Server nevidí plaintext zpráv ani souborů.
                </p>
                <p className="flex gap-2">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  Klíč je PBKDF2 (250 000 it.) odvozený lokálně a nikam se neposílá.
                </p>
                <p className="flex gap-2">
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  HTTP odpovědi mají no-store hlavičky, bez cookies a storage.
                </p>
                <p className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  Auto-reconnect WS: pokud spadne TCP spojení, okamžitě navazujeme znovu.
                </p>
                <p className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  {hasTURN
                    ? `TURN server je konfigurován (fallback pro restriktivní NAT).`
                    : `Bez TURN: za restriktivním NAT může P2P selhat. Doporučujeme nastavit VITE_TURN_URL.`}
                </p>
                <p className="flex gap-2">
                  <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  Soubory až ~2 GB letí šifrované po {CHUNK_SIZE} B chunks s SHA-256 ověřením integrity. Server je čistý signaling router.
                </p>
              </div>
            </section>
          </aside>

          <section className="flex min-h-[620px] flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-sm lg:min-h-0">
            <div className="border-b border-border p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Šifrovaný kanál</h2>
                  <p data-testid="text-notice" className="text-sm text-muted-foreground">
                    {notice}
                  </p>
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {room ? `room:${room}` : "not joined"} · {myId.slice(-10)}
                </div>
              </div>
            </div>

            <div
              data-testid="list-messages"
              className="flex-1 overflow-y-auto bg-chat-grid p-4"
            >
              {messages.length === 0 ? (
                <div className="flex h-full min-h-[420px] items-center justify-center">
                  <div className="max-w-sm rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Lock className="h-6 w-6" />
                    </div>
                    <h3 className="text-lg font-semibold">Čistá ephemeral místnost</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Žádná historie, žádné ukládání, žádný serverový relay. Soubory jdou rovnou mezi
                      prohlížeči po šifrovaném DataChannelu.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((message) => (
                    <article
                      key={message.id}
                      data-testid={`message-${message.id}`}
                      className={`flex ${message.mine ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[82%] rounded-3xl px-4 py-3 shadow-sm ${
                          message.senderId === "system"
                            ? "border border-border bg-card text-muted-foreground"
                            : message.mine
                              ? "bg-primary text-primary-foreground"
                              : "border border-border bg-card"
                        }`}
                      >
                        <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
                          <span className="font-semibold">{message.senderName}</span>
                          <span>{formatTime(message.createdAt)}</span>
                          {message.secure ? <Lock className="h-3 w-3" /> : null}
                          {typeof message.progress === "number" && message.progress < 1 ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {Math.round(message.progress * 100)}%
                            </span>
                          ) : null}
                        </div>
                        {message.text ? (
                          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                            {linkify(message.text)}
                          </p>
                        ) : null}
                        {message.attachment ? (
                          <div className="mt-2 rounded-2xl border border-border/60 bg-background/40 p-2 text-xs">
                            {/* Progress bar pro probíhající upload */}
                            {typeof message.progress === "number" && message.progress < 1 ? (
                              <div className="mb-2">
                                <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/10">
                                  <div
                                    className="h-full bg-current transition-all"
                                    style={{ width: `${Math.round(message.progress * 100)}%` }}
                                  />
                                </div>
                              </div>
                            ) : null}
                            {message.attachment.kind === "image" && message.attachment.blobUrl ? (
                              <img
                                src={message.attachment.blobUrl}
                                alt={message.attachment.name}
                                className="max-h-72 w-full rounded-xl object-contain"
                              />
                            ) : message.attachment.blobUrl ? (
                              <a
                                href={message.attachment.blobUrl}
                                download={message.attachment.name}
                                className="inline-flex items-center gap-2 underline decoration-dotted"
                              >
                                <Paperclip className="h-3 w-3" /> {message.attachment.name}
                              </a>
                            ) : (
                              <div className="inline-flex items-center gap-2">
                                {message.attachment.kind === "image" ? (
                                  <ImageIcon className="h-3 w-3" />
                                ) : (
                                  <FileText className="h-3 w-3" />
                                )}
                                {message.attachment.name}
                              </div>
                            )}
                            <div className="mt-1 text-[11px] opacity-70">
                              {message.attachment.mime} · {formatBytes(message.attachment.size)}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                  <div ref={messageEndRef} />
                </div>
              )}
            </div>

            <form onSubmit={sendMessage} className="border-t border-border bg-card p-4">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="button-emoji"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent"
                  onClick={() => setEmojiOpen((current) => !current)}
                  aria-expanded={emojiOpen}
                >
                  <Smile className="h-4 w-4" />
                  Emoji
                </button>
                <button
                  type="button"
                  data-testid="button-attach-file"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={openPeerCount === 0}
                >
                  <Paperclip className="h-4 w-4" />
                  Soubor
                </button>
                <button
                  type="button"
                  data-testid="button-attach-image"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={openPeerCount === 0}
                >
                  <ImageIcon className="h-4 w-4" />
                  Obrázek
                </button>
                <span className="text-xs text-muted-foreground">
                  Max ~2 GB / příloha · 64 KB chunks s SHA-256.
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleAttachmentChange}
                  data-testid="input-file"
                />
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAttachmentChange}
                  data-testid="input-image"
                />
              </div>

              {emojiOpen ? (
                <div
                  className="mb-2 flex flex-wrap gap-1 rounded-2xl border border-border bg-background p-2"
                  data-testid="picker-emoji"
                >
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

              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="sr-only" htmlFor="message">
                  Zpráva
                </label>
                <textarea
                  data-testid="input-message"
                  id="message"
                  className="min-h-14 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-base outline-none focus:ring-2 focus:ring-ring"
                  placeholder={openPeerCount > 0 ? "Napiš šifrovanou zprávu..." : "Čekám na otevřený P2P kanál..."}
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  onKeyDown={handleMessageKeyDown}
                />
                <button
                  data-testid="button-send"
                  className="inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  type="submit"
                  disabled={!canSend}
                >
                  <Send className="h-4 w-4" />
                  Odeslat
                </button>
              </div>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Router — kompatibilita pro deep-link cesty "/room/:id" (jinak "/" — lobby/room)
// ─────────────────────────────────────────────────────────────────────────────

function ChatRoute() {
  return <ChatApp />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ChatRoute} />
      <Route path="/room/:id" component={ChatRoute} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
