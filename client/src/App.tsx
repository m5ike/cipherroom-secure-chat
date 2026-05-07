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
import { clearPreferences, loadPreferences, savePreferences, type Preferences } from "./lib/preferences";
import { linkify } from "./lib/linkify";
import { fetchPushStatus, subscribeToPush, ensureServiceWorker } from "./lib/push";
import { dispatchInternal, installPublicAPI } from "./lib/cipherroom-api";

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

  return {
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
  };
}

async function decryptEnvelope<T>(key: CryptoKey, envelope: DataChannelEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

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
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function fileToAttachment(file: File): Promise<AttachmentMeta> {
  if (file.size > ATTACHMENT_LIMIT) {
    throw new Error(`Soubor je větší než ${formatBytes(ATTACHMENT_LIMIT)}.`);
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

function CipherLogo() {
  return (
    <svg aria-label="CipherRoom logo" viewBox="0 0 36 36" className="h-9 w-9" fill="none">
      <rect x="6" y="11" width="24" height="18" rx="6" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 11V8.8C12 5.6 14.6 3 17.8 3h.4C21.4 3 24 5.6 24 8.8V11" stroke="currentColor" strokeWidth="2.2" />
      <path d="M13.5 19h9M13.5 23h5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
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
          Tato aplikace potřebuje moderní šifrování a P2P přenos přímo v prohlížeči. Internet Explorer není
          podporován. Použij prosím Edge, Chrome, Firefox nebo Safari.
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
  const [status, setStatus] = useState<"idle" | "deriving" | "connecting" | "joined" | "offline">("idle");
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
  const [notificationsEnabled, setNotificationsEnabled] = useState(initialPrefs.notificationsEnabled);

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
  const notificationsEnabledRef = useRef(notificationsEnabled);

  const openPeerCount = useMemo(() => peers.filter((peer) => peer.status === "open").length, [peers]);
  const audioPeerCount = useMemo(
    () => peers.filter((peer) => peer.audio === "live" || peer.audio === "muted").length,
    [peers],
  );
  const canSend = status === "joined" && openPeerCount > 0 && messageInput.trim().length > 0;

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
        senderName: "CipherRoom",
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

  function wireDataChannel(peerId: string, channel: RTCDataChannel) {
    const handle = peersRef.current.get(peerId);
    if (handle) {
      handle.channel = channel;
    }

    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      setPeerView(peerId, { status: "open" });
      setNotice("P2P data kanál je otevřený. Texty už nejdou přes server.");
      void broadcastAudioStatus(audioStatusRef.current);
    };
    channel.onclose = () => setPeerView(peerId, { status: "closed", audio: "off" });
    channel.onerror = () => {
      setPeerView(peerId, { status: "closed" });
      systemMessage(`Spojení s ${handle?.name || peerId.slice(-6)} spadlo.`);
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
      const channel = pc.createDataChannel("cipherroom", { ordered: true });
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
      setNotice("Zadej klíč místnosti. Bez něj by šifrování nemělo smysl.");
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
    setNotice("Klíč je odvozený lokálně v prohlížeči. Připojuji WebSocket signalizaci.");
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
        systemMessage(`Připojeno do místnosti ${frame.room}. Nalezeno peerů: ${frame.peers.length}.`);
        for (const peer of frame.peers) {
          await createPeer(peer.peerId, peer.name, true);
        }
        if (mode === "server") {
          void fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "client-join",
              room: nextRoom,
              peerId: nextPeerId,
              meta: { peers: frame.peers.length },
            }),
          }).catch(() => undefined);
        }
      }

      if (frame.type === "peer-joined") {
        setPeerView(frame.peerId, { name: frame.name, status: "connecting", initiator: false });
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
      setStatus((current) => (current === "idle" ? "idle" : "offline"));
    };
    socket.onerror = () => {
      setStatus("offline");
      setNotice("WebSocket signalizace není dostupná.");
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
      systemMessage("Lokální session ukončena. Klíč i WebRTC spojení jsou zahozena.");
    }
  }

  async function sendChatPayload(text: string, attachment?: AttachmentMeta) {
    const key = keyRef.current;
    if (!key) return;
    const payload = {
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

  async function copyRoom() {
    const text = `Room: ${room || normalizeRoom(roomInput)}\nKey: ${passphrase ? "(pošli mimo tento chat)" : "(není zadán)"}`;
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
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
      systemMessage("Push notifikace přihlášené.");
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
    }
  }

  useEffect(() => () => disconnect(false), []);

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
              <p className="text-sm text-muted-foreground">P2P místnostní chat, žádné ukládání, žádná cache.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="status-connection"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2 text-sm"
            >
              {status === "joined" ? <Wifi className="h-4 w-4 text-emerald-600" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
              {status === "joined" ? `${openPeerCount} P2P` : status}
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
                  <p className="text-sm text-muted-foreground">Identita a klíč žijí jen v paměti tabu.</p>
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
                  className="min-h-11 rounded-2xl border border-input bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  type="password"
                  placeholder="sdílej bokem, neposílá se serveru"
                  autoComplete="new-password"
                />
              </label>

              <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
                <button
                  data-testid="button-connect"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  type="submit"
                  disabled={status === "deriving" || status === "connecting"}
                >
                  <Radio className="h-4 w-4" />
                  {status === "joined" ? "Reconnect" : "Připojit"}
                </button>
                <button
                  data-testid="button-copy-room"
                  className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-border bg-background px-3 hover:bg-accent"
                  type="button"
                  onClick={copyRoom}
                  aria-label="Kopírovat místnost"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              {copied ? <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Room info zkopírováno.</p> : null}
              {status === "joined" ? (
                <button
                  data-testid="button-disconnect"
                  className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-border bg-background px-4 text-sm font-semibold hover:bg-accent"
                  type="button"
                  onClick={() => disconnect()}
                >
                  <LogOut className="h-4 w-4" />
                  Odpojit a zahodit klíč
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
                    disabled={status !== "joined" || audioStatus === "joining"}
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
                  peers.map((peer) => (
                    <div key={peer.id} className="flex items-center justify-between gap-3 rounded-2xl bg-background p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" data-testid={`text-peer-${peer.id}`}>
                          {peer.name}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">{peer.id.slice(-12)}</p>
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
                  ))
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
                  onClick={() => (notificationsEnabled ? disableNotifications() : void enableNotifications())}
                >
                  {notificationsEnabled ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                  {notificationsEnabled ? "Vypnout notifikace" : "Zapnout notifikace"}
                </button>
                <p className="text-xs text-muted-foreground">
                  {pushAvailable
                    ? "Server-side push je nakonfigurován (VAPID)."
                    : "Server-side push není konfigurován. Použijí se lokální notifikace v tabu."}
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
                  AES-GCM nad WebRTC DataChannel. Server nevidí plaintext zpráv.
                </p>
                <p className="flex gap-2">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  Klíč je PBKDF2 odvozený lokálně a nikam se neposílá.
                </p>
                <p className="flex gap-2">
                  <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  HTTP odpovědi mají no-store hlavičky, bez cookies a storage.
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

            <div data-testid="list-messages" className="flex-1 overflow-y-auto bg-chat-grid p-4">
              {messages.length === 0 ? (
                <div className="flex h-full min-h-[420px] items-center justify-center">
                  <div className="max-w-sm rounded-3xl border border-border bg-card/90 p-6 text-center shadow-sm">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <Lock className="h-6 w-6" />
                    </div>
                    <h3 className="text-lg font-semibold">Čistá ephemeral místnost</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Žádná historie, žádné ukládání, žádný serverový relay textů. Pošli první zprávu, až bude peer ve stavu open.
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
                <span className="text-xs text-muted-foreground">Max {formatBytes(ATTACHMENT_LIMIT)} / příloha.</span>
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
