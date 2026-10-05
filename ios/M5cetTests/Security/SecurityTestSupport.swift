// What the security tests share: a throwaway directory, a scripted clock, the
// keyrings of both kinds (Secure Enclave where the simulator has one, software),
// a scripted biometric prompt and a SecurityCenter put together from them —
// nothing here touches the app's own files, Keychain items or windows.

import CryptoKit
import Foundation
import LocalAuthentication
import XCTest
@testable import M5cet

// XCTest's asserts take autoclosures, which cannot await: these take the awaited value.
func eq<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a, b, message, file: file, line: line)
}

func isNil<T>(_ a: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(a, message, file: file, line: line)
}

func isTrue(_ a: Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(a, message, file: file, line: line)
}

func isFalse(_ a: Bool, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertFalse(a, message, file: file, line: line)
}

/// A directory of its own per test, removed afterwards.
final class TempDir {
    let url: URL

    init() {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("m5-sec-tests/\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    /// Every file below it (relative paths), for "is anything left" checks.
    func files() -> [String] {
        let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey])
        var out: [String] = []
        while let f = e?.nextObject() as? URL {
            if (try? f.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                out.append(String(f.standardizedFileURL.path.dropFirst(url.standardizedFileURL.path.count + 1)))
            }
        }
        return out.sorted()
    }
}

/// A clock the test moves: wall and monotonic time separately, and the boot session.
final class FakeClock: LockClock, @unchecked Sendable {
    private let lock = NSLock()
    private var t = LockTime(wallMs: 1_767_225_600_000, monoMs: 5_000_000, boot: "boot-A")

    func now() -> LockTime { lock.withLock { t } }

    /// Real time passing (both clocks).
    func advance(seconds: Double) { lock.withLock { t.wallMs += Int64(seconds * 1000); t.monoMs += Int64(seconds * 1000) } }
    /// Someone sets the wall clock (the monotonic one does not move).
    func setWall(by seconds: Double) { lock.withLock { t.wallMs += Int64(seconds * 1000) } }
    /// A reboot after `uptime` seconds of the new boot.
    func reboot(uptime: Double, wallAdvance: Double) {
        lock.withLock {
            t.boot = "boot-" + UUID().uuidString.prefix(4)
            t.monoMs = Int64(uptime * 1000)
            t.wallMs += Int64(wallAdvance * 1000)
        }
    }
}

/// The biometric prompt as a script.
@MainActor
final class ScriptedBiometrics: BiometricAuthenticator {
    var available = true
    var kind = "faceID"
    var enrolmentHash: Data? = Data([1, 2, 3])
    var next: () -> BiometricOutcome = { .success(LAContext()) }
    private(set) var prompts = 0

    func authenticate(reason: String, fallbackTitle: String) async -> BiometricOutcome {
        prompts += 1
        return next()
    }
}

@MainActor
final class ScriptedBackground: BackgroundTime {
    private(set) var begun = 0, ended = 0
    private var expirations: [Int: @MainActor () -> Void] = [:]

    func begin(expiration: @escaping @MainActor () -> Void) -> Int {
        begun += 1
        expirations[begun] = expiration
        return begun
    }

    func end(_ id: Int) {
        ended += 1
        expirations[id] = nil
    }

    /// iOS ends the background time: the expiration handlers run.
    func expire() { for (_, e) in expirations { e() } }
}

/// A participant that records what the lock told it.
@MainActor
final class RecordingParticipant: LockParticipant {
    var calls: [String] = []
    var inbox: LockInbox?
    func lockWillForget(receiving inbox: LockInbox?) {
        self.inbox = inbox
        calls.append(inbox == nil ? "willForget(disconnect)" : "willForget(receiving)")
    }
    func lockDidForget() { calls.append("didForget") }
    func lockDidUnlock() { calls.append("didUnlock") }
}

/// A consumer of the lock inbox's drain that keeps what it got.
final class RecordingConsumer: LockInboxConsumer, @unchecked Sendable {
    private let lock = NSLock()
    private var _parsed: [LockInboxParsedCopy] = []
    private var _restored = 0

    struct LockInboxParsedCopy {
        var rooms: [String: [String]]
        var pins: [String]
    }

    func apply(_ parsed: LockInboxParsed, inbox: LockInbox) {
        var rooms: [String: [String]] = [:]
        for r in parsed.rooms { rooms[r.room] = r.items.map { ($0["m"] as? [String: Any])?["id"] as? String ?? $0.jString("t") } }
        lock.withLock { _parsed.append(LockInboxParsedCopy(rooms: rooms, pins: parsed.pins.map(\.slot))) }
    }

    func restoreAll() { lock.withLock { _restored += 1 } }

    var parsed: [LockInboxParsedCopy] { lock.withLock { _parsed } }
    var restored: Int { lock.withLock { _restored } }
}

enum TestKeys {
    /// The Secure Enclave keyring where this simulator has one (Apple silicon), with software biometric keys.
    static func enclave(_ store: SecureStore) throws -> Keyring {
        guard EnclaveKeyMaker.available else { throw XCTSkip("no Secure Enclave on this runner") }
        return Keyring(store: store, enclave: EnclaveKeyMaker(), softwareBiometry: true)
    }

    static func software(_ store: SecureStore) -> Keyring { Keyring(store: store, enclave: nil) }
}

/// A signed policy as the server makes it (server/android/crypto.ts signPolicy), with a test server key.
struct TestServer {
    let key = P256.Signing.PrivateKey()
    var spki: String { Bytes.b64(key.publicKey.derRepresentation) }

    func signedPolicy(_ lock: SecRecord, deviceId: String, at: Int64) throws -> SecRecord {
        let json = SecJSON.string(["lock": lock])
        let sig = try key.signature(for: Bytes.utf8(SignedPolicy.signedString(deviceId: deviceId, at: at, policyJson: json)))
        return ["at": at, "policy": json, "sig": Bytes.b64(sig.rawRepresentation)]
    }
}

/// A SecurityCenter of throwaway parts.
@MainActor
struct Fixture {
    let dir = TempDir()
    let store = MemorySecureStore()
    let clock = FakeClock()
    let bio = ScriptedBiometrics()
    let background = ScriptedBackground()
    let events = LoggedSecurityEvents()
    let center: SecurityCenter
    let server = TestServer()
    static let deviceId = "ios_test1"
    static let iterations = 1000

    init(enclave: Bool = false) throws {
        let keyring = enclave ? try TestKeys.enclave(store) : TestKeys.software(store)
        center = SecurityCenter(paths: .under(dir.url), store: store, keyring: keyring, clock: clock, biometrics: bio,
                                background: background, events: events, iterations: Self.iterations,
                                extraDirs: [dir.url.appendingPathComponent("caches", isDirectory: true)])
    }

    var lock: AppLock { center.lock }
    var vault: Vault { center.vault }

    /// Applies a lock policy as the server would sign it.
    func policy(_ lock: SecRecord, at: Int64 = 1) throws {
        let ok = center.policies.apply(answer: ["policySigned": try server.signedPolicy(lock, deviceId: Self.deviceId, at: at)],
                                       serverKey: server.spki, deviceId: Self.deviceId)
        XCTAssertTrue(ok, "the test policy applies")
    }

    func eventTypes() -> [String] { events.events.map(\.type) }
}
