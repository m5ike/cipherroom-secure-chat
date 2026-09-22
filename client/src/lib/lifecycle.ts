// When the browser puts this page aside, and when it hands it back.
//
// A tab that the user switches away from is not simply "hidden": depending
// on the browser and the platform it may be throttled, frozen, moved into
// the back/forward cache, or discarded outright and rebuilt later. Each of
// those arrives as a different event, and no single one of them is enough:
//
//   visibilitychange   the tab went to the background (or came back)
//   blur / focus       the window lost the keyboard — the user switched to
//                      another application while this tab stayed "visible"
//   freeze / resume    Page Lifecycle: the browser stopped running our code
//   pagehide / pageshow   navigation, and the back/forward cache
//   online / offline   the network came and went
//   document.wasDiscarded   we were thrown away and are being rebuilt
//
// This module listens to all of them and reports two things instead:
// the page was SUSPENDED, and the page RESUMED (with how long it was gone
// and how it left). Callers get one pair of hooks rather than a pile of
// event listeners with subtly different meanings.
//
// Grace periods matter: flicking to another tab for two seconds should not
// tell the room you are away, while a freeze should be reported at once
// because the browser may stop running us mid-callback.

export type SuspendReason = "hidden" | "blurred" | "frozen" | "pagehide";
export type ResumeReason = "visible" | "focused" | "resumed" | "pageshow" | "restored";

export type SuspendEvent = {
  reason: SuspendReason;
  at: number;
  /** A freeze or a pagehide can be the last thing we ever run. */
  final: boolean;
};

export type ResumeEvent = {
  reason: ResumeReason;
  at: number;
  /** How long the page was suspended, in ms. */
  awayMs: number;
  /** The browser discarded the page and rebuilt it: state is gone. */
  wasDiscarded: boolean;
  /** We came back from the back/forward cache. */
  fromCache: boolean;
};

export type LifecycleOptions = {
  /** Hidden this long before we call it a suspend (default 1.5 s). */
  hiddenGraceMs?: number;
  /** Window blurred (another app) this long before we call it a suspend
   *  — the user is still looking at the tab, so this is generous. */
  blurGraceMs?: number;
  onSuspend?: (event: SuspendEvent) => void;
  onResume?: (event: ResumeEvent) => void;
  /** Network transitions, which usually need the same repair work. */
  onOnline?: () => void;
  onOffline?: () => void;
};

export type LifecycleHandle = {
  stop(): void;
  /** True while we consider the page suspended. */
  readonly suspended: boolean;
  /** For callers that want to ask rather than be told. */
  state(): { suspended: boolean; since: number };
};

const DEFAULT_HIDDEN_GRACE = 1_500;
const DEFAULT_BLUR_GRACE = 30_000;

/** True when the page was restored after the browser discarded it. */
export function wasDiscarded(): boolean {
  try {
    return Boolean((document as Document & { wasDiscarded?: boolean }).wasDiscarded);
  } catch {
    return false;
  }
}

/**
 * Starts listening. Returns a handle that stops again — call it from a
 * React effect's cleanup so hot reloads do not stack listeners.
 */
export function watchLifecycle(options: LifecycleOptions): LifecycleHandle {
  const hiddenGrace = options.hiddenGraceMs ?? DEFAULT_HIDDEN_GRACE;
  const blurGrace = options.blurGraceMs ?? DEFAULT_BLUR_GRACE;

  let suspended = false;
  let suspendedAt = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clearPending = () => {
    if (pending !== null) { clearTimeout(pending); pending = null; }
  };

  const suspend = (reason: SuspendReason, final: boolean) => {
    clearPending();
    if (suspended || stopped) return;
    suspended = true;
    suspendedAt = Date.now();
    options.onSuspend?.({ reason, at: suspendedAt, final });
  };

  /** Suspend after `delay`, unless the page comes back first. */
  const suspendSoon = (reason: SuspendReason, delay: number) => {
    if (suspended || stopped) return;
    clearPending();
    pending = setTimeout(() => { pending = null; suspend(reason, false); }, delay);
  };

  const resume = (reason: ResumeReason, fromCache = false) => {
    clearPending();
    if (stopped) return;
    // Nothing to resume from: the page was never considered suspended.
    if (!suspended) return;
    const at = Date.now();
    const awayMs = suspendedAt ? at - suspendedAt : 0;
    suspended = false;
    suspendedAt = 0;
    options.onResume?.({ reason, at, awayMs, wasDiscarded: wasDiscarded(), fromCache });
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") suspendSoon("hidden", hiddenGrace);
    else resume("visible");
  };
  // The window lost focus but is still shown: the user is in another
  // application. Worth reporting, but only after a while.
  const onBlur = () => { if (document.visibilityState !== "hidden") suspendSoon("blurred", blurGrace); };
  const onFocus = () => resume("focused");
  // Page Lifecycle: the browser is about to stop running us, or just did.
  const onFreeze = () => suspend("frozen", true);
  const onResumeEvent = () => resume("resumed");
  const onPageHide = (event: PageTransitionEvent) => suspend("pagehide", !event.persisted);
  const onPageShow = (event: PageTransitionEvent) => {
    // A page restored from the back/forward cache never ran its suspend
    // handler to completion; treat it as a resume regardless of our state.
    if (!suspended && event.persisted) {
      suspended = true;
      suspendedAt = suspendedAt || Date.now();
    }
    resume("pageshow", event.persisted);
  };
  const onOnline = () => options.onOnline?.();
  const onOffline = () => options.onOffline?.();

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResumeEvent);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // A page that starts life hidden (opened in the background, restored on
  // launch) is suspended from the first moment.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    suspended = true;
    suspendedAt = Date.now();
  }

  return {
    get suspended() { return suspended; },
    state: () => ({ suspended, since: suspendedAt }),
    stop() {
      stopped = true;
      clearPending();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResumeEvent);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    },
  };
}

/* --------------------------------------------------------------- ticking */

export type TickSource = "interval" | "worker" | "none";

export type BackgroundTick = {
  stop(): void;
  /** Which mechanism is driving it. */
  readonly source: TickSource;
};

/**
 * A periodic tick that keeps going, as far as it can, while the page is in
 * the background.
 *
 * Be clear about the limits, because there is no way around them:
 *
 *   - A hidden tab's timers are throttled to roughly one call per minute
 *     (Chrome, Firefox, Safari), and after about five minutes of a hidden,
 *     silent tab Chrome may throttle them further or freeze the page.
 *   - A FROZEN or DISCARDED page runs nothing at all. No timer, worker or
 *     loop will fire; only the browser can wake it, and it does that for a
 *     push message, a navigation, or the user coming back.
 *   - A Web Worker's timers are throttled with the page that owns it, so a
 *     worker buys resolution, not immortality. It is still worth using:
 *     while the page is merely hidden it keeps a steadier beat.
 *
 * So: use this for "keep the socket warm and notice drift while hidden",
 * and use Web Push (service worker) for "wake me when something happens" —
 * that is the only mechanism that survives a frozen or closed page.
 */
export function startBackgroundTick(onTick: (source: TickSource) => void, intervalMs = 30_000): BackgroundTick {
  let stopped = false;
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let source: TickSource = "none";

  const fire = () => { if (!stopped) onTick(source); };

  // A worker's timer keeps a steadier beat than the page's own while the
  // page is hidden, so prefer it and fall back to a plain interval.
  try {
    const code = `let id = null;
      self.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === "start") {
          if (id !== null) clearInterval(id);
          id = setInterval(() => self.postMessage({ type: "tick" }), Math.max(1000, data.intervalMs || 30000));
        } else if (data.type === "stop") {
          if (id !== null) clearInterval(id);
          id = null;
          self.close();
        }
      };`;
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (event: MessageEvent<{ type?: string }>) => { if (event.data?.type === "tick") fire(); };
    worker.postMessage({ type: "start", intervalMs });
    source = "worker";
  } catch {
    worker = null;
  }

  if (!worker) {
    timer = setInterval(fire, intervalMs);
    source = "interval";
  }

  return {
    get source() { return source; },
    stop() {
      stopped = true;
      if (timer !== null) { clearInterval(timer); timer = null; }
      if (worker) {
        try { worker.postMessage({ type: "stop" }); worker.terminate(); } catch { /* already gone */ }
        worker = null;
      }
    },
  };
}
