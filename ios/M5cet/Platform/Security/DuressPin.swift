// The duress PIN (Android security/Duress, 6.12 F-16) — off by default
// (Settings › Security, "security.duress"). Typed on the lock screen, also during
// a wait, it erases the app the way the attempts' wipe does (Wiper, reason
// "duress") and the app opens empty — no "data erased" notice. The server hears
// of it as a wipe with that reason.
//
// Only a verifier is kept (SYS tier "duress", readable on the lock screen):
//   tag = PRF_duress("m5/duress/1|" ‖ PBKDF2-SHA256(PIN, salt, 210 000))
// PRF_duress is the Secure Enclave's (Keyring.prf, alias "duress") — Android's
// HMAC by m5.duress: typing it costs as much as the unlock PIN, guessing it needs
// this device. It must differ from the unlock PIN (set with the current PIN); a
// new unlock PIN may not be it.

import Foundation
import M5Core
import M5Crypto

enum DuressVerifier {
    typealias Mac = (Data) throws -> Data

    static func input(_ stretched: Bytes) -> Data { SecData.utf8("m5/duress/1|") + Data(stretched) }

    /// Why a new duress PIN is refused: nil (fine), "length" (not exactly the policy's length of digits), "same" (the unlock PIN).
    static func refusal(_ pin: String?, length: Int, isUnlockPin: Bool) -> String? {
        guard let pin, pin.count == length, !pin.isEmpty, pin.allSatisfy({ $0.isASCII && $0.isNumber }) else { return "length" }
        return isUnlockPin ? "same" : nil
    }

    /// The record {salt, iter, tag} for this PIN.
    static func make(pin: String, salt: Data, iterations: Int, mac: Mac) throws -> JSONObject {
        var stretched = PinWrap.stretch(pin: pin, salt: Array(salt), iterations: iterations)
        defer { ByteOps.wipe(&stretched) }
        let tag = try mac(input(stretched))
        return JSONObject([("salt", .string(Bytes.b64(salt))), ("iter", .int(iterations)), ("tag", .string(Bytes.b64(tag)))])
    }

    /// Whether the PIN is the one of this verifier (constant time; false on anything odd).
    static func matches(_ v: JSONObject?, pin: String?, mac: Mac) -> Bool {
        guard let v, let pin, v.isPresent("tag"), v.isPresent("salt") else { return false }
        let iterations = v.optInt("iter", 0)
        guard (1000...10_000_000).contains(iterations), let salt = Bytes.unb64(v.optString("salt")),
              let want = Bytes.unb64(v.optString("tag")) else { return false }
        var stretched = PinWrap.stretch(pin: pin, salt: Array(salt), iterations: iterations)
        defer { ByteOps.wipe(&stretched) }
        guard let tag = try? mac(input(stretched)) else { return false }
        return Bytes.same(tag, want)
    }
}

/// The settings the security code reads (Android Settings keys "security.*").
protocol SecuritySettings: AnyObject, Sendable {
    func bool(_ key: String) -> Bool
    func set(_ key: String, _ value: Bool)
}

enum SecuritySetting {
    /// The duress PIN is on (and set).
    static let duress = "security.duress"
    /// A lock disconnects the rooms too (off: they keep receiving into the lock inbox).
    static let lockDisconnect = "security.lockDisconnect"
    /// The PIN pad's digits at random places, reshuffled after every tap.
    static let shufflePin = "security.shufflePin"
    /// A short flash when a screenshot is taken while screenshots are not allowed.
    static let screenshotFlash = "security.screenshotFlash"
}

/// Until the app's settings store is ported: the security switches as a SYS-tier record.
final class VaultSecuritySettings: SecuritySettings, @unchecked Sendable {
    private let vault: Vault
    private let mutex = NSLock()
    static let record = "security-settings"

    init(vault: Vault) { self.vault = vault }

    func bool(_ key: String) -> Bool { mutex.withLock { vault.json(.sys, Self.record).bool(key) ?? false } }

    func set(_ key: String, _ value: Bool) {
        mutex.withLock {
            var o = vault.json(.sys, Self.record)
            o[key] = .bool(value)
            try? vault.putJson(.sys, Self.record, o)
        }
    }
}

final class DuressPin: @unchecked Sendable {
    static let record = "duress"
    private let vault: Vault
    private let settings: SecuritySettings
    private let iterations: Int

    init(vault: Vault, settings: SecuritySettings, iterations: Int? = nil) {
        self.vault = vault
        self.settings = settings
        self.iterations = iterations ?? vault.iterations
    }

    private var mac: DuressVerifier.Mac { { [keyring = vault.keyring] in try keyring.prf("duress", $0) } }

    private var verifier: JSONObject { vault.json(.sys, Self.record) }

    /// Switched on and set.
    var active: Bool { settings.bool(SecuritySetting.duress) && verifier.isPresent("tag") }

    /// Sets (or replaces) the duress PIN; the caller checked it with refusal().
    func set(_ pin: String) throws {
        try vault.keyring.ensureAgreementKey("duress", access: .foreground)
        let v = try DuressVerifier.make(pin: pin, salt: Bytes.random(16), iterations: iterations, mac: mac)
        try vault.putJson(.sys, Self.record, v, durable: true)
        settings.set(SecuritySetting.duress, true)
    }

    /// Whether this PIN is the duress PIN (switched on and set).
    func check(_ pin: String) -> Bool {
        guard settings.bool(SecuritySetting.duress) else { return false }
        let v = verifier
        return v.isPresent("tag") && DuressVerifier.matches(v, pin: pin, mac: mac)
    }

    /// Whether a PIN may not become the unlock PIN (it is the duress PIN).
    func isDuressPin(_ pin: String) -> Bool {
        let v = verifier
        return v.isPresent("tag") && DuressVerifier.matches(v, pin: pin, mac: mac)
    }

    /// The switch shows what is real: on without a verifier goes off.
    func reconcile() {
        if settings.bool(SecuritySetting.duress) && !verifier.isPresent("tag") { settings.set(SecuritySetting.duress, false) }
    }

    /// Off: the verifier and its key go.
    func clear() {
        vault.delete(.sys, Self.record)
        vault.keyring.delete("duress")
        settings.set(SecuritySetting.duress, false)
    }
}
