// Protocol 4 (M5cet 6.12) — the constants every implementation shares
// (client/src/lib/p4/contract.ts, android p4/P4.java; normative text
// docs/protocol-v4.md). This module is checked byte for byte against
// test/vectors/p4.json.

public enum P4 {
    public static let version = 4
    /// The capability a protocol-4 client lists in its hello `caps`.
    public static let cap = "p4"

    /* ------------------------------------------------------------- labels */

    public static let lHello = "m5cet/hello/4"
    public static let lTranscript = "m5cet/p4/th"
    public static let lRoot = "m5cet/p4/root"
    public static let lRatchet = "m5cet/p4/rk"
    public static let lPairKey = "m5cet/p4/mk"
    public static let lPairAad = "m5cet/p4/pair"
    public static let lSenderKey = "m5cet/p4/sk"
    public static let lMailboxBundle = "m5cet/mb/4"
    public static let lMailbox = "m5cet/p4/mb"
    public static let lFile = "m5cet/p4/file"
    public static let lFileMeta = "m5cet/p4/file-meta"
    public static let lFileChunk = "m5cet/p4/chunk"
    public static let lFileEnd = "m5cet/p4/file-end"
    public static let lMedia = "m5cet/p4/media"
    public static let lHubSeed = "m5cet/hub-auth/4"
    public static let lHubJoin = "m5cet/hub-join/4"
    public static let lDeviceCert = "m5cet/device-cert/2"
    public static let lKtUser = "m5cet/kt/user|"
    public static let lKtSth = "m5cet/kt/sth/4"
    public static let lReplay = "m5cet/p4/seen"
    public static let lSkCert = "m5cet/sk-cert/4"

    /* ------------------------------------------------------------- limits */

    /// Skipped message keys kept per chain (pair ratchet and sender keys).
    public static let maxSkip = 1_000
    /// Skipped message keys kept per pair session in total.
    public static let maxSkippedTotal = 2_000
    /// A sender-key chain is replaced after this many messages or this long.
    public static let senderKeyRotateMessages: Int64 = 100
    public static let senderKeyRotateMs: Int64 = 15 * 60 * 1000
    public static let mailboxLifetimeMs: Int64 = 7 * 24 * 60 * 60 * 1000
    public static let mailboxRenewBeforeMs: Int64 = 24 * 60 * 60 * 1000
    public static let mailboxKeepMs: Int64 = 31 * 24 * 60 * 60 * 1000
    public static let deviceCertLifetimeMs: Int64 = 90 * 24 * 60 * 60 * 1000
    public static let replayWindowMs: Int64 = 31 * 24 * 60 * 60 * 1000
    public static let replayFutureMs: Int64 = 5 * 60 * 1000
    public static let replayMaxIdsPerRoom = 50_000
    /// Padding buckets (padded length INCLUDING the 0x80 marker); above the last, multiples of it.
    public static let padBuckets = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]

    /// ML-KEM-768 sizes (FIPS 203).
    public static let kemEk = 1184, kemDk = 2400, kemCt = 1088, kemSs = 32, kemSeed = 64

    /// JavaScript's Number.MAX_SAFE_INTEGER.
    public static let maxSafe: Int64 = 9_007_199_254_740_991
}

/// Why a protocol-4 operation refused its input (primitives.ts P4Error). The
/// codes are stable (tests, UI, the reset reason): malformed, aead, kct, skip,
/// replay, signature, no-chain, expired, wiped, id-mismatch, state.
public struct P4Error: Error, Sendable, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String? = nil) { self.code = code; self.message = message ?? code }

    public static func malformed(_ message: String) -> P4Error { P4Error("malformed", message) }

    public var description: String { "\(code): \(message)" }
}
