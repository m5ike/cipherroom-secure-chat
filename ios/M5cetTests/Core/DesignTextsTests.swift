// The design's words outside the screens follow a design bundle that becomes active
// (DesignBundleStore → DesignServices.setDesign) as they follow lang.set: M5Core's Texts
// (protocol notices), the notifications' mirror for the extension (the app's name, the
// language), M5NFC's texts (the system NFC sheet, the readers' summaries).

import M5Core
import M5Design
import M5NFC
import XCTest
@testable import M5cet

@MainActor
final class DesignTextsTests: XCTestCase {
    /// The built-in design as a bundle with other words for a few keys (and another app name).
    private func bundle(_ base: Design, text: String, appName: String) -> Design {
        var doc = base.document
        for lang in doc.strings.keys {
            doc.strings[lang]?["rooms.title"] = text
            doc.strings[lang]?["nfc.ios.hold"] = text
        }
        doc.appName = appName
        return Design(source: "bundle-test", version: "1", document: doc)
    }

    func testTheCoreTextsFollowABundleAndTheLanguage() {
        let me = TestPerson.make("texts", hub: FakeHub(), net: LoopbackNet())
        let services = me.core.services
        let builtIn = Texts.t("rooms.title", "?")
        XCTAssertNotEqual(builtIn, "?")
        services.setDesign(bundle(services.builtIn, text: "Bundle rooms", appName: "Bundle"))
        XCTAssertEqual(Texts.t("rooms.title", "?"), "Bundle rooms", "the active bundle's words, not the built-in design's")
        services.setDesign(services.builtIn)
        XCTAssertEqual(Texts.t("rooms.title", "?"), builtIn, "back to the built-in design")
        services.setLang("cs")
        XCTAssertEqual(Texts.t("rooms.title", "?"), services.builtIn.text("rooms.title", lang: "cs"))
        services.setLang("")
    }

    func testTheNotificationsMirrorFollowsABundle() throws {
        let suite = "cz.m5cet.tests.texts.notify"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        let services = DesignServices(store: SettingsStore(defaults: d))
        let store = MemorySyncStateStore()
        let n = Notifier(prefs: NotificationPrefs(settings: DesignNotifySettings(services: services), store: store),
                         conversations: Conversations(store: store), system: nil)
        n.connect(design: services)
        func mirroredName() -> String? { store.loadNow(NotifyMirror.record)?.str("appName") }
        XCTAssertEqual(mirroredName(), services.builtIn.appName)
        services.setDesign(bundle(services.builtIn, text: "x", appName: "Bundle app"))
        XCTAssertEqual(mirroredName(), "Bundle app", "the extension's neutral titles name the bundle's app")
        services.setLang("de")
        XCTAssertEqual(store.loadNow(NotifyMirror.record)?.str("lang"), "de")
    }

    func testTheNfcTextsFollowABundle() async throws {
        let model = AppModel()
        let services = model.design
        NfcParts.installTexts(services)
        defer { services.setDesign(services.builtIn); NfcParts.installTexts(services) }
        services.setDesign(bundle(services.builtIn, text: "Bundle hold", appName: "B"))
        // NfcParts installs M5NFC's texts by observing the design: the change lands on the next turn.
        for _ in 0..<50 where NfcTexts.t("nfc.ios.hold", "?") != "Bundle hold" { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(NfcTexts.t("nfc.ios.hold", "?"), "Bundle hold")
    }
}
