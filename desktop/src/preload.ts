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
