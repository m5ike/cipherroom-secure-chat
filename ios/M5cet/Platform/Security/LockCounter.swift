// The rules of the unlock-attempt counter (Android security/LockCounter). Pure:
// the state is the record, the time is given — LockCounterTests run it.
//
//   - an attempt counts before the slow PIN derivation (6.7, audit S10): begin()
//     raises the counter and marks it "pending"; AppLock stores that before deriving,
//     so killing the app meanwhile cannot forget it — the next attempt settles it
//     as a failure first;
//   - from the third failure a wait: 30 s, doubling, at most an hour; at the
//     policy's maximum the wipe, or (no wipe) an hour's lock-out;
//   - a rollback found by LockStore counts as every attempt used (rolledBack).
//
// iOS improvement on Android's known weakness M4 (the wait was wall-clock time:
// moving the clock forward skipped it): the wait is measured on the monotonic
// clock (CLOCK_MONOTONIC, which keeps counting while the device sleeps) of the
// boot session it started in ("boot" = kern.bootsessionuuid, "untilMono"). The
// wall-clock "until" stays for display and Android's shape. After a reboot the
// monotonic clock starts again from zero; then only the time since that boot is
// sure to have passed, so what is left is wait − uptime, anchored anew — a
// reboot or a moved clock never shortens a wait (it can lengthen one by the
// time the device was off).

import Foundation
import M5Core

/// A moment on both clocks.
struct LockTime: Sendable, Equatable {
    /// Wall-clock milliseconds since 1970 (display, events).
    var wallMs: Int64
    /// Monotonic milliseconds of this boot session (counts during sleep).
    var monoMs: Int64
    /// This boot session's id.
    var boot: String
}

/// Where AppLock takes the time from (tests give their own).
protocol LockClock: Sendable {
    func now() -> LockTime
}

struct SystemLockClock: LockClock {
    static let bootSession: String = {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0) == 0 else { return "" }
        return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }()

    func now() -> LockTime {
        LockTime(wallMs: Int64(Date().timeIntervalSince1970 * 1000),
                 monoMs: Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000),
                 boot: Self.bootSession)
    }
}

enum LockCounter {
    enum Outcome: Equatable { case wrong, lockedOut, wipe }

    static let lockoutMs: Int64 = 3_600_000

    /// The attempt about to be checked counts now; returns the new count.
    @discardableResult
    static func begin(_ s: inout JSONObject, now: LockTime) -> Int {
        let attempts = s.optInt("attempts") + 1
        s["attempts"] = .int(attempts)
        s["last"] = .int(now.wallMs)
        s["pending"] = .int(now.wallMs)
        clearWait(&s) // only begun once the wait is over
        return attempts
    }

    /// An attempt was begun and never finished (the app died while checking it).
    static func interrupted(_ s: JSONObject) -> Bool { s.isPresent("pending") }

    /// A wrong answer, or one that never came: decides on the wait, the lock-out or the wipe.
    /// An attempt begin() counted is not counted twice; any other failure is counted here.
    static func settle(_ s: inout JSONObject, now: LockTime, maxAttempts: Int, wipe: Bool, backoff: Bool) -> Outcome {
        var attempts = s.optInt("attempts")
        if !s.isPresent("pending") { attempts += 1 }
        s["pending"] = nil
        s["attempts"] = .int(attempts)
        s["last"] = .int(now.wallMs)
        if attempts >= maxAttempts {
            if wipe { return .wipe }
            startWait(&s, ms: lockoutMs, now: now)
            return .lockedOut
        }
        if backoff && attempts >= 3 { startWait(&s, ms: waitMs(attempts), now: now) }
        return .wrong
    }

    /// 30 s after the third failure, doubling, at most an hour.
    static func waitMs(_ attempts: Int) -> Int64 {
        min(3600, Int64(30) << Int64(min(10, max(0, attempts - 3)))) * 1000
    }

    static func startWait(_ s: inout JSONObject, ms: Int64, now: LockTime) {
        s["until"] = .int(now.wallMs + ms)
        s["untilMono"] = .int(now.monoMs + ms)
        s["boot"] = .string(now.boot)
        s["wait"] = .int(ms)
    }

    /// Milliseconds until the next attempt is allowed (0: now). The monotonic clock of the wait's
    /// boot session decides — the wall clock never does.
    static func waitLeftMs(_ s: JSONObject, now: LockTime) -> Int64 {
        let until = s.optInt64("until"), wait = s.optInt64("wait")
        guard until > 0 || wait > 0 else { return 0 }
        // A record without the monotonic anchor (none is written so): the wall clock, as Android.
        guard wait > 0 else { return max(0, until - now.wallMs) }
        let boot = s.optString("boot")
        if !boot.isEmpty, boot == now.boot, s.isPresent("untilMono") {
            return max(0, min(wait, s.optInt64("untilMono") - now.monoMs))
        }
        // Started in another boot session: only the time since this boot surely passed.
        return max(0, wait - now.monoMs)
    }

    /// A wait anchored in another boot session, to be anchored in this one (AppLock stores it).
    static func needsReanchor(_ s: JSONObject, now: LockTime) -> Bool {
        s.optInt64("wait") > 0 && s.optString("boot") != now.boot && waitLeftMs(s, now: now) > 0
    }

    /// What is left of a wait from another boot session, anchored on this one's clock.
    static func reanchor(_ s: inout JSONObject, now: LockTime) {
        startWait(&s, ms: waitLeftMs(s, now: now), now: now)
    }

    /// An over wait leaves the record (begin(): the next attempt is allowed, so it is over).
    static func clearWait(_ s: inout JSONObject) {
        s["until"] = .int(0)
        for k in ["untilMono", "boot", "wait"] { s[k] = nil }
    }

    static func waitSeconds(_ s: JSONObject, now: LockTime) -> Int64 {
        let left = waitLeftMs(s, now: now)
        return left > 0 ? (left + 999) / 1000 : 0
    }

    static func fresh() -> JSONObject { JSONObject([("attempts", .int(0)), ("until", .int(0))]) }

    /// The counter after a rollback: one short of the maximum, so the failure it is settled as is the last one.
    static func rolledBack(maxAttempts: Int) -> JSONObject {
        JSONObject([("attempts", .int(max(0, maxAttempts - 1))), ("until", .int(0))])
    }
}
