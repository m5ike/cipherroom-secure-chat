// The device's own keys for the server (docs/android-architecture.md § 1.2), in
// the Keyring (Secure Enclave where there is one):
//
//   signing     ECDSA P-256 — signs the requests to /api/ios (X-M5-Signature, P1363)
//               and the enrolment proof: M5Net's `RequestSigner`, M5Crypto's `DeviceSigner`
//   encryption  ECDH P-256 — opens what the server seals to the device (ECIES: push
//               control messages, design bundle keys): M5Crypto's `KeyAgreer`
//               (`Ecies.open(agreement, …)`)
//
// Android keeps the encryption key in software (sealed by the system tier); here
// it is a Secure Enclave key too, usable after the first unlock, in the keychain
// group the notification extension shares (Keyring.sharedAliases). The signing
// key stays in the app's own group.

import CryptoKit
import Foundation
import M5Core
import M5Crypto
import M5Net

/// The device's signing key — the one implementation of M5Net's `RequestSigner` and M5Crypto's
/// `DeviceSigner` over the Keyring (`SecurityCenter.signer()`). The key is made on first use.
struct KeyringSigner: RequestSigner, DeviceSigner {
    let keyring: Keyring
    let alias: String
    /// The public key as SPKI DER, base64 (M5Crypto `DeviceSigner.publicKey`).
    let publicKey: String

    /// Makes the key when missing (after-first-unlock access: background check-ins sign too).
    init(keyring: Keyring, alias: String = "sign") throws {
        self.keyring = keyring
        self.alias = alias
        try keyring.ensureSigningKey(alias, access: .background)
        publicKey = Bytes.b64(try keyring.signingPublicKey(alias).derRepresentation)
    }

    var level: KeyLevel { keyring.level(of: alias) ?? keyring.level }

    /// ECDSA P-256 / SHA-256, IEEE P1363 (r ‖ s, 64 bytes).
    func sign(data: Data) throws -> Data { try keyring.sign(alias, data) }

    // M5Net RequestSigner
    func publicKeySPKI() async throws -> String { publicKey }
    func signP1363(_ data: Data) async throws -> Data { try sign(data: data) }

    // M5Crypto DeviceSigner: P1363, base64
    func sign(_ data: Bytes) throws -> String { Bytes.b64(try sign(data: Data(data))) }
}

/// The device's encryption key — M5Crypto's `KeyAgreer` over the Keyring (`SecurityCenter.agreement()`).
struct KeyringAgreement: KeyAgreer {
    let keyring: Keyring
    let alias: String
    /// The public key as SPKI DER, base64 (enrolment's `encKey`).
    let spki: String

    init(keyring: Keyring, alias: String = "enc") throws {
        self.keyring = keyring
        self.alias = alias
        try keyring.ensureAgreementKey(alias, access: .background)
        spki = Ec.spki(try keyring.agreementPublicKey(alias))
    }

    var level: KeyLevel { keyring.level(of: alias) ?? keyring.level }

    /// ECDH with a peer: the 32-byte x-coordinate.
    func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Bytes { Array(try keyring.agree(alias, with: peer)) }
}
