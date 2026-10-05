// The core's contracts with the renderer: every action of the design's catalogue
// has an owner (the renderer, the core, a part, another Platform area); the
// route follows the device and the lock (enrol → set the PIN → the rooms → the
// room, locked → the lock); the screens' variables come from the rooms.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Proto
import XCTest
@testable import M5cet

@MainActor
final class CoreStateTests: XCTestCase {
    /// What DesignHost.perform and M5Design's ActionRunner do themselves (Renderer/README.md, contract 2).
    static let rendererOwned: Set<String> = [
        "screen.open", "back", "menu.open", "sheet.open", "sheet.close", "flash", "nfc.workbench", "nfc.builder", "update.later",
        "lib.run", "set", "setting.set", "setting.toggle", "look.set", "look.reset", "appearance.reset", "theme.toggle", "nfc.reader",
        "url.open", "copy", "share",
    ]

    func testEveryCatalogueActionHasAnOwner() {
        let router = AppActionRouter()
        let core = TestPerson.make("Owner", hub: FakeHub(), net: LoopbackNet()).core
        CoreActions(core: core, state: AppScreenState(core: core)).install(into: router)
        var missing: [String] = []
        for name in ActionCatalog.names {
            if Self.rendererOwned.contains(name) || router.handles(name) || CoreActions.platformOwned.contains(name) { continue }
            missing.append(name)
        }
        XCTAssertEqual(missing, [], "actions nobody handles")
        XCTAssertEqual(ActionCatalog.names.count, 122)
        // The core does not register what another area registers itself (Notifications: notify.*).
        for n in CoreActions.platformOwned { XCTAssertFalse(router.handles(n)) }
        // Every name the core registers is a name of the catalogue.
        for n in CoreActions.handled + CoreActions.partOwned { XCTAssertTrue(ActionCatalog.isKnown(n), n) }
    }

    func testTheRouteFollowsTheDeviceAndTheLock() async throws {
        let p = TestPerson.make("Route", hub: FakeHub(), net: LoopbackNet())
        let state = AppScreenState(core: p.core)
        p.device.enrolled = false
        XCTAssertEqual(state.routeState, AppRouteState(enrolled: false, lockSetUp: true, locked: false))
        p.device.enrolled = true
        p.security.isSetUp = false
        XCTAssertFalse(state.routeState.lockSetUp)
        p.security.isSetUp = true
        p.security.lockNow()
        XCTAssertTrue(state.routeState.locked)
        p.security.unlock()
        XCTAssertEqual(state.routeState, AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: false))
        p.rooms.add("Somewhere", passphrase: "x", userName: "Route")
        p.rooms.switchTo(RoomKeys.normalizeRoom("Somewhere"))
        XCTAssertTrue(state.routeState.hasActiveRoom)

        // The host routes by it: enrol → lock → rooms → room.
        let host = DesignHost(services: DesignServices(store: SettingsStore(defaults: UserDefaults(suiteName: "cz.m5cet.tests.core.route")!), state: state))
        host.reducedMotion = true
        p.device.enrolled = false
        host.route()
        XCTAssertEqual(host.screen, "enroll")
        p.device.enrolled = true
        p.security.isSetUp = false
        host.route()
        XCTAssertEqual(host.screen, "lock")
        p.security.isSetUp = true
        p.security.lockNow()
        host.route()
        XCTAssertEqual(host.screen, "lock")
        p.security.unlock()
        host.route()
        XCTAssertEqual(host.screen, "room")
        p.rooms.leave("")
        host.route()
        XCTAssertEqual(host.screen, "rooms")
    }

    func testScreenVariables() async throws {
        let p = TestPerson.make("Vars", hub: FakeHub(), net: LoopbackNet())
        let state = AppScreenState(core: p.core)
        let ctx = ScreenContext(wide: false, regularWidth: false, lang: "en")
        p.rooms.add("Team", passphrase: "x", userName: "Vars")
        p.rooms.add("Family", passphrase: "y", userName: "Vars")
        let rooms = state.variables(for: "rooms", context: ctx)
        XCTAssertEqual(rooms["rooms"]?.arrayValue?.count, 2)
        XCTAssertEqual(rooms["rooms"]?[0]["status"], "saved")
        XCTAssertEqual(rooms["selectedCount"], 2)
        let room = state.variables(for: "room", context: ctx)
        XCTAssertEqual(room["room"]?["status"], "offline")
        XCTAssertEqual(room["call"]?["active"], false)
        XCTAssertEqual(state.variables(for: "splash", context: ctx)["busy"], true)
        XCTAssertEqual(state.define["greeting"], "ahoj")
        XCTAssertEqual(state.account["signedIn"], false)
        // A part's own variable (core.variables).
        p.core.models.variables.register("ai", "ai") { ["state": "ready"] }
        XCTAssertEqual(state.variables(for: "ai", context: ctx)["ai"]?["state"], "ready")
        XCTAssertEqual(state.variables(for: "tools", context: ctx)["tools"]?["ai"], true)
    }

    func testTheComposerSendsWithItsKinds() async throws {
        let hub = FakeHub(), net = LoopbackNet()
        let p = TestPerson.make("Composer", hub: hub, net: net)
        let key = p.rooms.join(room: "Composer Room", passphrase: "pp", userName: "Composer")
        await eventually("joined") { p.room(key)?.connected == true }
        let host = DesignHost(services: p.core.services)
        let c = p.core.models.composer(for: host)
        c.messageKind("tap")
        c.messageKind("vanish:30")
        XCTAssertEqual(c.plan.tap, true)
        XCTAssertEqual(c.plan.vanishSeconds, 30)
        c.text = "hello there"
        XCTAssertTrue(c.send())
        XCTAssertEqual(c.text, "")
        await eventually("in the list") { p.room(key)?.messages.contains { $0.text == "hello there" && $0.tap && $0.vanishSeconds == 30 } == true }
        // Inline bytes vs the vault.
        c.sendBytes(Data(repeating: 1, count: 1000), name: "a.bin", mime: "application/octet-stream", image: false, caption: "")
        await eventually("inline") { p.room(key)?.messages.contains { $0.fileName == "a.bin" && $0.fileDataUrl != nil } == true }
        XCTAssertEqual(c.scope["tap"], true)
        c.messageKind("normal")
        XCTAssertEqual(c.plan.count, 0)
    }

    func testRecoveryCodesAreTheWebsOnes() {
        let code = RecoveryCodes.generate()
        XCTAssertEqual(code.count, 26 + 5)
        XCTAssertEqual(RecoveryCodes.normalize(code.lowercased().replacingOccurrences(of: "-", with: " ")), code.replacingOccurrences(of: "-", with: ""))
        XCTAssertNil(RecoveryCodes.normalize("short"))
        let m = RecoveryCodes.material(code)!
        XCTAssertEqual(m.verifier.count, 64)
        XCTAssertEqual(m.id.count, 24)
    }
}
