// Opt-in: PNGs of People's screens and dialogs as the app draws them — the room with
// the user panel, a person's detail (users.person, $form.person from People), the
// sender's sheet, my profile's editor ($profile), the Settings card ($myProfile),
// the message details, the safety number with its QR code and the profile field
// dialog — iPhone and iPad, light and dark. The same DesignShell over the built-in
// design; the people come from a test room with real keys and statistics. Run with
//   TEST_RUNNER_M5_PEOPLE_SHOTS_DIR=/path xcodebuild … test -only-testing:M5cetTests/PeopleScreenshotTests
// Without the variable it is skipped.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit
import XCTest
@testable import M5cet

/// The console's samples with the variables the parts own (People's $users, $profile, $myProfile) on top.
@MainActor
final class PeopleShotState: ScreenStateProvider {
    let sample = SampleScreenState()
    var routeState: AppRouteState { AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true) }
    var define: DesignValue { .object([:]) }
    var account: DesignValue { ["signedIn": true, "username": "bystry-sokol-7k3q"] }

    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] {
        var v = sample.variables(for: screen, context: context)
        v["form"] = nil
        for (k, x) in CoreModels.shared.variables.values(for: screen) { v[k] = x }
        if screen == "room", let r = CoreModels.shared.rooms.active { v["room"] = r.scope }
        return v
    }
}

@MainActor
final class PeopleScreenshotTests: XCTestCase {
    private struct Device {
        let name: String
        let size: CGSize
        let regular: Bool
    }

    private let devices = [Device(name: "iphone", size: CGSize(width: 402, height: 874), regular: false),
                           Device(name: "ipad", size: CGSize(width: 1032, height: 1376), regular: true)]

    func testPeopleScreens() throws {
        guard let dir = ProcessInfo.processInfo.environment["M5_PEOPLE_SHOTS_DIR"], !dir.isEmpty else { throw XCTSkip("M5_PEOPLE_SHOTS_DIR not set") }
        let out = URL(fileURLWithPath: dir)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let w = PeopleWorld.make()
        defer { CoreModels.shared = CoreModels(rooms: NoRooms(), account: NoAccount()) }
        // The room's messages for the details, and Alice's public profile asked for.
        w.room.messages = PreviewRoom.sampleMessages("team")
        if let i = w.room.messages.firstIndex(where: { $0.id == "m8" }) {
            var m = w.room.messages[i]
            m.to = ["Alice"]
            m.mark("encrypted", "", at: m.createdAt + 12)
            m.mark("sent", "p2p", at: m.createdAt + 40)
            m.mark("relay-p4", "Eva", at: m.createdAt + 60)
            m.mark("stored", "Eva", at: m.createdAt + 480)
            m.mark("delivered", "Alice", at: m.createdAt + 900)
            m.mark("read", "Alice", at: m.createdAt + 61_000)
            w.room.messages[i] = m
        }
        // People's shared model for the parts on screen.
        let people = PeopleModel.shared
        people.store = PeopleStore(records: MemoryPeopleRecords())
        people.profiles = { w.profiles }
        people.core = { w.core }
        people.now = { PeopleFakeRoom.t0 }
        people.store.putLink(username: "alice-novak", contactName: "Alice Nováková", lookup: "ABC-123")
        UserPanelState.shared = UserPanelState.sample(dock: "right", autoHide: false)
        ProfileEditor.shared.profiles = { w.profiles }
        ProfileEditor.shared.account = { w.core.account }
        w.profiles.publicProfiles["alice-novak"] = JSONObject([("profile", .object(JSONObject([("v", 1), ("nickname", "Alice N."), ("about", "Veřejně: horolezkyně.")]))),
                                                               ("accountKey", .string(String(repeating: "A", count: 43)))])
        w.room.accountKeys["peer-alice"] = String(repeating: "A", count: 43)
        w.profiles.fetchPublic("alice-novak")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        for device in devices {
            for dark in [false, true] {
                let tone = dark ? "dark" : "light"
                let state = PeopleShotState()
                let host = RendererTestSupport.host(state: state)
                SampleSlots.register(into: host.services.slots, state: state.sample)
                PeopleParts.install(services: host.services)
                PeopleParts.ensureVariables(w.core)
                _ = host.userSetSetting("people.contacts", .bool(true))
                host.toneOverride = dark
                host.showScreen("room", transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: host), size: device.size, regular: device.regular, dark: dark)
                defer { window.isHidden = true }
                func shot(_ name: String) throws {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.6))
                    let image = RendererTestSupport.draw(vc.view)
                    try XCTUnwrap(image.pngData()).write(to: out.appendingPathComponent("\(device.name)-\(name)-\(tone).png"))
                }
                try shot("user-panel")
                PeopleModel.shared.run("people.select", "peer-alice", host: host)
                PeopleModel.shared.run("people.open", "peer-alice", host: host)
                try shot("person")
                host.closeOverlay()
                PeopleParts.showSender("m1", host: host)
                try shot("sender")
                host.closeOverlay()
                ProfileEditor.shared.forget()
                ProfileEditor.shared.run("profile.open", "", host: host, source: nil)
                try shot("my-profile")
                host.showScreen("settings", transition: false)
                try shot("settings-card")
                PeopleModel.shared.run("people.none", "", host: host)

                // The dialogs (SecureDialog sheets), each as the sheet shows it.
                try dialog(MsgDetailsView(room: w.room, messageId: "m8", hides: DetailsHides(), now: { PeopleFakeRoom.t0 + 600_000 },
                                          timeZone: TimeZone(identifier: "Europe/Prague")),
                           host: host, device: device, dark: dark, name: "msg-info", out: out)
                let number = PeopleSafety.number(PeopleSafetyTests.a, PeopleSafetyTests.b)
                try dialog(SafetyVerifyView(name: "Alice", number: number, verified: false, ktAlert: "", onVerify: { _, _ in }, canScan: true),
                           host: host, device: device, dark: dark, name: "safety-number", out: out)
                let field = ProfileFieldSheet.Field(type: "phone", label: "Mobil", value: "+420 777 123 456", audience: "room")
                try dialog(ProfileFieldSheet(field: field, isNew: false, onSave: { _ in }, onRemove: {}),
                           host: host, device: device, dark: dark, name: "profile-field", out: out)
            }
        }
    }

    /// A dialog as its sheet shows it: the iPhone's full width, the iPad's form-sheet card.
    private func dialog<V: View>(_ view: V, host: DesignHost, device: Device, dark: Bool, name: String, out: URL) throws {
        let size = device.regular ? CGSize(width: 704, height: 980) : CGSize(width: device.size.width, height: device.size.height - 60)
        let (vc, window) = RendererTestSupport.show(view.environment(host), size: size, regular: device.regular, dark: dark)
        defer { window.isHidden = true }
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        let image = RendererTestSupport.draw(vc.view)
        try XCTUnwrap(image.pngData()).write(to: out.appendingPathComponent("\(device.name)-\(name)-\(dark ? "dark" : "light").png"))
    }
}
