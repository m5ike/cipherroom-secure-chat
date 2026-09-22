// Flash messages: the queue behind the notices that slide in at the top.
//
// System notices used to land in the conversation, between people's
// messages. They belong somewhere else: one at a time, at the top of the
// screen, gone in ten seconds — and in the conversation only if the user
// asks for them (Preferences.showSystemInChat).
//
// The queue is deliberately strict: exactly one message is on screen at a
// time, the rest wait their turn, and a click takes the current one away
// and brings the next one up at once. Everything about how it looks —
// position, colour, font, icon, animation, how long it stays — is a
// preference (FlashSettings), so this module only decides *what* shows and
// *when*.

export type FlashKind = "info" | "success" | "warning" | "error" | "system";

export type FlashMessage = {
  id: string;
  text: string;
  kind: FlashKind;
  at: number;
  /** Overrides the configured duration for this one message (ms). */
  durationMs?: number;
  /** Shown under the text, smaller (a room name, a peer, a reason). */
  detail?: string;
};

export type FlashInput = Omit<FlashMessage, "id" | "at"> & { id?: string; at?: number };

export type FlashListener = (current: FlashMessage | null, queued: number) => void;

export const FLASH_LIMITS = {
  /** Messages waiting behind the current one; the oldest go first. */
  maxQueue: 20,
  maxTextChars: 240,
  maxDetailChars: 120,
} as const;

export type FlashQueue = {
  push(message: FlashInput): FlashMessage | null;
  /** Take the current message away; the next one appears immediately. */
  dismiss(id?: string): void;
  clear(): void;
  current(): FlashMessage | null;
  pending(): number;
  subscribe(listener: FlashListener): () => void;
  stop(): void;
};

export function createFlashQueue(options: {
  /** How long a message stays before it fades out (default 10 s). */
  durationMs?: number;
  now?: () => number;
  /** Injected in tests; window.setTimeout otherwise. */
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
} = {}): FlashQueue {
  const defaultDuration = options.durationMs ?? 10_000;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));

  const queue: FlashMessage[] = [];
  const listeners = new Set<FlashListener>();
  let current: FlashMessage | null = null;
  let timer: number | null = null;
  let counter = 0;
  let stopped = false;

  const announce = () => {
    for (const listener of listeners) listener(current, queue.length);
  };

  const clearTimer = () => {
    if (timer !== null) { cancel(timer); timer = null; }
  };

  /** Puts the next message on screen, or nothing if the queue ran dry. */
  const advance = () => {
    clearTimer();
    current = queue.shift() ?? null;
    if (current) {
      const duration = Math.max(1_000, current.durationMs ?? defaultDuration);
      timer = schedule(() => { if (!stopped) advance(); }, duration);
    }
    announce();
  };

  return {
    push(message) {
      if (stopped) return null;
      const text = String(message.text ?? "").trim().slice(0, FLASH_LIMITS.maxTextChars);
      if (!text) return null;
      const full: FlashMessage = {
        id: message.id ?? `flash-${++counter}-${now()}`,
        text,
        kind: message.kind ?? "system",
        at: message.at ?? now(),
        ...(message.durationMs ? { durationMs: message.durationMs } : {}),
        ...(message.detail ? { detail: String(message.detail).slice(0, FLASH_LIMITS.maxDetailChars) } : {}),
      };
      queue.push(full);
      // A backlog means the user is not looking; keep the newest.
      while (queue.length > FLASH_LIMITS.maxQueue) queue.shift();
      if (!current) advance();
      else announce();
      return full;
    },

    dismiss(id) {
      if (!current) return;
      if (id && current.id !== id) {
        // Not the one on screen: drop it from the queue instead.
        const index = queue.findIndex((m) => m.id === id);
        if (index >= 0) { queue.splice(index, 1); announce(); }
        return;
      }
      advance();
    },

    clear() {
      clearTimer();
      queue.length = 0;
      current = null;
      announce();
    },

    current: () => current,
    pending: () => queue.length,

    subscribe(listener) {
      listeners.add(listener);
      listener(current, queue.length);
      return () => { listeners.delete(listener); };
    },

    stop() {
      stopped = true;
      clearTimer();
      listeners.clear();
      queue.length = 0;
      current = null;
    },
  };
}

/** What a system notice looks like when it is worth a louder colour. */
export function kindForText(text: string): FlashKind {
  // Czech inflects, so match stems rather than whole words.
  const lower = text.toLowerCase();
  if (/(selhal|nepodařil|nelze|chyb|failed|error|refused|could not|missing)/.test(lower)) return "error";
  if (/(pozor|upozorn|warning|expir|vypršel|offline|odpojen)/.test(lower)) return "warning";
  if (/(hotovo|uložen|doruč|připojen|saved|delivered|connected|joined)/.test(lower)) return "success";
  return "system";
}
