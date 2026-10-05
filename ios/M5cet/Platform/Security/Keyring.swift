// The keys that never leave the device's secure hardware — Android
// security/Keystore (TEE / StrongBox) on the Secure Enclave:
//
//   sys      key agreement, after first unlock  → wraps the SYS tier's data key (Vault)
//   bio      key agreement, biometryCurrentSet  → wraps the USER tier's data key (Vault)
//   pin      key agreement, when unlocked       → the PIN key: PRF over the stretched PIN (PinWrap v 2)
//   duress   key agreement, when unlocked       → the duress PIN's verifier (DuressPin)
//   ctr.N    key agreement, when unlocked       → seals the attempt counter, one generation at a time (LockStore)
//   sign     signing, after first unlock        → signs requests to the server (DeviceSigner)
//   enc      key agreement, after first unlock  → the device's encryption key (DeviceAgreement: ECIES from the server)
//
// Every key is a Secure Enclave P-256 key (CryptoKit's SecureEnclave.P256 —
// SecKeyCreateRandomKey with kSecAttrTokenIDSecureEnclave underneath). Its
// `dataRepresentation` is the key encrypted by the Secure Enclave, usable only
// by this device's Secure Enclave; that blob is kept as a Keychain item
// (SecureStore, ThisDeviceOnly). Deleting the item deletes the key.
//
// The Secure Enclave can sign and agree (ECDH) but has no HMAC, which Android's
// PIN key, duress key and counter keys are. The PRF that replaces them:
//
//   prf(alias, x) = HMAC-SHA256(key: ECDH(d_alias, H(x)), x)      H = EcP256.hashToCurve
//
// d_alias never leaves the Secure Enclave and H(x) is a point nobody knows the
// discrete logarithm of, so ECDH(d, H(x)) — and the PRF — cannot be computed
// for any x without asking this device's Secure Enclave, once per x (an
// oblivious-PRF-style use of the enclave). Guessing a PIN offline therefore
// needs the device, as Android's HMAC key in the TEE. See README "PIN key".
//
// Without a Secure Enclave the same keys are software P-256 keys in the
// Keychain — level "software", shown as such, as Android's "software only".

import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum KeyLevel: String, Sendable {
    case secureEnclave = "secure-enclave"
    case software
}

/// When a key may be used.
enum KeyAccess: Sendable {
    /// After the first unlock since boot (background work, the notification extension).
    case background
    /// While the device is unlocked.
    case foreground
    /// A biometric per use, invalidated by a changed enrolment (Android setInvalidatedByBiometricEnrollment).
    case biometry
}

/// Makes and uses P-256 keys of one kind. The blob is what is stored: the Secure
/// Enclave's encrypted key, or the raw scalar of a software key.
protocol KeyMaker: Sendable {
    var level: KeyLevel { get }
    func newAgreementKey(_ access: KeyAccess) throws -> Data
    func agreementPublicKey(_ blob: Data) throws -> P256.KeyAgreement.PublicKey
    /// The raw ECDH x-coordinate. `context`: an evaluated LAContext for a biometric key.
    func agree(_ blob: Data, with peer: P256.KeyAgreement.PublicKey, context: LAContext?) throws -> Data
    func newSigningKey(_ access: KeyAccess) throws -> Data
    func signingPublicKey(_ blob: Data) throws -> P256.Signing.PublicKey
    /// ECDSA P-256 / SHA-256, IEEE P1363 (r ‖ s).
    func sign(_ blob: Data, _ data: Data) throws -> Data
}

struct EnclaveKeyMaker: KeyMaker {
    var level: KeyLevel { .secureEnclave }

    static var available: Bool { SecureEnclave.isAvailable }

    static func accessControl(_ access: KeyAccess) throws -> SecAccessControl {
        let (protection, flags): (CFString, SecAccessControlCreateFlags) = switch access {
        case .background: (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, [.privateKeyUsage])
        case .foreground: (kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage])
        case .biometry: (kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet])
        }
        var error: Unmanaged<CFError>?
        guard let ac = SecAccessControlCreateWithFlags(nil, protection, flags, &error) else {
            throw SecurityError.unavailable("access control")
        }
        return ac
    }

    func newAgreementKey(_ access: KeyAccess) throws -> Data {
        do { return try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: Self.accessControl(access)).dataRepresentation }
        catch let e as SecurityError { throw e }
        catch { throw SecurityError.unavailable("secure enclave key") }
    }

    func agreementPublicKey(_ blob: Data) throws -> P256.KeyAgreement.PublicKey {
        do { return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob).publicKey }
        catch { throw SecurityError.damaged("secure enclave key") }
    }

    func agree(_ blob: Data, with peer: P256.KeyAgreement.PublicKey, context: LAContext?) throws -> Data {
        do {
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
            return try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        } catch let e as LAError where e.code == .userCancel || e.code == .appCancel || e.code == .systemCancel || e.code == .userFallback {
            throw SecurityError.cancelled
        } catch {
            throw SecurityError.damaged("secure enclave agreement")
        }
    }

    func newSigningKey(_ access: KeyAccess) throws -> Data {
        do { return try SecureEnclave.P256.Signing.PrivateKey(accessControl: Self.accessControl(access)).dataRepresentation }
        catch { throw SecurityError.unavailable("secure enclave key") }
    }

    func signingPublicKey(_ blob: Data) throws -> P256.Signing.PublicKey {
        do { return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob).publicKey }
        catch { throw SecurityError.damaged("secure enclave key") }
    }

    func sign(_ blob: Data, _ data: Data) throws -> Data {
        do { return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob).signature(for: data).rawRepresentation }
        catch { throw SecurityError.damaged("secure enclave signature") }
    }
}

/// Software P-256 (no Secure Enclave): the scalar is the blob, kept in the Keychain.
struct SoftwareKeyMaker: KeyMaker {
    var level: KeyLevel { .software }

    func newAgreementKey(_ access: KeyAccess) throws -> Data { P256.KeyAgreement.PrivateKey().rawRepresentation }

    func agreementPublicKey(_ blob: Data) throws -> P256.KeyAgreement.PublicKey {
        do { return try P256.KeyAgreement.PrivateKey(rawRepresentation: blob).publicKey } catch { throw SecurityError.damaged("software key") }
    }

    func agree(_ blob: Data, with peer: P256.KeyAgreement.PublicKey, context: LAContext?) throws -> Data {
        do { return try EcP256.ecdh(P256.KeyAgreement.PrivateKey(rawRepresentation: blob), peer) } catch { throw SecurityError.damaged("software agreement") }
    }

    func newSigningKey(_ access: KeyAccess) throws -> Data { P256.Signing.PrivateKey().rawRepresentation }

    func signingPublicKey(_ blob: Data) throws -> P256.Signing.PublicKey {
        do { return try P256.Signing.PrivateKey(rawRepresentation: blob).publicKey } catch { throw SecurityError.damaged("software key") }
    }

    func sign(_ blob: Data, _ data: Data) throws -> Data {
        do { return try P256.Signing.PrivateKey(rawRepresentation: blob).signature(for: data).rawRepresentation }
        catch { throw SecurityError.damaged("software signature") }
    }
}

/// The named keys (Android Keystore's aliases) in a SecureStore, made by the Secure Enclave
/// where there is one. Thread-safe.
final class Keyring: @unchecked Sendable {
    let store: SecureStore
    private let enclave: (any KeyMaker)?
    private let software: any KeyMaker
    /// Biometric keys in software where the Secure Enclave cannot make them (the simulator only).
    private let softwareBiometry: Bool
    private let lock = NSLock()

    static let prefix = "key."
    static let counterPrefix = "ctr."

    /// The keys made from now on: in the Secure Enclave when `enclave` is given.
    init(store: SecureStore, enclave: (any KeyMaker)?, software: any KeyMaker = SoftwareKeyMaker(), softwareBiometry: Bool = false) {
        self.store = store
        self.enclave = enclave
        self.software = software
        self.softwareBiometry = softwareBiometry
    }

    /// This device: the Secure Enclave when available; software biometric keys only in the simulator.
    static func system(store: SecureStore) -> Keyring {
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        return Keyring(store: store, enclave: EnclaveKeyMaker.available ? EnclaveKeyMaker() : nil, softwareBiometry: simulator)
    }

    /// Where new keys are made.
    var level: KeyLevel { enclave?.level ?? software.level }

    // MARK: storage: a level byte, then the maker's blob

    private enum Tag: UInt8 { case enclave = 1, software = 2 }

    private func item(_ alias: String) -> String { Self.prefix + alias }

    private func load(_ alias: String) throws -> (any KeyMaker, Data)? {
        guard let raw = try store.read(item(alias)), raw.count > 1 else { return nil }
        let blob = Bytes.fresh(raw.dropFirst())
        switch Tag(rawValue: raw[raw.startIndex]) {
        case .enclave:
            guard let enclave else { throw SecurityError.unavailable("secure enclave") }
            return (enclave, blob)
        case .software: return (software, blob)
        case nil: throw SecurityError.damaged("key \(alias)")
        }
    }

    private func save(_ alias: String, maker: any KeyMaker, blob: Data, access: KeyAccess) throws {
        let tag: Tag = maker.level == .secureEnclave ? .enclave : .software
        try store.write(item(alias), Data([tag.rawValue]) + blob, access: access == .background ? .background : .foreground)
    }

    /// The level of an existing key (nil: none).
    func level(of alias: String) -> KeyLevel? {
        (try? load(alias))?.0.level
    }

    func has(_ alias: String) -> Bool { (try? store.read(item(alias))) != nil }

    func delete(_ alias: String) { store.delete(item(alias)) }

    // MARK: key agreement and the PRF

    /// Makes the key when missing; returns its level. Never replaces an existing key.
    @discardableResult
    func ensureAgreementKey(_ alias: String, access: KeyAccess) throws -> KeyLevel {
        try lock.withLock {
            if let (maker, _) = try load(alias) { return maker.level }
            var maker = try makerFor(access)
            let blob: Data
            do {
                blob = try maker.newAgreementKey(access)
            } catch {
                // The simulator's Secure Enclave makes no biometric keys: a software one, gated by the prompt only.
                guard access == .biometry, softwareBiometry, maker.level == .secureEnclave else { throw error }
                maker = software
                blob = try software.newAgreementKey(access)
            }
            try save(alias, maker: maker, blob: blob, access: access)
            return maker.level
        }
    }

    /// A new key replacing any old one (the biometric key at enrolment).
    @discardableResult
    func replaceAgreementKey(_ alias: String, access: KeyAccess) throws -> KeyLevel {
        lock.withLock { store.delete(item(alias)) }
        return try ensureAgreementKey(alias, access: access)
    }

    private func makerFor(_ access: KeyAccess) throws -> any KeyMaker {
        if let enclave { return enclave }
        return software
    }

    func agreementPublicKey(_ alias: String) throws -> P256.KeyAgreement.PublicKey {
        guard let (maker, blob) = try load(alias) else { throw SecurityError.noKey(alias) }
        return try maker.agreementPublicKey(blob)
    }

    /// Raw ECDH of the named key with a peer key.
    func agree(_ alias: String, with peer: P256.KeyAgreement.PublicKey, context: LAContext? = nil) throws -> Data {
        guard let (maker, blob) = try load(alias) else { throw SecurityError.noKey(alias) }
        return try maker.agree(blob, with: peer, context: context)
    }

    /// prf(alias, x) = HMAC-SHA256(ECDH(d_alias, hashToCurve(x)), x) — the hardware HMAC of Android's Keystore.hmacBy.
    func prf(_ alias: String, _ input: Data) throws -> Data {
        var shared = try agree(alias, with: EcP256.hashToCurve(input))
        defer { Bytes.wipe(&shared) }
        return SecCrypto.hmac(key: shared, input)
    }

    // MARK: signing

    @discardableResult
    func ensureSigningKey(_ alias: String, access: KeyAccess) throws -> KeyLevel {
        try lock.withLock {
            if let (maker, _) = try load(alias) { return maker.level }
            let maker = try makerFor(access)
            try save(alias, maker: maker, blob: try maker.newSigningKey(access), access: access)
            return maker.level
        }
    }

    func signingPublicKey(_ alias: String) throws -> P256.Signing.PublicKey {
        guard let (maker, blob) = try load(alias) else { throw SecurityError.noKey(alias) }
        return try maker.signingPublicKey(blob)
    }

    func sign(_ alias: String, _ data: Data) throws -> Data {
        guard let (maker, blob) = try load(alias) else { throw SecurityError.noKey(alias) }
        return try maker.sign(blob, data)
    }

    // MARK: the attempt counter's generations (LockStore.Anchor)

    /// The generations whose keys exist; nil when the store cannot be read now.
    func counterGenerations() -> Set<Int64>? {
        guard let names = try? store.names() else { return nil }
        let p = Self.prefix + Self.counterPrefix
        return Set(names.filter { $0.hasPrefix(p) }.compactMap { Int64($0.dropFirst(p.count)) })
    }

    func newCounterKey(_ gen: Int64) -> Bool {
        (try? replaceAgreementKey(Self.counterPrefix + String(gen), access: .foreground)) != nil
    }

    // MARK: the wipe

    /// Every key of this keyring (Android Keystore.deleteAll).
    func deleteAll() {
        lock.withLock {
            for name in (try? store.names()) ?? [] where name.hasPrefix(Self.prefix) { store.delete(name) }
        }
    }
}
