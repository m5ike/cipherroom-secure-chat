// The page's preload: a minimal, typed bridge as `window.m5desktop`
// (client/src/lib/desktop-bridge.ts is the page's side).
//
// Sandboxed, context-isolated: the page gets plain functions, never
// ipcRenderer, Node or Electron objects. The main process checks every
// message's sender (the main frame of the app window, on the chosen server's
// origin) before it acts — this file is not the security boundary.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type Info = { version: string; platform: string; codeSource: "app" | "server" };
const info = ipcRenderer.sendSync("m5:info") as Info;

const listen = <T>(channel: string, fn: (value: T) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, value: T) => { try { fn(value); } catch (err) { console.warn("[m5desktop]", err); } };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
};

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(seq += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* 6.13.1: the system smart-card readers (client/src/lib/nfc/pcsc-bridge.ts is the contract). */
type PcscFail = { ok: false; code: string; message: string; reader?: string };
const PCSC_MAX_APDU = 4 + 3 + 65_535 + 3;
const badRequest = (message: string): Promise<PcscFail> => Promise.resolve({ ok: false, code: "bad-request", message });
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const isHandle = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
/** Readers as plain objects (nothing else crosses into the page). */
const readerList = (v: unknown) => (Array.isArray(v) ? v.slice(0, 32).map((r: { name?: unknown; slot?: unknown; card?: unknown }) => ({
  name: String(r?.name ?? "").slice(0, 200),
  slot: ["contact", "contactless", "sam"].includes(String(r?.slot)) ? String(r.slot) : "unknown",
  card: r?.card === true,
})) : []);

const pcsc = {
  listReaders(): Promise<unknown> { return ipcRenderer.invoke("m5:pcsc-list"); },
  /** Without a name (or one the user has not picked on this page) the app asks which reader. */
  connect(reader?: string | null): Promise<unknown> {
    if (reader !== undefined && reader !== null && !isName(reader)) return badRequest("Bad reader name");
    return ipcRenderer.invoke("m5:pcsc-connect", reader ?? null);
  },
  transmit(handle: string, apdu: Uint8Array): Promise<unknown> {
    if (!isHandle(handle)) return badRequest("Bad handle");
    if (!(apdu instanceof Uint8Array) || apdu.length < 4 || apdu.length > PCSC_MAX_APDU) return badRequest("The APDU must be 4 to 65544 bytes");
    return ipcRenderer.invoke("m5:pcsc-transmit", handle, new Uint8Array(apdu));
  },
  disconnect(handle: string): Promise<unknown> {
    if (!isHandle(handle)) return badRequest("Bad handle");
    return ipcRenderer.invoke("m5:pcsc-disconnect", handle);
  },
  onChange(fn: (readers: Array<{ name: string; slot: string; card: boolean }>) => void): () => void {
    return listen<unknown>("m5:pcsc-change", (v) => fn(readerList(v)));
  },
};

const bridge = {
  isDesktop: true as const,
  version: String(info?.version ?? ""),
  platform: String(info?.platform ?? ""),
  codeSource: info?.codeSource === "server" ? "server" as const : "app" as const,
  notify(n: { title: string; body?: string; tag?: string; silent?: boolean }): string {
    const id = newId();
    ipcRenderer.send("m5:notify", { id, title: String(n?.title ?? "").slice(0, 200), body: String(n?.body ?? "").slice(0, 500), tag: String(n?.tag ?? "").slice(0, 80), silent: n?.silent === true });
    return id;
  },
  closeNotification(id: string): void { ipcRenderer.send("m5:notify-close", String(id)); },
  onNotificationClick(fn: (id: string) => void): () => void { return listen<string>("m5:notification-click", fn); },
  setBadge(count: number): void { ipcRenderer.send("m5:badge", Number(count) || 0); },
  openExternal(url: string): Promise<boolean> { return ipcRenderer.invoke("m5:open-external", String(url)) as Promise<boolean>; },
  /** The app's update state (the dialogs are native; this is for showing it in the page). */
  onUpdate(fn: (e: { kind: string; version?: string }) => void): () => void { return listen<{ kind: string; version?: string }>("m5:update", fn); },
  auth: {
    mode(): Promise<"app" | "browser"> { return ipcRenderer.invoke("m5:auth-mode") as Promise<"app" | "browser">; },
    begin(url: string, code: string): Promise<"cancel" | "done"> { return ipcRenderer.invoke("m5:auth-begin", String(url), String(code)) as Promise<"cancel" | "done">; },
    end(): void { ipcRenderer.send("m5:auth-end"); },
    offerBrowser(): Promise<boolean> { return ipcRenderer.invoke("m5:auth-offer-browser") as Promise<boolean>; },
    onCallback(fn: (id: string) => void): () => void { return listen<string>("m5:auth-callback", fn); },
  },
  /** 6.13.1: the computer's smart-card readers (PC/SC); the app asks the user and lets them pick the reader. */
  pcsc,
};

contextBridge.exposeInMainWorld("m5desktop", bridge);

// The page's language (it sets <html lang>) — the native menus follow it.
function reportLanguage(): void {
  const lang = document.documentElement?.getAttribute("lang") ?? "";
  if (lang) ipcRenderer.send("m5:lang", lang.slice(0, 16));
}
window.addEventListener("DOMContentLoaded", () => {
  reportLanguage();
  new MutationObserver(reportLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
});
