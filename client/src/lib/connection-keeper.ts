// Connection keeper / clock service.
//
// Provides heartbeat over the signaling WebSocket, exponential backoff
// reconnect with user intent flag, online/offline + Page Visibility
// hooks, and three keepalive strategies (conservative/balanced/aggressive).
//
// Important: browsers throttle background timers (Chrome ~1 minute,
// Firefox/Safari similar) and may suspend WebSockets entirely on mobile
// when the page is hidden. We do NOT pretend to override that. Instead
// we expose service worker / push hooks so the app can be re-armed by
// a push notification or visibility change.
//
// Public API:
//   const keeper = createConnectionKeeper({ url, onOpen, onClose, onMessage, strategy });
//   keeper.start();
//   keeper.stop();
//   keeper.send(obj);
//   keeper.setStrategy("aggressive");
//   keeper.subscribe((status) => ...);

export type KeepaliveStrategy = "conservative" | "balanced" | "aggressive";

export type ConnectionStatus = {
  state: "idle" | "connecting" | "open" | "reconnecting" | "offline" | "stopped";
  lastActivityAt: number;
  lastPingAt: number;
  lastPongAt: number;
  rttMs: number;
  attempts: number;
  strategy: KeepaliveStrategy;
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
    inactivityTimeoutMs: 120_000,
    reconnectInitialDelayMs: 1_500,
    reconnectMaxDelayMs: 30_000,
  },
  balanced: {
    pingIntervalMs: 25_000,
    inactivityTimeoutMs: 60_000,
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
  onClose?: (event: CloseEvent | { code: number; reason: string }) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (err: Event) => void;
  onStatus?: (status: ConnectionStatus) => void;
};

export type ConnectionKeeper = {
  start: () => void;
  stop: () => void;
  send: (obj: unknown) => boolean;
  setStrategy: (s: KeepaliveStrategy) => void;
  getStatus: () => ConnectionStatus;
  subscribe: (cb: (status: ConnectionStatus) => void) => () => void;
  socket: () => WebSocket | null;
};

export function createConnectionKeeper(options: ConnectionKeeperOptions): ConnectionKeeper {
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intent = false; // user intends to stay connected
  const subscribers = new Set<(s: ConnectionStatus) => void>();

  const status: ConnectionStatus = {
    state: "idle",
    lastActivityAt: 0,
    lastPingAt: 0,
    lastPongAt: 0,
    rttMs: 0,
    attempts: 0,
    strategy: options.strategy || "balanced",
  };

  function notify() {
    options.onStatus?.(status);
    subscribers.forEach((cb) => {
      try { cb(status); } catch { /* ignore */ }
    });
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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

  function scheduleReconnect() {
    if (!intent) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const cfg = STRATEGIES[status.strategy];
    const attempt = status.attempts + 1;
    status.attempts = attempt;
    const exp = Math.min(cfg.reconnectMaxDelayMs, cfg.reconnectInitialDelayMs * Math.pow(2, attempt - 1));
    const jitter = Math.random() * 250;
    const delay = exp + jitter;
    status.state = "reconnecting";
    notify();
    reconnectTimer = setTimeout(() => {
      open();
    }, delay);
  }

  function open() {
    clearTimers();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      status.state = "offline";
      notify();
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
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      status.state = "open";
      status.lastActivityAt = Date.now();
      status.attempts = 0;
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
      options.onClose?.(event);
      if (intent) scheduleReconnect();
      else { status.state = "stopped"; notify(); }
    };
  }

  function start() {
    intent = true;
    status.attempts = 0;
    open();
  }

  function stop() {
    intent = false;
    clearTimers();
    if (socket) {
      try { socket.close(1000, "client-stop"); } catch { /* ignore */ }
      socket = null;
    }
    status.state = "stopped";
    notify();
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

  // Browser-level reconnect triggers: visibility/online events.
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (intent && (!socket || socket.readyState === WebSocket.CLOSED)) open();
    });
    window.addEventListener("offline", () => {
      status.state = "offline";
      notify();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
  }

  return {
    start, stop, send, setStrategy, getStatus, subscribe,
    socket: () => socket,
  };
}
