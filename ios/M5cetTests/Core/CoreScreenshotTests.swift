// Opt-in: the rooms list and a room with real messages, drawn by the app's own
// DesignShell over the core (AppScreenState, CoreActions, the core's slots) —
// the messages went through a real server's hub (M5_TEST_SERVER) between two
// in-process people. Run with
//   TEST_RUNNER_M5_TEST_SERVER=http://127.0.0.1:5871 TEST_RUNNER_M5_CORE_SHOTS=/path xcodebuild … test \
//     -only-testing:M5cetTests/CoreScreenshotTests
// (A screenshot of the running app on the simulator would also catch the system's notification prompt,
// which simctl cannot answer.)

import Foundation
import M5Core
import M5Design
import M5Net
import M5Proto
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

@MainActor
final class CoreScreenshotTests: XCTestCase {
    private func person(_ name: String, server: String, net: LoopbackNet) -> TestPerson {
        let suite = "cz.m5cet.tests.core.shots." + name
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        let sec = MemorySecurity()
        let dev = TestDevice()
        dev.server = server
        let core = AppCore(security: sec, device: dev, services: DesignServices(store: SettingsStore(defaults: d)), hub: HubRooms(),
                           wires: LoopbackWires(net: net, owner: name), fileStore: MemoryFileStore(), passkeys: FakePasskeys())
        return TestPerson(name: name, core: core, security: sec, device: dev)
    }

    func testRoomsAndARoomWithRealMessages() async throws {
        guard let server = ProcessInfo.processInfo.environment["M5_TEST_SERVER"], !server.isEmpty,
              let dir = ProcessInfo.processInfo.environment["M5_CORE_SHOTS"], !dir.isEmpty else {
            throw XCTSkip("M5_TEST_SERVER / M5_CORE_SHOTS not set")
        }
        let net = LoopbackNet()
        let mike = person("Mike", server: server, net: net), alice = person("Alice", server: server, net: net)
        let n = String(Int.random(in: 100...999))
        let room = "Tým " + n
        mike.rooms.add("Rodina", passphrase: "rodinne heslo", userName: "Mike")
        mike.rooms.add("Projekt X", passphrase: "projekt heslo", userName: "Mike")
        let key = mike.rooms.join(room: room, passphrase: "tymove heslo " + n, userName: "Mike")
        _ = alice.rooms.join(room: room, passphrase: "tymove heslo " + n, userName: "Alice")
        await eventually("both in, channel open", timeout: 30) { mike.room(key)?.peers.count == 1 && alice.room(key)?.peers.count == 1 }
        let m = try XCTUnwrap(mike.room(key)), a = try XCTUnwrap(alice.room(key))
        a.sendText("Ahoj Miku! Jsi tam?")
        await eventually("1", timeout: 30) { m.messages.contains { $0.text == "Ahoj Miku! Jsi tam?" } }
        m.sendText("Jsem tu, díky 👍")
        try? await Task.sleep(for: .milliseconds(400))
        a.sendText("Posílám plán na zítřek, mrkni na něj")
        await eventually("2", timeout: 30) { m.messages.contains { $0.text.hasPrefix("Posílám plán") } }
        var o = Outgoing(text: "Super, podívám se na to")
        o.replyTo = m.messages.last { $0.text.hasPrefix("Posílám plán") }
        m.send(o)
        await eventually("delivered", timeout: 30) { m.messages.filter(\.mine).allSatisfy { ChatMessage.rank($0.status) >= ChatMessage.rank("delivered") } }
        m.markRead(m.messages.filter { !$0.mine }.map(\.id))
        try? await Task.sleep(for: .milliseconds(600))

        // Mike's window: the design, the core's state, actions and slots.
        let services = mike.core.services
        let state = AppScreenState(core: mike.core)
        services.state = state
        let actions = CoreActions(core: mike.core, state: state)
        actions.install(into: services.actions)
        CoreSlots.register(into: services.slots, core: mike.core, state: state, actions: actions)
        FallbackChatSlots.register(into: services.slots, core: mike.core)
        for dark in [false, true] {
            let host = DesignHost(services: services)
            host.reducedMotion = true
            host.toneOverride = dark
            mike.core.attach(host)
            host.showScreen("rooms", transition: false)
            let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: CGSize(width: 402, height: 874), regular: false, dark: dark)
            defer { window.isHidden = true }
            for id in ["rooms", "room"] {
                host.showScreen(id, transition: false)
                try? await Task.sleep(for: .milliseconds(900))
                let image = RendererTestSupport.draw(vc.view)
                try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(id)-\(dark ? "dark" : "light").png"))
            }
        }
        mike.rooms.leave(key)
        alice.rooms.leave(key)
        try? await Task.sleep(for: .milliseconds(300))
    }
}
