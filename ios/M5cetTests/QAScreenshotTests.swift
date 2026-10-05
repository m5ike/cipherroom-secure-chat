// Opt-in: the QA set of an iPad on its side (simctl cannot rotate a simulator, XCUIDevice needs a UI
// test bundle) — the app's own DesignServices with every part Bootstrap installed (chat, People,
// tools, NFC…), the sample core (PreviewCore + the chat's samples), a regular-width window of the
// iPad's landscape size, drawn with the window's drawHierarchy (sheets and dialogs included).
// Light and dark. Run with
//   TEST_RUNNER_M5_SHOTS_DIR=/path xcodebuild … test -only-testing:M5cetTests/QAScreenshotTests
// (an iPad simulator). Without the variable it is skipped. ios/docs/screenshots/final/ was made so.

import M5Design
import M5Proto
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class QAScreenshotTests: XCTestCase {
    private struct Shot {
        let name: String
        var screen: String
        var demo: String? = nil
        var setup: (@MainActor (DesignHost) async -> Void)? = nil
    }

    /// The design's call screen with the call's parts over a group call (Alice live, Bob muted, Cecilie live) —
    /// sample mode has no call. iPhone and iPad (landscape), light and dark.
    func testTheCallScreen() async throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_SHOTS_DIR not set") }
        let rtc = RoomRtc(roomKey: "qa", label: "Team", engine: testEngine())
        let link = RecordingLink()
        rtc.link = link
        for (name, status) in [("Alice", "live"), ("Bob", "muted"), ("Cecilie", "live")] {
            rtc.addPeer(id: "p-" + name, name: name, initiator: true)
            rtc.peerAudioStatus(status, from: "p-" + name)
        }
        rtc.startAudio()
        defer { rtc.disconnect() }
        let system = CallSystem(engine: testEngine(), provider: FakeProvider(), controller: FakeController(), environment: FakeEnvironment())
        let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true))
        state.vars["call"] = ["room": ["name": "Team", "users": 4], "call": ["active": true, "mode": "audio", "peers": 3, "muted": false]]
        for (size, regular, device) in [(RendererTestSupport.iPhone, false, "iphone"), (RendererTestSupport.iPadLandscape, true, "ipad")] {
            for dark in [false, true] {
                let services = DesignServices(store: RendererTestSupport.store("cz.m5cet.tests.qa.call"), state: state)
                services.slots.register("callVideo") { ctx in AnyView(CallParticipantsGrid(room: rtc, regular: ctx.horizontalSizeClass == .regular)) }
                services.slots.register("callControls") { ctx in
                    AnyView(CallControls(room: rtc, system: system, regular: ctx.horizontalSizeClass == .regular).frame(idealHeight: 88))
                }
                let host = DesignHost(services: services)
                host.reducedMotion = true
                host.toneOverride = dark
                host.showScreen("call", transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: regular, dark: dark)
                try await Task.sleep(for: .milliseconds(800))
                vc.view.layoutIfNeeded()
                let image = RendererTestSupport.draw(window)
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(device)-call-\(dark ? "dark" : "light").png"))
                window.isHidden = true
            }
        }
    }

    func testIPadLandscapeQASet() async throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_SHOTS_DIR not set") }
        let only = ProcessInfo.processInfo.environment["M5_SHOTS_ONLY"].map { Set($0.split(separator: ",").map(String.init)) }
        let services = try XCTUnwrap(AppCore.current?.services, "the host app's core")
        // Sample mode as -M5Screen makes it (the parts' samples follow DebugLaunch.screen); put back afterwards.
        let defaults = UserDefaults.standard
        defaults.set("room", forKey: "M5Screen")
        defer { for k in ["M5Screen", "M5Tools"] { defaults.removeObject(forKey: k) } }
        let core = PreviewCore.install()
        // The tools without network, as -M5Screen installs them (the server's answers from the fixtures).
        ToolParts.install(design: services, engine: ToolsFnEngine(transport: ToolsPreviewTransport()))
        core.rooms.switchTo("team")
        let room = try XCTUnwrap(core.rooms.active as? PreviewRoom)
        let savedState = services.state
        let state = SampleScreenState()
        state.withParts = true
        services.state = state
        defer { services.state = savedState }

        let msg: (String) -> ChatMessage? = { room.message($0) }
        let shots: [Shot] = [
            Shot(name: "splash", screen: "splash"), Shot(name: "enroll", screen: "enroll"), Shot(name: "lock", screen: "lock"),
            Shot(name: "rooms", screen: "rooms"), Shot(name: "room", screen: "room"),
            Shot(name: "room-people", screen: "room") { h in _ = h.runner.runFromApp("users.toggle", value: nil) },
            Shot(name: "attach", screen: "room") { h in h.showSheet("attach") },
            Shot(name: "tools", screen: "room") { h in h.showSheet("tools") },
            Shot(name: "menu", screen: "room") { h in if let m = msg("s6") { ChatActions.menu(m, host: h, anchor: "msg/s6") } },
            Shot(name: "map", screen: "room") { h in if let m = msg("m4") { PlaceSheet.show(m, host: h) } },
            Shot(name: "msginfo", screen: "room") { h in _ = h.runner.runFromApp("msg.info", value: .string("m8")) },
            Shot(name: "person", screen: "room") { h in _ = h.runner.runFromApp("people.open", value: .string("peer-alice")) },
            Shot(name: "safety", screen: "room") { h in _ = h.runner.runFromApp("people.verify", value: .string("peer-alice")) },
            Shot(name: "join", screen: "rooms") { h in h.showSheet("join") },
            Shot(name: "update", screen: "rooms") { h in h.showSheet("update") },
            Shot(name: "settings", screen: "settings"), Shot(name: "settings.user", screen: "settings.user"),
            Shot(name: "settings.messages", screen: "settings.messages"), Shot(name: "settings.voice", screen: "settings.voice"),
            Shot(name: "settings.voiceFx", screen: "settings.voiceFx"), Shot(name: "settings.location", screen: "settings.location"),
            Shot(name: "settings.calls", screen: "settings.calls"), Shot(name: "settings.people", screen: "settings.people"),
            Shot(name: "settings.appearance", screen: "settings.appearance"), Shot(name: "settings.security", screen: "settings.security"),
            Shot(name: "settings.notify", screen: "settings.notify"),
            Shot(name: "settings.profile", screen: "room") { h in _ = h.runner.runFromApp("profile.open", value: .string("")) },
            Shot(name: "about", screen: "about"), Shot(name: "log", screen: "log"),
            Shot(name: "ai", screen: "ai", demo: "ai"), Shot(name: "voice", screen: "voice", demo: "voice"),
            Shot(name: "nfc", screen: "nfc"), Shot(name: "nfc.builder", screen: "nfc.builder"),
        ]
        let size = RendererTestSupport.iPadLandscape
        for dark in [false, true] {
            for shot in shots where only?.contains(shot.name) ?? true {
                if let demo = shot.demo { defaults.set(demo, forKey: "M5Tools") } else { defaults.removeObject(forKey: "M5Tools") }
                let host = DesignHost(services: services)
                host.sampleMode = true
                host.reducedMotion = true
                host.toneOverride = dark
                host.showScreen(shot.screen, transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: size, regular: true, dark: dark)
                window.makeKey()
                if shot.screen == "room" { await ChatSamples.prepare(host, room: room) }
                try await Task.sleep(for: .milliseconds(900))
                if let setup = shot.setup {
                    await setup(host)
                    try await Task.sleep(for: .milliseconds(1400))
                }
                vc.view.layoutIfNeeded()
                let image = RendererTestSupport.draw(window)
                let file = URL(fileURLWithPath: dir).appendingPathComponent("ipad-\(shot.name)-\(dark ? "dark" : "light").png")
                try XCTUnwrap(image.pngData()).write(to: file)
                vc.presentedViewController?.dismiss(animated: false)
                window.rootViewController?.presentedViewController?.dismiss(animated: false)
                host.closeOverlay()
                window.isHidden = true
                try await Task.sleep(for: .milliseconds(200))
            }
        }
    }
}
