// This device's chat identity (client/src/lib/identity.ts; android
// chat/ChatIdentity.java): an ECDSA P-256 key that signs message bodies and
// hellos, and an ECDH P-256 key for the pairwise keys. The public keys travel
// as SPKI base64. The app may hold either key in the Secure Enclave (through
// DeviceSigner / KeyAgreer); software keys are kept in the vault (PKCS#8).

import Foundation
import M5Core

public struct ChatIdentity: Sendable {
    public let publicKey: String
    public let dhPublicKey: String
    public let kid: String
    public let fingerprint: String
    private let signer: any DeviceSigner
    private let dh: any KeyAgreer
    private let softwareSign: P256Pair?
    private let softwareDh: P256Pair?

    public init(signer: any DeviceSigner, dh: any KeyAgreer) {
        self.signer = signer
        self.dh = dh
        publicKey = signer.publicKey
        dhPublicKey = dh.spki
        kid = Ec.kid(publicKey)
        fingerprint = Ec.fingerprint(publicKey)
        softwareSign = (signer as? SoftwareSigner)?.pair
        softwareDh = dh as? P256Pair
    }

    public static func generate() -> ChatIdentity {
        ChatIdentity(signer: SoftwareSigner(Prim.generateP256()), dh: Prim.generateP256())
    }

    public static func fromPkcs8(signPkcs8: String, publicKey: String, dhPkcs8: String, dhPublicKey: String) throws -> ChatIdentity {
        let s = try Ec.privateFromPkcs8(try Crypto.unb64(signPkcs8))
        let d = try Ec.privateFromPkcs8(try Crypto.unb64(dhPkcs8))
        if s.spki != publicKey || d.spki != dhPublicKey { throw CryptoError("the identity's public keys do not match") }
        return ChatIdentity(signer: SoftwareSigner(s), dh: d)
    }

    /// PKCS#8 of the software keys (nil for hardware keys).
    public var signPkcs8: String? { softwareSign?.pkcs8 }
    public var dhPkcs8: String? { softwareDh?.pkcs8 }

    /// P1363 signature, base64 (WebCrypto's form).
    public func sign(_ data: Bytes) throws -> String { try signer.sign(data) }

    public func sharedSecret(_ peerDhPublicKey: String) throws -> Bytes { try dh.agree(with: try Ec.publicFromSpki(peerDhPublicKey)) }

    /// identity.ts safetyNumber: 12 groups of 5 digits from both keys.
    public static func safetyNumber(_ a: String, _ b: String) -> String {
        let first = Ordinal.compare(a, b) <= 0 ? a : b
        let second = Ordinal.compare(a, b) <= 0 ? b : a
        var digest = Crypto.sha512(((try? Crypto.unb64(first)) ?? []) + ((try? Crypto.unb64(second)) ?? []))
        for _ in 0..<1024 { digest = Crypto.sha512(digest) }
        var groups = [String]()
        for i in 0..<12 {
            let n = UInt64(digest[i * 5]) << 24 | UInt64(digest[i * 5 + 1]) << 16 | UInt64(digest[i * 5 + 2]) << 8 | UInt64(digest[i * 5 + 3])
            let s = String(n % 100_000)
            groups.append(String(repeating: "0", count: 5 - s.count) + s)
        }
        return groups.joined(separator: " ")
    }
}
