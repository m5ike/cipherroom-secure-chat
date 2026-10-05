// The account's key material exactly as the web does it
// (client/src/lib/passkey.ts; android account/AccountKeys.java), and the
// WebAuthn JSON around it:
//
//   root        the first passkey's PRF output — or 32 random bytes kept on a
//               phone whose passkey provider has no PRF
//   key proof   HKDF(root, PRF_SALT, "m5cet:key-proof:v1"): the server keeps its hash
//   sealed root AES-GCM(HKDF(secret, PRF_SALT, info), root), AAD "m5cet:account-root:v1"
//   vault key   HKDF(root, PRF_SALT, "m5cet:profile:v1")
//   vault parts v1: b64(iv ‖ AES-GCM(JSON)), no AAD
//               v2 (6.12, F-26): b64("M5V2" ‖ rev (8 bytes BE) ‖ iv ‖ AES-GCM(JSON)),
//               AAD "m5cet:vault-slot:v2|<slot>|<rev>" — bound to its slot and revision

import Foundation
import M5Core

public enum AccountKeys {
    public static let prfSalt = Crypto.utf8("m5cet:passkey:prf:v1")
    public static let wrapPasskey = "m5cet:root-wrap:passkey:v1"
    public static let wrapRecovery = "m5cet:root-wrap:recovery:v1"
    private static let wrapAad = Crypto.utf8("m5cet:account-root:v1")
    private static let proofInfo = Crypto.utf8("m5cet:key-proof:v1")
    private static let profileInfo = Crypto.utf8("m5cet:profile:v1")

    /// The key proof (base64url, 43 characters) the server checks at sign-in.
    public static func keyProof(_ root: Bytes) -> String { Crypto.b64url(Crypto.hkdf(root, prfSalt, proofInfo, 32)) }

    /// Seals the root under a key from `secret` (web: sealRoot) → {iv, ct}.
    public static func sealRoot(_ root: Bytes, secret: Bytes, info: String, iv: Bytes? = nil) throws -> JSONObject {
        let k = Crypto.hkdf(secret, prfSalt, Crypto.utf8(info), 32)
        let nonce = iv ?? Crypto.random(12)
        return JSONObject([("iv", .string(Crypto.b64(nonce))), ("ct", .string(Crypto.b64(try Crypto.gcmSeal(k, nonce, root, wrapAad))))])
    }

    /// Opens a sealed root (web: openRoot).
    public static func openRoot(_ wrapped: JSONObject, secret: Bytes, info: String) throws -> Bytes {
        let k = Crypto.hkdf(secret, prfSalt, Crypto.utf8(info), 32)
        guard let iv = B64.decode(wrapped.optString("iv")), let ct = B64.decode(wrapped.optString("ct")) else { throw CryptoError("the sealed account key is malformed") }
        return try Crypto.gcmOpen(k, iv, ct, wrapAad)
    }

    /// Does the server's answer carry a root sealed for this passkey?
    public static func sealed(_ wrapped: JSONObject?) -> Bool { !(wrapped?.optString("iv").isEmpty ?? true) && !(wrapped?.optString("ct").isEmpty ?? true) }

    /* ------------------------------------------------------------- vault */

    /// 6.4: the vault key (web: deriveAccountKeys → key).
    public static func profileKey(_ root: Bytes) -> Bytes { Crypto.hkdf(root, prfSalt, profileInfo, 32) }

    /// Seals a vault part v1 (web: sealProfile): base64(iv ‖ AES-GCM(JSON)), no AAD.
    public static func sealProfile(_ value: JSONObject, key: Bytes, iv: Bytes? = nil) throws -> String {
        let nonce = iv ?? Crypto.random(12)
        return Crypto.b64(nonce + (try Crypto.gcmSeal(key, nonce, Crypto.utf8(value.stringify()), nil)))
    }

    /// Opens a vault part v1 (web: openProfile); a JSON object, or an error — never a guess.
    public static func openProfile(_ ciphertext: String, key: Bytes) throws -> JSONObject {
        guard let all = B64.decode(ciphertext) else { throw CryptoError("the vault is malformed") }
        if all.count < 12 + 16 { throw CryptoError("the vault is too short") }
        let plain = try Crypto.gcmOpen(key, Array(all[0..<12]), Array(all[12...]), nil)
        guard let o = JSON.parseObject(Crypto.str(plain)) else { throw CryptoError("the vault's profile is not a JSON object") }
        return o
    }

    private static let slotMagic: Bytes = [0x4d, 0x35, 0x56, 0x32] // "M5V2"
    private static let slotHead = 4 + 8

    public static func slotAad(_ slot: String, _ rev: Int64) -> Bytes { Crypto.utf8("m5cet:vault-slot:v2|" + slot + "|" + String(rev)) }

    /// A vault part in format 2 (rev: the writer's clock, newer is larger).
    public static func sealSlot(_ value: JSONObject, key: Bytes, slot: String, rev: Int64, iv: Bytes? = nil) throws -> String {
        let r = max(0, min(P4.maxSafe, rev))
        let nonce = iv ?? Crypto.random(12)
        let ct = try Crypto.gcmSeal(key, nonce, Crypto.utf8(value.stringify()), slotAad(slot, r))
        return Crypto.b64(slotMagic + ByteOps.be64(UInt64(r)) + nonce + ct)
    }

    /// An opened vault part: its value, its revision (0 for a v1 part) and whether it is still v1.
    public struct Slot: Sendable {
        public let value: JSONObject
        public let rev: Int64
        public let legacy: Bool
    }

    /// Opens a vault part of either format. A v2 part opens only as the slot it
    /// was sealed for. (A v1 IV that happens to start with "M5V2" fails the v2
    /// check and is then opened as v1, as the web does.)
    public static func openSlot(_ ciphertext: String, key: Bytes, slot: String) throws -> Slot {
        guard let all = B64.decode(ciphertext) else { throw CryptoError("the vault is malformed") }
        if all.count >= slotHead + 12 + 16 && Array(all[0..<4]) == slotMagic {
            var rev: UInt64 = 0
            for b in all[4..<12] { rev = rev << 8 | UInt64(b) }
            if rev <= UInt64(P4.maxSafe) {
                do {
                    let plain = try Crypto.gcmOpen(key, Array(all[slotHead..<slotHead + 12]), Array(all[(slotHead + 12)...]), slotAad(slot, Int64(rev)))
                    guard let o = JSON.parseObject(Crypto.str(plain)) else { throw CryptoError("the vault's part is not a JSON object") }
                    return Slot(value: o, rev: Int64(rev), legacy: false)
                } catch {
                    if let v1 = try? openProfile(ciphertext, key: key) { return Slot(value: v1, rev: 0, legacy: true) }
                    throw error
                }
            }
        }
        return Slot(value: try openProfile(ciphertext, key: key), rev: 0, legacy: true)
    }

    /* ---------------------------------------------------------- webauthn */

    /// clientExtensionResults.prf.results.first (base64url) of a credential response; nil without one.
    public static func prfOf(_ credential: JSONObject?) -> Bytes? {
        guard let first = credential?.object("clientExtensionResults")?.object("prf")?.object("results")?.string("first"), !first.isEmpty,
              let b = B64.decodeURL(first.replacingOccurrences(of: "=", with: "")), !b.isEmpty else { return nil }
        return b
    }

    /// What the server reads of a credential (webauthn.ts): id, rawId, type, response.
    public static func strip(_ c: JSONObject) -> JSONObject {
        JSONObject([("id", c["id"] ?? .null), ("rawId", .string(c.string("rawId") ?? c.optString("id"))), ("type", "public-key"), ("response", c["response"] ?? .null)])
    }

    /// The credential's id (base64url).
    public static func credentialId(_ c: JSONObject?) -> String {
        (c?.string("rawId") ?? c?.string("id") ?? "").replacingOccurrences(of: "=", with: "")
    }

    /// Asks for the PRF output with PRF_SALT (merged into the options' extensions).
    public static func withPrf(_ options: JSONObject) -> JSONObject {
        var ext = options.object("extensions") ?? JSONObject()
        ext["prf"] = .object(JSONObject([("eval", .object(JSONObject([("first", .string(Crypto.b64url(prfSalt)))])))]))
        return options.with("extensions", .object(ext))
    }

    /// A PRF-only assertion with a credential just created (web: prfSecretFor).
    public static func prfRequest(rpId: String, registration: JSONObject, challenge: Bytes) -> JSONObject {
        var allow = JSONObject([("type", "public-key"), ("id", .string(credentialId(registration)))])
        if let transports = registration.object("response")?.array("transports"), !transports.isEmpty { allow["transports"] = .array(transports) }
        let request = JSONObject([("challenge", .string(Crypto.b64url(challenge))), ("rpId", .string(rpId)), ("allowCredentials", .array([.object(allow)])),
                                  ("userVerification", "required"), ("timeout", 60_000)])
        return withPrf(request)
    }

    /// The account's passkeys (base64url ids) from its summary: every one listed, else the first one.
    public static func credentialIds(_ summary: JSONObject?) -> [String] {
        var ids = [String]()
        for p in summary?.array("passkeys") ?? [] {
            let id = (p.objectValue?.optString("credentialId") ?? "").replacingOccurrences(of: "=", with: "")
            if !id.isEmpty { ids.append(id) }
        }
        let first = (summary?.optString("credentialId") ?? "").replacingOccurrences(of: "=", with: "")
        if ids.isEmpty && !first.isEmpty { ids.append(first) }
        return ids
    }

    /// "Confirm with your passkey": any of the account's passkeys, a local challenge, no PRF.
    public static func confirmRequest(rpId: String, ids: [String], challenge: Bytes) -> JSONObject {
        var request = JSONObject([("challenge", .string(Crypto.b64url(challenge))), ("rpId", .string(rpId)), ("userVerification", "required"), ("timeout", 60_000)])
        if !ids.isEmpty { request["allowCredentials"] = .array(ids.map { .object(JSONObject([("type", "public-key"), ("id", .string($0))])) }) }
        return request
    }

    /// The username in an assertion's user handle (the server puts it there since 4.0), or "".
    public static func handleName(_ assertion: JSONObject?) -> String {
        let h = assertion?.object("response")?.optString("userHandle") ?? ""
        if h.isEmpty || h == "null" { return "" }
        guard let b = B64.decodeURL(h.replacingOccurrences(of: "=", with: "")), let name = UTF8Text.decode(b) else { return "" }
        let n = name.unicodeScalars.count
        guard n >= 1 && n <= 40 else { return "" }
        for u in name.unicodeScalars {
            let cat = u.properties.generalCategory
            let letterOrNumber: Bool
            switch cat {
            case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                 .decimalNumber, .letterNumber, .otherNumber: letterOrNumber = true
            default: letterOrNumber = false
            }
            if !(letterOrNumber || u == "." || u == "_" || u == "-") { return "" }
        }
        return name
    }
}

/// The recovery code as the web makes it (client/src/lib/recovery.ts; android
/// account/RecoveryCode.java): 26 Crockford base32 characters (130 bits),
/// shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X. Three values are derived:
///   id      HMAC(code, "m5cet:recovery:id")[0..18]  which account (lookup)
///   proof   HMAC(code, "m5cet:recovery:proof")      the server keeps SHA-256 of it
///   secret  HMAC(code, "m5cet:recovery:kek")        seals the account root
public enum RecoveryCode {
    public static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    public static let chars = 26

    public struct Material: Sendable {
        public let id: String, proof: String, verifier: String
        public let secret: Bytes
    }

    /// A fresh code, grouped for writing down.
    public static func generate() -> String {
        let b = Crypto.random(chars)
        var s = ""
        for i in 0..<chars {
            if i > 0 && i % 5 == 0 { s += "-" }
            s.append(alphabet[Int(b[i] & 31)])
        }
        return s
    }

    /// How a typed code is compared: case, spaces, dashes and look-alikes do not matter; nil when it is not a code.
    public static func normalize(_ code: String?) -> String? {
        guard let code else { return nil }
        var c = ""
        for ch in code.uppercased().unicodeScalars {
            if ch == "-" || ch == " " || ch == "\t" || ch == "\n" || ch == "\u{0B}" || ch == "\u{0C}" || ch == "\r" { continue }
            switch ch {
            case "I", "L": c += "1"
            case "O": c += "0"
            case "U": c += "V"
            default: c.unicodeScalars.append(ch)
            }
        }
        guard c.count == chars, c.allSatisfy({ alphabet.contains($0) }) else { return nil }
        return c
    }

    /// The three values of a code; nil for a malformed one.
    public static func material(_ code: String) -> Material? {
        guard let n = normalize(code) else { return nil }
        let key = Crypto.utf8("m5cet:recovery:v1:" + n)
        let id = Crypto.b64url(Array(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:id")).prefix(18)))
        let proof = Crypto.b64url(Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:proof")))
        let verifier = Crypto.hex(Crypto.sha256(Crypto.utf8(proof)))
        return Material(id: id, proof: proof, verifier: verifier, secret: Crypto.hmac256(key, Crypto.utf8("m5cet:recovery:kek")))
    }
}
