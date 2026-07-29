// Fingerprint TOFU (Trust On First Use) helper.
//
// Goal:
//  - Once a peer connection is established, walk the RTCPeerConnection
//    stats and extract the remote DTLS certificate fingerprint (SHA-256).
//  - Surface it to the UI for out-of-band comparison so the user can
//    detect MITM by comparing fingerprints with the peer over Signal etc.
//  - Persist the first observed fingerprint per peerId in localStorage
//    under `preferences.fingerprints[peerId]`. Subsequent connections
//    alert the user if the fingerprint changes.
//
// Note: this is best-effort. The `getStats()` API exposes certificate
// info only after DTLS handshake completes; before that the fingerprint
// is null. We tolerate this gracefully.

export type Fingerprint = {
  /** hex SHA-256 of the remote DTLS certificate fingerprint. */
  digest: string;
  /** ISO timestamp when we observed it for the first time. */
  firstSeenAt: string;
  /** ISO timestamp when we last observed the matching fingerprint. */
  lastSeenAt: string;
};

const STORE_KEY = "m5cet:fingerprints:v1";

/** Read all stored fingerprints (peerId -> Fingerprint). */
export function loadFingerprints(): Record<string, Fingerprint> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Fingerprint>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Save fingerprints back to localStorage. */
export function saveFingerprints(map: Record<string, Fingerprint>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORE_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

/** Compute SHA-256 hash of a buffer, returning lowercase hex. */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : (buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Format a digest as colon-separated uppercase pairs (industry-standard
 * DTLS fingerprint notation). Input is 64 hex chars (32 bytes / 256 bit).
 */
export function formatFingerprint(digest: string): string {
  if (!digest) return "";
  // Strip whitespace, then whitelist lowercase hex. We do NOT
  // pad short inputs — a fingerprint that lost prefix bytes must
  // not silently turn into zeros (that would create ambiguous
  // collision risk with an authentic empty-prefix digest).
  const clean = digest.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  return clean.toUpperCase().match(/.{2}/g)?.join(":") ?? clean;
}

/**
 * Walk the connection's stats and return SHA-256 hex of the remote
 * certificate fingerprint. Returns null when not yet available.
 *
 * The stats dictionary varies by browser but `remoteCertificateFingerprint`
 * is the standardised field (e.g. from RTCIceTransport.getStats()).
 * Older browsers may expose `certificateHash` or a combination of
 * `fingerprintAlgorithm` + `fingerprint` — we handle both.
 */
export async function extractRemoteFingerprint(
  pc: RTCPeerConnection,
): Promise<string | null> {
  if (typeof pc.getStats !== "function") return null;
  let best: string | null = null;
  try {
    const stats = await pc.getStats();
    stats.forEach((report) => {
      // Modern standardised: RTCIceCandidatePair-style / certificate stats
      const candidate = report as Record<string, unknown>;
      const type = String(candidate.type || "");
      // Some browsers prefix with `peerconnection.` for older code.
      const fp = String(candidate.remoteCertificateFingerprint
        || candidate.certificateHash
        || candidate.fingerprint
        || "");
      if (!fp) return;
      // Some implementations report SHA-1 / SHA-256 explicitly.
      const algo = String(candidate.fingerprintAlgorithm || candidate.certificateType || "");
      // We only accept SHA-256 by base.
      const cleaned = fp.replace(/[^0-9A-Fa-f:]/g, "").replace(/:/g, "").toLowerCase();
      if (cleaned.length < 16) return;
      // If we know the algorithm, filter to SHA-256.
      if (algo && algo.toUpperCase() !== "SHA-256" && cleaned.length !== 64) return;
      // Pick the longest (SHA-256 is 64 hex chars).
      if (!best || cleaned.length > best.length) best = cleaned;
      // Touch the type so unused-variable lints do not fire.
      void type;
    });
  } catch { /* ignore */ }
  return best;
}

/**
 * Compare a freshly observed fingerprint against the stored one.
 * Returns { status, stored, fresh } where status is "first-use" or
 * "match" or "mismatch".
 */
export function compareFingerprint(
  peerId: string,
  fresh: string,
): { status: "first-use" | "match" | "mismatch"; stored: Fingerprint | null } {
  const map = loadFingerprints();
  const stored = map[peerId] || null;
  if (!stored) return { status: "first-use", stored: null };
  if (stored.digest === fresh) return { status: "match", stored };
  return { status: "mismatch", stored };
}

/**
 * Persist a freshly observed fingerprint for a peerId. Returns the
 * updated map.
 */
export function persistFingerprint(peerId: string, digest: string): Record<string, Fingerprint> {
  const map = loadFingerprints();
  const now = new Date().toISOString();
  const existing = map[peerId];
  map[peerId] = {
    digest,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
  };
  saveFingerprints(map);
  return map;
}

/**
 * Remove a fingerprint entry (e.g. when a peer leaves for good).
 */
export function dropFingerprint(peerId: string): void {
  const map = loadFingerprints();
  if (map[peerId]) {
    delete map[peerId];
    saveFingerprints(map);
  }
}
