// Against a real server (skipped unless M5_TEST_SERVER is set, e.g.
// TEST_RUNNER_M5_TEST_SERVER=http://127.0.0.1:5871 xcodebuild test …): two
// in-process people through the core's controllers on the server's own hub
// (URLSession WebSocket, the join with the room proof, sealed signals), the data
// channels between them in memory — a message, its receipt, a reply.

import Foundation
import M5Core
import M5Design
import M5Net
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class CoreServerIntegrationTests: XCTestCase {
    private func person(_ name: String, server: String, net: LoopbackNet) -> TestPerson {
        let suite = "cz.m5cet.tests.core.server." + name
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        let sec = MemorySecurity()
        let dev = TestDevice()
        dev.server = server
        let core = AppCore(security: sec, device: dev, services: DesignServices(store: SettingsStore(defaults: d)), hub: HubRooms(),
                           wires: LoopbackWires(net: net, owner: name), fileStore: MemoryFileStore(), passkeys: FakePasskeys())
        return TestPerson(name: name, core: core, security: sec, device: dev)
    }

    func testTwoPeopleTalkThroughTheServersHub() async throws {
        guard let server = ProcessInfo.processInfo.environment["M5_TEST_SERVER"], !server.isEmpty else {
            throw XCTSkip("M5_TEST_SERVER is not set")
        }
        let net = LoopbackNet()
        let alice = person("Alice", server: server, net: net), bob = person("Bob", server: server, net: net)
        let room = "ios core it " + String(Int.random(in: 1000...9999))
        let key = alice.rooms.join(room: room, passphrase: "integration passphrase", userName: "Alice")
        await eventually("Alice joined the server's hub", timeout: 30) { alice.room(key)?.connected == true }
        _ = bob.rooms.join(room: room, passphrase: "integration passphrase", userName: "Bob")
        await eventually("Bob joined", timeout: 30) { bob.room(key)?.connected == true }
        await eventually("signals through the hub opened the channel", timeout: 30) { alice.room(key)?.peers.count == 1 && bob.room(key)?.peers.count == 1 }
        let a = try XCTUnwrap(alice.room(key)), b = try XCTUnwrap(bob.room(key))
        // The server checked the room proof (a blind id): the join says so.
        let me = try XCTUnwrap(a.people.first { $0.me })
        XCTAssertEqual(me.scope["proven"], true)

        let id = a.sendText("Ahoj přes server")
        await eventually("Bob got it", timeout: 30) { b.messages.contains { $0.text == "Ahoj přes server" } }
        await eventually("delivered", timeout: 30) { a.message(id).map { ChatMessage.rank($0.status) >= ChatMessage.rank("delivered") } ?? false }
        var o = Outgoing(text: "Ahoj zpět")
        o.replyTo = b.messages.first { $0.text == "Ahoj přes server" }
        b.send(o)
        await eventually("Alice got the reply", timeout: 30) { a.messages.contains { $0.text == "Ahoj zpět" && $0.replyToId == id } }
        alice.rooms.leave(key)
        bob.rooms.leave(key)
        try? await Task.sleep(for: .milliseconds(300))
    }
}
