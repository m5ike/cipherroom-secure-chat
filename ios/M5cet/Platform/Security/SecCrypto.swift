// AES-256-GCM with a key that stays zeroable (SecretBytes → CryptoKit's
// SymmetricKey, never a Swift array): the vault's records, its wrapped keys and
// the file vault's segments. The bytes are M5Crypto's (`Crypto.gcmSeal`: 12-byte
// IV, ciphertext ‖ 16-byte tag; Android security/Crypto) — this is the same
// operation for keys the platform holds in SecretBytes. Every other primitive
// (HKDF, HMAC, PBKDF2, SHA-256, P-256, ECDSA P1363, kid) is M5Crypto's
// `Crypto` / `Ec` / `PinWrap` / `LockBox`.

import CryptoKit
import Foundation
import M5Core
import M5Crypto

enum SecCrypto {
    /// ciphertext ‖ 16-byte tag (Android Crypto.gcmSeal).
    static func gcmSeal(_ key: SymmetricKey, iv: Data, _ plain: Data, aad: Data) throws -> Data {
        let box = try AES.GCM.seal(plain, using: key, nonce: AES.GCM.Nonce(data: iv), authenticating: aad)
        // A fresh Data from index 0 (box.ciphertext is a slice of the box's storage).
        var out = Data(capacity: box.ciphertext.count + 16)
        out.append(contentsOf: box.ciphertext)
        out.append(contentsOf: box.tag)
        return out
    }

    static func gcmSeal(_ key: SecretBytes, iv: Data, _ plain: Data, aad: Data) throws -> Data {
        try gcmSeal(key.symmetricKey(), iv: iv, plain, aad: aad)
    }

    /// Opens ciphertext ‖ tag; throws `.damaged` when it does not authenticate.
    static func gcmOpen(_ key: SymmetricKey, iv: Data, _ ctAndTag: Data, aad: Data) throws -> Data {
        guard iv.count == 12, ctAndTag.count >= 16 else { throw SecurityError.damaged("gcm") }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ctAndTag.dropLast(16), tag: ctAndTag.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: aad)
        } catch {
            throw SecurityError.damaged("gcm")
        }
    }

    static func gcmOpen(_ key: SecretBytes, iv: Data, _ ctAndTag: Data, aad: Data) throws -> Data {
        try gcmOpen(key.symmetricKey(), iv: iv, ctAndTag, aad: aad)
    }

    /// iv ‖ ciphertext ‖ tag with a fresh IV — the shape of the vault's records and wrapped keys.
    static func sealWithIV(_ key: SecretBytes, _ plain: Data, aad: Data) throws -> Data {
        let iv = Bytes.random(12)
        return iv + (try gcmSeal(key, iv: iv, plain, aad: aad))
    }

    static func openWithIV(_ key: SecretBytes, _ sealed: Data, aad: Data) throws -> Data {
        guard sealed.count >= 28 else { throw SecurityError.damaged("short") }
        return try gcmOpen(key, iv: sealed.prefix(12), sealed.dropFirst(12), aad: aad)
    }
}
