// The device's keys and storage as M5Net and M5Design want them, over
// Platform/Security (Android: net/Server's Keystore.signKey, Config.encPrivateKey,
// the vault's system tier):
//
//   DeviceKeys              the Keyring's signing and encryption keys, made on first use (KeyringSigner,
//                           KeyringAgreement — Secure Enclave where there is one)
//   DeviceRequestSigner     M5Net RequestSigner   — the signing key (X-M5-Signature, the enrolment proof)
//   KeyringEciesOpener      M5Net EciesOpener     — ECIES with the encryption key (push, bundle keys), also synchronous
//   DeviceBundleCrypto      M5Design BundleCrypto — the same key for design bundles, CryptoKit for the rest
//   VaultNetStateStore      M5Net NetStateStore   — JSON records of the SYS tier (readable while locked, and by
//                                                   the notification extension): "config", "seen", "events", …

import CryptoKit
import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net

/// The device's two keys in the Keyring (SecurityCenter.signer() / .agreement() without the main actor):
/// each use reads the key, so a key the system cannot reach yet (before the first unlock) fails that use only.
struct DeviceKeys: Sendable {
    let keyring: Keyring
    func signer() throws -> KeyringSigner { try KeyringSigner(keyring: keyring) }
    func agreement() throws -> KeyringAgreement { try KeyringAgreement(keyring: keyring) }
}

/// M5Net's request signer over the device's signing key, made when first used.
struct DeviceRequestSigner: RequestSigner {
    let keys: DeviceKeys
    func publicKeySPKI() async throws -> String { try await keys.signer().publicKeySPKI() }
    func signP1363(_ data: Data) async throws -> Data { try keys.signer().sign(data: data) }
}

/// ECIES (server/mobile/crypto.ts eciesSeal) opened with the device's encryption key — synchronously
/// (PushKit and the bundle checks cannot await) and as M5Net's EciesOpener.
struct KeyringEciesOpener: EciesOpener {
    /// The encryption key (M5Crypto KeyAgreer: the Keyring's, a software pair in tests).
    let agreement: @Sendable () throws -> any KeyAgreer

    init(agreement: @escaping @Sendable () throws -> any KeyAgreer) { self.agreement = agreement }
    init(agreement: any KeyAgreer) { self.agreement = { agreement } }

    /// Raw ECDH with a peer key (the 32-byte x).
    var agree: @Sendable (P256.KeyAgreement.PublicKey) throws -> Data {
        let a = agreement
        return { peer in Data(try a().agree(with: peer)) }
    }

    func publicKeySPKI() async throws -> String { try agreement().spki }

    func open(_ wire: EciesEnvelope, deviceId: String, purpose: String) async throws -> Data {
        try openNow(e: wire.e, iv: wire.iv, ct: wire.ct, deviceId: deviceId, purpose: purpose)
    }

    func openNow(e: String, iv: String, ct: String, deviceId: String, purpose: String) throws -> Data {
        try PushOpener.eciesOpen(e: e, iv: iv, ct: ct, deviceId: deviceId, purpose: purpose, agree: agree)
    }
}

/// M5Design's bundle cryptography: the device's encryption key for the content key, CryptoKit for the rest.
struct DeviceBundleCrypto: BundleCrypto {
    let opener: KeyringEciesOpener

    func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    func verifyP1363(publicKeySpki: Data, message: Data, signature: Data) -> Bool {
        guard let key = try? P256.Signing.PublicKey(derRepresentation: publicKeySpki), signature.count == 64,
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(sig, for: message)
    }

    func eciesOpen(deviceId: String, purpose: String, wire: EciesWire) throws -> Data {
        try opener.openNow(e: wire.e, iv: wire.iv, ct: wire.ct, deviceId: deviceId, purpose: purpose)
    }

    func aesGcmOpen(key: Data, iv: Data, ciphertextAndTag: Data, aad: Data) throws -> Data {
        guard ciphertextAndTag.count >= 16 else { throw BundleError("a bundle segment does not authenticate") }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ciphertextAndTag.dropLast(16), tag: ciphertextAndTag.suffix(16))
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }
}

/// M5Net's documents in the vault's SYS tier (Android: the system tier's JSON records). "config" is written
/// durably (the enrolment and the pinned key must survive a crash right after).
/// A NetStateStore that also answers synchronously (the event queue, the extension's records, PushKit).
protocol SyncStateStore: NetStateStore {
    func loadNow(_ key: String) -> NetJSON?
    func saveNow(_ key: String, _ value: NetJSON?)
}

/// In memory (tests, previews).
final class MemorySyncStateStore: SyncStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var docs: [String: NetJSON] = [:]
    init(_ docs: [String: NetJSON] = [:]) { self.docs = docs }
    func load(_ key: String) async -> NetJSON? { loadNow(key) }
    func save(_ key: String, _ value: NetJSON?) async { saveNow(key, value) }
    func loadNow(_ key: String) -> NetJSON? { lock.withLock { docs[key] } }
    func saveNow(_ key: String, _ value: NetJSON?) { lock.withLock { docs[key] = value } }
    var all: [String: NetJSON] { lock.withLock { docs } }
}

struct VaultNetStateStore: SyncStateStore {
    let vault: Vault
    static let durable: Set<String> = ["config", "bundles"]

    func load(_ key: String) async -> NetJSON? { loadNow(key) }

    func save(_ key: String, _ value: NetJSON?) async { saveNow(key, value) }

    func loadNow(_ key: String) -> NetJSON? {
        guard let d = try? vault.get(.sys, key) else { return nil }
        return try? NetJSON.parse(d)
    }

    func saveNow(_ key: String, _ value: NetJSON?) {
        guard let value else { vault.delete(.sys, key); return }
        try? vault.put(.sys, key, value.data, durable: Self.durable.contains(key))
    }
}

extension NetJSON {
    /// The same value as a JSONSerialization dictionary (the security code's records, userInfo, payloads).
    var foundation: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }

    /// A JSONSerialization value as NetJSON (nil when it is not JSON).
    static func from(_ value: Any) -> NetJSON? {
        guard JSONSerialization.isValidJSONObject(value), let d = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? NetJSON.parse(d)
    }
}
