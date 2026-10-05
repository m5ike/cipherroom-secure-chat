// Small secrets and key blobs that must not live in the app's files: the
// Keychain (generic-password items, `…ThisDeviceOnly`, never synchronised,
// never in a backup that restores elsewhere). Android has no direct
// counterpart — its Keystore holds the keys themselves; here the Secure
// Enclave keys' blobs (usable only by this device's Secure Enclave), the
// attempt counter and the software fallback's keys are Keychain items.
//
// A build without code signing (the simulator in CI: CODE_SIGNING_ALLOWED=NO)
// has no keychain entitlement and the Keychain answers errSecMissingEntitlement.
// There — and only in the simulator — FileSecureStore stands in, reported as
// "file" (development only, nothing secret should be in such a build).

import Foundation
import Security

/// When an item can be read (Keychain accessibility, always ThisDeviceOnly).
enum SecureStoreAccess: Sendable {
    /// After the first unlock since boot — background work (push wake-ups, the notification extension).
    case background
    /// Only while the device is unlocked — what the user is in front of (the PIN key, the attempt counter).
    case foreground

    var keychainValue: CFString {
        switch self {
        case .background: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        case .foreground: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        }
    }
}

/// Named small secrets of one namespace. Other parts of the app use it for their own
/// secrets (an account session token…): `SecurityCenter.shared.secrets`.
protocol SecureStore: AnyObject, Sendable {
    /// "keychain", "file" (unsigned simulator builds only) or "memory" (tests, previews).
    var kind: String { get }
    /// nil when there is no such item; throws when the store cannot answer now (device locked…).
    func read(_ name: String) throws -> Data?
    func write(_ name: String, _ value: Data, access: SecureStoreAccess) throws
    func delete(_ name: String)
    /// Every item's name; throws when the store cannot answer now.
    func names() throws -> [String]
    /// Removes every item of the namespace (the wipe).
    func deleteAll()
}

extension SecureStore {
    func string(_ name: String) throws -> String? { try read(name).flatMap { Bytes.str($0) } }
    func write(_ name: String, string: String, access: SecureStoreAccess) throws { try write(name, Bytes.utf8(string), access: access) }
}

/// The Keychain: one service (namespace), the account is the item's name. Items go to the
/// app's default access group — the first of `keychain-access-groups`, shared with the
/// notification extension (Resources/M5cet.entitlements).
final class KeychainSecureStore: SecureStore, @unchecked Sendable {
    let service: String
    var kind: String { "keychain" }

    init(service: String) { self.service = service }

    /// Whether this process may use the Keychain at all (false in an unsigned build: errSecMissingEntitlement).
    static func usable() -> Bool {
        let probe = KeychainSecureStore(service: "cz.m5cet.app.probe")
        do {
            try probe.write("probe", Data([1]), access: .background)
            probe.delete("probe")
            return true
        } catch {
            return false
        }
    }

    private func base(_ name: String? = nil) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecUseDataProtectionKeychain as String: true]
        if let name { q[kSecAttrAccount as String] = name }
        return q
    }

    func read(_ name: String) throws -> Data? {
        var q = base(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecurityError.keychain(status) }
        return out as? Data
    }

    func write(_ name: String, _ value: Data, access: SecureStoreAccess) throws {
        // Delete + add: the accessibility of an existing item is replaced too.
        SecItemDelete(base(name) as CFDictionary)
        var q = base(name)
        q[kSecValueData as String] = value
        q[kSecAttrAccessible as String] = access.keychainValue
        q[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw SecurityError.keychain(status) }
    }

    func delete(_ name: String) { SecItemDelete(base(name) as CFDictionary) }

    func names() throws -> [String] {
        var q = base()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw SecurityError.keychain(status) }
        return (out as? [[String: Any]] ?? []).compactMap { $0[kSecAttrAccount as String] as? String }
    }

    func deleteAll() { SecItemDelete(base() as CFDictionary) }
}

/// Unsigned simulator builds only (no keychain entitlement): one file per item in a directory
/// with the matching Data Protection class. Development stand-in, never used on a device.
final class FileSecureStore: SecureStore, @unchecked Sendable {
    let dir: URL
    private let lock = NSLock()
    var kind: String { "file" }

    init(dir: URL) { self.dir = dir }

    private func url(_ name: String) -> URL { dir.appendingPathComponent(Bytes.hex(Bytes.utf8(name)) + ".item") }

    func read(_ name: String) throws -> Data? {
        try lock.withLock {
            let u = url(name)
            guard FileManager.default.fileExists(atPath: u.path) else { return nil }
            do { return try Data(contentsOf: u) } catch { throw SecurityError.io("secure store read") }
        }
    }

    func write(_ name: String, _ value: Data, access: SecureStoreAccess) throws {
        try lock.withLock {
            try ProtectedFiles.ensureDirectory(dir, protection: .completeUntilFirstUserAuthentication)
            try ProtectedFiles.writeDurable(value, to: url(name), protection: access == .background ? .completeUntilFirstUserAuthentication : .complete)
        }
    }

    func delete(_ name: String) {
        lock.withLock { try? FileManager.default.removeItem(at: url(name)) }
    }

    func names() throws -> [String] {
        lock.withLock {
            let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            return files.filter { $0.hasSuffix(".item") }.compactMap { Bytes.unhex(String($0.dropLast(5))).flatMap { Bytes.str($0) } }
        }
    }

    func deleteAll() {
        lock.withLock { try? FileManager.default.removeItem(at: dir) }
    }
}

/// In memory (tests, previews). `failing` makes it behave like a Keychain that cannot answer.
final class MemorySecureStore: SecureStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var _failing = false
    var kind: String { "memory" }

    init() {}

    var failing: Bool {
        get { lock.withLock { _failing } }
        set { lock.withLock { _failing = newValue } }
    }

    var snapshot: [String: Data] { lock.withLock { items } }

    func read(_ name: String) throws -> Data? {
        try lock.withLock {
            if _failing { throw SecurityError.keychain(errSecInteractionNotAllowed) }
            return items[name]
        }
    }

    func write(_ name: String, _ value: Data, access: SecureStoreAccess) throws {
        try lock.withLock {
            if _failing { throw SecurityError.keychain(errSecInteractionNotAllowed) }
            items[name] = value
        }
    }

    func delete(_ name: String) { lock.withLock { _ = items.removeValue(forKey: name) } }

    func names() throws -> [String] {
        try lock.withLock {
            if _failing { throw SecurityError.keychain(errSecInteractionNotAllowed) }
            return Array(items.keys)
        }
    }

    func deleteAll() { lock.withLock { items.removeAll() } }
}
