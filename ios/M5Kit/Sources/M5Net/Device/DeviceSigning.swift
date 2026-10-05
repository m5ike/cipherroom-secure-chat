// The device API's signatures (server/android/crypto.ts, Android net/Server
// and security/Ec): ECDSA P-256 / SHA-256 in IEEE P1363 form (r ‖ s, 64 bytes,
// base64), public keys as SPKI DER (base64). The strings below are signed
// byte for byte as the server builds them — a request signed here verifies
// there (Tests/M5NetTests/fixtures: vectors made by the server's own code).
//
// The private key never has to be in this process: RequestSigner is what the
// app implements over the Secure Enclave (SecureEnclaveRequestSigner below),
// a software key is for tests and the simulator.

import CryptoKit
import Foundation
import M5Core
import M5Crypto

/* ------------------------------------------------------------ the signer */

/// The device's signing key (Android: Keystore.signKey). P-256; signs requests, the enrolment proof.
public protocol RequestSigner: Sendable {
    /// The public key as SPKI DER, base64 (what /enroll registers as `signKey`).
    func publicKeySPKI() async throws -> String
    /// ECDSA P-256 / SHA-256 over `data`, IEEE P1363 (r ‖ s, 64 bytes).
    func signP1363(_ data: Data) async throws -> Data
}

/// A P-256 key in this process (CryptoKit) — tests, the simulator, or a key the app keeps itself.
public struct SoftwareRequestSigner: RequestSigner {
    public let key: P256.Signing.PrivateKey
    public init(key: P256.Signing.PrivateKey = .init()) { self.key = key }
    /// From PKCS#8 or SEC1 DER (base64), e.g. the vectors' `devicePkcs8`.
    public init(derBase64: String) throws {
        guard let der = Bytes.unb64(derBase64) else { throw NetError.invalid("not base64") }
        key = try P256.Signing.PrivateKey(derRepresentation: der)
    }
    public func publicKeySPKI() async throws -> String { Bytes.b64(key.publicKey.derRepresentation) }
    public func signP1363(_ data: Data) async throws -> Data { try key.signature(for: data).rawRepresentation }
}

/// A key in the Secure Enclave: `dataRepresentation` is the enclave's handle (kept in the Keychain by the app).
public struct SecureEnclaveRequestSigner: RequestSigner {
    public let key: SecureEnclave.P256.Signing.PrivateKey
    public init(key: SecureEnclave.P256.Signing.PrivateKey) { self.key = key }
    public init(dataRepresentation: Data) throws { key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation) }
    public static var isAvailable: Bool { SecureEnclave.isAvailable }
    public func publicKeySPKI() async throws -> String { Bytes.b64(key.publicKey.derRepresentation) }
    public func signP1363(_ data: Data) async throws -> Data { try key.signature(for: data).rawRepresentation }
}

/* ----------------------------------------------------------- verification */

/// P-256 public keys and signatures as the server sends them.
public enum P256Keys {
    /// The key of an SPKI (base64), or nil when it is not a P-256 public key.
    public static func publicKey(spki: String) -> P256.Signing.PublicKey? {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return try? P256.Signing.PublicKey(derRepresentation: der)
    }

    /// Is `signature` (P1363, base64) by the key of `spki` over `data`? Never throws.
    public static func verify(spki: String, data: Data, signature: String) -> Bool {
        guard let key = publicKey(spki: spki), let raw = Bytes.unb64(signature), raw.count == 64,
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw) else { return false }
        return key.isValidSignature(sig, for: data)
    }

    public static func verify(spki: String, text: String, signature: String) -> Bool {
        verify(spki: spki, data: Data(text.utf8), signature: signature)
    }

    /// Short stable id of a public key: base64url(SHA-256(SPKI))[0..16] (crypto.ts kidOf, Ec.kid).
    public static func kid(spki: String) -> String {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return "" }
        return String(Bytes.b64url(Bytes.sha256(der)).prefix(16))
    }

    /// Grouped hex of the key hash for a person to compare: "ABCD EF01 …" (first 16 bytes; crypto.ts fingerprintOf).
    public static func fingerprint(spki: String) -> String {
        guard let der = Bytes.unb64(spki.trimmingCharacters(in: .whitespacesAndNewlines)) else { return "" }
        let hex = Bytes.hex(Bytes.sha256(der).prefix(16)).uppercased()
        var groups: [String] = []
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 4)
            groups.append(String(hex[i..<j]))
            i = j
        }
        return groups.joined(separator: " ")
    }
}

/* ------------------------------------------------------- signed strings */

/// The strings the device API signs (server/android/crypto.ts — byte for byte).
public enum DeviceSigning {
    /// The label of a signed request. The iOS API (/api/ios) verifies the same string as Android's.
    public static let requestLabel = "m5android/1"
    public static let enrollLabel = "m5android/enroll/1"

    /// label|METHOD|path?query|time|nonce|b64(sha256(body)) — `pathAndQuery` as the server sees `originalUrl`.
    public static func requestString(label: String = requestLabel, method: String, pathAndQuery: String, time: String, nonce: String, body: Data) -> String {
        [label, method.uppercased(), pathAndQuery, time, nonce, Bytes.b64(Bytes.sha256(body))].joined(separator: "|")
    }

    /// m5android/enroll/1|signKey|encKey|time — the enrolment's proof of holding the signing key.
    public static func enrollString(label: String = enrollLabel, signKey: String, encKey: String, time: Millis) -> String {
        [label, signKey, encKey, String(time)].joined(separator: "|")
    }

    /// m5push/1|deviceId|id|e|iv|ct — the server's signature over a control message.
    public static func pushString(deviceId: String, id: String, e: String, iv: String, ct: String) -> String {
        ["m5push/1", deviceId, id, e, iv, ct].joined(separator: "|")
    }

    /// m5policy/1|deviceId|at|policyJson — the device policy signed for one device (F-16).
    public static func policyString(deviceId: String, at: Millis, policyJson: String) -> String {
        ["m5policy/1", deviceId, String(at), policyJson].joined(separator: "|")
    }

    /// The headers of a signed request (X-M5-Device, X-M5-Time, X-M5-Nonce, X-M5-Signature).
    /// `nonce`: 16 random bytes, base64url — pass one only in tests.
    public static func headers(deviceId: String, method: String, pathAndQuery: String, body: Data, time: Millis,
                               signer: any RequestSigner, label: String = requestLabel, nonce: String? = nil) async throws -> [String: String] {
        let n = nonce ?? Bytes.b64url(Bytes.random(16))
        let t = String(time)
        let sig = try await signer.signP1363(Data(requestString(label: label, method: method, pathAndQuery: pathAndQuery, time: t, nonce: n, body: body).utf8))
        return ["X-M5-Device": deviceId, "X-M5-Time": t, "X-M5-Nonce": n, "X-M5-Signature": Bytes.b64(sig)]
    }
}
