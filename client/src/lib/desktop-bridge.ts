// M5cet Desktop (6.13): the page's side of the app's bridge.
//
// In the desktop app the page is this same web client, served from inside the
// signed app; its preload (desktop/src/preload.ts) exposes a small typed API
// as `window.m5desktop`. In a browser it does not exist and nothing here does
// anything — every use is feature-detected.
//
// What the page uses it for:
//   * notifications — the app shows them natively, and a click brings the
//     window to the front before the page's own click handler opens the room;
//   * the passkey sign-in through the system browser (desktop-auth.ts) — the
//     app opens the browser and shows the verification code natively;
//   * the m5cet:// callback that says the browser is done;
//   * 6.13.1: the computer's smart-card readers through PC/SC (`pcsc`, used by
//     lib/nfc/transports/desktop-pcsc.ts — the NFC workbench's System reader).
// The unread count reaches the dock / taskbar badge without help: the app
// reads it from the title ("(3) M5cet"), as the page already writes it.
// Deliberately NOT in the bridge: the list of the user's other servers (one
// server's page has no business knowing which others the user uses).

import type { PcscBridge } from "./nfc/pcsc-bridge";

export type DesktopPasskeyMode = "app" | "browser";

export type M5Desktop = {
  readonly isDesktop: true;
  readonly version: string;
  readonly platform: string;
  /** "app": the code runs from the signed app; "server": the user chose this server's web code. */
  readonly codeSource: "app" | "server";
  notify(n: { title: string; body?: string; tag?: string; silent?: boolean }): string;
  closeNotification(id: string): void;
  onNotificationClick(fn: (id: string) => void): () => void;
  setBadge(count: number): void;
  openExternal(url: string): Promise<boolean>;
  /** The app's update state ("checking", "available", "none", "downloaded", "error", "off"). */
  onUpdate(fn: (e: { kind: string; version?: string }) => void): () => void;
  auth: {
    mode(): Promise<DesktopPasskeyMode>;
    /** Opens the sign-in page in the system browser and shows the code; resolves "cancel" if the user cancels in the app. */
    begin(url: string, code: string): Promise<"cancel" | "done">;
    end(): void;
    /** Asks (natively) whether to sign in through the browser instead — after the in-app passkey had no PRF. */
    offerBrowser(): Promise<boolean>;
    onCallback(fn: (id: string) => void): () => void;
  };
  /**
   * 6.13.1: the computer's smart-card readers through the system (PC/SC) —
   * lib/nfc/pcsc-bridge.ts. The app asks the user once per server and lets
   * them pick the reader; the page never gets a reader silently.
   */
  pcsc?: PcscBridge;
};

export function desktop(): M5Desktop | null {
  if (typeof window === "undefined") return null;
  const d = (window as unknown as { m5desktop?: M5Desktop }).m5desktop;
  return d && d.isDesktop === true ? d : null;
}

/** The system smart-card reader bridge, when this is M5cet Desktop 6.13.1+. */
export function desktopPcsc(): PcscBridge | null {
  const p = desktop()?.pcsc;
  return p && typeof p.connect === "function" && typeof p.transmit === "function" ? p : null;
}

export function isDesktopApp(): boolean {
  return desktop() !== null;
}

/* ----------------------------------------------------------- notifications */

type NotificationCtor = typeof Notification;

/**
 * A `Notification` that the app shows natively. Same surface the page uses:
 * `new Notification(title, { body, tag, silent })`, `.onclick`, `.close()`,
 * the static `permission` / `requestPermission` (the app decides those).
 */
export function desktopNotificationClass(d: M5Desktop, Base: NotificationCtor): NotificationCtor {
  const live = new Map<string, EventTarget>();
  d.onNotificationClick((id) => {
    const n = live.get(id) as (EventTarget & { onclick?: ((e: Event) => void) | null }) | undefined;
    if (!n) return;
    const ev = new Event("click");
    n.dispatchEvent(ev);
    try { n.onclick?.call(n, ev); } catch (err) { console.warn("[m5cet] notification click:", err); }
  });

  class DesktopNotification extends EventTarget {
    static get permission(): NotificationPermission { return Base.permission; }
    static requestPermission(cb?: NotificationPermissionCallback): Promise<NotificationPermission> { return Base.requestPermission(cb); }
    static readonly maxActions = 0;
    /** Marks the app's notification class (the desktop self-test checks it). */
    static readonly m5desktop = true;
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly silent: boolean;
    readonly data: unknown;
    onclick: ((this: Notification, ev: Event) => unknown) | null = null;
    onclose: ((this: Notification, ev: Event) => unknown) | null = null;
    onerror: ((this: Notification, ev: Event) => unknown) | null = null;
    onshow: ((this: Notification, ev: Event) => unknown) | null = null;
    readonly #id: string;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title ?? "");
      this.body = String(options.body ?? "");
      this.tag = String(options.tag ?? "");
      this.silent = options.silent === true;
      this.data = options.data ?? null;
      this.#id = d.notify({ title: this.title, body: this.body, tag: this.tag, silent: this.silent });
      if (this.#id) {
        // Same tag: the newer one replaces the older (as the browser does).
        if (this.tag) for (const [id, n] of live) if ((n as DesktopNotification).tag === this.tag && id !== this.#id) live.delete(id);
        live.set(this.#id, this);
        if (live.size > 100) live.delete(live.keys().next().value as string);
      }
    }

    close(): void {
      if (!this.#id) return;
      live.delete(this.#id);
      d.closeNotification(this.#id);
    }
  }
  return DesktopNotification as unknown as NotificationCtor;
}

/** Installs the bridge's pieces that replace browser APIs (once, before the app renders). */
export function installDesktopBridge(): void {
  const d = desktop();
  if (!d || typeof window === "undefined" || typeof window.Notification === "undefined") return;
  const w = window as unknown as { Notification: NotificationCtor; __m5desktopNotify?: boolean };
  if (w.__m5desktopNotify) return;
  w.__m5desktopNotify = true;
  w.Notification = desktopNotificationClass(d, window.Notification);
}
