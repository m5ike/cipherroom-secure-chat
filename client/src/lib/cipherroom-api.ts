// Optimized Public API facade — lazy loading + proper cleanup

import { detectCapabilities } from "./capabilities";
import { fetchPushStatus } from "./push";

// Lazy-loaded modules — defer until first access
let modulesPromise: Promise<ModuleManifest | null> | null = null;

type Listener = (detail: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function on(event: string, fn: Listener) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export type ModuleManifest = {
  modes: { id: string; label: string; description: string }[];
  features: Record<string, { enabled: boolean; reason?: string }>;
  push: { enabled: boolean; vapidPublicKey: string | null };
  events: { enabled: boolean; backend: string };
};

function fetchModules(): Promise<ModuleManifest | null> {
  return fetch("/api/modules", { cache: "no-store" })
    .then(res => res.ok ? res.json() : null)
    .catch(() => null);
}

export type RecordEventResult = { ok: boolean; message?: string };

export function dispatchInternal(event: string, detail: unknown) {
  listeners.get(event)?.forEach((fn) => {
    try {
      fn(detail);
    } catch { /* ignore */ }
  });
}

export async function recordEvent(payload: { kind: string; meta?: Record<string, unknown> }): Promise<RecordEventResult> {
  try {
    const res = await fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}

export function installPublicAPI() {
  if (typeof window === "undefined") return;
  
  // Avoid clobbering — first install wins
  if (window.CipherRoomAPI) return;
  
  const api = {
    version: "1.0.0",
    capabilities: detectCapabilities(),
    modules: async (): Promise<ModuleManifest | null> => {
      // Lazy load on first access
      if (!modulesPromise) {
        modulesPromise = fetchModules();
      }
      return modulesPromise;
    },
    pushStatus: fetchPushStatus,
    recordEvent,
    on,
  };
  
  window.CipherRoomAPI = api;
}