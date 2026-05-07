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
  Copy,
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
  Send,
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
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { detectCapabilities } from "./lib/capabilities";
import { clearPreferences, loadPreferences, savePreferences, DEFAULT_ROOM_SECURITY, type Preferences } from "./lib/preferences";
import { linkify } from "./lib/linkify";
import { fetchPushStatus, subscribeToPush, ensureServiceWorker } from "./lib/push";
import { dispatchInternal, installPublicAPI } from "./lib/cipherroom-api";
import { applyTheme, applyFont, applyEffects } from "./lib/themes";
import { detectLang, t, type Lang } from "./lib/i18n";
import { M5Logo } from "./components/M5Logo";
import {
  AnalyticsPanel,
  EncryptionPanel,
  NotificationsPanel,
  PrivacyPanel,
  ProfilePanel,
  RoomSecurityPanel,
  SettingsPanel,
  TemplatesPanel,
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

type AttachmentMeta = {
  kind: "file" | "image";
  name: string;
  mime: string;
  size: number;
  dataUrl: string;
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
  expiresAt?: number;
};

type SignalFrame =
  | { type: "joined"; peerId: string; room: string; peers: Array<{ peerId: string; name: string; joinedAt: number }> }
  | { type: "peer-joined"; peerId: string; name: string; joinedAt: number }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; source: string; payload: RTCSessionDescriptionInit | RTCIceCandidateInit }
  | { type: "hello"; peerId: string }
  | { type: "error"; message: string };

type DataChannelEnvelope = { iv: string; ciphertext: string };

type DecryptedPayload =
  | {
      kind?: undefined | "text";
      id: string;
      text: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      attachment?: AttachmentMeta;
      ttlMinutes?: number;
    }
  | {
      kind: "audio-status";
      id: string;
      createdAt: number;
      senderId: string;
      senderName: string;
      status: AudioStatus;
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
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceTransportPolicy: "all",
};
const ATTACHMENT_LIMIT = 512 * 1024;
const QUICK_EMOJI = ["😀", "😂", "🥳", "👍", "🙏", "🔥", "❤️", "🎉", "✅", "❓"];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function newId(prefix = "id") {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

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

function toBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
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

async function deriveRoomKey(room: string, passphrase: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode(`CipherRoom:v1:${room}`),
      iterations: 250_000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptEnvelope(key: CryptoKey, payload: unknown): Promise<DataChannelEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
}

async function decryptEnvelope<T>(key: CryptoKey, envelope: DataChannelEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

function formatTime(value: number, lang: Lang, timezone: string) {
  try {
    return new Intl.DateTimeFormat(lang === "cs" ? "cs-CZ" : lang === "de" ? "de-DE" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: timezone || undefined,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleTimeString();
  }
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToAttachment(file: File): Promise<AttachmentMeta> {
  if (file.size > ATTACHMENT_LIMIT) {
    throw new Error(`File exceeds ${formatBytes(ATTACHMENT_LIMIT)}.`);
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

type PanelKey =
  | "profile"
  | "settings"
  | "templates"
  | "privacy"
  | "encryption"
  | "notifications"
  | "analytics"
  | "roomSecurity"
  | "join"
  | "peers"
  | "audio"
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("off");
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushVapidKey, setPushVapidKey] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<PanelKey>(null);
  const [now, setNow] = useState(Date.now());

  const socketRef = useRef<WebSocket | null>(null);
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
  const notificationsEnabledRef = useRef(initialPrefs.notificationsEnabled);

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

  const canSend = status === "joined" && openPeerCount > 0 && messageInput.trim().length > 0;

  function setPrefs(next: Partial<Preferences>) {
    setPrefsState((current) => {
      const merged = { ...current, ...next };
      savePreferences(merged);
      return merged;
    });
  }

  // Apply theme/font/effects whenever they change.
  useEffect(() => {
    applyTheme(prefs.theme);
  }, [prefs.theme]);
  useEffect(() => {
    applyFont(prefs.font, prefs.fontSize);
  }, [prefs.font, prefs.fontSize]);
  useEffect(() => {
    applyEffects(prefs.effects);
  }, [prefs.effects]);
  useEffect(() => {
    document.documentElement.setAttribute("lang", prefs.lang);
  }, [prefs.lang]);

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

  function systemMessage(text: string) {
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

  function sendSignal(target: string, payload: RTCSessionDescriptionInit | RTCIceCandidateInit) {
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
          // ignore
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

  function handleAudioStatusFrame(frame: Extract<DecryptedPayload, { kind: "audio-status" }>) {
    setPeerView(frame.senderId, { audio: frame.status });
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

  function wireDataChannel(peerId: string, channel: RTCDataChannel) {
    const handle = peersRef.current.get(peerId);
    if (handle) {
      handle.channel = channel;
    }

    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      setPeerView(peerId, { status: "open" });
      setNotice(lang === "cs"
        ? "P2P data kanál je otevřený."
        : lang === "de" ? "P2P-Datenkanal offen." : "P2P data channel is open.");
      void broadcastAudioStatus(audioStatusRef.current);
    };
    channel.onclose = () => setPeerView(peerId, { status: "closed", audio: "off" });
    channel.onerror = () => {
      setPeerView(peerId, { status: "closed" });
      systemMessage(`Connection with ${handle?.name || peerId.slice(-6)} dropped.`);
    };
    channel.onmessage = async (event) => {
      try {
        const envelope = JSON.parse(String(event.data)) as DataChannelEnvelope;
        const key = keyRef.current;
        if (!key) throw new Error("Missing room key");
        const plaintext = await decryptEnvelope<DecryptedPayload>(key, envelope);

        if (plaintext.kind === "audio-status") {
          handleAudioStatusFrame(plaintext);
          return;
        }

        const expiresAt = computeExpiry(plaintext.ttlMinutes, plaintext.createdAt);
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
            expiresAt,
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
            new Notification(`M5cet · ${plaintext.senderName}`, {
              body: plaintext.text || "(attachment)",
              tag: "m5cet",
            });
          } catch {
            // ignore
          }
        }
      } catch {
        systemMessage(lang === "cs"
          ? "Přišla zpráva, ale nejde dešifrovat. Druhá strana má pravděpodobně jiný klíč."
          : lang === "de" ? "Nachricht konnte nicht entschlüsselt werden — andere Seite hat anderen Schlüssel."
            : "A message arrived but could not be decrypted. The other side likely has a different room key.");
      }
    };
  }

  async function createPeer(peerId: string, peerName: string, initiator: boolean) {
    if (peersRef.current.has(peerId) || peerId === myIdRef.current) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
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
      const channel = pc.createDataChannel("m5cet", { ordered: true });
      wireDataChannel(peerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(peerId, offer);
    }
  }

  async function handleSignal(source: string, payload: RTCSessionDescriptionInit | RTCIceCandidateInit) {
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
      await handle.pc.addIceCandidate(payload);
    }
  }

  async function connect(event?: FormEvent) {
    event?.preventDefault();
    if (!passphrase.trim()) {
      setNotice(lang === "cs" ? "Zadej klíč místnosti." : lang === "de" ? "Bitte Raum-Schlüssel eingeben." : "Enter the room key.");
      return;
    }

    disconnect(false);
    const nextRoom = normalizeRoom(roomInput);
    const nextPeerId = newId("peer");
    setStatus("deriving");
    setRoom(nextRoom);
    setMyId(nextPeerId);
    myIdRef.current = nextPeerId;
    roomRef.current = nextRoom;
    keyRef.current = await deriveRoomKey(nextRoom, passphrase);
    setMessages([]);
    setPeers([]);
    setStatus("connecting");

    const socket = new WebSocket(wsUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "join", room: nextRoom, peerId: nextPeerId, name: nameRef.current }));
    };
    socket.onmessage = async (event) => {
      const frame = JSON.parse(String(event.data)) as SignalFrame;

      if (frame.type === "joined") {
        setStatus("joined");
        systemMessage(`Joined ${frame.room}. Peers: ${frame.peers.length}.`);
        for (const peer of frame.peers) {
          await createPeer(peer.peerId, peer.name, true);
        }
        if (prefs.mode === "server" && prefs.analyticsConsent) {
          void fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "client-join",
              room: nextRoom,
              peerId: nextPeerId,
              meta: { peers: frame.peers.length, deviceId: prefs.deviceId },
            }),
          }).catch(() => undefined);
        }
        // Close the join modal once we are in.
        setActivePanel((current) => (current === "join" ? null : current));
      }

      if (frame.type === "peer-joined") {
        setPeerView(frame.peerId, { name: frame.name, status: "connecting", initiator: false });
        systemMessage(`${frame.name} entered the room.`);
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
        await handleSignal(frame.source, frame.payload);
      }

      if (frame.type === "error") {
        setNotice(frame.message);
      }
    };
    socket.onclose = () => {
      setStatus((current) => (current === "idle" ? "idle" : "offline"));
    };
    socket.onerror = () => {
      setStatus("offline");
      setNotice(lang === "cs" ? "WebSocket signalizace není dostupná." : lang === "de" ? "WebSocket-Signalisierung nicht erreichbar." : "WebSocket signaling unavailable.");
    };
  }

  function disconnect(showMessage = true) {
    socketRef.current?.send(JSON.stringify({ type: "leave" }));
    socketRef.current?.close();
    socketRef.current = null;
    peersRef.current.forEach((peer) => {
      peer.channel?.close();
      detachAudioElement(peer);
      peer.pc.close();
    });
    peersRef.current.clear();
    keyRef.current = null;
    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }
    setPeers([]);
    setAudioStatus("off");
    setStatus("idle");
    if (showMessage) {
      systemMessage(lang === "cs"
        ? "Lokální session ukončena. Klíč i WebRTC spojení jsou zahozena."
        : lang === "de" ? "Lokale Session beendet. Schlüssel und WebRTC-Verbindungen verworfen."
          : "Local session ended. Key and WebRTC connections discarded.");
    }
  }

  async function sendChatPayload(text: string, attachment?: AttachmentMeta) {
    const key = keyRef.current;
    if (!key) return;
    const { perMessage } = ttlForRoom();
    const ttlMinutes = perMessage > 0 ? perMessage : undefined;

    const payload = {
      id: newId("msg"),
      text,
      createdAt: Date.now(),
      senderId: myIdRef.current,
      senderName: nameRef.current,
      attachment,
      ttlMinutes,
    };
    const envelope = await encryptEnvelope(key, payload);
    const sent = await broadcastEnvelope(envelope);

    if (sent > 0) {
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
        },
      ]);
      setMessageInput("");
    } else {
      setNotice(lang === "cs" ? "Zatím není otevřený žádný P2P data kanál." : lang === "de" ? "Noch kein offener P2P-Kanal." : "No open P2P data channel yet.");
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = messageInput.trim();
    if (!text) return;
    await sendChatPayload(text);
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const attachment = await fileToAttachment(file);
      await sendChatPayload(messageInput.trim(), attachment);
    } catch (err) {
      setNotice((err as Error).message);
    }
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
    const text = `Room: ${room || normalizeRoom(roomInput)}\nKey: ${passphrase ? "(share out-of-band)" : "(none)"}`;
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

    const result = await subscribeToPush(pushVapidKey);
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

  useEffect(() => () => disconnect(false), []);

  if (!capabilities.supported) {
    return <UnsupportedBanner reasons={capabilities.unsupportedReasons} />;
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground safe-pt safe-pb safe-px">
      {/* Top motorsport stripe */}
      <div className="m5-stripe h-1 w-full" aria-hidden="true" />

      {/* Top app bar */}
      <header className="flex items-center gap-2 border-b border-border bg-card/80 px-3 py-2 backdrop-blur sm:px-4">
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
          className="ml-2 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs"
        >
          {status === "joined" ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <WifiOff className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="hidden sm:inline">{status === "joined" ? `${openPeerCount} P2P · ${room}` : t(lang, `status.${status}`)}</span>
          <span className="sm:hidden">{status === "joined" ? `${openPeerCount}` : status[0]}</span>
        </span>

        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton testId="btn-templates" label={t(lang, "menu.templates")} onClick={() => setActivePanel("templates")} icon={<Palette />} />
          <ToolbarButton testId="btn-settings" label={t(lang, "menu.settings")} onClick={() => setActivePanel("settings")} icon={<SettingsIcon />} />
          <ToolbarButton testId="btn-encryption" label={t(lang, "menu.encryption")} onClick={() => setActivePanel("encryption")} icon={<KeyRound />} />
          <ToolbarButton testId="btn-room-security" label={t(lang, "room.security.title")} onClick={() => setActivePanel("roomSecurity")} icon={<ShieldCheck />} />
          <ToolbarButton testId="btn-privacy" label={t(lang, "menu.privacy")} onClick={() => setActivePanel("privacy")} icon={<Eye />} />
          <ToolbarButton testId="btn-notifications" label={t(lang, "menu.notifications")} onClick={() => setActivePanel("notifications")} icon={<BellIcon />} />
          <ToolbarButton testId="btn-analytics" label={t(lang, "menu.analytics")} onClick={() => setActivePanel("analytics")} icon={<Activity />} />
          <ToolbarButton testId="btn-profile" label={t(lang, "menu.profile")} onClick={() => setActivePanel("profile")} icon={<UserCircle2 />} />
          <ToolbarButton testId="btn-peers" label={t(lang, "menu.peers")} onClick={() => setActivePanel("peers")} icon={<Users />} />
          <ToolbarButton testId="btn-audio" label={t(lang, "menu.audio")} onClick={() => setActivePanel("audio")} icon={<Mic />} />
          <ToolbarButton testId="btn-language" label={t(lang, "common.language")} onClick={() => setActivePanel("settings")} icon={<Languages />} />
        </div>
      </header>

      {/* Full-screen chat area */}
      <main className="relative flex flex-1 min-h-0 flex-col chat-canvas">
        <div className="flex flex-1 min-h-0 flex-col">
          <div className="flex-shrink-0 border-b border-border bg-card/60 px-3 py-2 sm:px-4">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p data-testid="text-notice" className="truncate text-muted-foreground">
                {notice}
              </p>
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>{room ? `room:${room}` : t(lang, "status.idle")}</span>
                <span className="hidden sm:inline">·</span>
                <span className="hidden sm:inline">{myId.slice(-10)}</span>
                {status === "joined" ? (
                  <button type="button" onClick={() => disconnect()} className="ml-1 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-accent">
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

          <div data-testid="list-messages" className="flex-1 overflow-y-auto bg-chat-grid p-3 sm:p-5">
            {visibleMessages.length === 0 ? (
              <div className="flex h-full min-h-[60dvh] items-center justify-center">
                <div className="max-w-md rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Lock className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold">{t(lang, "chat.empty.title")}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{t(lang, "chat.empty.body")}</p>
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
              <div className="mx-auto w-full max-w-4xl space-y-3">
                {visibleMessages.map((message) => (
                  <article
                    key={message.id}
                    data-testid={`message-${message.id}`}
                    className={`flex ${message.mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[88%] rounded-3xl px-4 py-3 shadow-sm ${
                        message.senderId === "system"
                          ? "border border-border bg-card text-muted-foreground"
                          : message.mine
                            ? "bg-primary text-primary-foreground"
                            : "border border-border bg-card"
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
                        <span className="font-semibold">{message.senderName}</span>
                        <span>{formatTime(message.createdAt, lang, prefs.timezone)}</span>
                        {message.secure ? <Lock className="h-3 w-3" /> : null}
                        {message.expiresAt ? (
                          <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                            TTL
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
                          {message.attachment.kind === "image" ? (
                            <img
                              src={message.attachment.dataUrl}
                              alt={message.attachment.name}
                              className="max-h-72 w-full rounded-xl object-contain"
                            />
                          ) : (
                            <a
                              href={message.attachment.dataUrl}
                              download={message.attachment.name}
                              className="inline-flex items-center gap-2 underline decoration-dotted"
                            >
                              <Paperclip className="h-3 w-3" />
                              {message.attachment.name}
                            </a>
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

          <form onSubmit={sendMessage} className="border-t border-border bg-card/80 p-3 sm:p-4 backdrop-blur">
            <div className="mx-auto w-full max-w-4xl">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="button-emoji"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent"
                  onClick={() => setEmojiOpen((current) => !current)}
                  aria-expanded={emojiOpen}
                >
                  <Smile className="h-4 w-4" />
                  {t(lang, "chat.emoji")}
                </button>
                <button
                  type="button"
                  data-testid="button-attach-file"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={openPeerCount === 0}
                >
                  <Paperclip className="h-4 w-4" />
                  {t(lang, "chat.attach.file")}
                </button>
                <button
                  type="button"
                  data-testid="button-attach-image"
                  className="inline-flex min-h-9 items-center gap-1 rounded-full border border-border bg-background px-3 text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={openPeerCount === 0}
                >
                  <ImageIcon className="h-4 w-4" />
                  {t(lang, "chat.attach.image")}
                </button>
                <span className="text-xs text-muted-foreground">Max {formatBytes(ATTACHMENT_LIMIT)}.</span>
                <input ref={fileInputRef} type="file" className="hidden" onChange={handleAttachmentChange} data-testid="input-file" />
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleAttachmentChange} data-testid="input-image" />
              </div>

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

              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="sr-only" htmlFor="message">Message</label>
                <textarea
                  data-testid="input-message"
                  id="message"
                  className="min-h-14 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-base outline-none focus:ring-2 focus:ring-ring"
                  placeholder={openPeerCount > 0 ? t(lang, "chat.placeholder") : t(lang, "chat.placeholder.waiting")}
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
                  {t(lang, "common.send")}
                </button>
              </div>
            </div>
          </form>
        </div>
      </main>

      {/* Modal panels */}
      <ProfilePanel open={activePanel === "profile"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <SettingsPanel open={activePanel === "settings"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <TemplatesPanel open={activePanel === "templates"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <EncryptionPanel open={activePanel === "encryption"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} />
      <RoomSecurityPanel open={activePanel === "roomSecurity"} onClose={() => setActivePanel(null)} prefs={prefs} setPrefs={setPrefs} lang={lang} room={room} />
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

      {/* Join modal */}
      {activePanel === "join" ? (
        <SimpleModal title={t(lang, "menu.room")} onClose={() => setActivePanel(null)}>
          <form
            data-testid="form-join"
            onSubmit={(event) => {
              void connect(event);
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
              {status === "joined" ? (
                <button type="button" onClick={() => disconnect()} className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-border bg-background px-3 text-sm hover:bg-accent">
                  <LogOut className="h-4 w-4" />
                  {t(lang, "common.disconnect")}
                </button>
              ) : null}
            </div>
          </form>
        </SimpleModal>
      ) : null}
    </div>
  );
}

function ToolbarButton({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid={testId}
      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-transparent text-foreground hover:border-border hover:bg-accent sm:w-auto sm:gap-2 sm:px-3"
    >
      <span className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
      <span className="hidden text-xs sm:inline">{label}</span>
    </button>
  );
}

function SimpleModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/45 p-3 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="my-auto flex max-h-[92dvh] w-full max-w-xl flex-col modal-shell" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent">×</button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
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

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ChatApp} />
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
