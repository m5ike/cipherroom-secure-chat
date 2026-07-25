// Public, namespaced helper for embedders. Exposed as window.CipherRoomAPI.
// Read-only surface: capability info, module manifest, and tiny dispatchers.

import { detectCapabilities } from "./capabilities";
import { fetchPushStatus } from "./push";

export type ModuleManifest = {
  modes: { id: string; label: string; description: string }[];
  features: Record<string, { enabled: boolean; reason?: string }>;
  push: { enabled: boolean; vapidPublicKey: string | null };
  events: { enabled: boolean; backend: string };
};

type Listener = (detail: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

function on(event: string, fn: Listener) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function dispatchInternal(event: string, detail: unknown) {
  listeners.get(event)?.forEach((fn) => {
    try {
      fn(detail);
    } catch {
      // ignore listener faults
    }
  });
}

async function fetchModules(): Promise<ModuleManifest | null> {
  try {
    const res = await fetch("/api/modules", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ModuleManifest;
  } catch {
    return null;
  }
}

async function recordEvent(payload: { kind: string; meta?: Record<string, unknown> }) {
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
  const api = {
    version: "1.0.0",
    capabilities: detectCapabilities(),
    modules: fetchModules,
    pushStatus: fetchPushStatus,
    recordEvent,
    on,
  };
  // Avoid clobbering — first install wins.
  if (!(window as unknown as Record<string, unknown>).CipherRoomAPI) {
    (window as unknown as Record<string, unknown>).CipherRoomAPI = api;
  }
}
