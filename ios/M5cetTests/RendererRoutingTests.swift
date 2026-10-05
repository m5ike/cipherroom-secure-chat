// Which screen shows when (MainActivity.route), the back stack (showScreen's push rule,
// onBackPressed), and the renderer's own actions: menus, sheets, flash, the
// confirmations ActionGuard asks for.

import M5Design
import XCTest
@testable import M5cet

@MainActor
final class RendererRoutingTests: XCTestCase {
    // MARK: route()

    private func routed(_ st: AppRouteState) -> DesignHost {
        let host = RendererTestSupport.host(state: StubScreenState(st))
        host.route()
        return host
    }

    func testRouteDecidesTheFirstScreen() {
        XCTAssertEqual(routed(AppRouteState(enrolled: false, lockSetUp: false, locked: false)).screen, "enroll")
        XCTAssertEqual(routed(AppRouteState(enrolled: true, lockSetUp: false, locked: false)).screen, "lock", "no PIN yet: set it up")
        XCTAssertEqual(routed(AppRouteState(enrolled: true, lockSetUp: true, locked: true)).screen, "lock")
        XCTAssertEqual(routed(AppRouteState(enrolled: true, lockSetUp: true, locked: false)).screen, "rooms")
        XCTAssertEqual(routed(AppRouteState(enrolled: true, lockSetUp: true, locked: false, hasActiveRoom: true)).screen, "room")
    }

    /// DEBUG -M5Screen: the core's routeChanged() after its start (every window routes) keeps the screen asked for.
    func testSampleModeKeepsTheScreenAskedForWhenTheCoreRoutes() {
        let host = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false)))
        host.sampleMode = true
        host.showScreen("settings.notify", transition: false)
        host.route()
        XCTAssertEqual(host.screen, "settings.notify")
        // Without it the same route goes to the rooms (Release behaviour).
        host.sampleMode = false
        host.route()
        XCTAssertEqual(host.screen, "rooms")
    }

    func testEnteringTheAppTellsTheObserversAndClearsTheStack() {
        let router = AppActionRouter()
        var entered = 0
        router.onEnterApp { _ in entered += 1 }
        let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: true))
        let host = RendererTestSupport.host(state: state, actions: router)
        host.route()
        XCTAssertEqual(host.screen, "lock")
        XCTAssertEqual(entered, 0)
        state.routeState.locked = false
        host.route()
        XCTAssertEqual(host.screen, "rooms")
        XCTAssertEqual(entered, 1)
        XCTAssertTrue(host.router.stack.isEmpty)
    }

    func testTheSplashWaitsItsMinimumTime() async throws {
        let host = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false)))
        host.start()
        XCTAssertEqual(host.screen, "splash", "animations.splash.minMs (700 ms)")
        try await Task.sleep(for: .milliseconds(1100))
        XCTAssertEqual(host.screen, "rooms")
    }

    func testResumingLockedGoesToTheLock() {
        let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false))
        let host = RendererTestSupport.host(state: state)
        host.route()
        host.showScreen("settings")
        state.routeState.locked = true
        host.resumed()
        XCTAssertEqual(host.screen, "lock")
        XCTAssertTrue(host.router.stack.isEmpty)
    }

    func testNoScreenStepsPastTheLock() {
        let state = StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: true))
        let host = RendererTestSupport.host(state: state)
        host.route()
        XCTAssertEqual(host.screen, "lock")
        for id in ["rooms", "room", "settings"] {
            host.showScreen(id)
            XCTAssertEqual(host.screen, "lock", "\(id) while locked")
        }
        state.routeState = AppRouteState(enrolled: false, lockSetUp: false, locked: false)
        host.showScreen("rooms")
        XCTAssertEqual(host.screen, "enroll", "not enrolled: enrolment first")
        state.routeState = AppRouteState(enrolled: true, lockSetUp: true, locked: false)
        host.showScreen("settings")
        XCTAssertEqual(host.screen, "settings", "unlocked: any screen")
    }

    // MARK: the back stack (ScreenRouter)

    func testShowScreenPushesAsAndroidDoes() {
        let r = ScreenRouter()
        r.show("splash", transition: false)
        r.show("rooms", transition: true)
        XCTAssertEqual(r.stack, [], "nothing from the splash")
        r.show("settings", transition: true)
        r.show("settings.voice", transition: true)
        XCTAssertEqual(r.stack, ["rooms", "settings"])
        r.show("settings.voice", transition: true)
        XCTAssertEqual(r.stack, ["rooms", "settings"], "the same screen again is no new entry")
        r.show("lock", transition: true)
        XCTAssertEqual(r.stack, ["rooms", "settings"], "the lock never goes on the stack")
        r.show("rooms", transition: true)
        XCTAssertEqual(r.stack, ["rooms", "settings"], "nothing from the lock")
    }

    func testBackPopsAndDropsDuplicates() {
        let r = ScreenRouter()
        r.show("rooms", transition: false)
        r.show("settings", transition: true)
        r.show("about", transition: true)
        XCTAssertEqual(r.back(), .shown("settings"))
        XCTAssertEqual(r.screen, "settings")
        XCTAssertEqual(r.stack, ["rooms"])
        XCTAssertEqual(r.back(), .shown("rooms"))
        XCTAssertEqual(r.back(), .leave, "an empty stack: Android leaves the app")
        // rooms → room → settings → room: back from room pops settings, then the room under it goes too.
        let r2 = ScreenRouter()
        r2.show("rooms", transition: false)
        r2.show("room", transition: true)
        r2.show("settings", transition: true)
        r2.show("room", transition: true)
        XCTAssertEqual(r2.stack, ["rooms", "room", "settings"])
        XCTAssertEqual(r2.back(), .shown("settings"))
        XCTAssertEqual(r2.stack, ["rooms"], "the room it came from is not kept twice")
    }

    func testBackFromTheRoomGoesToTheRooms() {
        let r = ScreenRouter()
        r.show("room", transition: false)
        XCTAssertEqual(r.back(), .shown("rooms"))
        XCTAssertEqual(r.stack, [])
        let lock = ScreenRouter()
        lock.show("lock", transition: false)
        XCTAssertEqual(lock.back(), .leave)
    }

    func testTransitionsOnlyBetweenScreens() {
        let r = ScreenRouter()
        r.show("splash", transition: true)
        XCTAssertFalse(r.animated, "the first screen just shows")
        r.show("rooms", transition: true)
        XCTAssertTrue(r.animated)
        r.show("rooms", transition: true)
        XCTAssertFalse(r.animated)
        r.reshow()
        XCTAssertFalse(r.animated)
    }

    // MARK: the renderer's own actions

    func testNavigationActions() {
        let host = RendererTestSupport.host()
        host.showScreen("rooms", transition: false)
        host.runner.run("screen.open", raw: "settings", value: "settings", scope: .empty)
        XCTAssertEqual(host.screen, "settings")
        host.runner.run("screen.open", raw: "nothing.like.this", value: "nothing.like.this", scope: .empty)
        XCTAssertEqual(host.screen, "settings", "a screen the design does not have is ignored")
        host.runner.run("back", raw: nil, value: nil, scope: .empty)
        XCTAssertEqual(host.screen, "rooms")
        host.runner.run("nfc.workbench", raw: nil, value: nil, scope: .empty)
        XCTAssertEqual(host.screen, "nfc")
    }

    func testMenusNeedAnAnchorAndRunTheirItems() async {
        let router = AppActionRouter()
        var ran: [DesignAction] = []
        router.register(["lock.now"]) { a, _ in ran.append(a) }
        let host = RendererTestSupport.host(state: StubScreenState(AppRouteState(enrolled: true, lockSetUp: true, locked: false)), actions: router)
        host.showScreen("rooms", transition: false)
        host.runner.run("menu.open", raw: "main", value: "main", scope: .empty)
        XCTAssertNil(host.menu, "no anchor, no menu (MainActivity.showMenu)")
        host.runner.run("menu.open", raw: "main", value: "main", scope: .empty, source: ActionSource("root/bar/menu"))
        let menu = try? XCTUnwrap(host.menu)
        XCTAssertEqual(menu?.anchor, "root/bar/menu")
        let lock = menu?.entries.first { $0.icon == "lock" }
        XCTAssertNotNil(lock)
        XCTAssertFalse(menu?.entries.contains { $0.icon == "circle-user-round" } ?? true, "profile only when signed in")
        host.pick(lock!)
        XCTAssertNil(host.menu)
        await Task.yield()
        await Task.yield()
        XCTAssertEqual(ran, [.lockNow])
        XCTAssertFalse(host.menuBinding("root/bar/menu").wrappedValue)
    }

    func testSheetsOpenCloseAndBackClosesThemFirst() {
        let host = RendererTestSupport.host()
        host.showScreen("rooms", transition: false)
        host.showScreen("room")
        host.runner.run("sheet.open", raw: "tools", value: "tools", scope: .empty)
        XCTAssertEqual(host.sheet?.screen, "tools")
        XCTAssertTrue(host.back())
        XCTAssertNil(host.sheet)
        XCTAssertEqual(host.screen, "room", "Back closed the sheet, not the screen")
        host.runner.run("room.join", raw: nil, value: nil, scope: .empty)
        XCTAssertNil(host.sheet, "room.join is the app's (unhandled here)")
        host.showSheet("join")
        XCTAssertEqual(host.sheet?.screen, "join")
        host.runner.run("sheet.close", raw: nil, value: nil, scope: .empty)
        XCTAssertNil(host.sheet)
        host.showSheet("update")
        host.runner.run("update.later", raw: nil, value: nil, scope: .empty)
        XCTAssertNil(host.sheet, "update.later closes the card")
    }

    func testTheDockATapClosedStaysClosedForThatTap() {
        let host = RendererTestSupport.host()
        host.showScreen("room", transition: false)
        host.showSheet("tools")
        host.dockClosedByTap()
        XCTAssertNil(host.sheet)
        host.showSheet("tools")
        XCTAssertNil(host.sheet, "the same tap reached the dock's own button")
    }

    func testFlash() {
        let host = RendererTestSupport.host()
        XCTAssertTrue(host.showFlash(title: "", text: "Saved.", level: .success))
        XCTAssertFalse(host.showFlash(title: "", text: "", level: .info))
        XCTAssertEqual(host.flashes.map(\.text), ["Saved."])
        host.runner.run("flash", raw: "Hi", value: "Hi", scope: .empty)
        XCTAssertEqual(host.flashes.last?.level, .info)
        host.dismissFlash(host.flashes[0].id)
        XCTAssertEqual(host.flashes.map(\.text), ["Hi"])
    }

    func testURLOpenIsConfirmedFirst() {
        let host = RendererTestSupport.host()
        host.runner.run("url.open", raw: "https://example.com/help", value: "https://example.com/help", scope: .empty)
        XCTAssertEqual(host.urlConfirmation?.url, "https://example.com/help")
        XCTAssertEqual(host.urlConfirmation?.title, "example.com")
        host.urlConfirmation = nil
        // Computed from data: refused before anything is shown.
        let out = host.runner.run("url.open", raw: "=$msg.text", value: "https://evil.example/x", scope: .empty)
        XCTAssertEqual(out, .refused(.computed))
        XCTAssertNil(host.urlConfirmation)
        XCTAssertEqual(host.flashes.last?.text, host.translator.t("security.refused"))
    }

    func testComputedCopyIsShownBeforeItGoes() {
        let host = RendererTestSupport.host()
        host.runner.run("copy", raw: "{$msg.text}", value: "secret\u{202E}text", scope: .empty)
        let req = try? XCTUnwrap(host.shareConfirmation)
        XCTAssertEqual(req?.text, "secret\u{202E}text")
        XCTAssertEqual(req?.shown, "secret[U+202E]text")
        XCTAssertFalse(req?.share ?? true)
    }

    func testLanguageAndThemeChangeInPlace() {
        let host = RendererTestSupport.host()
        host.showScreen("settings", transition: false)
        let before = host.revision
        host.runner.run("lang.set", raw: "cs", value: "cs", scope: .empty)
        XCTAssertEqual(host.services.lang, "cs")
        XCTAssertEqual(host.translator.lang, "cs")
        XCTAssertGreaterThan(host.revision, before)
        XCTAssertEqual(host.screen, "settings", "no restart: the same screen in the new language")
        host.systemDark = false
        XCTAssertFalse(host.isDark)
        host.runner.run("theme.toggle", raw: nil, value: nil, scope: .empty)
        XCTAssertTrue(host.isDark)
        XCTAssertEqual(host.settings.str("appearance.tone"), "dark")
        XCTAssertEqual(host.explicitDark, true)
    }

    func testSettingsArePersisted() {
        let store = RendererTestSupport.store("cz.m5cet.tests.renderer.persist")
        let a = DesignServices(store: store, state: SampleScreenState())
        var s = a.settings
        XCTAssertTrue(s.set("voice.pitch", .number(1.3)))
        a.settings = s
        a.setLang("de")
        let b = DesignServices(store: store, state: SampleScreenState())
        XCTAssertEqual(b.settings.num("voice.pitch"), 1.3)
        XCTAssertEqual(b.lang, "de")
        XCTAssertEqual(b.settings.num("look.v"), 1, "the look migrated once")
    }
}
