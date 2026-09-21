// Connection keeper / clock service.
//
// Provides heartbeat over the signaling WebSocket, exponential backoff
// reconnect with user intent flag, online/offline + Page Visibility hooks,
// and three keepalive strategies (conservative / balanced / aggressive).
//
// Persistent connection contract:
//   - `intent` keeps the connection alive across network blips forever
//     (capped only by an explicit `stop()` which the client UI calls when
//     the user clicks Leave).
//   - `disconnectReason` is exposed in `ConnectionStatus` so the UI can
//     show "network issue, reconnecting" vs "you pressed Leave".
//   - Heartbeats are tried with three overlapping strategies so a flaky
//     network does not kill the connection unnecessarily — pong RTT is
//     tracked per-message and exposed via the status object.
//   - `requestStop()` is the ONLY way to permanently tear down. Anything
//     else (close event, browser tab hidden, OS sleep, NAT rebind)
//     triggers automatic reconnect.
//
// Important: browsers throttle background timers (Chrome ~1 minute,
// Firefox/Safari similar) and may suspend WebSockets entirely on mobile
// when the page is hidden. We do NOT pretend to override that. Instead
// we expose service worker / push hooks so the app can be re-armed by
// a push notification or visibility change.
//
// Public API:
//   const keeper = createConnectionKeeper({ url, onOpen, onClose, onMessage, strategy });
//   keeper.start();           // intent = true, persistent reconnect begins
//   keeper.requestStop();     // intent = false, no further reconnects
//   keeper.send(obj);
//   keeper.setStrategy("aggressive");
//   keeper.subscribe((status) => ...);

export type KeepaliveStrategy = "conservative" | "balanced" | "aggressive";

export type DisconnectReason = "idle" | "client-leave" | "server-close" | "network" | "offline" | "inactivity";

export type ConnectionStatus = {
  state: "idle" | "connecting" | "open" | "reconnecting" | "offline" | "stopped";
  lastActivityAt: number;
  lastPingAt: number;
  lastPongAt: number;
  rttMs: number;
  attempts: number;
  strategy: KeepaliveStrategy;
  disconnectReason: DisconnectReason;
  nextReconnectAtMs: number; // 0 when no reconnect is scheduled
  totalReconnects: number;
};

export type StrategyConfig = {
  pingIntervalMs: number;
  inactivityTimeoutMs: number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
};

export const STRATEGIES: Record<KeepaliveStrategy, StrategyConfig> = {
  conservative: {
    pingIntervalMs: 45_000,
    inactivityTimeoutMs: 180_000,
    reconnectInitialDelayMs: 1_500,
    reconnectMaxDelayMs: 30_000,
  },
  balanced: {
    pingIntervalMs: 25_000,
    inactivityTimeoutMs: 90_000,
    reconnectInitialDelayMs: 1_000,
    reconnectMaxDelayMs: 15_000,
  },
  aggressive: {
    pingIntervalMs: 12_000,
    inactivityTimeoutMs: 30_000,
    reconnectInitialDelayMs: 500,
    reconnectMaxDelayMs: 8_000,
  },
};

export type ConnectionKeeperOptions = {
  url: () => string;
  strategy?: KeepaliveStrategy;
  onOpen?: (socket: WebSocket) => void;
  onClose?: (event: CloseEvent | { code: number; reason: string }, reason: DisconnectReason) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (err: Event) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Maximum total backoff cap across all retries. Default 2 minutes. */
  maxTotalBackoffMs?: number;
};

export type ConnectionKeeper = {
  start: () => void;
  requestStop: () => void;
  send: (obj: unknown) => boolean;
  setStrategy: (s: KeepaliveStrategy) => void;
  getStatus: () => ConnectionStatus;
  subscribe: (cb: (status: ConnectionStatus) => void) => () => void;
  socket: () => WebSocket | null;
  forceReconnect: () => void;
};

export function createConnectionKeeper(options: ConnectionKeeperOptions): ConnectionKeeper {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** User wants to stay connected. Only requestStop() sets this to false. */
  let intent = false;
  /** Last observed disconnect reason, surfaced in ConnectionStatus. */
  let disconnectReason: DisconnectReason = "idle";
  let nextReconnectAtMs = 0;
  let totalReconnects = 0;
  const maxTotalBackoffMs = options.maxTotalBackoffMs ?? 120_000;

  const subscribers = new Set<(s: ConnectionStatus) => void>();

  const status: ConnectionStatus = {
    state: "idle",
    lastActivityAt: 0,
    lastPingAt: 0,
    lastPongAt: 0,
    rttMs: 0,
    attempts: 0,
    strategy: options.strategy || "balanced",
    disconnectReason: "idle",
    nextReconnectAtMs: 0,
    totalReconnects: 0,
  };

  function notify() {
    status.disconnectReason = disconnectReason;
    status.nextReconnectAtMs = nextReconnectAtMs;
    status.totalReconnects = totalReconnects;
    options.onStatus?.(status);
    subscribers.forEach((cb) => {
      try { cb(status); } catch { /* ignore */ }
    });
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    nextReconnectAtMs = 0;
  }

  function startKeepalive() {
    const cfg = STRATEGIES[status.strategy];
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        const t = Date.now();
        status.lastPingAt = t;
        socket.send(JSON.stringify({ type: "ping", t }));
        notify();
      } catch { /* ignore */ }
    }, cfg.pingIntervalMs);

    if (activityTimer) clearInterval(activityTimer);
    activityTimer = setInterval(() => {
      const since = Date.now() - (status.lastActivityAt || Date.now());
      if (since > cfg.inactivityTimeoutMs && socket?.readyState === WebSocket.OPEN) {
        try { socket.close(4000, "inactivity-timeout"); } catch { /* ignore */ }
      }
    }, Math.max(5_000, cfg.inactivityTimeoutMs / 2));
  }

  function scheduleReconnect(reason: DisconnectReason) {
    if (!intent) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    disconnectReason = reason;
    const cfg = STRATEGIES[status.strategy];
    const attempt = status.attempts + 1;
    status.attempts = attempt;
    // Exponent with full jitter, capped so we never wait longer than maxTotalBackoffMs.
    const exp = Math.min(cfg.reconnectMaxDelayMs, cfg.reconnectInitialDelayMs * Math.pow(2, attempt - 1));
    const jitter = Math.random() * exp;
    const delay = Math.min(maxTotalBackoffMs, jitter + cfg.reconnectInitialDelayMs);
    status.state = "reconnecting";
    nextReconnectAtMs = Date.now() + delay;
    notify();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      nextReconnectAtMs = 0;
      open();
    }, delay);
  }

  function open() {
    clearTimers();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      status.state = "offline";
      disconnectReason = "offline";
      notify();
      // Wait for the browser to fire the online event; do not retry blindly.
      return;
    }
    let url: string;
    try { url = options.url(); } catch { return; }

    status.state = "connecting";
    notify();

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      options.onError?.(err as Event);
      scheduleReconnect("network");
      return;
    }
    socket = ws;

    ws.onopen = () => {
      status.state = "open";
      disconnectReason = "idle";
      status.lastActivityAt = Date.now();
      status.attempts = 0;
      totalReconnects += 1;
      notify();
      startKeepalive();
      options.onOpen?.(ws);
    };
    ws.onmessage = (event) => {
      status.lastActivityAt = Date.now();
      // Server reply to ping (lightweight pong protocol).
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (data && data.type === "pong" && typeof data.t === "number") {
          status.lastPongAt = Date.now();
          status.rttMs = Math.max(0, Date.now() - data.t);
          notify();
          return;
        }
      } catch { /* not JSON */ }
      options.onMessage?.(event);
    };
    ws.onerror = (event) => {
      options.onError?.(event);
    };
    ws.onclose = (event) => {
      socket = null;
      clearTimers();
      // Decide whether this was a user-initiated stop or a server/network blip.
      if (!intent) {
        status.state = "stopped";
        disconnectReason = "client-leave";
        notify();
        options.onClose?.(event, "client-leave");
        return;
      }
      const code = event.code;
      // 1000 = normal closure from the server; treat as "the server kicked us,
      // reconnect" because the user did not ask for it. 4xxx codes usually
      // indicate the app closing intentionally — we still reconnect by default,
      // because nobody on the UI explicitly stopped.
      const reason: DisconnectReason =
        code === 4000 ? "inactivity" :
        code >= 4000 && code <= 4999 ? "network" :
        "server-close";
      options.onClose?.(event, reason);
      scheduleReconnect(reason);
    };
  }

  function start() {
    if (intent) return;
    intent = true;
    status.attempts = 0;
    open();
  }

  function requestStop() {
    intent = false;
    clearTimers();
    if (socket) {
      try { socket.close(1000, "client-stop"); } catch { /* ignore */ }
      socket = null;
    }
    status.state = "stopped";
    disconnectReason = "client-leave";
    notify();
  }

  function forceReconnect() {
    if (!intent) return;
    status.attempts = 0;
    if (socket) {
      try { socket.close(4001, "force-reconnect"); } catch { /* ignore */ }
    }
    setTimeout(() => open(), 50);
  }

  function send(obj: unknown): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(obj));
      status.lastActivityAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  function setStrategy(s: KeepaliveStrategy) {
    status.strategy = s;
    if (socket?.readyState === WebSocket.OPEN) startKeepalive();
    notify();
  }

  function subscribe(cb: (s: ConnectionStatus) => void) {
    subscribers.add(cb);
    cb(status);
    return () => subscribers.delete(cb);
  }

  function getStatus() { return { ...status }; }

  // Browser-level reconnect triggers: visibility/online events, page lifecycle.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
    window.addEventListener("offline", () => {
      status.state = "offline";
      disconnectReason = "offline";
      notify();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
    // Mobile OSes may freeze a backgrounded tab. When the page becomes
    // visible again or the OS resumes work (pageshow + persisted = back from
    // bfcache), re-arm the connection.
    window.addEventListener("pageshow", () => {
      if (intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
    // Page lifecycle hint: a long-running app should keep its socket alive
    // across visibility changes, so we explicitly DO NOT register a
    // beforeunload handler that closes the socket.
  }

  return {
    start, requestStop, send, setStrategy, getStatus, subscribe,
    socket: () => socket,
    forceReconnect,
  };
}
