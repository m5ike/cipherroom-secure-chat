// Protocol 4 primitives (docs/protocol-v4.md § 0; primitives.ts; android
// p4/Prim.java): the transcript join, SHA-256, HMAC, HKDF, keyIv, strict
// base64, AES-256-GCM with associated data, P-256 ECDH (32-byte x) and ECDSA
// (raw r‖s) through CryptoKit, Ed25519 (RFC 8032, deterministic). Transcript
// parts are validated in one place (`join`): a part with "|" or a
// non-printable character, or a number that is not a non-negative safe
// integer, throws — two transcripts can never join to the same bytes.

import CryptoKit
import Foundation
import M5Core

/* ---------------------------------------------------------------- join */

/// One transcript part: printable ASCII without "|", or a non-negative safe integer.
public protocol JoinPart {
    func joinPart() throws -> String
}

extension String: JoinPart {
    public func joinPart() throws -> String {
        for u in utf16 where u < 0x20 || u > 0x7e || u == 0x7c {
            throw P4Error.malformed("transcript part is not ASCII without |")
        }
        return self
    }
}

extension Int64: JoinPart {
    public func joinPart() throws -> String {
        if self < 0 || self > P4.maxSafe { throw P4Error.malformed("transcript integer out of range") }
        return String(self)
    }
}

extension Int: JoinPart {
    public func joinPart() throws -> String { try Int64(self).joinPart() }
}

/* ---------------------------------------------------------------- keys */

/// A software P-256 key pair; `spki` is the public key as SPKI DER, base64 (WebCrypto's export form).
public struct P256Pair: Sendable {
    public let privateKey: P256.KeyAgreement.PrivateKey
    public let spki: String

    public init(_ privateKey: P256.KeyAgreement.PrivateKey) {
        self.privateKey = privateKey
        self.spki = B64.encode(Array(privateKey.publicKey.derRepresentation))
    }

    /// PKCS#8 (base64) of the private key — for the vault (mailbox bundles, the identity).
    public var pkcs8: String { B64.encode(Array(privateKey.derRepresentation)) }
    /// The 32-byte private scalar.
    public var raw: Bytes { Array(privateKey.rawRepresentation) }
    public var publicKey: P256.KeyAgreement.PublicKey { privateKey.publicKey }

    var signingKey: P256.Signing.PrivateKey { try! P256.Signing.PrivateKey(rawRepresentation: privateKey.rawRepresentation) }
}

/// What signs for this device: the hello's device key (`publicKey` SPKI b64,
/// raw r‖s b64 signatures). The app supplies a Secure Enclave key through it;
/// `SoftwareSigner` wraps a software key (tests, older stores).
public protocol DeviceSigner: Sendable {
    var publicKey: String { get }
    func sign(_ data: Bytes) throws -> String
}

/// A P-256 key that agrees on secrets (a Secure Enclave key in the app, a software pair here).
public protocol KeyAgreer: Sendable {
    /// The public key, SPKI b64.
    var spki: String { get }
    /// ECDH with a peer: the 32-byte x-coordinate.
    func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Bytes
}

extension P256Pair: KeyAgreer {
    public func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Bytes {
        let s = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        return s.withUnsafeBytes { Array($0) }
    }
}

public struct SoftwareSigner: DeviceSigner {
    public let pair: P256Pair
    public init(_ pair: P256Pair) { self.pair = pair }
    public var publicKey: String { pair.spki }
    public func sign(_ data: Bytes) throws -> String { try Prim.ecdsaSign(pair, data) }
}

/* -------------------------------------------------------------- Prim */

public enum Prim {
    public static let maxSafe = P4.maxSafe

    /* --------------------------------------------------------- bytes */

    public static func utf8(_ s: String) -> Bytes { Array(s.utf8) }

    /// Strict UTF-8 decoding: an invalid sequence throws, it is never replaced.
    public static func fromUtf8(_ b: Bytes) throws -> String {
        guard let s = UTF8Text.decode(b) else { throw P4Error.malformed("not UTF-8") }
        return s
    }

    public static func concat(_ parts: Bytes...) -> Bytes { ByteOps.concat(parts) }
    public static func ctEqual(_ a: Bytes, _ b: Bytes) -> Bool { ByteOps.ctEqual(a, b) }
    public static func wipe(_ b: inout Bytes) { ByteOps.wipe(&b) }

    /// A JSON number that is a non-negative safe integer (JavaScript's Number.isSafeInteger(v) && v >= 0).
    public static func isSafeCount(_ v: JSON?) -> Bool {
        guard let n = v?.numberValue else { return false }
        if let i = n.int64 { return i >= 0 && i <= maxSafe }
        let d = n.double
        return d >= 0 && d <= Double(maxSafe) && d == d.rounded()
    }

    public static func count(_ v: JSON?) throws -> Int64 {
        guard isSafeCount(v), let n = v?.numberValue else { throw P4Error.malformed("not a non-negative safe integer") }
        return n.int64 ?? Int64(n.double)
    }

    /* -------------------------------------------------------- base64 */

    public static func b64(_ b: Bytes) -> String { B64.encode(b) }
    public static func b64url(_ b: Bytes) -> String { B64.url(b) }
    public static func hex(_ b: Bytes) -> String { Hex.encode(b) }

    private static func isStdB64(_ s: String) -> Bool {
        var padding = false, pads = 0
        for u in s.utf8 {
            if u == 61 { padding = true; pads += 1; continue }
            if padding { return false }
            switch u {
            case 65...90, 97...122, 48...57, 43, 47: continue
            default: return false
            }
        }
        return pads <= 2
    }

    /// Strict standard base64 (padding required, canonical only); anything else is `malformed`.
    public static func unb64(_ value: String?, length: Int = -1) throws -> Bytes {
        guard let s = value else { throw P4Error.malformed("not base64") }
        guard s.utf8.count % 4 == 0, isStdB64(s), let out = B64.decode(s) else { throw P4Error.malformed("not base64") }
        if b64(out) != s { throw P4Error.malformed("non-canonical base64") }
        if length >= 0 && out.count != length { throw P4Error.malformed("expected \(length) bytes, got \(out.count)") }
        return out
    }

    public static func unb64(_ value: JSON?, length: Int = -1) throws -> Bytes { try unb64(value?.stringValue, length: length) }

    /// Strict base64url without padding (canonical only).
    public static func unb64url(_ value: String?, length: Int = -1) throws -> Bytes {
        guard let s = value else { throw P4Error.malformed("not base64url") }
        let ok = s.utf8.allSatisfy { u in (65...90).contains(u) || (97...122).contains(u) || (48...57).contains(u) || u == 45 || u == 95 }
        guard ok, s.utf8.count % 4 != 1, let out = B64.decodeURL(s) else { throw P4Error.malformed("not base64url") }
        if b64url(out) != s { throw P4Error.malformed("non-canonical base64url") }
        if length >= 0 && out.count != length { throw P4Error.malformed("expected \(length) bytes, got \(out.count)") }
        return out
    }

    public static func unb64url(_ value: JSON?, length: Int = -1) throws -> Bytes { try unb64url(value?.stringValue, length: length) }

    /* ---------------------------------------------------------- join */

    /// § 0: the text of join(a, b, …) — parts joined with "|".
    public static func joinText(_ parts: [any JoinPart]) throws -> String {
        try parts.map { try $0.joinPart() }.joined(separator: "|")
    }

    public static func joinText(_ parts: any JoinPart...) throws -> String { try joinText(parts) }

    /// § 0: join(a, b, …) — the ASCII bytes of the parts joined with "|".
    public static func join(_ parts: [any JoinPart]) throws -> Bytes { utf8(try joinText(parts)) }

    public static func join(_ parts: any JoinPart...) throws -> Bytes { try join(parts) }

    /* -------------------------------------------------- hash and KDFs */

    public static func H(_ data: Bytes) -> Bytes { Crypto.sha256(data) }

    /// b64(H(x)) — the digest form every transcript uses.
    public static func hB64(_ data: Bytes) -> String { b64(H(data)) }

    public static func hmac(_ key: Bytes, _ data: Bytes) -> Bytes { Crypto.hmac256(key, data) }

    /// RFC 5869 HKDF-SHA-256; `info` is the UTF-8 of the label.
    public static func hkdf(_ salt: Bytes, _ ikm: Bytes, _ info: String, _ length: Int) -> Bytes {
        precondition(length > 0 && length <= 255 * 32, "HKDF length")
        return Crypto.hkdf(ikm, salt, utf8(info), length)
    }

    /// § 5.1 keyIv: HKDF(salt = 32 zero bytes, ikm = mk, info = label, L = 44) → key [0:32], iv [32:44].
    public static func keyIv(_ mk: Bytes, _ label: String) -> (key: Bytes, iv: Bytes) {
        let okm = hkdf(Bytes(repeating: 0, count: 32), mk, label, 44)
        return (Array(okm[0..<32]), Array(okm[32..<44]))
    }

    /* ------------------------------------------------------- AES-GCM */

    /// AES-256-GCM, 12-byte IV, the 16-byte tag appended.
    public static func aesGcmSeal(_ key: Bytes, _ iv: Bytes, _ aad: Bytes, _ plain: Bytes) throws -> Bytes {
        if key.count != 32 { throw P4Error.malformed("AES-256 key must be 32 bytes") }
        if iv.count != 12 { throw P4Error.malformed("IV must be 12 bytes") }
        do { return try Crypto.gcmSeal(key, iv, plain, aad) } catch { throw P4Error.malformed("AES-GCM") }
    }

    /// Inverse of `aesGcmSeal`; any failure is `aead`.
    public static func aesGcmOpen(_ key: Bytes, _ iv: Bytes, _ aad: Bytes, _ sealed: Bytes) throws -> Bytes {
        if key.count != 32 { throw P4Error.malformed("AES-256 key must be 32 bytes") }
        if iv.count != 12 || sealed.count < 16 { throw P4Error("aead", "ciphertext too short") }
        do { return try Crypto.gcmOpen(key, iv, sealed, aad) } catch { throw P4Error("aead", "does not decrypt") }
    }

    /* --------------------------------------------------------- P-256 */

    static let spkiPrefix: Bytes = Hex.decode("3059301306072a8648ce3d020106082a8648ce3d030107034200")!

    /// A peer's P-256 public key (SPKI b64): the canonical uncompressed form
    /// WebCrypto exports, with a point on the curve; anything else is `malformed`.
    public static func p256Public(_ spki: String?) throws -> P256.KeyAgreement.PublicKey {
        let der = try unb64(spki)
        guard der.count == 91, Array(der[0..<26]) == spkiPrefix, der[26] == 0x04 else { throw P4Error.malformed("not a P-256 public key") }
        do { return try P256.KeyAgreement.PublicKey(x963Representation: der[26..<91]) } catch { throw P4Error.malformed("not a P-256 public key") }
    }

    public static func p256Public(_ spki: JSON?) throws -> P256.KeyAgreement.PublicKey { try p256Public(spki?.stringValue) }

    /// Is this a P-256 public key (SPKI b64)?
    public static func isP256Spki(_ spki: String?) -> Bool { (try? p256Public(spki)) != nil }

    /// A fresh P-256 key pair (ECDH and ECDSA use the same scalar).
    public static func generateP256() -> P256Pair { P256Pair(P256.KeyAgreement.PrivateKey()) }

    /// A PKCS#8 (b64) P-256 private key with its public half, as WebCrypto exports both.
    public static func importP256Pkcs8(_ pkcs8: String?) throws -> P256Pair {
        let der = try unb64(pkcs8)
        do { return P256Pair(try P256.KeyAgreement.PrivateKey(derRepresentation: der)) } catch { throw P4Error.malformed("not a P-256 private key") }
    }

    /// ECDH: the 32-byte x-coordinate of the shared point.
    public static func ecdh(_ mine: any KeyAgreer, _ peerSpki: String?) throws -> Bytes { try ecdh(mine, p256Public(peerSpki)) }

    public static func ecdh(_ mine: any KeyAgreer, _ peer: P256.KeyAgreement.PublicKey) throws -> Bytes {
        let out: Bytes
        do { out = try mine.agree(with: peer) } catch { throw P4Error.malformed("ECDH failed") }
        if out.count != 32 { throw P4Error.malformed("ECDH output") }
        return out
    }

    /// ECDSA P-256 / SHA-256, raw r‖s (64 bytes), base64.
    public static func ecdsaSign(_ key: P256Pair, _ data: Bytes) throws -> String {
        do { return b64(Array(try key.signingKey.signature(for: data).rawRepresentation)) } catch { throw P4Error("state", "cannot sign") }
    }

    /// Verifies a raw r‖s signature (b64) with an SPKI (b64) key; never throws.
    public static func ecdsaVerify(_ spki: String?, _ data: Bytes, _ signature: String?) -> Bool {
        guard let sig = try? unb64(signature, length: 64), let pub = try? p256Public(spki) else { return false }
        guard let s = try? P256.Signing.ECDSASignature(rawRepresentation: sig),
              let key = try? P256.Signing.PublicKey(x963Representation: pub.x963Representation) else { return false }
        return key.isValidSignature(s, for: data)
    }

    public static func ecdsaVerify(_ spki: JSON?, _ data: Bytes, _ signature: JSON?) -> Bool {
        ecdsaVerify(spki?.stringValue, data, signature?.stringValue)
    }

    /// A software signer for a key pair.
    public static func signer(_ pair: P256Pair) -> any DeviceSigner { SoftwareSigner(pair) }

    /* ------------------------------------------------------- Ed25519 */

    /// The raw 32-byte Ed25519 public key of a 32-byte seed (RFC 8032).
    public static func ed25519Public(_ seed: Bytes) throws -> Bytes {
        if seed.count != 32 { throw P4Error.malformed("Ed25519 seed must be 32 bytes") }
        return Ed25519Impl.publicKey(seed: seed)
    }

    /// RFC 8032's deterministic signature (64 bytes).
    public static func ed25519Sign(_ seed: Bytes, _ data: Bytes) throws -> Bytes {
        if seed.count != 32 { throw P4Error.malformed("Ed25519 seed must be 32 bytes") }
        return Ed25519Impl.sign(seed: seed, message: data)
    }

    /// Verifies an Ed25519 signature (raw bytes); never throws.
    public static func ed25519Verify(_ publicKey: Bytes, _ data: Bytes, _ signature: Bytes) -> Bool {
        Ed25519Impl.verify(publicKey: publicKey, message: data, signature: signature)
    }

    /// The same with the public key and the signature as strict b64.
    public static func ed25519Verify(_ publicKey: String?, _ data: Bytes, _ signature: String?) -> Bool {
        guard let pub = try? unb64(publicKey, length: 32), let sig = try? unb64(signature, length: 64) else { return false }
        return ed25519Verify(pub, data, sig)
    }
}
