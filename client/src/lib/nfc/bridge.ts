// The NFC bridge (6.3): the seam between a Functions model asking for an NFC
// op and the device that runs it.
//
// The platform registers ONE executor — the web workbench (its transports and
// card modules) or, in a webview, the Android NFC service. When a model's
// `m5.nfc.*` call arrives as an "nfc" run interaction, the interaction handler
// calls runNfcCommand(); the executor runs it on the reader and returns an
// NfcResult, which is answered back to the waiting model call.
//
// Keeping the executor behind this registry means the model code, the run
// plumbing and the docs share command.ts, while the hardware lives in the
// platform layer and nothing here ever holds a key or a card PIN.

import type { NfcCommand, NfcResult } from "./command";

export type NfcExecutor = (command: NfcCommand, signal?: AbortSignal) => Promise<NfcResult>;

let executor: NfcExecutor | null = null;

/** The platform registers its executor once (returns an unregister). */
export function registerNfcExecutor(fn: NfcExecutor): () => void {
  executor = fn;
  return () => { if (executor === fn) executor = null; };
}

export function hasNfcExecutor(): boolean {
  return executor !== null;
}

/** Runs a model's NFC command on the device, or says none is available. */
export async function runNfcCommand(command: NfcCommand, signal?: AbortSignal): Promise<NfcResult> {
  if (!executor) return { status: "unsupported", message: "No NFC reader is available on this device." };
  try {
    return await executor(command, signal);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
