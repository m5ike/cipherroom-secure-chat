// The app lock end to end on throwaway parts (SecurityCenter with a memory Keychain,
// a temporary directory and a scripted clock): setup, the PIN, attempts with the
// growing wait and the policy's wipe or lock-out, a rolled-back counter, the duress
// PIN, biometrics, the auto-lock (timer, return, suspension, a call), a lock that
// forgets the data key and opens a lock inbox — merged at the unlock — and the
// strict "disconnect when locked". The clock is moved by hand: the wall clock alone
// never shortens a wait.

import LocalAuthentication
import M5Core
import XCTest
@testable import M5cet

@MainActor
final class AppLockTests: XCTestCase {
    private let pin = "482915"

    private func setUp(_ f: Fixture) async throws {
        try await f.lock.setUp(pin: pin)
        XCTAssertTrue(f.lock.isSetUp)
        XCTAssertFalse(f.lock.isLocked)
    }

    func testSetUpLockAndUnlock() async throws {
        let f = try Fixture()
        XCTAssertFalse(f.lock.isSetUp)
        XCTAssertTrue(f.lock.isLocked, "a process starts locked")
        try await setUp(f)
        try f.vault.put(.user, "rooms", Data("[]".utf8))
        let held = try f.vault.userKey()
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.lock.isLocked)
        XCTAssertFalse(f.vault.unlocked, "a lock forgets the data key")
        XCTAssertTrue(held.isWiped)
        eq(await f.lock.unlock(pin: "000000"), .wrong)
        XCTAssertEqual(f.lock.attempts, 1)
        XCTAssertEqual(f.lock.left, 7)
        eq(await f.lock.unlock(pin: pin), .ok)
        XCTAssertFalse(f.lock.isLocked)
        XCTAssertEqual(try f.vault.get(.user, "rooms"), Data("[]".utf8))
        XCTAssertEqual(f.lock.attempts, 0, "a success resets the counter")
        XCTAssertTrue(f.eventTypes().contains("unlock-failed"))
        XCTAssertTrue(f.eventTypes().contains("unlock"), "an unlock after failures is reported")
    }

    func testTheWaitGrowsAndTheWallClockDoesNotSkipIt() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.lock.lockNow(remote: false)
        for _ in 0..<3 { eq(await f.lock.unlock(pin: "111111"), .wrong) }
        XCTAssertEqual(f.lock.waitSeconds, 30)
        eq(await f.lock.unlock(pin: pin), .wait, "even the right PIN waits")
        XCTAssertEqual(f.lock.attempts, 3, "a refused attempt is not counted")
        f.clock.setWall(by: 7200)
        eq(await f.lock.unlock(pin: pin), .wait, "moving the wall clock skips nothing")
        f.clock.reboot(uptime: 5, wallAdvance: 3600)
        XCTAssertEqual(f.lock.waitSeconds, 25, "after a reboot only the uptime counts")
        eq(await f.lock.unlock(pin: pin), .wait)
        f.clock.advance(seconds: 25)
        eq(await f.lock.unlock(pin: "222222"), .wrong)
        XCTAssertEqual(f.lock.waitSeconds, 60, "the fourth failure: 60 s")
        f.clock.advance(seconds: 60)
        eq(await f.lock.unlock(pin: pin), .ok)
    }

    func testTheLastAttemptWipesEverything() async throws {
        let f = try Fixture()
        try f.policy(["maxAttempts": 3, "backoff": false])
        try await setUp(f)
        try f.vault.put(.user, "rooms", Data("[]".utf8))
        try f.vault.put(.sys, "config", Data("{}".utf8))
        f.lock.lockNow(remote: false)
        eq(await f.lock.unlock(pin: "000001"), .wrong)
        eq(await f.lock.unlock(pin: "000002"), .wrong)
        eq(await f.lock.unlock(pin: "000003"), .wiped)
        XCTAssertFalse(f.lock.isSetUp)
        XCTAssertEqual(f.dir.files().filter { !$0.hasPrefix("group/m5/lock-state.json") }, [])
        XCTAssertEqual(try f.keychainNames(), [], "every Keychain item and key is gone")
        XCTAssertTrue(f.center.wipedNotice, "a wipe of the attempts says so")
        XCTAssertTrue(f.eventTypes().contains("lockout"))
    }

    func testWithoutWipeTheLastAttemptLocksOutForAnHour() async throws {
        let f = try Fixture()
        try f.policy(["maxAttempts": 3, "wipe": false, "backoff": false])
        try await setUp(f)
        f.lock.lockNow(remote: false)
        _ = await f.lock.unlock(pin: "000001")
        _ = await f.lock.unlock(pin: "000002")
        eq(await f.lock.unlock(pin: "000003"), .lockedOut)
        XCTAssertTrue(f.lock.isSetUp)
        XCTAssertEqual(f.lock.waitSeconds, 3600)
        eq(await f.lock.unlock(pin: pin), .wait)
        f.clock.advance(seconds: 3600)
        eq(await f.lock.unlock(pin: pin), .ok)
    }

    func testAnInterruptedAttemptCountsAsAFailure() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.lock.lockNow(remote: false)
        // The app died during a derivation: the counter says "pending".
        let anchor = KeyringLockAnchor(keyring: f.center.keyring), records = SecureStoreLockRecords(store: f.store)
        let store = LockStore(anchor: anchor, records: records)
        var s = store.load().state
        LockCounter.begin(&s, now: f.clock.now())
        XCTAssertTrue(store.save(s))
        eq(await f.lock.unlock(pin: pin), .ok, "settled as a failure first, then checked")
        let failed = f.events.events.filter { $0.type == "unlock-failed" }
        XCTAssertEqual(failed.last?.detail["method"] as? String, "pin-interrupted")
    }

    func testARolledBackCounterUsesEveryAttempt() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.lock.lockNow(remote: false)
        let before = try XCTUnwrap(try f.store.read("lock"))
        eq(await f.lock.unlock(pin: "000001"), .wrong)
        eq(await f.lock.unlock(pin: "000002"), .wrong)
        // Someone puts the older counter back (to get the attempts back).
        try f.store.write("lock", before, access: .foreground)
        eq(await f.lock.unlock(pin: pin), .wiped, "a rollback is every attempt used: the policy's wipe")
        XCTAssertFalse(f.lock.isSetUp)
    }

    func testTheDuressPinErasesQuietly() async throws {
        let f = try Fixture()
        try await setUp(f)
        eq(await f.lock.setDuress(pin: pin), "same", "the duress PIN must differ from the unlock PIN")
        eq(await f.lock.setDuress(pin: "12345"), "length")
        isNil(await f.lock.setDuress(pin: "999111"))
        XCTAssertTrue(f.center.duress.active)
        eq(await f.lock.changePin(current: pin, new: "999111"), .refused("duress"), "a new PIN may not be the duress PIN")
        f.lock.lockNow(remote: false)
        // Typed during a wait too.
        for _ in 0..<3 { _ = await f.lock.unlock(pin: "000000") }
        XCTAssertGreaterThan(f.lock.waitSeconds, 0)
        eq(await f.lock.unlock(pin: "999111"), .duress)
        XCTAssertFalse(f.lock.isSetUp)
        XCTAssertFalse(f.center.wipedNotice, "quiet: no \"data erased\" notice")
        XCTAssertEqual(try f.keychainNames(), [])
    }

    func testChangingThePinCountsTheCurrentOne() async throws {
        let f = try Fixture()
        try await setUp(f)
        eq(await f.lock.changePin(current: "000000", new: "135790"), .wrongCurrent(.wrong))
        XCTAssertEqual(f.lock.attempts, 1)
        eq(await f.lock.changePin(current: pin, new: "13579"), .refused("length"))
        eq(await f.lock.changePin(current: pin, new: "135790"), .ok)
        f.lock.lockNow(remote: false)
        eq(await f.lock.unlock(pin: pin), .wrong)
        eq(await f.lock.unlock(pin: "135790"), .ok)
    }

    func testBiometricsUnlockAndAChangedEnrolmentSwitchesThemOff() async throws {
        let f = try Fixture()
        try await setUp(f)
        try f.lock.enrollBiometrics()
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.lock.biometricAvailable)
        f.bio.next = { .cancelled }
        eq(await f.lock.unlockWithBiometrics(reason: "r", fallbackTitle: "PIN"), .cancelled)
        XCTAssertEqual(f.lock.attempts, 0, "a cancelled prompt counts nothing")
        f.bio.next = { .success(LAContext()) }
        eq(await f.lock.unlockWithBiometrics(reason: "r", fallbackTitle: "PIN"), .ok)
        XCTAssertFalse(f.lock.isLocked)
        // A new face / finger enrolled: the key no longer opens — off before any prompt.
        f.lock.lockNow(remote: false)
        f.bio.enrolmentHash = Data([9])
        let prompts = f.bio.prompts
        eq(await f.lock.unlockWithBiometrics(reason: "r", fallbackTitle: "PIN"), .cancelled)
        XCTAssertEqual(f.bio.prompts, prompts)
        XCTAssertFalse(f.vault.bioEnrolled)
        XCTAssertTrue(f.eventTypes().contains("key-invalidated"))
        // The policy can switch biometrics off.
        eq(await f.lock.unlock(pin: pin), .ok)
        try f.lock.enrollBiometrics()
        try f.policy(["biometric": "off"])
        XCTAssertFalse(f.lock.biometricAvailable)
    }

    // MARK: the auto-lock

    func testTheAutoLockAfterTheBackgroundTime() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.lock.onBackground()
        f.clock.advance(seconds: 59)
        XCTAssertFalse(f.lock.isLocked)
        f.lock.onForeground()
        XCTAssertTrue(f.vault.unlocked, "back within the auto-lock: still open")
        f.lock.onBackground()
        f.clock.advance(seconds: 60)
        XCTAssertTrue(f.lock.isLocked, "locked in the background already (neutral notifications)")
        f.lock.onForeground()
        XCTAssertFalse(f.vault.unlocked, "…and the data key is gone")
        eq(await f.lock.unlock(pin: pin), .ok)
        // The wall clock moved by a day in the background does not lock (nor would moving it back unlock).
        f.lock.onBackground()
        f.clock.setWall(by: 86_400)
        f.lock.onForeground()
        XCTAssertTrue(f.vault.unlocked)
    }

    func testAutoLockZeroAndTheSuspension() async throws {
        let f = try Fixture()
        try f.policy(["autolockSeconds": 0])
        try await setUp(f)
        f.lock.onBackground()
        XCTAssertFalse(f.vault.unlocked, "auto-lock 0: at once")
        eq(await f.lock.unlock(pin: pin), .ok)
        // The lock inbox of that lock merges first (a lock meanwhile would wait for it).
        for _ in 0..<100 where f.center.inbox.isDraining { try await Task.sleep(for: .milliseconds(10)) }
        try f.policy(["autolockSeconds": 300], at: 2)
        f.lock.onBackground()
        XCTAssertTrue(f.vault.unlocked)
        XCTAssertEqual(f.background.begun, 1, "a background task to see the time pass")
        // iOS is about to suspend the app before the auto-lock's time: the key does not sleep in it.
        f.background.expire()
        XCTAssertFalse(f.vault.unlocked)
        XCTAssertTrue(f.lock.isLocked)
        XCTAssertEqual(f.background.ended, 1)
    }

    func testACallKeepsTheKeyUntilItEnds() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.center.inCall = { true }
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.lock.isLocked, "the screen locks at once")
        XCTAssertTrue(f.vault.unlocked, "the key stays for the call")
        XCTAssertTrue(f.lock.forgetWaiting)
        f.lock.lockNow(remote: true)
        XCTAssertFalse(f.vault.unlocked, "the server's lock command takes it during a call too")
        eq(await f.lock.unlock(pin: pin), .ok)
    }

    // MARK: forgetting, the lock inbox and the strict mode

    func testALockReceivesIntoTheInboxAndTheUnlockMergesIt() async throws {
        let f = try Fixture()
        let rooms = RecordingParticipant()
        let consumer = RecordingConsumer()
        f.center.add(rooms)
        f.center.inboxConsumer = consumer
        try await setUp(f)
        f.lock.lockNow(remote: false)
        XCTAssertEqual(rooms.calls, ["willForget(receiving)", "didForget"])
        let inbox = try XCTUnwrap(rooms.inbox)
        XCTAssertTrue(inbox.isActive)
        XCTAssertFalse(f.vault.unlocked)
        // Messages keep arriving while locked.
        XCTAssertTrue(inbox.seal(TestItems.message(room: "family", id: "m1", text: "hi")))
        XCTAssertTrue(inbox.seal(TestItems.message(room: "family", id: "m2", text: "there")))
        eq(await f.lock.unlock(pin: pin), .ok)
        XCTAssertEqual(rooms.calls.last, "didUnlock")
        for _ in 0..<100 where consumer.restored == 0 { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(inbox.isActive)
        XCTAssertEqual(consumer.parsed.first?.rooms["family"], ["m1", "m2"])
        XCTAssertEqual(consumer.restored, 1)
        XCTAssertFalse(inbox.hasPending)
    }

    func testALockDuringTheMergeWaitsForIt() async throws {
        let f = try Fixture()
        let consumer = RecordingConsumer()
        f.center.inboxConsumer = consumer
        try await setUp(f)
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.center.inbox.seal(TestItems.message(room: "r", id: "m1")))
        eq(await f.lock.unlock(pin: pin), .ok)
        // Locked again at once, before the merge ran: the key stays until it is done, then goes.
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.lock.isLocked)
        XCTAssertTrue(f.vault.unlocked, "the merge needs the data key")
        XCTAssertTrue(f.lock.forgetWaiting)
        for _ in 0..<150 where f.vault.unlocked { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertFalse(f.vault.unlocked, "forgotten right after the merge")
        XCTAssertEqual(consumer.parsed.first?.rooms["r"], ["m1"])
        XCTAssertTrue(f.center.inbox.isActive, "the new lock's generation is open — not closed by the merge")
        XCTAssertTrue(f.center.inbox.seal(TestItems.message(room: "r", id: "m2")))
    }

    func testTheStrictModeDisconnects() async throws {
        let f = try Fixture()
        let rooms = RecordingParticipant()
        f.center.add(rooms)
        try await setUp(f)
        f.center.settings.set(SecuritySetting.lockDisconnect, true)
        f.lock.lockNow(remote: false)
        XCTAssertEqual(rooms.calls, ["willForget(disconnect)", "didForget"])
        XCTAssertFalse(f.center.inbox.isActive)
        XCTAssertFalse(f.center.inbox.hasPending)
    }

    func testTheNotificationExtensionsMirror() async throws {
        let f = try Fixture()
        try await setUp(f)
        f.lock.onBackground()
        let m = try XCTUnwrap(SecData.json(Data(contentsOf: f.center.paths.lockState)))
        XCTAssertEqual(m.bool("locked"), false)
        XCTAssertGreaterThan(m.optInt64("bg"), 0)
        XCTAssertEqual(m.optInt("autolock"), 60)
        XCTAssertEqual(m.optString("boot"), "boot-A")
        f.lock.lockNow(remote: false)
        XCTAssertEqual(try XCTUnwrap(SecData.json(Data(contentsOf: f.center.paths.lockState))).bool("locked"), true)
        // Nothing of the user tier on the extension's side.
        XCTAssertTrue(f.dir.files().filter { $0.hasPrefix("group/") }.allSatisfy { !$0.contains("user") && !$0.contains("lockbox") })
    }
}
