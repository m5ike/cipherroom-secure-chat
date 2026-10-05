// Sealed messages (6.1) as client/src/lib/message-kinds.ts makes them
// (android chat/Sealed.java): the text encrypted with a code the recipients
// get some other way. PBKDF2-SHA256 (600 000 rounds, 16-byte salt) →
// AES-256-GCM (12-byte IV, no AAD) over the UTF-8 text; flags.sealed =
// {salt, iv, v: 2, it}. The code: 12 characters from an alphabet without
// look-alikes, shown as XXXX-XXXX-XXXX; normalised (NFKC, upper case, no
// spaces or dashes). Slow (PBKDF2): never on the main thread.

import Foundation
import M5Core

public enum Sealed {
    public static let alphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    public static let rounds = 600_000, legacyRounds = 150_000, maxRounds = 2_000_000

    /// A new random code, XXXX-XXXX-XXXX (rejection sampling: no modulo bias).
    public static func newCode() -> String {
        var b = [Character]()
        let limit = 256 - 256 % alphabet.count
        while b.count < 12 {
            let v = Int(Crypto.random(1)[0])
            if v < limit { b.append(alphabet[v % alphabet.count]) }
        }
        return String(b[0..<4]) + "-" + String(b[4..<8]) + "-" + String(b[8..<12])
    }

    /// NFKC, upper case (locale-independent), white space and dashes removed.
    public static func normalize(_ code: String?) -> String {
        var out = ""
        for u in (code ?? "").precomposedStringWithCompatibilityMapping.uppercased().unicodeScalars {
            // Java's [\s-]: ASCII white space and "-".
            if u == "-" || u == " " || u == "\t" || u == "\n" || u == "\u{0B}" || u == "\u{0C}" || u == "\r" { continue }
            out.unicodeScalars.append(u)
        }
        return out
    }

    static func key(_ code: String, _ salt: Bytes, _ rounds: Int) -> Bytes { Crypto.pbkdf2(Crypto.utf8(code), salt, rounds, 32) }

    /// The ciphertext (base64) and the meta for flags.sealed {salt, iv, v: 2, it}.
    public static func seal(_ text: String, code: String) throws -> (ciphertext: String, meta: JSONObject) {
        let salt = Crypto.random(16), iv = Crypto.random(12)
        let k = key(normalize(code), salt, rounds)
        let ct = try Crypto.gcmSeal(k, iv, Crypto.utf8(text), nil)
        return (Crypto.b64(ct), JSONObject([("salt", .string(Crypto.b64(salt))), ("iv", .string(Crypto.b64(iv))), ("v", 2), ("it", .int(rounds))]))
    }

    /// The text, or nil when the code is wrong (or the meta is unusable).
    public static func open(_ ciphertext: String, meta: JSONObject, code: String) -> String? {
        let v2 = Envelopes.optInt(meta, "v", 1) == 2
        let it: Int64 = v2 ? (meta["it"] == nil ? Int64(rounds) : meta.optInt64("it", Int64(rounds))) : Int64(legacyRounds)
        // 6.7 (audit N18): the count comes from the sender — a huge one froze the phone for hours.
        if it < 1 || it > Int64(maxRounds) { return nil }
        guard let salt = B64.decodeTrimmed(meta.optString("salt")), let iv = B64.decodeTrimmed(meta.optString("iv")),
              let ct = B64.decodeTrimmed(ciphertext) else { return nil }
        let k = key(v2 ? normalize(code) : code, salt, Int(it))
        guard let plain = try? Crypto.gcmOpen(k, iv, ct, nil) else { return nil }
        return Crypto.str(plain)
    }
}

/// The device policy is applied only as the server signed it for this device
/// (6.7, F-16; android security/SignedPolicy.java):
///   policySigned = { at, policy: "<JSON text>", sig }
///   sig = ECDSA P-256 (P1363) by the pinned server key over "m5policy/1|<deviceId>|<at>|<JSON text>"
/// and never older than the policy the app already has.
public enum SignedPolicy {
    public static func signedString(deviceId: String, at: Int64, policyJson: String) -> String {
        "m5policy/1|" + deviceId + "|" + String(at) + "|" + policyJson
    }

    /// The policy, when the wire holds a valid signature of serverKey for this device and is not older than lastAt; nil otherwise.
    public static func open(_ wire: JSONObject?, serverKey: String?, deviceId: String?, lastAt: Int64) -> JSONObject? {
        guard let wire, let serverKey, !serverKey.isEmpty, let deviceId, !deviceId.isEmpty, let atRaw = wire["at"]?.numberValue else { return nil }
        let at = atRaw.int64 ?? Int64(atRaw.double)
        let json = wire.optString("policy"), sig = wire.optString("sig")
        if json.isEmpty || sig.isEmpty || at < lastAt { return nil }
        if !Ec.verify(serverKey, Crypto.utf8(signedString(deviceId: deviceId, at: at, policyJson: json)), sig) { return nil }
        return JSON.parseObject(json)
    }
}

/// Extras the app takes only from its own intents / URLs (6.10, G-23; android
/// security/IntentSeal.java): a tag is HMAC-SHA256 under a key that exists only
/// in this process, over the purpose and the value — 128 bits, base64url.
/// On iOS: notification actions, Handoff / Siri intents and deep links that name a room.
public enum IntentSeal {
    public static let open = "open", reply = "reply"

    private static let processKey = Crypto.random(32)

    /// The tag of a value for a purpose under a key.
    public static func tag(_ key: Bytes, _ purpose: String, _ value: String) -> String {
        let mac = Crypto.hmac256(key, Crypto.utf8("m5cet/intent\u{0}" + purpose + "\u{0}" + value))
        return Crypto.b64url(Array(mac.prefix(16)))
    }

    /// Whether a tag is this key's for the purpose and value (in constant time).
    public static func valid(_ key: Bytes, _ purpose: String?, _ value: String?, _ tag: String?) -> Bool {
        guard let purpose, let value, let tag, !value.isEmpty else { return false }
        return Crypto.same(Crypto.utf8(IntentSeal.tag(key, purpose, value)), Crypto.utf8(tag))
    }

    /// This process's tag of a value.
    public static func tag(_ purpose: String, _ value: String) -> String { tag(processKey, purpose, value) }

    /// Whether the tag is this process's for the purpose and value.
    public static func valid(_ purpose: String?, _ value: String?, _ tag: String?) -> Bool { valid(processKey, purpose, value, tag) }
}
