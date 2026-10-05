// P-256 keys as the web client and the server use them (android
// security/Ec.java): public keys travel as SPKI (base64), signatures are
// ECDSA/SHA-256 in IEEE P1363 form (r‖s, 64 bytes) — WebCrypto's shape —
// while DER is what some platforms speak; this converts. ECDH gives the raw
// 32-byte x-coordinate.

import CryptoKit
import Foundation
import M5Core

public enum Ec {
    /// Any P-256 SPKI (DER) → the public key; throws for another curve or a bad point.
    public static func publicFromSpki(_ spki: Bytes) throws -> P256.KeyAgreement.PublicKey {
        do { return try P256.KeyAgreement.PublicKey(derRepresentation: spki) } catch { throw CryptoError("not a P-256 key") }
    }

    public static func publicFromSpki(_ spkiB64: String) throws -> P256.KeyAgreement.PublicKey {
        try publicFromSpki(try Crypto.unb64(spkiB64))
    }

    public static func privateFromPkcs8(_ pkcs8: Bytes) throws -> P256Pair {
        do { return P256Pair(try P256.KeyAgreement.PrivateKey(derRepresentation: pkcs8)) } catch { throw CryptoError("not a P-256 private key") }
    }

    public static func generate() -> P256Pair { Prim.generateP256() }

    public static func spki(_ key: P256.KeyAgreement.PublicKey) -> String { Crypto.b64(Array(key.derRepresentation)) }

    /// base64url(SHA-256(SPKI))[0..16] — identity.ts keyId, the server's kid.
    public static func kid(_ spkiB64: String) -> String {
        String(Crypto.b64url(Crypto.sha256((try? Crypto.unb64(spkiB64)) ?? [])).prefix(16))
    }

    /// Grouped hex of the first 16 bytes of SHA-256(SPKI), upper case.
    public static func fingerprint(_ spkiB64: String) -> String {
        let h = Crypto.hex(Array(Crypto.sha256((try? Crypto.unb64(spkiB64)) ?? []).prefix(16))).uppercased()
        var groups = [String]()
        var i = h.startIndex
        while i < h.endIndex {
            let j = h.index(i, offsetBy: 4, limitedBy: h.endIndex) ?? h.endIndex
            groups.append(String(h[i..<j]))
            i = j
        }
        return groups.joined(separator: " ")
    }

    public static func ecdh(_ mine: any KeyAgreer, _ theirs: P256.KeyAgreement.PublicKey) throws -> Bytes { try mine.agree(with: theirs) }

    /// Signs and returns P1363 (r‖s).
    public static func sign(_ key: P256Pair, _ data: Bytes) throws -> Bytes {
        Array(try key.signingKey.signature(for: data).rawRepresentation)
    }

    public static func verify(_ key: P256.KeyAgreement.PublicKey, _ data: Bytes, _ p1363: Bytes) -> Bool {
        guard p1363.count == 64, let s = try? P256.Signing.ECDSASignature(rawRepresentation: p1363),
              let k = try? P256.Signing.PublicKey(x963Representation: key.x963Representation) else { return false }
        return k.isValidSignature(s, for: data)
    }

    /// Verifies a P1363 signature (b64) with an SPKI (b64) key; never throws.
    public static func verify(_ spkiB64: String?, _ data: Bytes, _ sigB64: String?) -> Bool {
        guard let spkiB64, let sigB64, let key = try? publicFromSpki(spkiB64), let sig = B64.decode(sigB64) else { return false }
        return verify(key, data, sig)
    }

    /// DER SEQUENCE { INTEGER r, INTEGER s } → r‖s (32 + 32 bytes).
    public static func derToP1363(_ der: Bytes) throws -> Bytes {
        var at = 0
        func byte() throws -> UInt8 {
            guard at < der.count else { throw CryptoError("bad DER signature") }
            defer { at += 1 }
            return der[at]
        }
        if try byte() != 0x30 { throw CryptoError("bad DER signature") }
        let len = Int(try byte())
        if len > 0x80 { at += len - 0x80 }
        var out = Bytes(repeating: 0, count: 64)
        for k in 0..<2 {
            if try byte() != 0x02 { throw CryptoError("bad DER signature") }
            let n = Int(try byte())
            guard at + n <= der.count else { throw CryptoError("bad DER signature") }
            var v = Array(der[at..<at + n])
            at += n
            while v.count > 1 && v[0] == 0 { v.removeFirst() }
            if v.count > 32 { throw CryptoError("bad DER signature") }
            for (i, b) in v.enumerated() { out[k * 32 + 32 - v.count + i] = b }
        }
        return out
    }

    /// r‖s → DER (minimal integers, a leading 0 when the top bit is set).
    public static func p1363ToDer(_ sig: Bytes) -> Bytes {
        func integer(_ unsigned: ArraySlice<UInt8>) -> Bytes {
            var v = Array(unsigned)
            while v.count > 1 && v[0] == 0 { v.removeFirst() }
            if v[0] & 0x80 != 0 { v.insert(0, at: 0) }
            return [0x02, UInt8(v.count)] + v
        }
        let r = integer(sig[0..<32]), s = integer(sig[32..<64])
        return [0x30, UInt8(r.count + s.count)] + r + s
    }
}

/// ECIES from the server to this device (docs/android-architecture.md § 1.3;
/// android security/Ecies.java): an ephemeral P-256 key, ECDH with the device's
/// encryption key, HKDF-SHA256 (salt "m5cet/android/ecies/1", info
/// purpose|deviceId), AES-256-GCM with "m5cet/android/ecies/1|purpose|deviceId"
/// as associated data. Control messages (purpose "push") and design bundle
/// content keys (purpose "bundle|<id>").
public enum Ecies {
    public static let label = "m5cet/android/ecies/1"

    public struct Wire: Sendable, Equatable {
        public let e: String, iv: String, ct: String
        public init(e: String, iv: String, ct: String) { self.e = e; self.iv = iv; self.ct = ct }
    }

    private static func key(_ shared: Bytes, _ purpose: String, _ deviceId: String) -> Bytes {
        Crypto.hkdf(shared, Crypto.utf8(label), Crypto.utf8(purpose + "|" + deviceId), 32)
    }

    /// Opens what the server sealed to this device's encryption key (a Secure Enclave key in the app).
    public static func open(_ device: any KeyAgreer, deviceId: String, purpose: String, _ w: Wire) throws -> Bytes {
        let shared = try device.agree(with: try Ec.publicFromSpki(w.e))
        let k = key(shared, purpose, deviceId)
        return try Crypto.gcmOpen(k, try Crypto.unb64(w.iv), try Crypto.unb64(w.ct), Crypto.utf8(label + "|" + purpose + "|" + deviceId))
    }

    /// The server's side; the app uses it in tests and for its own sealed notes.
    public static func seal(deviceEncSpki: String, deviceId: String, purpose: String, _ plain: Bytes) throws -> Wire {
        let eph = Prim.generateP256()
        let shared = try eph.agree(with: try Ec.publicFromSpki(deviceEncSpki))
        let k = key(shared, purpose, deviceId)
        let iv = Crypto.random(12)
        let ct = try Crypto.gcmSeal(k, iv, plain, Crypto.utf8(label + "|" + purpose + "|" + deviceId))
        return Wire(e: eph.spki, iv: Crypto.b64(iv), ct: Crypto.b64(ct))
    }
}
