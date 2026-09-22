// Typed errors shared by every transport and card driver in lib/nfc.
//
// The UI switches on `code`, never on the message text, so messages can
// stay developer-oriented (English) while the workbench renders its own
// localized copy per code.

export type NfcErrorCode =
  | "unsupported" // API is missing in this browser / platform
  | "permission-denied" // user cancelled the chooser or blocked the permission
  | "no-device" // chooser closed without a device / nothing paired
  | "disconnected" // device went away mid-operation
  | "not-connected" // connect() has not been called (or failed)
  | "timeout" // no card / no answer in time
  | "aborted" // AbortSignal fired
  | "no-card" // no card in the field
  | "protocol" // malformed frame / unexpected answer from reader
  | "card-error" // card answered with an error status (SW != 9000, NAK, ...)
  | "auth-failed" // Mifare authentication rejected
  | "not-supported-by-transport" // e.g. APDU on Web NFC
  | "invalid-argument"
  | "busy";

export class NfcError extends Error {
  readonly code: NfcErrorCode;
  /** Optional machine-readable detail (status word, USB error name, ...). */
  readonly detail?: string;

  constructor(code: NfcErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "NfcError";
    this.code = code;
    this.detail = detail;
  }

  static is(err: unknown, code?: NfcErrorCode): err is NfcError {
    return err instanceof NfcError && (code === undefined || err.code === code);
  }
}

/** Wrap a DOMException from a device chooser / permission API into NfcError. */
export function fromDomError(err: unknown, fallback: NfcErrorCode = "protocol"): NfcError {
  if (err instanceof NfcError) return err;
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);
  if (name === "NotFoundError") return new NfcError("no-device", msg || "No device selected", name);
  if (name === "NotAllowedError" || name === "SecurityError") return new NfcError("permission-denied", msg || "Permission denied", name);
  if (name === "AbortError") return new NfcError("aborted", msg || "Aborted", name);
  if (name === "NetworkError") return new NfcError("disconnected", msg || "Device disconnected", name);
  if (name === "NotSupportedError") return new NfcError("unsupported", msg || "Not supported", name);
  if (name === "InvalidStateError") return new NfcError("not-connected", msg || "Invalid state", name);
  if (name === "TimeoutError") return new NfcError("timeout", msg || "Timeout", name);
  return new NfcError(fallback, msg, name || undefined);
}

/** Resolve after `ms` unless `signal` aborts first; rejects with NfcError("aborted"). */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new NfcError("aborted", "Aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(new NfcError("aborted", "Aborted")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Race a promise against a timeout and an optional AbortSignal. */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal, what = "operation"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new NfcError("aborted", "Aborted"));
    const t = setTimeout(() => { cleanup(); reject(new NfcError("timeout", `Timeout waiting for ${what} (${ms} ms)`)); }, ms);
    function onAbort() { cleanup(); reject(new NfcError("aborted", "Aborted")); }
    function cleanup() { clearTimeout(t); signal?.removeEventListener("abort", onAbort); }
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { cleanup(); resolve(v); }, (e) => { cleanup(); reject(e); });
  });
}
