// The PIN pad (Parts/Lock): the keys fit the room they get (Android LockPad
// keySizes), the setup asks twice and starts again on a mismatch, a full PIN
// unlocks, a shuffled pad still has every digit once, the texts come from the
// built-in design, and the lock screen renders on iPhone and iPad sizes.

import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class LockPadTests: XCTestCase {
    func testTheKeysFitTheRoom() {
        let roomy = LockScreenView.keySizes(width: 1000, height: 1000)
        XCTAssertEqual(roomy.key, 84, "at most 84 pt")
        let tight = LockScreenView.keySizes(width: 120, height: 150)
        XCTAssertEqual(tight.key, 40, "at least 40 pt")
        XCTAssertEqual(tight.gapH, 0, "the gaps give way first")
        XCTAssertEqual(tight.gapV, 0)
        let phone = LockScreenView.keySizes(width: 345, height: 420)
        XCTAssertLessThanOrEqual(3 * phone.key + 2 * phone.gapH, 345)
        XCTAssertLessThanOrEqual(4 * phone.key + 3 * phone.gapV, 420)
    }

    func testSetupAsksTwiceAndUnlockTakesAFullPin() async throws {
        let f = try Fixture()
        let pad = LockPadModel(lock: f.lock, mode: .setup)
        XCTAssertEqual(pad.step, .choose)
        for d in [1, 2, 3, 4, 5, 6] { pad.press(d) }
        try await settle { pad.step == .confirm }
        for d in [1, 2, 3, 4, 5, 7] { pad.press(d) }
        try await settle { pad.error != nil }
        XCTAssertEqual(pad.error, "lock.pinMismatch")
        XCTAssertEqual(pad.step, .choose)
        XCTAssertFalse(f.lock.isSetUp)
        for d in [2, 4, 6, 8, 0, 2] { pad.press(d) }
        try await settle { pad.step == .confirm }
        for d in [2, 4, 6, 8, 0, 2] { pad.press(d) }
        try await settle { f.lock.isSetUp && !f.lock.busy }
        XCTAssertFalse(f.lock.isLocked)
        f.lock.lockNow(remote: false)
        let unlock = LockPadModel(lock: f.lock, mode: .unlock)
        for d in [2, 4, 6, 8, 0, 1] { unlock.press(d) }
        try await settle { unlock.lastResult != nil }
        XCTAssertEqual(unlock.lastResult, .wrong)
        XCTAssertEqual(unlock.error, "lock.wrongPin")
        XCTAssertEqual(unlock.count, 0, "the digits are gone after a try")
        unlock.press(9)
        unlock.delete()
        XCTAssertEqual(unlock.count, 0)
        for d in [2, 4, 6, 8, 0, 2] { unlock.press(d) }
        try await settle { !f.lock.isLocked }
    }

    func testAShuffledPadHasEveryDigitOnce() throws {
        let f = try Fixture()
        let pad = LockPadModel(lock: f.lock, mode: .unlock, shuffle: true)
        var orders = Set<[Int]>()
        for _ in 0..<10 {
            XCTAssertEqual(pad.order.sorted(), Array(0...9))
            orders.insert(pad.order)
            pad.press(1)
            pad.clear()
        }
        XCTAssertGreaterThan(orders.count, 1, "it reshuffles after a tap")
        XCTAssertEqual(LockPadModel(lock: f.lock, mode: .unlock).order, Array(1...9) + [0])
    }

    func testTextsComeFromTheBuiltInDesign() {
        XCTAssertEqual(LockTexts.builtIn("lock.wrongPin").isEmpty, false)
        let cs = LockTexts(strings: ["cs": ["lock.title": "Aplikace je zamčená"], "en": ["lock.title": "The app is locked", "lock.delete": "Delete"]],
                           languages: ["sk-SK"])
        XCTAssertEqual(cs("lock.title"), "Aplikace je zamčená", "Slovak falls back to Czech")
        XCTAssertEqual(cs("lock.delete"), "Delete", "then English")
        XCTAssertEqual(cs("lock.unknown"), "lock.unknown")
        let en = LockTexts(strings: LockDesignFile.builtIn.strings, languages: ["en-US"])
        XCTAssertEqual(en("lock.title"), "The app is locked")
    }

    func testTheLockScreenRendersOnPhoneAndPad() throws {
        let f = try Fixture()
        for size in [CGSize(width: 393, height: 852), CGSize(width: 852, height: 393), CGSize(width: 1032, height: 1376), CGSize(width: 320, height: 480)] {
            let host = UIHostingController(rootView: LockScreenView(model: LockPadModel(lock: f.lock, mode: .unlock)))
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.layoutIfNeeded()
            let fit = host.sizeThatFits(in: size)
            XCTAssertLessThanOrEqual(fit.height, size.height + 1, "\(size)")
        }
    }

    // MARK: the windows on the host app's own scene

    private var hostScene: UIWindowScene? { UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first }

    func testTheLockWindowIsUpWhileLocked() async throws {
        let scene = try XCTUnwrap(hostScene, "the test host has a scene")
        let f = try Fixture()
        f.center.showsWindows = true
        defer { f.center.presenter.update() }
        try await f.lock.setUp(pin: "482915")
        XCTAssertFalse(f.center.presenter.isShowingLock)
        f.lock.lockNow(remote: false)
        XCTAssertTrue(f.center.presenter.isShowingLock)
        let window = try XCTUnwrap(scene.windows.first { $0.windowLevel == .alert + 1 && !$0.isHidden })
        XCTAssertTrue(window.isKeyWindow, "the app below gets no keyboard focus")
        eq(await f.lock.unlock(pin: "482915"), .ok)
        XCTAssertFalse(f.center.presenter.isShowingLock)
        XCTAssertFalse(scene.windows.contains { $0 === window && !$0.isHidden })
        // A wipe that is not quiet: the notice instead of the lock.
        f.center.wipe(reason: "attempts", remote: false, attempts: 8)
        XCTAssertTrue(f.center.wipedNotice)
        XCTAssertFalse(f.center.presenter.isShowingLock)
        f.center.wipedNotice = false
    }

    func testThePrivacyCoverFollowsTheScenesAndThePolicy() throws {
        let scene = try XCTUnwrap(hostScene)
        let privacy = ScreenPrivacy()
        final class Box { var allowed = false, shots = 0 }
        let box = Box()
        privacy.screenshotsAllowed = { box.allowed }
        privacy.onScreenshot = { box.shots += 1 }
        privacy.install()
        let nc = NotificationCenter.default
        nc.post(name: UIScene.willDeactivateNotification, object: scene)
        XCTAssertEqual(privacy.coveredScenes, 1, "the app switcher's snapshot shows the cover")
        XCTAssertTrue(scene.windows.contains { $0.windowLevel == .alert + 2 && !$0.isHidden })
        nc.post(name: UIScene.didActivateNotification, object: scene)
        XCTAssertEqual(privacy.coveredScenes, 0)
        nc.post(name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        XCTAssertEqual(box.shots, 1, "a screenshot is reported")
        box.allowed = true
        nc.post(name: UIScene.willDeactivateNotification, object: scene)
        XCTAssertEqual(privacy.coveredScenes, 0, "screenshots allowed: no cover (Android: no FLAG_SECURE)")
        nc.post(name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        XCTAssertEqual(box.shots, 1)
        nc.post(name: UIScene.didActivateNotification, object: scene)
        XCTAssertFalse(ScreenPrivacy.captured(scene), "the simulator is not recording")
    }

    private func settle(_ done: @escaping () -> Bool) async throws {
        for _ in 0..<200 where !done() { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(done(), "timed out")
    }
}
