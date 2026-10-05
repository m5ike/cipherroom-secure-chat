// The counter's rules (Android LockCounterTest) and iOS's monotonic waits: the
// attempt counts before the slow check, the wipe after the last attempt stays, the
// wait grows from the third failure — and moving the wall clock or rebooting never
// shortens a wait (Android's known weakness M4).

import M5Core
import XCTest
@testable import M5cet

final class LockCounterTests: XCTestCase {
    private let t = LockTime(wallMs: 1_700_000_000_000, monoMs: 1_000_000, boot: "A")

    private func at(_ seconds: Int64, wall: Int64 = 0, boot: String = "A", mono: Int64? = nil) -> LockTime {
        LockTime(wallMs: t.wallMs + seconds * 1000 + wall * 1000, monoMs: mono ?? (t.monoMs + seconds * 1000), boot: boot)
    }

    /// The record as the Keychain keeps it — a JSON round trip.
    private func stored(_ s: JSONObject) -> JSONObject { JSON.parseObject(s.stringify())! }

    func testAnAttemptCountsBeforeTheCheck() {
        var s = LockCounter.fresh()
        XCTAssertEqual(LockCounter.begin(&s, now: t), 1)
        var afterKill = stored(s)
        XCTAssertEqual(afterKill.optInt("attempts"), 1)
        XCTAssertTrue(LockCounter.interrupted(afterKill))
        XCTAssertEqual(LockCounter.settle(&afterKill, now: at(5), maxAttempts: 8, wipe: true, backoff: true), .wrong)
        XCTAssertEqual(afterKill.optInt("attempts"), 1, "counted once, not twice")
        XCTAssertFalse(LockCounter.interrupted(afterKill))
    }

    func testKillingTheAppEveryTimeStillReachesTheWipe() {
        var s = LockCounter.fresh()
        for i in 0..<8 {
            s = stored(s)
            if LockCounter.interrupted(s) {
                if LockCounter.settle(&s, now: at(Int64(i)), maxAttempts: 8, wipe: true, backoff: false) != .wrong { break }
            }
            LockCounter.begin(&s, now: at(Int64(i))) // …and killed before an answer, again
        }
        s = stored(s)
        XCTAssertTrue(LockCounter.interrupted(s))
        XCTAssertEqual(s.optInt("attempts"), 8)
        XCTAssertEqual(LockCounter.settle(&s, now: at(100), maxAttempts: 8, wipe: true, backoff: false), .wipe)
    }

    func testAWrongLastAttemptWipesOrLocksOut() {
        var s = JSONObject([("attempts", .int(7))])
        LockCounter.begin(&s, now: t)
        var w = stored(s)
        XCTAssertEqual(LockCounter.settle(&w, now: t, maxAttempts: 8, wipe: true, backoff: true), .wipe)
        var l = stored(s)
        XCTAssertEqual(LockCounter.settle(&l, now: t, maxAttempts: 8, wipe: false, backoff: true), .lockedOut)
        XCTAssertEqual(l.optInt64("until"), t.wallMs + LockCounter.lockoutMs)
        XCTAssertEqual(LockCounter.waitLeftMs(l, now: t), LockCounter.lockoutMs)
    }

    func testARejectedBiometricCountsOnce() {
        var s = LockCounter.fresh()
        XCTAssertEqual(LockCounter.settle(&s, now: t, maxAttempts: 8, wipe: true, backoff: true), .wrong)
        XCTAssertEqual(s.optInt("attempts"), 1)
        XCTAssertEqual(LockCounter.settle(&s, now: t, maxAttempts: 8, wipe: true, backoff: true), .wrong)
        XCTAssertEqual(s.optInt("attempts"), 2)
    }

    func testTheWaitGrowsFromTheThirdFailure() {
        var s = LockCounter.fresh()
        for _ in 0..<2 {
            LockCounter.begin(&s, now: t)
            _ = LockCounter.settle(&s, now: t, maxAttempts: 20, wipe: true, backoff: true)
        }
        XCTAssertEqual(s.optInt64("until"), 0)
        LockCounter.begin(&s, now: t)
        _ = LockCounter.settle(&s, now: t, maxAttempts: 20, wipe: true, backoff: true)
        XCTAssertEqual(s.optInt64("until"), t.wallMs + 30_000)
        XCTAssertEqual(LockCounter.waitMs(4), 60_000)
        XCTAssertEqual(LockCounter.waitMs(19), 3_600_000)
        var noBackoff = JSONObject([("attempts", .int(5))])
        _ = LockCounter.settle(&noBackoff, now: t, maxAttempts: 20, wipe: true, backoff: false)
        XCTAssertFalse(noBackoff.isPresent("until"))
    }

    func testAutolockAppliesInTheBackground() {
        XCTAssertFalse(AppLock.autolockDue(since: nil, now: 5, seconds: 60))
        XCTAssertFalse(AppLock.autolockDue(since: 1000, now: 1000 + 59_999, seconds: 60))
        XCTAssertTrue(AppLock.autolockDue(since: 1000, now: 1000 + 60_000, seconds: 60))
        XCTAssertTrue(AppLock.autolockDue(since: 1000, now: 1000, seconds: 0))
    }

    // MARK: iOS: the monotonic wait (M4)

    func testMovingTheWallClockDoesNotSkipTheWait() {
        var s = JSONObject([("attempts", .int(2))])
        LockCounter.begin(&s, now: t)
        _ = LockCounter.settle(&s, now: t, maxAttempts: 8, wipe: true, backoff: true)
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: t), 30_000)
        // The wall clock a day ahead, no real time passed: still the whole wait.
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: at(0, wall: 86_400)), 30_000)
        // …or back a day: never longer than the wait itself.
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: at(0, wall: -86_400)), 30_000)
        // Real time: it runs out.
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: at(20)), 10_000)
        XCTAssertEqual(LockCounter.waitSeconds(stored(s), now: at(29)), 1)
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: at(30)), 0)
    }

    func testARebootNeverShortensTheWait() {
        var s = JSONObject([("attempts", .int(7))])
        LockCounter.begin(&s, now: t)
        _ = LockCounter.settle(&s, now: t, maxAttempts: 8, wipe: false, backoff: true) // an hour's lock-out
        // Rebooted 10 s ago with the wall clock moved a day ahead: only the 10 s since the boot count.
        let afterBoot = LockTime(wallMs: t.wallMs + 86_400_000, monoMs: 10_000, boot: "B")
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: afterBoot), LockCounter.lockoutMs - 10_000)
        XCTAssertTrue(LockCounter.needsReanchor(stored(s), now: afterBoot))
        // Anchored on this boot: it counts down on this boot's clock.
        var r = stored(s)
        LockCounter.reanchor(&r, now: afterBoot)
        XCTAssertFalse(LockCounter.needsReanchor(r, now: afterBoot))
        let later = LockTime(wallMs: afterBoot.wallMs, monoMs: afterBoot.monoMs + 600_000, boot: "B")
        XCTAssertEqual(LockCounter.waitLeftMs(r, now: later), LockCounter.lockoutMs - 10_000 - 600_000)
        // Up longer than the wait: it is over.
        XCTAssertEqual(LockCounter.waitLeftMs(stored(s), now: LockTime(wallMs: 0, monoMs: LockCounter.lockoutMs + 1, boot: "C")), 0)
    }

    func testTheNextAttemptClearsAnOverWait() {
        var s = JSONObject([("attempts", .int(3))])
        LockCounter.startWait(&s, ms: 30_000, now: t)
        LockCounter.begin(&s, now: at(31))
        XCTAssertEqual(s.optInt64("until"), 0)
        XCTAssertFalse(s.isPresent("wait"))
        XCTAssertEqual(LockCounter.waitLeftMs(s, now: LockTime(wallMs: 0, monoMs: 1, boot: "Z")), 0, "a later reboot restarts nothing")
    }

    func testARollbackUsesEveryAttempt() {
        for max in [3, 8, 20] {
            var s = LockCounter.rolledBack(maxAttempts: max)
            XCTAssertEqual(LockCounter.settle(&s, now: t, maxAttempts: max, wipe: true, backoff: true), .wipe)
            XCTAssertEqual(s.optInt("attempts"), max)
            var l = LockCounter.rolledBack(maxAttempts: max)
            XCTAssertEqual(LockCounter.settle(&l, now: t, maxAttempts: max, wipe: false, backoff: true), .lockedOut)
            XCTAssertEqual(l.optInt64("until"), t.wallMs + LockCounter.lockoutMs)
        }
    }
}
