// 6.3 define — m5mobile.define in the web app.
//
// The operator's typed constants/variables (Android › Define) reach the web
// client already materialized: GET /api/define?scope=web returns
// { values, updatedAt }, where a value is the plain scalar/object/array (bytes
// as a hex string) and a `script` value is data ({ __m5script, code, lang }),
// never evaluated. This module fetches them once, caches them, exposes them as
// window.m5mobile.define and via the useDefine() hook, and refetches on demand.
// Absence (offline, no definitions, an error) is handled as an empty object.

import { useEffect, useSyncExternalStore } from "react";
import type { ScriptValue } from "./schema";

/** name → materialized value; a script value is a ScriptValue ({ __m5script }). */
export type DefineValues = Record<string, unknown>;
export type { ScriptValue };

type State = { values: DefineValues; updatedAt: number; loaded: boolean };

// Replaced (never mutated) on each change so useSyncExternalStore sees a new
// reference; the empty starting state is a valid, usable value on its own.
let state: State = { values: {}, updatedAt: 0, loaded: false };
let inflight: Promise<DefineValues> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setWindowGlobal(values: DefineValues): void {
  if (typeof window === "undefined") return;
  // Mirrors the Functions sandbox global: window.m5mobile.define.<name>.
  (window as unknown as Record<string, unknown>).m5mobile = { define: values };
}

/** The values known right now (synchronous; {} until the first fetch lands). */
export function defineValuesNow(): DefineValues {
  return state.values;
}

/** True once a fetch has resolved (success or a graceful empty on failure). */
export function defineLoaded(): boolean {
  return state.loaded;
}

/**
 * Fetch the web-scope define values. Cached: after the first success later
 * calls return the cached values unless `force` is true (refetch on demand).
 * Concurrent callers share one in-flight request.
 */
export function fetchDefine(force = false): Promise<DefineValues> {
  if (!force && state.loaded) return Promise.resolve(state.values);
  if (inflight && !force) return inflight;
  inflight = (async () => {
    let values: DefineValues = {};
    let updatedAt = state.updatedAt;
    try {
      const res = await fetch("/api/define?scope=web", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { values?: unknown; updatedAt?: unknown };
        if (body && typeof body.values === "object" && body.values) values = body.values as DefineValues;
        if (typeof body.updatedAt === "number") updatedAt = body.updatedAt;
      }
    } catch {
      // Offline or blocked: keep an empty, valid object.
    }
    state = { values, updatedAt, loaded: true };
    setWindowGlobal(values);
    emit();
    inflight = null;
    return values;
  })();
  return inflight;
}

/**
 * Called once at app startup: publishes window.m5mobile = { define } (empty
 * until the fetch resolves) and kicks off the fetch. Safe to call more than
 * once; the cache makes later calls no-ops.
 */
export function bootstrapDefine(): void {
  setWindowGlobal(state.values);
  void fetchDefine();
}

/** Test-only: clears the cache and the window global back to the empty start. */
export function _resetDefineForTest(): void {
  state = { values: {}, updatedAt: 0, loaded: false };
  inflight = null;
  if (typeof window !== "undefined") delete (window as unknown as Record<string, unknown>).m5mobile;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): State {
  return state;
}

/**
 * React hook: the materialized define values, kept in sync across the app.
 * Fetches on first use if it has not loaded yet; refresh() forces a refetch.
 */
export function useDefine(): { values: DefineValues; updatedAt: number; loaded: boolean; refresh: () => Promise<DefineValues> } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!snap.loaded) void fetchDefine();
  }, [snap.loaded]);
  return { values: snap.values, updatedAt: snap.updatedAt, loaded: snap.loaded, refresh: () => fetchDefine(true) };
}
