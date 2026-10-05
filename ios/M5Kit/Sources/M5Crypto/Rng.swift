// Where protocol 4 gets its randomness (rng.ts; android p4/Rng.java). Every
// random value — ephemeral and ratchet P-256 keys, ML-KEM seeds and
// encapsulation messages, nonces, chain keys, ids — is drawn through an Rng:
// `SystemRng` in the app, a `TapeRng` in the vector tests, which replays the
// draws the web reference recorded (bytes as b64, P-256 private keys as
// PKCS#8) and fails at once, naming the draw, when this port draws in another
// order (§ 0).

import M5Core
import Synchronization

public enum P256Use: String, Sendable { case ecdh, ecdsa }

public protocol Rng: Sendable {
    /// `n` random bytes; `what` names the draw.
    func bytes(_ n: Int, _ what: String) throws -> Bytes
    /// A fresh P-256 key pair; `use` is kept for the tape (one key type in CryptoKit terms).
    func p256(_ use: P256Use, _ what: String) throws -> P256Pair
}

/// The system's CSPRNG.
public struct SystemRng: Rng {
    public init() {}
    public func bytes(_ n: Int, _ what: String) -> Bytes { Crypto.random(n) }
    public func p256(_ use: P256Use, _ what: String) -> P256Pair { Prim.generateP256() }
}

public extension Rng where Self == SystemRng {
    static var system: SystemRng { SystemRng() }
}

/// Replays a recorded tape; a draw of another kind, label or length than recorded throws `state`.
public final class TapeRng: Rng {
    private let tape: [JSON]
    private let at = Mutex(0)

    public init(_ tape: [JSON]) { self.tape = tape }

    public var remaining: Int { at.withLock { tape.count - $0 } }

    private func take(_ what: String) throws -> JSONObject {
        try at.withLock { i in
            guard i < tape.count, let entry = tape[i].objectValue else { throw P4Error("state", "tape exhausted at draw \"\(what)\"") }
            let got = entry.optString("what")
            if got != what { throw P4Error("state", "tape draw \(i) is \"\(got)\", wanted \"\(what)\"") }
            i += 1
            return entry
        }
    }

    public func bytes(_ n: Int, _ what: String) throws -> Bytes {
        let entry = try take(what)
        guard entry.has("bytes") else { throw P4Error("state", "tape draw \"\(what)\" is not bytes") }
        let out = try Prim.unb64(entry.string("bytes"))
        if out.count != n { throw P4Error("state", "tape draw \"\(what)\" has \(out.count) bytes, wanted \(n)") }
        return out
    }

    public func p256(_ use: P256Use, _ what: String) throws -> P256Pair {
        let entry = try take(what)
        if entry.optString("p256") != use.rawValue { throw P4Error("state", "tape draw \"\(what)\" is not a P-256 \(use.rawValue) key") }
        let pair = try Prim.importP256Pkcs8(entry.string("pkcs8"))
        if pair.spki != entry.optString("spki") { throw P4Error("state", "tape draw \"\(what)\": public key does not match") }
        return pair
    }
}

/// Draws real randomness and records it in the vectors' tape format (Swift↔Swift tests).
public final class RecordingRng: Rng {
    private let entries = Mutex<[JSON]>([])

    public init() {}

    public var tape: [JSON] { entries.withLock { $0 } }

    public func bytes(_ n: Int, _ what: String) -> Bytes {
        let out = Crypto.random(n)
        entries.withLock { $0.append(["what": .string(what), "bytes": .string(Prim.b64(out))]) }
        return out
    }

    public func p256(_ use: P256Use, _ what: String) -> P256Pair {
        let pair = Prim.generateP256()
        entries.withLock { $0.append(["what": .string(what), "p256": .string(use.rawValue), "pkcs8": .string(pair.pkcs8), "spki": .string(pair.spki)]) }
        return pair
    }
}
