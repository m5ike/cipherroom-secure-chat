// The three contracts of Renderer/README.md: the slot registry, the action router and
// the screen state provider — what later agents plug into.

import M5Design
import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class RendererContractTests: XCTestCase {
    // MARK: SlotRegistry

    func testRegistryHasTheRenderersOwnSlots() {
        let r = SlotRegistry()
        for name in ["splashLogo", "logo", "settingsList", "updateProgress"] { XCTAssertTrue(r.has(name), name) }
        for name in ["messages", "composer", "lockPad", "roomList", "enrollForm"] { XCTAssertFalse(r.has(name), name) }
        XCTAssertEqual(Set(SlotRegistry.names), Set(SlotRegistry.names), "names")
        XCTAssertEqual(SlotRegistry.names.count, 22)
    }

    func testEveryDesignSlotIsAKnownName() {
        var used: Set<String> = []
        for (_, tree) in DesignAssets.builtIn.document.screens {
            tree.walk { n, _ in if n.el == "slot", let name = n.propString("name") { used.insert(name) } }
        }
        XCTAssertFalse(used.isEmpty)
        XCTAssertTrue(used.isSubset(of: Set(SlotRegistry.names)), "\(used.subtracting(SlotRegistry.names))")
    }

    func testARegisteredPartGetsTheSlotsScope() throws {
        let host = RendererTestSupport.host()
        var seen: Scope?
        host.services.slots.register("messages") { ctx in
            seen = ctx.scope
            XCTAssertEqual(ctx.name, "messages")
            XCTAssertEqual(ctx.id, "root/body/messages")
            return AnyView(Color.red)
        }
        let scope = host.scope(for: "room")
        let node = try XCTUnwrap(host.resolve("room", scope: scope))
        let slot = try XCTUnwrap(node.find("messages"))
        _ = host.services.slots.view(SlotContext(name: "messages", node: slot, context: host.renderContext(), horizontalSizeClass: .compact, host: host))
        XCTAssertEqual(seen?["room"]["name"], "team")
        host.services.slots.unregister("messages")
        XCTAssertFalse(host.services.slots.has("messages"))
    }

    func testAnUnregisteredSlotIsAnEmptyPlaceholder() {
        let size = RendererTestSupport.idealSize(SlotPlaceholder(name: "composer"))
        XCTAssertLessThanOrEqual(size.height, 20)
    }

    // MARK: AppActionRouter

    func testRouterDispatchesByName() {
        let router = AppActionRouter()
        var got: [DesignAction] = []
        router.register(["room.switch", "message.send"]) { action, ctx in
            got.append(action)
            XCTAssertEqual(ctx.source?.id, "row")
        }
        let host = RendererTestSupport.host(actions: router)
        XCTAssertTrue(router.dispatch(.roomSwitch("family"), context: ActionContext(host: host, source: ActionSource("row"))))
        XCTAssertTrue(router.dispatch(.messageSend, context: ActionContext(host: host, source: ActionSource("row"))))
        XCTAssertEqual(got, [.roomSwitch("family"), .messageSend])
        // Nobody handles call.audio: logged and ignored.
        XCTAssertFalse(router.dispatch(.callAudio, context: ActionContext(host: host, source: nil)))
        XCTAssertTrue(router.handles("room.switch"))
        router.unregister(["room.switch"])
        XCTAssertFalse(router.handles("room.switch"))
    }

    func testTheHostHandsTheAppsActionsToTheRouter() {
        let router = AppActionRouter()
        var got: [DesignAction] = []
        router.register(["room.switch", "lock.now"]) { a, _ in got.append(a) }
        let host = RendererTestSupport.host(actions: router)
        let scope = host.scope(for: "rooms")
        XCTAssertEqual(host.runner.run("room.switch", raw: "=$room.key", value: "team", scope: scope), .performed(.roomSwitch("team")))
        XCTAssertEqual(host.runner.run("lock.now", raw: nil, value: nil, scope: scope), .performed(.lockNow))
        XCTAssertEqual(got, [.roomSwitch("team"), .lockNow])
        // Unhandled: no crash, nothing else happens.
        XCTAssertEqual(host.runner.run("call.video", raw: nil, value: nil, scope: scope), .performed(.callVideo))
        XCTAssertEqual(host.runner.run("no.such.action", raw: nil, value: nil, scope: scope), .unknown("no.such.action"))
    }

    func testSettingChangesReachTheObservers() {
        let router = AppActionRouter()
        var keys: [String] = []
        router.onSettingChanged { k, _ in keys.append(k) }
        let host = RendererTestSupport.host(actions: router)
        XCTAssertEqual(host.runner.run("setting.set", raw: "voice.rate=1.5", value: "voice.rate=1.5", scope: .empty), .handled)
        XCTAssertEqual(host.settings.num("voice.rate"), 1.5)
        XCTAssertEqual(keys, ["voice.rate"])
        // A privacy key: never from the design (ActionGuard), only the user's own tap.
        XCTAssertEqual(host.runner.run("setting.toggle", raw: "callLog", value: "callLog", scope: .empty), .refused(.privacy))
        XCTAssertTrue(host.userSetSetting("callLog", .bool(true)))
        XCTAssertTrue(host.settings.bool("callLog"))
        XCTAssertEqual(keys, ["voice.rate", "callLog"])
    }

    func testEveryCatalogActionHasItsNameBack() {
        for name in ActionCatalog.names {
            // Arguments that parse for every action (a room key, a language, a reader, a key=value, a command).
            let arg: DesignValue
            switch name {
            case "lang.set": arg = "cs"
            case "nfc.reader": arg = "usb"
            case "fn.run": arg = "/help"
            case "set", "setting.set", "look.set": arg = "a=b"
            default: arg = "x"
            }
            guard let parsed = DesignAction.parse(name, value: arg) else { XCTFail("\(name) does not parse"); continue }
            XCTAssertEqual(parsed.name, name)
        }
    }

    func testLinksGoToTheirHandler() throws {
        let router = AppActionRouter()
        let host = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: false, lockSetUp: false, locked: false)), actions: router)
        let url = try XCTUnwrap(URL(string: "m5cet://enroll?server=chat.example.com&code=AB-12"))
        // Nobody takes it: it stays pending (AppModel) for the enrolment form.
        XCTAssertFalse(host.handleLink(.enroll(url)))
        var taken: DeepLink?
        router.onLink { link, _ in taken = link; return true }
        XCTAssertTrue(host.handleLink(.enroll(url)))
        XCTAssertEqual(taken, .enroll(url))
    }

    // MARK: ScreenStateProvider

    func testTheProvidersVariablesWinAndTheCommonOnesAreThere() {
        let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: true))
        state.vars["lock"] = ["lock": ["mode": "pin", "setup": false, "left": 5]]
        state.vars["rooms"] = ["rooms": [], "selectedCount": 0]
        let host = RendererTestSupport.host(state: state)
        host.wide = true
        let lock = host.scope(for: "lock")
        XCTAssertEqual(lock["lock"]["mode"], "pin")
        XCTAssertEqual(lock["lock"]["wide"], true, "$lock.wide comes from the window")
        XCTAssertEqual(lock["app"]["name"], "M5cet")
        XCTAssertEqual(lock["form"], .object([:]), "the lock screen never sees $form")
        host.form["composer"] = "draft"
        XCTAssertEqual(host.scope(for: "rooms")["form"]["composer"], "draft")
        XCTAssertEqual(host.scope(for: "lock")["form"], .object([:]))
        XCTAssertEqual(host.scope(for: "rooms")["settings"]["voice"]["rate"], 1.0)
        // settings.appearance gets $presets from the look when the provider has none.
        XCTAssertNotNil(host.scope(for: "settings.appearance")["presets"].arrayValue?.first)
    }

    func testSampleStateIsTheConsolesSampleData() throws {
        // The fixture the M5Design tests use (server/android/design.ts SCREENS[].sample).
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let catalog = try DesignValue.parse(Data(contentsOf: repo.appendingPathComponent("ios/M5Kit/Tests/M5DesignTests/fixtures/catalog.json")))
        let screens = try XCTUnwrap(catalog["screens"].arrayValue)
        let state = SampleScreenState()
        XCTAssertEqual(SampleScreenData.screens, screens.compactMap { $0["id"].stringValue })
        for s in screens {
            let id = try XCTUnwrap(s["id"].stringValue)
            XCTAssertEqual(DesignValue.object(state.samples[id] ?? [:]), s["sample"], "SampleScreenData.\(id) is out of step: run the generator in its header")
        }
    }
}
