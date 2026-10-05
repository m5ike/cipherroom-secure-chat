// Opt-in: PNGs of screens at a window size the simulator cannot be put into from the
// command line (an iPad on its side: simctl has no rotation, and XCUIDevice needs a UI
// test bundle). The same DesignShell, the console's sample state, a regular-width
// window of the iPad's landscape size, drawn with drawHierarchy. Run with
//   TEST_RUNNER_M5_SHOTS_DIR=/path xcodebuild … test -only-testing:M5cetTests/RendererScreenshotTests
// Without the variable it is skipped.

import M5Design
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class RendererScreenshotTests: XCTestCase {
    func testIPadLandscapeScreens() throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_SHOTS_DIR not set") }
        let screens = (ProcessInfo.processInfo.environment["M5_SHOTS_SCREENS"] ?? "splash,lock,rooms,room,settings").split(separator: ",").map(String.init)
        let size = RendererTestSupport.iPadLandscape
        let state = SampleScreenState()
        for dark in [false, true] {
            let host = RendererTestSupport.host(state: state)
            SampleSlots.register(into: host.services.slots, state: state)
            host.toneOverride = dark
            host.showScreen("splash", transition: false)
            let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: true, dark: dark)
            defer { window.isHidden = true }
            for id in screens {
                host.showScreen(id, transition: false)
                RunLoop.main.run(until: Date().addingTimeInterval(0.4))
                let image = RendererTestSupport.draw(vc.view)
                let name = "ipad-landscape-\(id)-\(dark ? "dark" : "light").png"
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent(name))
            }
        }
    }
}
