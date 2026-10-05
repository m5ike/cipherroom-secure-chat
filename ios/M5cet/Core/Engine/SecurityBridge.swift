// The core's one door to Platform/Security (Android: what chat/* reached
// through M5.vault, M5.lock, LockedRooms, Rooms.identity): the vault's tiers as
// M5Proto's RecordVault and M5Net's NetStateStore (records named exactly like
// Android's — "rooms", "pins", "identity", "hist-<hash>", "resume", "p4.*",
// "calls", "config"…), the lock (state, participation, the inbox), the device's
// keys (request signing, the chat identity). Everything else in Core talks to
// `CoreSecurity`, so tests run the engine on memory stores and the security
// code can change behind this file only.

import CryptoKit
import Foundation
import M5Core
import M5Crypto
import M5Net
import M5Proto
import os

/// What a lock does to the rooms (Android M5.forgetSecrets / onUnlocked through Rooms).
@MainActor
protocol CoreLockListener: AnyObject {
    /// The data key is about to go. `inbox` non-nil: keep receiving and seal what would be stored into it.
    func coreLockWillForget(receiving inbox: (any LockInboxWriting)?)
    /// The data key is gone.
    func coreLockDidForget()
    /// The data key is back; the lock inbox's items come through `coreMerge` next, then `coreRestoreAll`.
    func coreLockDidUnlock()
    /// One generation of the lock inbox (msg / state items per room, pins, resumes, calls, files).
    func coreMerge(_ parsed: LockedRooms.Parsed)
    /// The drain is done (or nothing was pending): the rooms' lists get their histories.
    func coreRestoreAll()
}

/// The lock inbox while it is open (Android LockedRooms.message / state / pin / resume).
protocol LockInboxWriting: Sendable {
    var active: Bool { get }
    /// One item (LockedRooms.message / state / pin / resume / call) sealed into the open generation.
    @discardableResult func seal(_ item: JSONObject) -> Bool
    /// A received file (checked in full) kept for the unlock: its slots file moves into the inbox, the item carries its key.
    func keepFile(room: String, id: String, key: Bytes, slots: URL, chunkSize: Int, total: Int, size: Int64, lengths: [Int], root: String, p4: Bool) -> Bool
}

/// What the core needs of the device's security.
@MainActor
protocol CoreSecurity: AnyObject {
    /// The user tier (unreadable while locked).
    var userRecords: any RecordVault { get }
    /// The system tier (readable while locked: the device's config).
    var systemRecords: any RecordVault { get }
    var userState: any NetStateStore { get }
    var systemState: any NetStateStore { get }
    /// A PIN is set up (AppLock.isSetUp).
    var isSetUp: Bool { get }
    var isLocked: Bool { get }
    /// The vault's data key is in memory.
    var unlocked: Bool { get }
    /// "Erased" notice pending (route's wipedNotice).
    var wipedNotice: Bool { get }
    func lockNow()
    /// The lock inbox while locked in the receiving mode (nil unlocked / strict mode).
    var lockInbox: (any LockInboxWriting)? { get }
    /// The rooms take part in locks.
    func setLockListener(_ listener: any CoreLockListener)
    /// The device's request-signing key (M5Net: /api/ios, the enrolment proof).
    var requestSigner: any RequestSigner { get }
    /// The device's encryption key (SPKI b64) for /enroll's encKey.
    func encryptionKeySPKI() throws -> String
    /// This device's chat identity (record "identity"); made when missing. Nil while locked.
    func chatIdentity(create: Bool) -> ChatIdentity?
    /// A call keeps the data key until it ends.
    var inCall: (@MainActor () -> Bool) { get set }
    /// Where the lock inbox kept a received file (lockbox/files/<id>.part), nil when there is no inbox.
    func keptFileURL(id: String) -> URL?
    /// Bumped on every change of the lock (observable: the route follows it).
    var lockRevision: Int { get }
    /// The lock's numbers for $lock and Settings › Security.
    var lockFacts: LockFacts { get }
    /// The PIN pad's model (Parts/Lock LockPadModel over AppLock): setting the PIN up, or unlocking. Nil without AppLock (tests).
    func makeLockPad(setup: Bool) -> LockPadModel?
    /// Settings › Security's $security (pinKey, duress, biometric…).
    func securityScope(t: (String) -> String) -> DesignValue
    /// A security setting changed in the design's settings (security.*): into the lock's own store.
    func securitySettingChanged(_ key: String, _ value: Bool)
}

/// The lock's numbers (AppLock, LockPolicy).
struct LockFacts: Equatable, Sendable {
    var pinLength = 6
    var maxAttempts = 8
    var attempts = 0
    var left = 8
    var waitSeconds: Int64 = 0
    var biometricAvailable = false
}

// MARK: - the vault as M5Proto / M5Net stores

/// A tier of the app's vault as named JSON records (M5Core JSON, so numbers and key order are org.json's).
final class VaultRecords: RecordVault, @unchecked Sendable {
    let vault: Vault
    let tier: VaultTier

    init(vault: Vault, tier: VaultTier) { self.vault = vault; self.tier = tier }

    var unlocked: Bool { tier == .sys || vault.unlocked }

    func record(_ name: String) -> JSONObject? {
        guard unlocked else { return nil }
        guard let d = try? vault.get(tier, name) else { return unlocked ? JSONObject() : nil }
        return JSON.parseObject(String(decoding: d, as: UTF8.self)) ?? JSONObject()
    }

    func recordStrict(_ name: String) -> JSONObject? {
        guard unlocked else { return nil }
        do {
            guard let d = try vault.get(tier, name) else { return JSONObject() }
            return JSON.parseObject(String(decoding: d, as: UTF8.self))
        } catch { return nil }
    }

    @discardableResult
    func put(_ name: String, _ value: JSONObject) -> Bool {
        guard unlocked else { return false }
        do { try vault.put(tier, name, Data(value.stringify().utf8)); return true } catch { return false }
    }

    func delete(_ name: String) { vault.delete(tier, name) }
}

/// M5Net's documents in a vault tier (the same record names Android uses).
final class VaultNetState: NetStateStore, @unchecked Sendable {
    let records: any RecordVault
    init(records: any RecordVault) { self.records = records }

    func load(_ key: String) async -> NetJSON? {
        guard let o = records.record(key), !o.isEmpty else { return nil }
        return try? NetJSON.parse(o.stringify())
    }

    func save(_ key: String, _ value: NetJSON?) async {
        guard let value else { records.delete(key); return }
        if let o = JSON.parseObject(value.text) { records.put(key, o) }
    }
}

// MARK: - the app's security

/// Platform/Security's SecurityCenter behind CoreSecurity.
@MainActor
final class AppSecurity: CoreSecurity {
    let center: SecurityCenter
    let userRecords: any RecordVault
    let systemRecords: any RecordVault
    let userState: any NetStateStore
    let systemState: any NetStateStore
    private var bridge: LockBridge?

    init(center: SecurityCenter) {
        self.center = center
        userRecords = VaultRecords(vault: center.vault, tier: .user)
        systemRecords = VaultRecords(vault: center.vault, tier: .sys)
        userState = VaultNetState(records: userRecords)
        systemState = VaultNetState(records: systemRecords)
    }

    var isSetUp: Bool { center.lock.isSetUp }
    var isLocked: Bool { center.lock.isLocked }
    var unlocked: Bool { center.vault.unlocked }
    var wipedNotice: Bool { center.wipedNotice }
    func lockNow() { center.lock.lockNow(remote: false) }

    var lockInbox: (any LockInboxWriting)? { center.inbox.isActive ? InboxWriter(inbox: center.inbox) : nil }

    func setLockListener(_ listener: any CoreLockListener) {
        let b = LockBridge(listener: listener)
        bridge = b
        center.add(b)
        center.inboxConsumer = b
    }

    var requestSigner: any RequestSigner { LazyRequestSigner(center: center) }

    func encryptionKeySPKI() throws -> String { try center.agreement().spki }

    var inCall: (@MainActor () -> Bool) {
        get { center.inCall }
        set { center.inCall = newValue }
    }

    func chatIdentity(create: Bool) -> ChatIdentity? {
        guard center.vault.unlocked else { return nil }
        return ChatIdentityStore.load(records: userRecords, keyring: center.keyring, create: create)
    }

    func keptFileURL(id: String) -> URL? { center.inbox.partURL(id: id) }

    var lockRevision: Int { center.lock.revision }

    var lockFacts: LockFacts {
        let l = center.lock
        return LockFacts(pinLength: l.pinLength, maxAttempts: l.maxAttempts, attempts: l.attempts, left: l.left, waitSeconds: l.waitSeconds,
                         biometricAvailable: l.biometricAvailable)
    }

    func makeLockPad(setup: Bool) -> LockPadModel? {
        LockPadModel(lock: center.lock, mode: setup ? .setup : .unlock, shuffle: center.settings.bool(SecuritySetting.shufflePin))
    }

    func securityScope(t: (String) -> String) -> DesignValue {
        let l = center.lock
        let pinKey = l.pinKeyLevel
        return ["biometricAvailable": .bool(l.policy.biometric != "off" && l.biometrics.available), "biometric": .bool(center.vault.bioEnrolled),
                "pinLength": .number(Double(l.pinLength)), "maxAttempts": .number(Double(l.maxAttempts)), "wipe": .bool(l.policy.wipe),
                "screenshots": .bool(l.policy.screenshots), "pinKey": .string(pinKey), "pinKeyLabel": .string(pinKey.isEmpty ? "—" : t("set.security.pinKey." + pinKey)),
                "duress": .bool(center.duress.active)]
    }

    func securitySettingChanged(_ key: String, _ value: Bool) { center.settings.set(key, value) }
}

/// The device's Secure Enclave signing key, made on first use (KeyringSigner).
struct LazyRequestSigner: RequestSigner, @unchecked Sendable {
    let center: SecurityCenter
    func publicKeySPKI() async throws -> String { try await MainActor.run { try center.signer() }.publicKey }
    func signP1363(_ data: Data) async throws -> Data { try await MainActor.run { try center.signer() }.sign(data: data) }
}

/// The open lock inbox as LockInboxWriting.
struct InboxWriter: LockInboxWriting, @unchecked Sendable {
    let inbox: LockInboxFiles
    var active: Bool { inbox.isActive }
    func seal(_ item: JSONObject) -> Bool { inbox.seal(item) }
    func keepFile(room: String, id: String, key: Bytes, slots: URL, chunkSize: Int, total: Int, size: Int64, lengths: [Int], root: String, p4: Bool) -> Bool {
        inbox.keepFile(room: room, id: id, key: key, slots: slots, chunkSize: chunkSize, total: total, size: size, lengths: lengths, root: root, p4: p4)
    }
}

/// SecurityCenter's LockParticipant and LockInboxConsumer, handed to the rooms.
final class LockBridge: LockParticipant, LockInboxConsumer, @unchecked Sendable {
    weak var listener: (any CoreLockListener)?

    @MainActor init(listener: any CoreLockListener) { self.listener = listener }

    func lockWillForget(receiving inbox: LockInboxFiles?) {
        listener?.coreLockWillForget(receiving: inbox.map { InboxWriter(inbox: $0) })
    }

    func lockDidForget() { listener?.coreLockDidForget() }
    func lockDidUnlock() { listener?.coreLockDidUnlock() }

    /// Called off the main actor (the drain's task): merged on the main actor before the next generation.
    nonisolated func apply(_ parsed: LockedRooms.Parsed, inbox: LockInboxFiles) {
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.listener?.coreMerge(parsed) }
            done.signal()
        }
        done.wait()
    }

    nonisolated func restoreAll() {
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.listener?.coreRestoreAll() } }
    }
}

// MARK: - the chat identity

/// The chat identity (record "identity", Android Rooms.identity): Android keeps software keys there
/// (signPkcs8, dhPkcs8 — still read, so a record of that shape keeps working); iOS makes the two keys
/// in the Secure Enclave (Keyring aliases chat.sign, chat.dh — usable after the first unlock, so a room
/// receiving while the app is locked can still sign its receipts) and keeps their public halves there.
@MainActor
enum ChatIdentityStore {
    static let record = "identity"
    static let signAlias = "chat.sign", dhAlias = "chat.dh"

    static func load(records: any RecordVault, keyring: Keyring, create: Bool) -> ChatIdentity? {
        let o = records.record(record) ?? JSONObject()
        if let sp = o.string("signPkcs8"), let dp = o.string("dhPkcs8"),
           let id = try? ChatIdentity.fromPkcs8(signPkcs8: sp, publicKey: o.optString("publicKey"), dhPkcs8: dp, dhPublicKey: o.optString("dhPublicKey")) {
            return id
        }
        if o.optString("keys") == "keyring", keyring.has(signAlias), keyring.has(dhAlias),
           let id = try? keyringIdentity(keyring), id.publicKey == o.optString("publicKey") {
            return id
        }
        guard create else { return nil }
        keyring.delete(signAlias)
        keyring.delete(dhAlias)
        do {
            let id = try keyringIdentity(keyring)
            records.put(record, JSONObject([("publicKey", .string(id.publicKey)), ("dhPublicKey", .string(id.dhPublicKey)), ("keys", "keyring"),
                                            ("hw", .string(keyring.level(of: signAlias)?.rawValue ?? ""))]))
            return id
        } catch {
            // No keyring key (a broken store): Android's software identity in the vault.
            let id = ChatIdentity.generate()
            records.put(record, JSONObject([("signPkcs8", .string(id.signPkcs8 ?? "")), ("publicKey", .string(id.publicKey)),
                                            ("dhPkcs8", .string(id.dhPkcs8 ?? "")), ("dhPublicKey", .string(id.dhPublicKey))]))
            return id
        }
    }

    /// The identity's two Secure Enclave keys (made when missing).
    static func keyringIdentity(_ keyring: Keyring) throws -> ChatIdentity {
        ChatIdentity(signer: try KeyringSigner(keyring: keyring, alias: signAlias), dh: try KeyringAgreement(keyring: keyring, alias: dhAlias))
    }
}

// MARK: - memory (tests, previews)

/// Everything in memory: an unlocked vault, software keys, a lock that only flips a flag.
@MainActor
final class MemorySecurity: CoreSecurity {
    let userVault = MemoryRecordVault()
    let systemVault = MemoryRecordVault()
    var userRecords: any RecordVault { userVault }
    var systemRecords: any RecordVault { systemVault }
    lazy var userState: any NetStateStore = VaultNetState(records: userVault)
    lazy var systemState: any NetStateStore = VaultNetState(records: systemVault)
    var isSetUp = true
    var isLocked = false
    var unlocked: Bool { userVault.unlocked }
    var wipedNotice = false
    var inbox = MemoryInbox()
    var receiveWhileLocked = true
    private weak var listener: (any CoreLockListener)?
    private let signKey = P256.Signing.PrivateKey()
    private let encKey = P256.KeyAgreement.PrivateKey()
    private var identity: ChatIdentity?
    var inCall: (@MainActor () -> Bool) = { false }

    var lockInbox: (any LockInboxWriting)? { inbox.active ? inbox : nil }
    func keptFileURL(id: String) -> URL? { nil }
    var lockRevision = 0
    var lockFacts = LockFacts()
    func makeLockPad(setup: Bool) -> LockPadModel? { nil }
    func securityScope(t: (String) -> String) -> DesignValue { ["pinLength": 6, "duress": false] }
    func securitySettingChanged(_ key: String, _ value: Bool) {}
    func setLockListener(_ listener: any CoreLockListener) { self.listener = listener }
    var requestSigner: any RequestSigner { SoftwareRequestSigner(key: signKey) }
    func encryptionKeySPKI() throws -> String { Crypto.b64(Array(encKey.publicKey.derRepresentation)) }

    func chatIdentity(create: Bool) -> ChatIdentity? {
        guard unlocked else { return nil }
        if identity == nil, create { identity = ChatIdentity.generate() }
        return identity
    }

    /// The lock as SecurityCenter.forgetSecrets does it: the inbox begins, the listener hears, the vault locks.
    func lockNow() {
        isLocked = true
        if receiveWhileLocked { inbox.begin() }
        listener?.coreLockWillForget(receiving: receiveWhileLocked ? inbox : nil)
        userVault.setLocked(true)
        listener?.coreLockDidForget()
    }

    /// The unlock: the vault opens, the inbox drains into the rooms, then the histories come back.
    func unlock() {
        isLocked = false
        userVault.setLocked(false)
        listener?.coreLockDidUnlock()
        let items = inbox.close()
        if !items.isEmpty { listener?.coreMerge(LockedRooms.parse(items.map { Crypto.utf8($0.stringify()) })) }
        listener?.coreRestoreAll()
    }
}

/// The lock inbox in memory (tests): items as they were sealed.
final class MemoryInbox: LockInboxWriting, @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var items: [JSONObject] = []
    var active: Bool { lock.withLock { open } }
    var sealed: [JSONObject] { lock.withLock { items } }
    func begin() { lock.withLock { open = true; items = [] } }
    func close() -> [JSONObject] { lock.withLock { open = false; let i = items; items = []; return i } }
    func seal(_ item: JSONObject) -> Bool { lock.withLock { guard open else { return false }; items.append(item); return true } }
    func keepFile(room: String, id: String, key: Bytes, slots: URL, chunkSize: Int, total: Int, size: Int64, lengths: [Int], root: String, p4: Bool) -> Bool { false }
}
