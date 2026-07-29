/// <reference types="node" />
// Shared string-sanitization helpers used by HTTP and WS routes.

/**
 * Whitelist a string to printable ASCII alphanumerics, dot, dash, underscore, and a single
 * space character. Newlines, tabs, and control characters are explicitly rejected to
 * prevent framing or response-splitting issues that might surface in peer
 * names, room IDs, or device IDs.
 */
export function safeString(value: unknown, fallback: string, max = 96): string {
  if (typeof value !== "string") return fallback;
  // Allow only printable ASCII alphanumerics, single space, dot, dash,
  // underscore. We intentionally reject every other whitespace
  // (newline/tab/etc) for response-splitting safety. If the result is
  // empty after sanitisation — or contains only spaces — return the
  // fallback instead.
  const cleaned = value.replace(/[^a-zA-Z0-9 ._-]/g, "").slice(0, max);
  const compact = cleaned.trim();
  return compact.length === 0 ? fallback : cleaned;
}

/**
 * Whitelist a device id: alphanumerics, underscore, dash. Length 4-64.
 * Returns null if invalid.
 */
export function safeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 4 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Sanitize an opaque metadata object recorded in the optional event log.
 * Only "safe" primitive types are kept (number/finite, boolean, short alnum string).
 * Keys must match a strict whitelist to avoid smuggling structured metadata through
 * the log.
 */
export function sanitizeMeta(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string" || key.length > 32) continue;
    if (/[^a-zA-Z0-9_-]/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "string") {
      const trimmed = value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 64);
      if (trimmed) safe[key] = trimmed;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

/**
 * Whitelist an opaque id (room id, peer id, kind). Returns undefined if the
 * sanitisation yields an empty string OR a string with no alphanumeric
 * characters (i.e. the id is composed solely of separators — a value
 * like `"---"` carries no identifying information and is rejected to
 * prevent collision with empty-prefix authentic ids).
 */
export function safeId(value: unknown, max = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, max);
  if (!trimmed) return undefined;
  if (!/[a-zA-Z0-9]/.test(trimmed)) return undefined;
  return trimmed;
}
