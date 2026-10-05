// The two key tiers of all local data (Android security/Vault,
// docs/android-architecture.md § 2):
//
//   SYS   DEK_sys, wrapped to the Secure Enclave key "sys" (no user needed, after the
//         first unlock): server settings, policy, device records, events, bundles,
//         the duress verifier — readable in the background (pushes) and by the
//         notification extension (App Group), never outside this device.
//         sys.key = {v: 1, hw, e, iv, ct}: e = an ephemeral P-256 key (SPKI),
//         K = HKDF-SHA256(ECDH(sys, e), salt "m5/ios/sys.key/1", info e), AES-256-GCM, AAD "m5/sys.key".
//   USER  DEK_user, wrapped twice (app container only, never the App Group):
//         user.pin  PinWrap v 2 — KEK = PRF_pin("m5/pin/2|" ‖ PBKDF2-SHA256(PIN, salt, 210 000))
//         user.bio  {v: 1, hw, e, iv, ct} to the Secure Enclave key "bio" (biometryCurrentSet:
//                   every use needs a biometric, a new enrolment invalidates it),
//                   salt "m5/ios/user.bio/1", AAD "m5/user.bio"
//         Rooms, passphrases, messages, identities, files. Only after unlock; a lock
//         forgets it (lock() zeroes it), unlocking derives it again (6.12, F-16).
//
// Records: <tier dir>/<name>.bin = iv ‖ AES-256-GCM(DEK, plain, AAD "SYS|name" / "USER|name") —
// Android's AAD, so a file cannot be swapped for another.

import CryptoKit
import Foundation
import LocalAuthentication

enum VaultTier: String, Sendable {
    case sys = "SYS"
    case user = "USER"
}

final class Vault: @unchecked Sendable {
    /// PBKDF2 iterations of a new PIN wrap (Android Vault.PIN_ITERATIONS).
    static let pinIterations = 210_000

    let paths: SecurityPaths
    let keyring: Keyring
    let iterations: Int

    private let state = NSLock()
    /// Serialises making / unwrapping keys (two threads must not make two system keys).
    private let keys = NSLock()
    private var sysKeyBytes: SecretBytes?
    private var userKeyBytes: SecretBytes?

    init(paths: SecurityPaths, keyring: Keyring, iterations: Int = Vault.pinIterations) {
        self.paths = paths
        self.keyring = keyring
        self.iterations = iterations
    }

    // MARK: the system tier

    func sysKey() throws -> SecretBytes {
        if let k = state.withLock({ sysKeyBytes }), !k.isWiped { return k }
        return try keys.withLock {
            if let k = state.withLock({ sysKeyBytes }), !k.isWiped { return k }
            let k: SecretBytes
            if let wrapped = try ProtectedFiles.read(paths.sysKey) {
                guard let o = SecJSON.parse(wrapped) else { throw SecurityError.damaged("sys.key") }
                k = try unwrap(o, alias: "sys", label: "m5/ios/sys.key/1", aad: "m5/sys.key", context: nil)
            } else {
                try paths.prepare()
                k = SecretBytes(random: 32)
                let o = try wrap(k, alias: "sys", access: .background, label: "m5/ios/sys.key/1", aad: "m5/sys.key")
                try ProtectedFiles.writeDurable(SecJSON.data(o), to: paths.sysKey, protection: .completeUntilFirstUserAuthentication)
            }
            state.withLock { sysKeyBytes = k }
            return k
        }
    }

    // MARK: the user tier

    var hasUserKey: Bool { FileManager.default.fileExists(atPath: paths.pinWrap.path) }

    var unlocked: Bool { state.withLock { userKeyBytes.map { !$0.isWiped } ?? false } }

    var bioEnrolled: Bool { FileManager.default.fileExists(atPath: paths.bioWrap.path) && keyring.has("bio") }

    /// The data key while unlocked; `.locked` otherwise.
    func userKey() throws -> SecretBytes {
        guard let k = state.withLock({ userKeyBytes }), !k.isWiped else { throw SecurityError.locked }
        return k
    }

    /// First setup: a new user key protected by this PIN (and held).
    func createUserKey(pin: String) throws {
        let key = SecretBytes(random: 32)
        try writePinWrap(key, pin: pin)
        state.withLock { userKeyBytes = key }
    }

    private func pinKek(_ stretched: Data, _ version: Int) throws -> Data {
        // v 1 needs Android's pepper key — never on iOS (the format reads in PinWrapTests only).
        guard version >= 2 else { throw SecurityError.unavailable("a v 1 PIN wrap") }
        return try keyring.prf("pin", PinWrap.prfInput(stretched))
    }

    private func writePinWrap(_ key: SecretBytes, pin: String) throws {
        try paths.prepare()
        let salt = Bytes.random(16)
        var stretched = PinWrap.stretch(pin, salt: salt, iterations: iterations)
        defer { Bytes.wipe(&stretched) }
        let hw = try keyring.ensureAgreementKey("pin", access: .foreground)
        let o = try PinWrap.seal(dek: key, stretched: stretched, salt: salt, iterations: iterations, version: 2, hw: hw.rawValue, kek: pinKek)
        try ProtectedFiles.writeDurable(SecJSON.data(o), to: paths.pinWrap, protection: .complete)
    }

    private func readWrap() throws -> SecRecord {
        guard let d = try ProtectedFiles.read(paths.pinWrap), let o = SecJSON.parse(d) else { throw SecurityError.damaged("the PIN wrap") }
        return o
    }

    /// The data key this PIN opens, or nil for a wrong PIN.
    private func open(pin: String) throws -> SecretBytes? {
        let o = try readWrap()
        var stretched = PinWrap.stretch(pin, salt: try PinWrap.salt(o), iterations: try PinWrap.iterations(o))
        defer { Bytes.wipe(&stretched) }
        return try PinWrap.open(o, stretched: stretched, kek: pinKek)
    }

    /// True when the PIN opens the user key (it is then held in memory).
    func unlockWithPin(_ pin: String) throws -> Bool {
        guard let key = try open(pin: pin) else { return false }
        hold(key)
        return true
    }

    /// Whether this PIN is the unlock PIN — nothing kept or changed (the duress PIN must differ).
    func opensWith(_ pin: String) -> Bool {
        guard let key = try? open(pin: pin) else { return false }
        key.wipe()
        return true
    }

    func changePin(_ pin: String) throws {
        try writePinWrap(userKey(), pin: pin)
    }

    /// What protects the PIN, for the security screen: "secure-enclave", "software", "" (no PIN).
    var pinKeyLevel: String {
        guard hasUserKey, let o = try? readWrap() else { return "" }
        return PinWrap.version(o) >= 2 ? o.jString("hw", KeyLevel.secureEnclave.rawValue) : "legacy"
    }

    // MARK: biometrics

    /// Wraps the held user key to a new biometric key. Unlike Android no prompt is needed now:
    /// wrapping uses only the key's public half; every unwrap asks for a biometric.
    func enrollBiometrics() throws -> KeyLevel {
        let key = try userKey()
        let level = try keyring.replaceAgreementKey("bio", access: .biometry)
        let o = try wrap(key, alias: "bio", access: .biometry, label: "m5/ios/user.bio/1", aad: "m5/user.bio")
        try ProtectedFiles.writeDurable(SecJSON.data(o), to: paths.bioWrap, protection: .complete)
        return level
    }

    /// Unwraps the user key with the biometric key — `context` is the LAContext that just
    /// evaluated a biometric (the Secure Enclave uses the key only with it).
    func unlockWithBiometrics(context: LAContext?) throws {
        guard let d = try ProtectedFiles.read(paths.bioWrap), let o = SecJSON.parse(d) else { throw SecurityError.noKey("user.bio") }
        hold(try unwrap(o, alias: "bio", label: "m5/ios/user.bio/1", aad: "m5/user.bio", context: context))
    }

    /// Holds an opened user key. Already held (a PIN confirmed while unlocked): the same key — the
    /// held instance stays (its readers keep working), the new copy is zeroed.
    private func hold(_ key: SecretBytes) {
        state.withLock {
            if let held = userKeyBytes, !held.isWiped {
                key.wipe()
            } else {
                userKeyBytes = key
            }
        }
    }

    /// Where the biometric key is ("secure-enclave" / "software"); nil when there is none.
    var biometricLevel: KeyLevel? { bioEnrolled ? keyring.level(of: "bio") : nil }

    func disableBiometrics() {
        keyring.delete("bio")
        try? FileManager.default.removeItem(at: paths.bioWrap)
    }

    // MARK: locking

    /// Forgets the user key: no reader gets it any more, then its bytes are zeroed (shared readers too).
    func lock() {
        let k = state.withLock { () -> SecretBytes? in
            defer { userKeyBytes = nil }
            return userKeyBytes
        }
        k?.wipe()
    }

    /// Both keys out of memory (the wipe).
    func forgetAll() {
        lock()
        let k = state.withLock { () -> SecretBytes? in
            defer { sysKeyBytes = nil }
            return sysKeyBytes
        }
        k?.wipe()
    }

    // MARK: wrapping a key to a Keyring key (ECIES with the Secure Enclave)

    private func wrap(_ secret: SecretBytes, alias: String, access: KeyAccess, label: String, aad: String) throws -> SecRecord {
        let level = try keyring.ensureAgreementKey(alias, access: access)
        let eph = P256.KeyAgreement.PrivateKey()
        let e = EcP256.spki(eph.publicKey)
        var shared = try EcP256.ecdh(eph, keyring.agreementPublicKey(alias))
        defer { Bytes.wipe(&shared) }
        var k = SecCrypto.hkdf(shared, salt: Bytes.utf8(label), info: Bytes.utf8(e), length: 32)
        defer { Bytes.wipe(&k) }
        let iv = Bytes.random(12)
        let ct = try secret.withBytes { try SecCrypto.gcmSeal(SymmetricKey(data: k), iv: iv, Data($0), aad: Bytes.utf8(aad)) }
        return ["v": 1, "hw": level.rawValue, "e": e, "iv": Bytes.b64(iv), "ct": Bytes.b64(ct)]
    }

    private func unwrap(_ o: SecRecord, alias: String, label: String, aad: String, context: LAContext?) throws -> SecretBytes {
        let e = o.jString("e")
        guard let iv = Bytes.unb64(o.jString("iv")), let ct = Bytes.unb64(o.jString("ct")) else { throw SecurityError.damaged(alias) }
        var shared = try keyring.agree(alias, with: EcP256.publicKey(spki: e), context: context)
        defer { Bytes.wipe(&shared) }
        var k = SecCrypto.hkdf(shared, salt: Bytes.utf8(label), info: Bytes.utf8(e), length: 32)
        defer { Bytes.wipe(&k) }
        var plain = try SecCrypto.gcmOpen(SymmetricKey(data: k), iv: iv, ct, aad: Bytes.utf8(aad))
        defer { Bytes.wipe(&plain) }
        return SecretBytes(plain)
    }

    // MARK: records

    private func keyOf(_ tier: VaultTier) throws -> SecretBytes { tier == .sys ? try sysKey() : try userKey() }

    static func validName(_ name: String) -> Bool {
        (1...120).contains(name.count) && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }
    }

    func recordURL(_ tier: VaultTier, _ name: String) throws -> URL {
        guard Self.validName(name) else { throw SecurityError.damaged("bad record name") }
        return (tier == .sys ? paths.sysDir : paths.userDir).appendingPathComponent(name + ".bin")
    }

    private static func aad(_ tier: VaultTier, _ name: String) -> Data { Bytes.utf8(tier.rawValue + "|" + name) }

    private static func protection(_ tier: VaultTier) -> FileProtectionType {
        tier == .sys ? .completeUntilFirstUserAuthentication : .complete
    }

    func seal(_ tier: VaultTier, _ name: String, _ plain: Data) throws -> Data {
        try SecCrypto.sealWithIV(keyOf(tier), plain, aad: Self.aad(tier, name))
    }

    func open(_ tier: VaultTier, _ name: String, _ sealed: Data) throws -> Data {
        try SecCrypto.openWithIV(keyOf(tier), sealed, aad: Self.aad(tier, name))
    }

    /// Stores a record; `durable`: the file and its directory synced (the rename is on the disk).
    func put(_ tier: VaultTier, _ name: String, _ plain: Data, durable: Bool = false) throws {
        let url = try recordURL(tier, name)
        let sealed = try seal(tier, name, plain)
        try paths.prepare()
        if durable {
            try ProtectedFiles.writeDurable(sealed, to: url, protection: Self.protection(tier))
        } else {
            do {
                try sealed.write(to: url, options: [.atomic, tier == .sys ? .completeFileProtectionUntilFirstUserAuthentication : .completeFileProtection])
            } catch {
                throw SecurityError.io("cannot write \(name)")
            }
        }
    }

    /// nil when there is no such record.
    func get(_ tier: VaultTier, _ name: String) throws -> Data? {
        guard let sealed = try ProtectedFiles.read(try recordURL(tier, name)) else { return nil }
        return try open(tier, name, sealed)
    }

    /// {} when there is none or it does not open (logged by the caller's choice).
    func json(_ tier: VaultTier, _ name: String) -> SecRecord {
        guard let d = try? get(tier, name), let o = SecJSON.parse(d) else { return [:] }
        return o
    }

    func putJson(_ tier: VaultTier, _ name: String, _ value: SecRecord, durable: Bool = false) throws {
        try put(tier, name, SecJSON.data(value), durable: durable)
    }

    /// For the attempt counter's kind of reading: {} when there is none, nil when it cannot be read
    /// now (the key, the storage), ["unreadable": true] when it does not open (changed by someone).
    func strictJson(_ tier: VaultTier, _ name: String) -> SecRecord? {
        guard let url = try? recordURL(tier, name) else { return nil }
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        guard let key = try? keyOf(tier), let sealed = try? ProtectedFiles.read(url) else { return nil }
        guard let plain = try? SecCrypto.openWithIV(key, sealed, aad: Self.aad(tier, name)), let o = SecJSON.parse(plain) else {
            return [LockStore.unreadable: true]
        }
        return o
    }

    func delete(_ tier: VaultTier, _ name: String) {
        if let url = try? recordURL(tier, name) { try? FileManager.default.removeItem(at: url) }
    }
}
