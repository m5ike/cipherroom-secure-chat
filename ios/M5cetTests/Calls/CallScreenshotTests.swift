// Screenshots of the calls' screens for a look at the layout (iPhone, and the
// iPad's regular width at an iPad's size): the call screen of a group call
// and the History. Each is attached to the test result; with
// TEST_RUNNER_M5_SNAPSHOT_DIR=<dir> on the xcodebuild line they are also
// written there as PNG.

import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class CallScreenshotTests: XCTestCase {
    private func snapshot<V: View>(_ name: String, size: CGSize, regular: Bool, dark: Bool, _ view: V) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view.environment(\.horizontalSizeClass, regular ? .regular : .compact))
        host.overrideUserInterfaceStyle = dark ? .dark : .light
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        try? await Task.sleep(for: .milliseconds(600))
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        let png = try XCTUnwrap(image.pngData())
        XCTAssertGreaterThan(png.count, 10_000, "something was drawn")
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["M5_SNAPSHOT_DIR"] {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
        }
    }

    private func groupCall() -> (RoomRtc, RecordingLink) {
        let room = RoomRtc(roomKey: "shot", label: "Team", engine: testEngine())
        let link = RecordingLink()
        room.link = link
        for (name, status) in [("Alice Novak", "live"), ("Bob", "muted"), ("Cecilie Dvořák", "live")] {
            let id = "p-" + name
            room.addPeer(id: id, name: name, initiator: true)
            room.peerAudioStatus(status, from: id)
        }
        room.startAudio()
        return (room, link)
    }

    func testTheCallScreenOnIPhoneAndIPad() async throws {
        let (room, link) = groupCall()
        let system = CallSystem(engine: testEngine(), provider: FakeProvider(), controller: FakeController(), environment: FakeEnvironment())
        try await snapshot("call-iphone", size: CGSize(width: 402, height: 874), regular: false, dark: true,
                           CallScreen(room: room, system: system, onClose: {}))
        try await snapshot("call-ipad", size: CGSize(width: 1032, height: 1376), regular: true, dark: true,
                           CallScreen(room: room, system: system, onClose: {}))
        room.disconnect()
        XCTAssertEqual(link.statuses.first, .live)
    }

    func testTheHistoryOnIPhoneAndIPad() async throws {
        final class Source: CallLogMessageSource {
            func savedRooms() -> [CallLogRoom] { [CallLogRoom(key: "team", label: "Team"), CallLogRoom(key: "family", label: "Family")] }
            func messages(ofRoom roomKey: String) -> [CallLogRoomMessage] {
                guard roomKey == "team" else { return [] }
                var sealed = CallLogItems.Message(id: "m2", createdAt: CallTrack.millis() - 7_200_000, mine: false, senderName: "Bob", text: "x")
                sealed.sealed = true
                return [CallLogRoomMessage(message: CallLogItems.Message(id: "m1", createdAt: CallTrack.millis() - 600_000, mine: false,
                                                                         senderName: "Alice", text: "Shall we call after lunch?"), hidden: false),
                        CallLogRoomMessage(message: sealed, hidden: false)]
            }
        }
        let store = AppCallHistory(vault: FakeVault())
        let now = CallTrack.millis()
        store.record(.init(kind: .missed, at: now - 300_000, seconds: 0, video: false, people: ["Alice"]), roomKey: "team", room: "Team")
        store.record(.init(kind: .incoming, at: now - 3_600_000, seconds: 724, video: true, people: ["Alice", "Bob"]), roomKey: "team", room: "Team")
        store.record(.init(kind: .outgoing, at: now - 90_000_000, seconds: 42, video: false, people: []), roomKey: "family", room: "Family")
        store.record(.init(kind: .declined, at: now - 200_000_000, seconds: 0, video: false, people: ["Dana"]), roomKey: "gone", room: "Old room")
        let system = CallSystem(engine: testEngine(), provider: FakeProvider(), controller: FakeController(), environment: FakeEnvironment(),
                                history: store)
        let source = Source()
        let view = NavigationStack { CallHistoryView(system: system, messages: source) }
        try await snapshot("history-iphone", size: CGSize(width: 402, height: 874), regular: false, dark: false, view)
        try await snapshot("history-ipad", size: CGSize(width: 1032, height: 1376), regular: true, dark: false, view)
    }
}
