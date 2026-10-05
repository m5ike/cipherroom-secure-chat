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
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "core")

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
        let b = LockBridge(listener: listener, center: center)
        bridge = b
        center.add(b)
        center.inboxConsumer = b
    }

    var requestSigner: any RequestSigner { SecureEnclaveRequests(signer: center.signer) }

    func encryptionKeySPKI() throws -> String { try center.agreement.publicKeySPKI() }

    var inCall: (@MainActor () -> Bool) {
        get { center.inCall }
        set { center.inCall = newValue }
    }

    func chatIdentity(create: Bool) -> ChatIdentity? {
        guard center.vault.unlocked else { return nil }
        return ChatIdentityStore.load(records: userRecords, keyring: center.keyring, create: create)
    }
}

/// The device's Secure Enclave signing key as M5Net's RequestSigner.
struct SecureEnclaveRequests: RequestSigner {
    let signer: any DeviceSigner
    func publicKeySPKI() async throws -> String { try signer.publicKeySPKI() }
    func signP1363(_ data: Data) async throws -> Data { try signer.sign(data) }
}

/// The open lock inbox as LockInboxWriting (M5Core items → the inbox's records).
struct InboxWriter: LockInboxWriting, @unchecked Sendable {
    let inbox: LockInbox
    var active: Bool { inbox.isActive }
    func seal(_ item: JSONObject) -> Bool {
        guard let rec = SecJSON.parse(item.stringify()) else { return false }
        return inbox.seal(rec)
    }
}

/// SecurityCenter's LockParticipant and LockInboxConsumer, handed to the rooms.
final class LockBridge: LockParticipant, LockInboxConsumer, @unchecked Sendable {
    weak var listener: (any CoreLockListener)?
    weak var center: SecurityCenter?

    @MainActor init(listener: any CoreLockListener, center: SecurityCenter) { self.listener = listener; self.center = center }

    func lockWillForget(receiving inbox: LockInbox?) {
        listener?.coreLockWillForget(receiving: inbox.map { InboxWriter(inbox: $0) })
    }

    func lockDidForget() { listener?.coreLockDidForget() }
    func lockDidUnlock() { listener?.coreLockDidUnlock() }

    /// Called off the main actor (the drain's task): the parsed generation as M5Proto's, merged on the main actor.
    nonisolated func apply(_ parsed: LockInboxParsed, inbox: LockInbox) {
        var p = LockedRooms.Parsed()
        for (room, items) in parsed.rooms { p.rooms[room] = items.compactMap { JSON.parseObject(SecJSON.string($0)) } }
        for (slot, kid) in parsed.pins where p.pins[slot] == nil { p.pins[slot] = kid }
        for (room, peerId, secret) in parsed.resumes { p.resumes[room] = [peerId, secret] }
        p.calls = parsed.calls.compactMap { JSON.parseObject(SecJSON.string($0)) }
        for (id, uri) in parsed.callUris { p.callUris[id] = uri }
        p.files = parsed.files.compactMap { JSON.parseObject(SecJSON.string($0)) }
        p.unknown = parsed.unknown
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.listener?.coreMerge(p) }
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
            _ = try keyring.ensureSigningKey(signAlias, access: .background)
            _ = try keyring.ensureAgreementKey(dhAlias, access: .background)
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

    static func keyringIdentity(_ keyring: Keyring) throws -> ChatIdentity {
        let signPub = try keyring.signingPublicKey(signAlias)
        let dhPub = try keyring.agreementPublicKey(dhAlias)
        return ChatIdentity(signer: KeyringChatSigner(keyring: keyring, publicKey: Crypto.b64(Array(signPub.derRepresentation))),
                            dh: KeyringChatAgreer(keyring: keyring, spki: Crypto.b64(Array(dhPub.derRepresentation))))
    }
}

/// The identity's signing key in the Secure Enclave (P1363, base64 — WebCrypto's form).
struct KeyringChatSigner: M5Crypto.DeviceSigner, @unchecked Sendable {
    let keyring: Keyring
    let publicKey: String
    func sign(_ data: Bytes) throws -> String { Crypto.b64(Array(try keyring.sign(ChatIdentityStore.signAlias, Data(data)))) }
}

/// The identity's ECDH key in the Secure Enclave (the 32-byte x-coordinate).
struct KeyringChatAgreer: KeyAgreer, @unchecked Sendable {
    let keyring: Keyring
    let spki: String
    func agree(with peer: P256.KeyAgreement.PublicKey) throws -> Bytes { Array(try keyring.agree(ChatIdentityStore.dhAlias, with: peer)) }
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
}
