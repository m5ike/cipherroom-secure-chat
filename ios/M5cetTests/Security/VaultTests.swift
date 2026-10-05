// The two tiers: the SYS tier opens without the user (and again in a new process),
// the USER tier only with the PIN or biometrics; records are bound to their tier and
// name; a lock zeroes the data key for every reader; only SYS material is in the
// App Group (the notification extension's) side; the directories are excluded from
// backups. Both key paths: software and (where present) the Secure Enclave.

import M5Core
import XCTest
@testable import M5cet

final class VaultTests: XCTestCase {
    private func vault(_ dir: TempDir, _ store: SecureStore = MemorySecureStore(), enclave: Bool = false) throws -> Vault {
        let k = enclave ? try TestKeys.enclave(store) : TestKeys.software(store)
        return Vault(paths: .under(dir.url), keyring: k, iterations: 1000)
    }

    func testTheSystemTierOpensWithoutTheUserAndInANewProcess() throws {
        for enclave in [false, true] where !enclave || EnclaveKeyMaker.available {
            let dir = TempDir(), store = MemorySecureStore()
            let v = try vault(dir, store, enclave: enclave)
            try v.putJson(.sys, "config", JSONObject([("server", "https://chat.example.com"), ("deviceId", "ios_1")]))
            XCTAssertEqual(v.json(.sys, "config").optString("deviceId"), "ios_1")
            // A new process: the same files and Keychain, nothing in memory.
            let again = try vault(dir, store, enclave: enclave)
            XCTAssertEqual(again.json(.sys, "config").optString("server"), "https://chat.example.com")
            let wrap = try XCTUnwrap(SecData.json(Data(contentsOf: v.paths.sysKey)))
            XCTAssertEqual(wrap.optString("hw"), enclave ? "secure-enclave" : "software")
            // Without the sys key in the Keychain the tier is noise.
            store.deleteAll()
            let lost = try vault(dir, store, enclave: enclave)
            XCTAssertThrowsError(try lost.get(.sys, "config"))
        }
    }

    func testRecordsAreBoundToTheirTierAndName() throws {
        let dir = TempDir()
        let v = try vault(dir)
        try v.createUserKey(pin: "123456")
        try v.put(.sys, "a", Data("system".utf8))
        try v.put(.user, "a", Data("user".utf8))
        try v.put(.user, "b", Data("bee".utf8), durable: true)
        XCTAssertEqual(try v.get(.sys, "a"), Data("system".utf8))
        XCTAssertEqual(try v.get(.user, "a"), Data("user".utf8))
        XCTAssertNil(try v.get(.user, "none"))
        // A file swapped for another's does not open (AAD "USER|b").
        try FileManager.default.removeItem(at: v.recordURL(.user, "b"))
        try FileManager.default.copyItem(at: v.recordURL(.user, "a"), to: v.recordURL(.user, "b"))
        XCTAssertThrowsError(try v.get(.user, "b"))
        XCTAssertEqual(v.strictJson(.user, "b")?.bool(LockStore.unreadable), true)
        XCTAssertEqual(v.strictJson(.user, "missing")?.count, 0)
        XCTAssertThrowsError(try v.recordURL(.sys, "../escape"))
        XCTAssertThrowsError(try v.recordURL(.sys, ""))
        // The plaintext is nowhere on the disk.
        for f in dir.files() {
            let d = try Data(contentsOf: dir.url.appendingPathComponent(f))
            XCTAssertNil(d.range(of: Data("system".utf8)), f)
            XCTAssertNil(d.range(of: Data("bee".utf8)), f)
        }
    }

    func testTheUserTierNeedsThePin() throws {
        for enclave in [false, true] where !enclave || EnclaveKeyMaker.available {
            let dir = TempDir(), store = MemorySecureStore()
            let v = try vault(dir, store, enclave: enclave)
            XCTAssertFalse(v.hasUserKey)
            XCTAssertThrowsError(try v.userKey()) { XCTAssertEqual($0 as? SecurityError, .locked) }
            try v.createUserKey(pin: "482915")
            XCTAssertTrue(v.unlocked)
            XCTAssertEqual(v.pinKeyLevel, enclave ? "secure-enclave" : "software")
            try v.put(.user, "rooms", Data("[1,2]".utf8))
            let reader = try v.userKey()
            v.lock()
            XCTAssertFalse(v.unlocked)
            XCTAssertTrue(reader.isWiped, "a lock zeroes the key for readers that took it earlier")
            XCTAssertThrowsError(try v.get(.user, "rooms"))
            // A new process: only the PIN opens it.
            let again = try vault(dir, store, enclave: enclave)
            XCTAssertFalse(try again.unlockWithPin("482916"))
            XCTAssertFalse(again.unlocked)
            XCTAssertTrue(again.opensWith("482915"))
            XCTAssertFalse(again.unlocked, "opensWith keeps nothing")
            XCTAssertTrue(try again.unlockWithPin("482915"))
            XCTAssertEqual(try again.get(.user, "rooms"), Data("[1,2]".utf8))
            // A new PIN: the same data key.
            try again.changePin("111222")
            again.lock()
            XCTAssertFalse(try again.unlockWithPin("482915"))
            XCTAssertTrue(try again.unlockWithPin("111222"))
            XCTAssertEqual(try again.get(.user, "rooms"), Data("[1,2]".utf8))
            // Without the PIN key (another device's enclave) the right PIN opens nothing.
            again.lock()
            again.keyring.delete("pin")
            XCTAssertThrowsError(try again.unlockWithPin("111222"))
        }
    }

    func testReopeningWhileUnlockedKeepsTheHeldKey() throws {
        let v = try vault(TempDir())
        try v.createUserKey(pin: "123456")
        let held = try v.userKey()
        XCTAssertTrue(try v.unlockWithPin("123456"))
        XCTAssertFalse(held.isWiped, "readers of the held key keep working")
        XCTAssertTrue(try v.userKey() === held)
    }

    func testBiometricsWrapTheSameKey() throws {
        let dir = TempDir(), store = MemorySecureStore()
        let v = try vault(dir, store, enclave: EnclaveKeyMaker.available)
        try v.createUserKey(pin: "123456")
        try v.put(.user, "x", Data("secret".utf8))
        let level = try v.enrollBiometrics()
        XCTAssertTrue(v.bioEnrolled)
        #if targetEnvironment(simulator)
        XCTAssertEqual(level, .software, "the simulator's enclave makes no biometric keys")
        #endif
        v.lock()
        try v.unlockWithBiometrics(context: nil)
        XCTAssertEqual(try v.get(.user, "x"), Data("secret".utf8))
        // The wrap carries the AAD's purpose: as a PIN wrap it is nothing.
        let wrap = try XCTUnwrap(SecData.json(Data(contentsOf: v.paths.bioWrap)))
        XCTAssertEqual(wrap.optInt("v"), 1)
        XCTAssertFalse(wrap.optString("e").isEmpty)
        v.disableBiometrics()
        XCTAssertFalse(v.bioEnrolled)
        v.lock()
        XCTAssertThrowsError(try v.unlockWithBiometrics(context: nil))
    }

    func testOnlyTheSystemTierIsOnTheSharedSide() throws {
        let dir = TempDir()
        let v = try vault(dir)
        try v.createUserKey(pin: "123456")
        try v.put(.sys, "policy", Data("{}".utf8))
        try v.put(.user, "rooms", Data("[]".utf8))
        _ = try v.enrollBiometrics()
        let shared = dir.files().filter { $0.hasPrefix("group/") }
        XCTAssertEqual(Set(shared), ["group/m5/sys.key", "group/m5/sys/policy.bin"])
        let app = dir.files().filter { $0.hasPrefix("app/") }
        XCTAssertEqual(Set(app), ["app/m5/user.pin", "app/m5/user.bio", "app/m5/user/rooms.bin"])
        // Excluded from backups.
        for d in [v.paths.root, v.paths.shared, v.paths.sysDir, v.paths.userDir] {
            XCTAssertEqual(try d.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, d.path)
        }
    }
}
