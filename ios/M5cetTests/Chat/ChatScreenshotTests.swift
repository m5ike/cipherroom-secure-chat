// Opt-in: PNGs of the room with the chat parts at a window size the simulator cannot be put
// into from the command line (an iPad on its side) — the same DesignShell, the sample core with
// the chat's extra samples (ChatSamples), a regular-width window of the iPad's landscape size,
// drawn with drawHierarchy. Run with
//   TEST_RUNNER_M5_SHOTS_DIR=/path xcodebuild … test -only-testing:M5cetTests/ChatScreenshotTests
// Without the variable it is skipped.

import M5Design
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class ChatScreenshotTests: XCTestCase {
    func testIPadLandscapeRoom() async throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_SHOTS_DIR not set") }
        let core = PreviewCore.install()
        core.rooms.switchTo("team")
        let room = try XCTUnwrap(core.rooms.active as? PreviewRoom)
        let size = RendererTestSupport.iPadLandscape
        let state = SampleScreenState()
        for dark in [false, true] {
            let host = RendererTestSupport.host(state: state)
            ChatParts.install(slots: host.services.slots, actions: host.services.actions)
            await ChatSamples.prepare(host, room: room)
            host.toneOverride = dark
            host.showScreen("room", transition: false)
            let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: true, dark: dark)
            defer { window.isHidden = true }
            try await Task.sleep(for: .milliseconds(1500))
            let tone = dark ? "dark" : "light"
            try XCTUnwrap(RendererTestSupport.draw(vc.view).pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("ipad-landscape-room-\(tone).png"))
            host.showSheet("attach")
            try await Task.sleep(for: .milliseconds(600))
            try XCTUnwrap(RendererTestSupport.draw(vc.view).pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("ipad-landscape-attach-\(tone).png"))
            host.closeOverlay()
        }
    }
}
