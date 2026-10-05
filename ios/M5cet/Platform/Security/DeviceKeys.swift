// The device's own keys for the server (docs/android-architecture.md § 1.2):
//
//   signing     ECDSA P-256 in the Secure Enclave — signs the requests to /api/ios
//               (X-M5-Signature, P1363) and the enrolment proof
//   encryption  ECDH P-256 in the Secure Enclave — opens what the server seals to
//               the device (ECIES: push control messages, design bundle keys)
//
// Android keeps the encryption key in software (sealed by the system tier); here
// it is a Secure Enclave key too, usable after the first unlock (push wake-ups,
// the notification extension). M5Net builds the signed strings and the ECIES
// layers on these protocols.

import CryptoKit
import Foundation

/// Signs requests to the server with the device's key — implemented by Platform/Security, used by M5Net.
protocol DeviceSigner: Sendable {
    /// The public key as SPKI (base64) — enrolment's `signKey`.
    func publicKeySPKI() throws -> String
    /// ECDSA P-256 / SHA-256 over `data`, IEEE P1363 form (r ‖ s, 64 bytes) — WebCrypto's shape, what the server verifies.
    func sign(_ data: Data) throws -> Data
    /// Where the key lives ("secure-enclave" / "software").
    var level: KeyLevel { get }
}

/// The device's encryption key: raw ECDH for ECIES from the server (Android Ecies.open's shared secret).
protocol DeviceAgreement: Sendable {
    /// The public key as SPKI (base64) — enrolment's `encKey`.
    func publicKeySPKI() throws -> String
    /// The raw 32-byte ECDH x-coordinate with a peer's (ephemeral) public key given as SPKI (base64).
    func sharedSecret(withSPKI spki: String) throws -> Data
    var level: KeyLevel { get }
}

struct KeyringSigner: DeviceSigner {
    let keyring: Keyring
    var alias = "sign"

    var level: KeyLevel { keyring.level(of: alias) ?? keyring.level }

    func publicKeySPKI() throws -> String {
        try keyring.ensureSigningKey(alias, access: .background)
        return EcP256.spki(try keyring.signingPublicKey(alias))
    }

    func sign(_ data: Data) throws -> Data {
        try keyring.ensureSigningKey(alias, access: .background)
        return try keyring.sign(alias, data)
    }
}

struct KeyringAgreement: DeviceAgreement {
    let keyring: Keyring
    var alias = "enc"

    var level: KeyLevel { keyring.level(of: alias) ?? keyring.level }

    func publicKeySPKI() throws -> String {
        try keyring.ensureAgreementKey(alias, access: .background)
        return EcP256.spki(try keyring.agreementPublicKey(alias))
    }

    func sharedSecret(withSPKI spki: String) throws -> Data {
        try keyring.ensureAgreementKey(alias, access: .background)
        return try keyring.agree(alias, with: EcP256.publicKey(spki: spki))
    }
}
