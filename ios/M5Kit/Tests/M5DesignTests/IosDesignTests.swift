import Foundation
import Testing
@testable import M5Design

/// 6.14: the design the iOS app ships (ios/Design/m5/default-design.json, script/ios-assets.ts from the server's
/// server/ios/design.ts) — Android's default design with the iOS look and the iOS-only items. Like
/// DesignDocumentTests and RendererTests for Android's file: it decodes, round-trips, this version knows
/// everything in it, every screen resolves in light and dark.
@MainActor
@Suite struct IosDesignTests {
    static let raw = try! Fixtures.data(Fixtures.iosAssets + "default-design.json")
    static let catalog = try! Fixtures.json(Fixtures.here + "catalog.json")
    static var ios: Design { Fixtures.iosBuiltIn }

    /// The watch app's keys (ios/M5cet/Platform/Watch/WatchWire.swift, WatchWire.english) and the NFC sheet's.
    static let watchKeys = [
        "watch.setting", "watch.setting.hint",
        "watch.locked", "watch.locked.hint", "watch.off", "watch.off.hint", "watch.waiting", "watch.waiting.hint",
        "watch.away", "watch.away.hint", "watch.unreachable", "watch.noRooms", "watch.noMessages", "watch.notOpen",
        "watch.open", "watch.opened", "watch.write", "watch.quick", "watch.reply.sending", "watch.reply.queued",
        "watch.reply.sent", "watch.reply.failed", "watch.reply.locked", "watch.kind.video", "watch.kind.held",
        "watch.kind.fn", "watch.quick.1", "watch.quick.2", "watch.quick.3", "watch.quick.4", "watch.quick.5",
    ]
    static let nfcKeys = ["nfc.ios.hold", "nfc.ios.holdWrite", "nfc.ios.step", "nfc.ios.multipleTags",
                          // the NFC screens (Parts/NFC): a dialog's OK, the permanent lock, a report's export, an iPad
                          "nfc.ok", "nfc.lock.title", "nfc.lock.text", "nfc.lock.confirm", "nfc.report.full", "nfc.report.export",
                          "nfc.report.files", "nfc.report.html", "nfc.report.saved", "nfc.unavailable.device"]
    /// A safety number's QR (Parts/People: PeopleTexts) — the web's words.
    static let peopleKeys = ["sec.safety.scan", "sec.safety.verified", "sec.safety.mismatch"]
    /// Why Core NFC cannot do an op (M5NFC NfcPlatform.limit), the PIN key in the Secure Enclave (Settings › Security).
    static let otherKeys = ["nfc.ios.limit.noReader", "nfc.ios.limit.classic", "nfc.ios.limit.raw", "nfc.ios.limit.hce",
                            "nfc.ios.limit.payment", "nfc.ios.limit.other", "set.security.pinKey.secure-enclave"]
    /// Android's texts in the words of what iOS does (server/ios/design.ts IOS_WORDING).
    static let reworded: Set<String> = [
        "conversations.section", "conversations.on", "conversations.hint", "conversations.names.hint",
        "notify.lockScreenHide", "notify.lockScreenHide.hint", "notify.channel.android", "notify.noFcm", "set.security.blocked",
        "passkey.unsupported", "passkey.rpText", "passkey.addNoPrf", "passkey.boundText", "passkey.noPrf", "passkey.orphan",
        "passkey.unknownHint", "set.user.boundHint", "settings.callLog", "calllog.hint", "calllog.name.hint",
        "nfc.hold", "nfc.work.tapScan", "nfc.model.hold", "nfc.tpl.none", "look.mic.blocked",
    ]
    /// The screens that are not Android's as they are (server/ios/design.ts IOS_CHANGED_SCREENS): the watch switch,
    /// no call log rows, the update notice without "· 0 B".
    static let changedScreens: Set<String> = ["settings.notify", "settings.calls", "update"]

    static func context(settings: SettingsModel = SettingsModel(), dark: Bool = false, lang: String = "en") -> RenderContext {
        RenderContext(design: ios, dark: dark, translator: Translator(design: ios, lang: lang), settings: settings,
                      templates: Fixtures.iosTemplates, form: [:], animateEnter: true)
    }

    @Test func theIosDesignDecodes() throws {
        let d = Self.ios
        #expect(d.source == "built-in")
        #expect(d.version == d.document.rev)
        #expect(d.document.format == 1)
        #expect(d.appName == "M5cet")
        #expect(d.document.screens.count >= 44)
        for id in Design.requiredScreens { #expect(d.screen(id) != nil, "\(id)") }
        #expect(d.menu("main")?.isEmpty == false)
        #expect(d.library("lock-and-rooms")?.steps?.count == 2)
        #expect(Set(d.document.strings.keys) == Set(DesignLocales.codes))
        // the iOS look (server/ios/design.ts IOS_THEME, IOS_ANIMATIONS)
        #expect(d.theme?.light?["primary"] == "#0064e0")
        #expect(d.theme?.dark?["background"] == "#000000")
        #expect(d.radius == 12)
        #expect(d.anim("screen").type == "slide-left" && d.anim("screen").ms == 350)
        #expect(d.anim("splash").style == "reveal")
        #expect(d.color("@primary", dark: false, fallback: .magenta) == DesignColor.parse("#0064e0"))
    }

    @Test func roundTripsThroughCodable() throws {
        let original = try DesignValue.parse(Self.raw)
        let doc = try JSONDecoder().decode(DesignDocument.self, from: Self.raw)
        let encoded = try JSONEncoder().encode(doc)
        #expect(try DesignValue.parse(encoded) == original)
        #expect(DesignDocument(value: original).value == original)
        #expect(try JSONDecoder().decode(DesignDocument.self, from: encoded) == doc)
    }

    @Test func thisVersionKnowsEverythingInIt() {
        let report = DesignReport.check(Self.ios.document)
        #expect(report.unknownElements.isEmpty, "\(report.unknownElements)")
        #expect(report.unknownActions.isEmpty, "\(report.unknownActions)")
        #expect(report.unknownEvents.isEmpty, "\(report.unknownEvents)")
        #expect(report.expressionErrors.isEmpty, "\(report.expressionErrors.prefix(5))")
        #expect(report.problems.isEmpty, "\(report.problems.prefix(5))")
        #expect(report.nodeCount > 500)
    }

    @Test func everyScreenResolvesWithItsSampleInLightAndDark() throws {
        let screens = Self.catalog["screens"].arrayValue!
        #expect(screens.count >= 44)
        var nodes = 0
        for s in screens {
            let id = s["id"].stringValue!
            guard Self.ios.screen(id) != nil else { Issue.record("no screen \(id)"); continue }
            for dark in [false, true] {
                let node = try ScreenResolver(Self.context(dark: dark)).resolve(screen: id, scope: RendererTests.scope(s["sample"]))
                if let node {
                    nodes += node.all().count
                    let ids = node.all().map(\.id)
                    #expect(Set(ids).count == ids.count, "\(id): ids repeat")
                }
            }
        }
        #expect(nodes > 1000)
    }

    @Test func itIsAndroidsDesignPlusTheIosItems() {
        let ios = Self.ios.document, android = Fixtures.builtIn.document
        #expect(Set(ios.screens.keys) == Set(android.screens.keys))
        for (id, tree) in android.screens where !Self.changedScreens.contains(id) { #expect(ios.screens[id] == tree, "\(id)") }
        for id in Self.changedScreens { #expect(ios.screens[id] != android.screens[id], "\(id)") }
        #expect(ios.menus == android.menus)
        #expect(ios.libraries == android.libraries)
        for lang in DesignLocales.codes {
            let i = ios.strings[lang] ?? [:], a = android.strings[lang] ?? [:]
            for (k, v) in a where !Self.reworded.contains(k) { #expect(i[k] == v, "\(lang) \(k)") }
            for k in Self.reworded { #expect(i[k] != nil && a[k] != nil && i[k] != a[k], "\(lang) \(k)") }
            #expect(Set(i.keys).subtracting(a.keys) == Set(Self.watchKeys + Self.nfcKeys + Self.peopleKeys + Self.otherKeys), "\(lang)")
        }
        // Android's design never carries the iOS-only items
        let androidJson = android.value.jsonText()
        #expect(!androidJson.contains("watch.on") && !androidJson.contains("nfc.ios."))
    }

    @Test func theWatchSwitchIsInTheNotificationSettingsBoundToItsSetting() throws {
        let notify = try #require(Self.ios.screen("settings.notify"))
        func walk(_ n: DesignNode) -> [String] { [n.id] + (n.children ?? []).flatMap(walk) }
        let ids = walk(notify)
        let i = try #require(ids.firstIndex(of: "watch"))
        #expect(ids.firstIndex(of: "lockscreen-hint").map { $0 < i } == true, "after Hide on the lock screen")
        #expect(ids.firstIndex(of: "s-quiet").map { $0 > i } == true, "before the quiet hours")
        let sample = Self.catalog["screens"].arrayValue!.first { $0["id"].stringValue == "settings.notify" }!["sample"]
        for on in [false, true] {
            var s = SettingsModel()
            if on { s.set("watch.on", true) }
            let tree = try #require(try ScreenResolver(Self.context(settings: s)).resolve(screen: "settings.notify", scope: RendererTests.scope(sample, settings: s)))
            let row = try #require(tree.find("watch-switch"))
            #expect(row.binding?.setting == "watch.on")
            guard case .toggle(let t) = row.content else { Issue.record("not a switch"); return }
            #expect(t.checked == on && t.commitsOnTap)
            guard case .text(let label) = try #require(tree.find("watch-label")).content else { Issue.record("no label"); return }
            #expect(label.text == "Apple Watch")
            #expect(tree.find("watch-hint") != nil)
        }
    }

    @Test func theIosTextsAreInEveryLanguage() {
        let en = Self.ios.document.strings["en"] ?? [:]
        func tokens(_ s: String) -> [String] {
            let re = try! NSRegularExpression(pattern: "\\{[^{}\\s]+\\}")
            return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { String(s[Range($0.range, in: s)!]) }.sorted()
        }
        for lang in DesignLocales.codes {
            let table = Self.ios.document.strings[lang] ?? [:]
            for key in Self.watchKeys + Self.nfcKeys + Self.peopleKeys + Self.otherKeys {
                let text = table[key] ?? ""
                #expect(!text.trimmingCharacters(in: .whitespaces).isEmpty, "\(lang) \(key)")
                #expect(tokens(text) == tokens(en[key] ?? ""), "\(lang) \(key)")
            }
        }
        #expect(en["watch.setting"] == "Apple Watch")
        #expect(en["nfc.ios.step"] == "{0}/{1} · {2}")
        #expect(Self.ios.text("watch.locked", lang: "cs") == "Zamčeno na iPhonu")
        #expect(Self.ios.text("watch.quick.4", lang: "de") == "Bin unterwegs")
    }

    @Test func theIconsAreAndroidsAndTheIosLookComesFirst() throws {
        #expect(try Fixtures.data(Fixtures.iosAssets + "icons.json") == Fixtures.data(Fixtures.assets + "icons.json"))
        #expect(Fixtures.iosTemplates.first?.id == "ios")
        #expect(Fixtures.iosTemplates.count == Fixtures.templates.count + 1)
    }
}

/// The Apple Watch switch's setting (6.14, iOS only): off by default, and only the person turns it on — a private
/// area no design action may change (SettingSchema), the user's own tap on the bound switch may.
@MainActor
@Suite struct WatchSettingTests {
    @Test func offByDefault() {
        #expect(SettingsModel.defaults["watch.on"] == false)
        #expect(!SettingsModel().bool("watch.on"))
        #expect(SettingsModel().scope()["watch"]["on"] == false)
        #expect(SettingSchema.valid("watch.on", true) && SettingSchema.valid("watch.on", false))
        #expect(!SettingSchema.valid("watch.on", "content"))
    }

    @Test func aDesignsActionNeverSwitchesItOn() {
        #expect(SettingSchema.privacy("watch.on"))
        #expect(SettingSchema.privacy("watch.anything"))
        #expect(!SettingSchema.privacy("watchful.on"))
        #expect(ActionGuard.check("setting.set", raw: "watch.on=true", value: "watch.on=true", own: nil) == .privacy)
        #expect(ActionGuard.check("setting.toggle", raw: "watch.on", value: "watch.on", own: nil) == .privacy)
        let h = MockHost()
        let runner = ActionRunner(host: h)
        #expect(runner.run("setting.toggle", raw: "watch.on", value: "watch.on", scope: .empty, source: nil) == .refused(.privacy))
        #expect(runner.run("setting.set", raw: "watch.on=true", value: "watch.on=true", scope: .empty, source: nil) == .refused(.privacy))
        #expect(!h.settings.bool("watch.on"))
    }

    @Test func theUsersOwnSwitchDoes() {
        let h = MockHost(design: Fixtures.iosBuiltIn)
        let runner = ActionRunner(host: h)
        runner.commit(ValueBinding(setting: "watch.on", bind: nil, change: nil, scope: .empty), value: true)
        #expect(h.settings.bool("watch.on") && h.changed == ["watch.on"])
        runner.commit(ValueBinding(setting: "watch.on", bind: nil, change: nil, scope: .empty), value: false)
        #expect(!h.settings.bool("watch.on") && h.changed == ["watch.on", "watch.on"])
    }
}
