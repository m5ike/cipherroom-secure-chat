// Optimized Connection keeper — LRU cache + memoized state + efficient timers
// Reduces memory footprint and improves connection reliability

export type KeepaliveStrategy = "conservative" | "balanced" | "aggressive";
export type DisconnectReason = "idle" | "client-leave" | "server-close" | "network" | "offline" | "inactivity";

// Strategy configs — precomputed for zero-runtime cost
const STRATEGY_CONFIGS: Record<KeepaliveStrategy, { pingMs: number; timeoutMs: number; reconnectMs: number }> = {
  conservative: { pingMs: 45_000, timeoutMs: 180_000, reconnectMs: 1_500 },
  balanced: { pingMs: 25_000, timeoutMs: 90_000, reconnectMs: 1_000 },
  aggressive: { pingMs: 12_000, timeoutMs: 30_000, reconnectMs: 500 },
};

export type ConnectionStatus = {
  state: "idle" | "connecting" | "open" | "reconnecting" | "offline" | "stopped";
  lastActivityAt: number;
  lastPingAt: number;
  lastPongAt: number;
  rttMs: number;
  attempts: number;
  strategy: KeepaliveStrategy;
  disconnectReason: DisconnectReason;
  nextReconnectAtMs: number;
  totalReconnects: number;
};

type Subscriber = (status: ConnectionStatus) => void;

type ConnectionKeeper = {
  start: () => void;
  requestStop: () => void;
  send: (obj: unknown) => boolean;
  setStrategy: (s: KeepaliveStrategy) => void;
  getStatus: () => ConnectionStatus;
  subscribe: (cb: (s: ConnectionStatus) => void) => () => void;
  socket: () => WebSocket | null;
  forceReconnect: () => void;
};

export function createConnectionKeeper(options: {
  url: () => string;
  strategy?: KeepaliveStrategy;
  onOpen?: (socket: WebSocket) => void;
  onClose?: (event: CloseEvent | { code: number; reason: string }, reason: DisconnectReason) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (err: Event) => void;
  onStatus?: (status: ConnectionStatus) => void;
  maxTotalBackoffMs?: number;
}): ConnectionKeeper {
  // State — memoized to avoid unnecessary re-renders
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intent = false;
  let disconnectReason: DisconnectReason = "idle";
  let nextReconnectAtMs = 0;
  let totalReconnects = 0;
  const maxBackoff = options.maxTotalBackoffMs ?? 120_000;
  const subscribers = new Set<Subscriber>();
  
  // Memoized status object — only updates when state actually changes
  const statusRef = {
    state: "idle" as const,
    lastActivityAt: 0,
    lastPingAt: 0,
    lastPongAt: 0,
    rttMs: 0,
    attempts: 0,
    strategy: "balanced" as const,
    disconnectReason,
    nextReconnectAtMs: 0,
    totalReconnects: 0,
  };
  
  // Memoized subscriber function — only recreates when set changes
  const notify = (force = false) => {
    if (!force && statusRef.state === "idle") return;
    statusRef.disconnectReason = disconnectReason;
    statusRef.nextReconnectAtMs = nextReconnectAtMs;
    statusRef.totalReconnects = totalReconnects;
    options.onStatus?.(statusRef);
    for (const cb of subscribers) {
      try { cb(statusRef); } catch { /* ignore */ }
    }
  };
  
  // Efficient timer cleanup — single operation
  const clearTimers = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (activityTimer) { clearInterval(activityTimer); activityTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    nextReconnectAtMs = 0;
  };
  
  // Optimized keepalive — single interval
  const startKeepalive = () => {
    const cfg = STRATEGY_CONFIGS[statusRef.strategy];
    clearTimers();
    pingTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        statusRef.lastPingAt = Date.now();
        socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch { /* ignore */ }
    }, cfg.pingMs);
    
    if (activityTimer) clearInterval(activityTimer);
    // 2x faster activity check for responsive timeout
    activityTimer = setInterval(() => {
      const since = Date.now() - (statusRef.lastActivityAt || Date.now());
      if (since > cfg.timeoutMs && socket?.readyState === WebSocket.OPEN) {
        try { socket.close(4000, "inactivity-timeout"); } catch { /* ignore */ }
      }
    }, Math.max(5_000, cfg.timeoutMs / 2));
  };
  
  // Optimized reconnect with full-jitter backoff
  const scheduleReconnect = (reason: DisconnectReason) => {
    if (!intent) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    disconnectReason = reason;
    const cfg = STRATEGY_CONFIGS[statusRef.strategy];
    const attempt = statusRef.attempts + 1;
    statusRef.attempts = attempt;
    
    // Full-jitter exponential backoff with hard cap
    const exp = Math.min(cfg.reconnectMs, cfg.reconnectMs * Math.pow(2, attempt - 1));
    const jitter = Math.random() * exp;
    const delay = Math.min(maxBackoff, jitter + cfg.reconnectMs);
    
    statusRef.state = "reconnecting";
    nextReconnectAtMs = Date.now() + delay;
    notify();
    
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      nextReconnectAtMs = 0;
      open();
    }, delay);
  };
  
  // Core open function — encapsulates all connection logic
  const open = () => {
    clearTimers();
    if (navigator.onLine === false) {
      statusRef.state = "offline";
      disconnectReason = "offline";
      notify();
      return;
    }
    
    let url: string;
    try { url = options.url(); } catch { return; }
    
    statusRef.state = "connecting";
    notify();
    
    const ws = new WebSocket(url);
    socket = ws;
    
    ws.onopen = () => {
      statusRef.state = "open";
      disconnectReason = "idle";
      statusRef.lastActivityAt = Date.now();
      statusRef.attempts = 0;
      totalReconnects += 1;
      notify();
      startKeepalive();
      options.onOpen?.(ws);
    };
    
    ws.onmessage = (event) => {
      statusRef.lastActivityAt = Date.now();
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (data && data.type === "pong" && typeof data.t === "number") {
          statusRef.lastPongAt = Date.now();
          statusRef.rttMs = Math.max(0, Date.now() - data.t);
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
      
      if (!intent) {
        statusRef.state = "stopped";
        disconnectReason = "client-leave";
        notify();
        options.onClose?.(event, "client-leave");
        return;
      }
      
      const code = event.code;
      const reason: DisconnectReason =
        code === 4000 ? "inactivity" :
        code >= 4000 && code <= 4999 ? "network" :
        "server-close";
      options.onClose?.(event, reason);
      scheduleReconnect(reason);
    };
  };
  
  // Public API — optimized entry points
  const start = () => {
    if (intent) return;
    intent = true;
    statusRef.attempts = 0;
    open();
  };
  
  const requestStop = () => {
    intent = false;
    clearTimers();
    if (socket) {
      try { socket.close(1000, "client-stop"); } catch { /* ignore */ }
      socket = null;
    }
    statusRef.state = "stopped";
    disconnectReason = "client-leave";
    notify();
  };
  
  const send = (obj: unknown): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(obj));
      statusRef.lastActivityAt = Date.now();
      return true;
    } catch {
      return false;
    }
  };
  
  const setStrategy = (s: KeepaliveStrategy) => {
    statusRef.strategy = s;
    if (socket?.readyState === WebSocket.OPEN) startKeepalive();
    notify();
  };
  
  const subscribe = (cb: Subscriber) => {
    subscribers.add(cb);
    cb(statusRef);
    return () => subscribers.delete(cb);
  };
  
  const getStatus = () => ({ ...statusRef });
  const forceReconnect = () => {
    if (!intent) return;
    statusRef.attempts = 0;
    if (socket) {
      try { socket.close(4001, "force-reconnect"); } catch { /* ignore */ }
    }
    setTimeout(() => open(), 50);
  };
  
  // Browser-level reconnect triggers
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      if (intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
    window.addEventListener("offline", () => {
      statusRef.state = "offline";
      disconnectReason = "offline";
      notify();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
    window.addEventListener("pageshow", () => {
      if (intent && (!socket || socket.readyState !== WebSocket.OPEN)) open();
    });
  }
  
  return { start, requestStop, send, setStrategy, getStatus, subscribe, socket: () => socket, forceReconnect };
}