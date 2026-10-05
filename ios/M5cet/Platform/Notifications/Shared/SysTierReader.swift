// The SYS tier of the vault read from outside the app (Platform/Security
// Vault.swift — the same formats, read only): the notification extension opens
// the server's settings ("config": device id, pinned server key), the person's
// notification switches ("notify-prefs") and the conversation key from the App
// Group, with the device's keys from the shared keychain group.
//
//   sys.key            {v:1, hw, e, iv, ct}: K = HKDF-SHA256(ECDH(key "sys", e), salt "m5/ios/sys.key/1",
//                      info e), AES-256-GCM, AAD "m5/sys.key" → DEK_sys
//   sys/<name>.bin     iv ‖ AES-256-GCM(DEK_sys, AAD "SYS|<name>")
//   Keychain           generic password, service "cz.m5cet.app.security", account "key.<alias>":
//                      a level byte (1 Secure Enclave, 2 software) and the key's blob
//
// Never the USER tier: it is not in the App Group (Security README). Shared:
// compiled into the app (tests) and, through a symlink, into M5cetNotifications.

import CryptoKit
import Foundation
import Security

struct SysTierReader: Sendable {
    enum Failure: Error, Equatable, Sendable { case noKey(String), damaged(String) }

    static let keychainService = "cz.m5cet.app.security"

    /// The App Group's Application Support/m5 (the app's SecurityPaths.shared).
    let shared: URL
    /// A key item's raw value ("key.<alias>": level byte + blob), nil when there is none.
    let keyItem: @Sendable (String) -> Data?

    init(shared: URL, keyItem: @escaping @Sendable (String) -> Data?) {
        self.shared = shared
        self.keyItem = keyItem
    }

    /// This device: the App Group named in Info.plist (M5AppGroup), the shared keychain group — and in
    /// an unsigned simulator build the development stand-in of the Keychain (FileSecureStore's files).
    static func system() -> SysTierReader? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "M5AppGroup") as? String, !group.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        let shared = container.appendingPathComponent("Library/Application Support/m5", isDirectory: true)
        return SysTierReader(shared: shared) { name in
            if let d = keychainItem(name) { return d }
            #if targetEnvironment(simulator)
            return devKeychainItem(shared.appendingPathComponent("dev-keychain", isDirectory: true), name)
            #else
            return nil
            #endif
        }
    }

    static func keychainItem(_ name: String) -> Data? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                                kSecAttrAccount as String: name, kSecUseDataProtectionKeychain as String: true,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    /// FileSecureStore's file for an item: hex(UTF-8 name) + ".item".
    static func devKeychainItem(_ dir: URL, _ name: String) -> Data? {
        let hex = Data(name.utf8).map { String(format: "%02x", $0) }.joined()
        return try? Data(contentsOf: dir.appendingPathComponent(hex + ".item"))
    }

    // MARK: keys

    /// Raw ECDH (the 32-byte x) with the named agreement key — Secure Enclave or software, as Keyring stores it.
    func agreement(_ alias: String) throws -> @Sendable (P256.KeyAgreement.PublicKey) throws -> Data {
        guard let raw = keyItem("key." + alias), raw.count > 1 else { throw Failure.noKey(alias) }
        let blob = Data(raw.dropFirst())
        switch raw[raw.startIndex] {
        case 1:
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
            return { peer in try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) } }
        case 2:
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: blob)
            return { peer in try key.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) } }
        default:
            throw Failure.damaged("key \(alias)")
        }
    }

    /// DEK_sys, unwrapped with the Secure Enclave key "sys".
    func sysKey() throws -> SymmetricKey {
        guard let d = try? Data(contentsOf: shared.appendingPathComponent("sys.key")),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let e = o["e"] as? String, let iv = (o["iv"] as? String).flatMap({ Data(base64Encoded: $0) }),
              let ct = (o["ct"] as? String).flatMap({ Data(base64Encoded: $0) }), iv.count == 12, ct.count >= 16,
              let eDer = Data(base64Encoded: e) else { throw Failure.damaged("sys.key") }
        let agree = try agreement("sys")
        var shared = try agree(try P256.KeyAgreement.PublicKey(derRepresentation: eDer))
        defer { shared.resetBytes(in: 0..<shared.count) }
        let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: shared), salt: Data("m5/ios/sys.key/1".utf8), info: Data(e.utf8),
                                       outputByteCount: 32)
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
            return SymmetricKey(data: try AES.GCM.open(box, using: k, authenticating: Data("m5/sys.key".utf8)))
        } catch {
            throw Failure.damaged("sys.key")
        }
    }

    // MARK: records

    /// A SYS record's plain bytes, nil when there is none.
    func record(_ name: String, key: SymmetricKey) throws -> Data? {
        guard let sealed = try? Data(contentsOf: shared.appendingPathComponent("sys/\(name).bin")) else { return nil }
        guard sealed.count >= 28 else { throw Failure.damaged(name) }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: sealed.prefix(12)), ciphertext: sealed.dropFirst(12).dropLast(16),
                                            tag: sealed.suffix(16))
            return try AES.GCM.open(box, using: key, authenticating: Data("SYS|\(name)".utf8))
        } catch {
            throw Failure.damaged(name)
        }
    }

    func json(_ name: String, key: SymmetricKey) -> [String: Any]? {
        guard let d = try? record(name, key: key) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    // MARK: what the extension needs at once

    struct Context: @unchecked Sendable {
        let deviceId: String
        let serverKey: String
        let prefs: NotifyMirror
        let conversationKey: Data?
        /// HMAC keys of server room ids → the room's thread id (the app's "threads" record).
        let threads: [String: String]
        let agree: @Sendable (P256.KeyAgreement.PublicKey) throws -> Data
    }

    /// The device's server settings, the switches and the encryption key; throws when anything is missing.
    func context() throws -> Context {
        let key = try sysKey()
        guard let config = json("config", key: key) else { throw Failure.noKey("config") }
        let deviceId = config["deviceId"] as? String ?? "", serverKey = config["serverKey"] as? String ?? ""
        guard !deviceId.isEmpty, !serverKey.isEmpty else { throw Failure.noKey("config") }
        let prefs = NotifyMirror.from(try? record(NotifyMirror.record, key: key))
        let conversations = json(ThreadIds.record, key: key)
        let threads = (json("threads", key: key)?["t"] as? [String: String]) ?? [:]
        return Context(deviceId: deviceId, serverKey: serverKey, prefs: prefs, conversationKey: ThreadIds.secret(fromRecord: conversations),
                       threads: threads, agree: try agreement("enc"))
    }
}
