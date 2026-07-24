// Auto-reconnect controller pro WebSocket signaling.
//
// Princip:
//   - Při neúspěchu spojení (onclose/onerror/onFailure) je reconnect plánován
//     s exponenciálním backoff 0.5→1→2→4→8→16→30 s.
//   - "manualDisconnect()" zastaví reconnect loop (uživatel stiskl tlačítko).
//   - "run()" se volá jednou po connect(); běží, dokud není killed.
//   - Auto-reconnect NERUŠÍ stávající RTCPeerConnection — peer connections
//     mohou přežít (lokální network change na WiFi), ale obnoví se signaling
//     pro nové ICE candidates.
//
// Tento modul je framework-agnostický. UI si ho napojí přes callbacky.

export type ReconnectPhase =
  | "idle"
  | "connecting"
  | "joined"
  | "reconnecting"
  | "offline"
  | "manual-disconnected";

export type ReconnectEvents = {
  onPhase?: (phase: ReconnectPhase, detail?: string) => void;
  onAttempt?: (attempt: number, delayMs: number) => void;
  onSocket?: (socket: WebSocket) => void;
  onFatal?: (reason: string) => void;
};

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];

export class ReconnectController {
  private phase: ReconnectPhase = "idle";
  private attempts = 0;
  private killed = false;
  private manualDisconnect = false;
  private currentSocket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTs = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly events: ReconnectEvents = {},
  ) {}

  getPhase(): ReconnectPhase {
    return this.phase;
  }

  getSocket(): WebSocket | null {
    return this.currentSocket;
  }

  /** Spustí reconnect loop. Pokud je manualDisconnect nastaveno, okamžitě skončí. */
  start(): void {
    this.killed = false;
    this.manualDisconnect = false;
    this.attempts = 0;
    this.run();
  }

  /** Ruční odpojení — zastaví reconnect, vyčistí stav. */
  stop(reason = "manual"): void {
    this.manualDisconnect = true;
    this.killed = true;
    this.clearTimer();
    this.clearHeartbeat();
    try {
      this.currentSocket?.close();
    } catch {
      // ignore
    }
    this.currentSocket = null;
    this.setPhase("manual-disconnected", reason);
    this.events.onFatal?.(reason);
  }

  /** Interní helper pro ukončení — vyčistí socket ale NIKOLI reconnect loop. */
  private handleDrop(detail = "socket-dropped"): void {
    if (this.killed || this.manualDisconnect) return;
    this.clearHeartbeat();
    try {
      this.currentSocket?.close();
    } catch {
      // ignore
    }
    this.currentSocket = null;
    this.setPhase("offline", detail);
    // Plánuj reconnect
    const delay = BACKOFF_STEPS_MS[Math.min(this.attempts, BACKOFF_STEPS_MS.length - 1)];
    this.attempts += 1;
    this.events.onAttempt?.(this.attempts, delay);
    this.setPhase("reconnecting", `attempt=${this.attempts} delay=${delay}ms`);
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (!this.killed && !this.manualDisconnect) this.run();
    }, delay);
  }

  run(): void {
    if (this.killed || this.manualDisconnect) return;
    this.setPhase("connecting", `attempt=${this.attempts + 1}`);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.wsUrl);
    } catch (err) {
      this.handleDrop(`construct-failed:${(err as Error).message}`);
      return;
    }
    this.currentSocket = socket;
    this.events.onSocket?.(socket);

    socket.onopen = () => {
      this.attempts = 0; // reset na úspěchu
      this.startHeartbeat(socket);
      this.events.onSocket?.(socket);
    };
    socket.onerror = () => {
      // onclose následuje — reconnect řešíme tam.
    };
    socket.onclose = () => {
      this.handleDrop("socket-closed");
    };

    // Reset timer pokud socket rychle spadne
    setTimeout(() => {
      if (this.currentSocket === socket && socket.readyState !== WebSocket.OPEN) {
        // 3 s timeout — pokud se socket neotevřel, řídíme reconnect
        this.handleDrop("socket-open-timeout");
      }
    }, 3000).unref?.();
  }

  /** Aplikační ping — ponechá spojení aktivní v případě mezilehlých proxy. */
  private startHeartbeat(socket: WebSocket) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      this.lastPingTs = Date.now();
      try {
        socket.send(JSON.stringify({ type: "ping", ts: this.lastPingTs }));
      } catch {
        // ignore
      }
    }, 20_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setPhase(phase: ReconnectPhase, detail?: string) {
    this.phase = phase;
    this.events.onPhase?.(phase, detail);
  }
}
