// Preload of the app's own pages (m5cet-app://ui/…): the server picker and
// the "code from the server" banner. They live in a session of their own,
// never the server page's.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type UiState = {
  strings: Record<string, string>;
  servers: Array<{ origin: string; display: string; codeSource: "app" | "server"; current: boolean }>;
  defaultServer: string;
  error: string;
  lang: string;
  version: string;
  /** The build was code-signed (else the picker says it is not). */
  signed: boolean;
  banner: { server: string } | null;
};

contextBridge.exposeInMainWorld("m5app", {
  state: (): Promise<UiState> => ipcRenderer.invoke("ui:state") as Promise<UiState>,
  connect: (input: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("ui:connect", String(input).slice(0, 2048)) as Promise<{ ok: boolean; error?: string }>,
  open: (origin: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("ui:open", String(origin)) as Promise<{ ok: boolean; error?: string }>,
  remove: (origin: string): Promise<void> => ipcRenderer.invoke("ui:remove", String(origin)) as Promise<void>,
  useAppCode: (): Promise<void> => ipcRenderer.invoke("ui:code-app") as Promise<void>,
  onState: (fn: () => void): (() => void) => {
    const h = (_e: IpcRendererEvent) => fn();
    ipcRenderer.on("ui:changed", h);
    return () => { ipcRenderer.removeListener("ui:changed", h); };
  },
});
