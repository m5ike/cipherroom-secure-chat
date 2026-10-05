// The NFC panel and the design's nfc.* actions (Android ToolPanels.NfcPanel over
// nfc/Nfc): $nfc, reading a connection tag (format 2 opened with its code, format
// 1 weak), writing / being the room's tag (format 2 only, prepared first), and the
// install of the NFC parts (slots, actions, $nfc, M5NFC's texts in the design's words).

import M5Core
import M5Design
import M5NFC
import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class NfcPanelModelTests: XCTestCase {
    private func panel(_ fake: FakeNfcUi, _ rec: NfcUiRecorder = NfcUiRecorder()) -> NfcPanelModel {
        let m = NfcPanelModel(service: { fake }, words: NfcUiTest.words)
        m.trustedOrigin = { "https://chat.example.com" }
        m.activeCard = { ["room": "team", "passphrase": "pp", "name": "Mike"] }
        m.conn.flash = { t, l in rec.flashes.append((t, l)) }
        return m
    }

    func testNfcScopeOnAnIPhoneAndAnIPad() {
        let phone = panel(FakeNfcUi())
        XCTAssertEqual(phone.scope["available"], true)
        XCTAssertEqual(phone.scope["enabled"], true, "iOS has no NFC switch")
        XCTAssertEqual(phone.scope["state"], "idle")
        XCTAssertEqual(phone.scope["last"], .null)
        XCTAssertEqual(phone.scope["emulating"], false)
        XCTAssertEqual(phone.status, NfcUiTest.w("tools.nfc"))

        let pad = panel(FakeNfcUi(iPhone: false))
        XCTAssertEqual(pad.scope["available"], false)
        XCTAssertEqual(pad.status, NfcUiTest.w("nfc.unavailable.device"))
        pad.action("read")
        XCTAssertEqual(pad.mode, "idle")
    }

    func testReadingAConnectionTagOpensItWithTheTypedCode() async {
        let fake = FakeNfcUi()
        fake.tag = NfcTagRead(identity: CardIdentity(uid: "04A1", tech: NfcCatalog.ntag21x), ndef: NdefStatus(state: .readWrite, capacity: 496),
                              records: [ConnectionCard.record(NfcTagV2.prefix + "{}"), try! Ndef.textRecord("hello")])
        fake.conn = { _, secret, redeem in
            var r = NfcConnReading()
            r.format = "v2-off"
            XCTAssertTrue(redeem)
            if secret == "CODE" { r.room = .init(room: "team", passphrase: "pp", name: "") } else { r.need = "code" }
            return r
        }
        let m = panel(fake)
        m.action("read")
        XCTAssertEqual(m.mode, "read")
        XCTAssertEqual(m.status, NfcUiTest.w("nfc.hold"))
        await NfcUiTest.until { m.mode == "idle" }
        XCTAssertEqual(m.last?.optBool("card"), true)
        XCTAssertEqual(m.lastConn?.need, "code")
        XCTAssertTrue(m.lines.contains("ID 04A1"))
        XCTAssertTrue(m.lines.contains("T  hello"))
        XCTAssertTrue(m.lines.contains("NDEF · 496 B"))
        XCTAssertEqual(m.scope["last"]["conn"]["need"], "code")

        // The code typed afterwards opens the same body again — no tag.
        m.openLast("CODE")
        XCTAssertEqual(m.mode, "opening")
        XCTAssertEqual(m.status, NfcUiTest.w("nfc.v2.opening"))
        await NfcUiTest.until { m.mode == "idle" }
        XCTAssertEqual(m.lastConn?.room?.room, "team")
        XCTAssertEqual(fake.calls.filter { $0 == "readTag" }.count, 1)
    }

    func testAnOldTagIsWeakAndItsErrorIsWorded() async {
        let fake = FakeNfcUi()
        fake.tag = NfcTagRead(identity: CardIdentity(uid: "04", tech: NfcCatalog.ntag21x), ndef: NdefStatus(state: .readWrite, capacity: 137),
                              records: [ConnectionCard.record("m5cet:nfc:v1:AAAA")])
        fake.conn = { _, _, _ in var r = NfcConnReading(); r.format = "v1"; r.weak = true; r.error = "wrong-pin"; r.need = "pin"; return r }
        let m = panel(fake)
        m.pin = "1111"
        m.action("read")
        await NfcUiTest.until { m.mode == "idle" }
        XCTAssertEqual(m.lastConn?.weak, true)
        XCTAssertEqual(m.status, "⚠ " + NfcUiTest.w("nfc.wrongPin"))
    }

    func testWritingTheRoomIsFormatTwoPreparedFirst() async {
        let fake = FakeNfcUi()
        let rec = NfcUiRecorder()
        let m = panel(fake, rec)
        var presented = 0
        m.conn.presenter = { _ in presented += 1 }
        m.action("write")
        XCTAssertTrue(m.conn.choosing)
        XCTAssertEqual(presented, 1)
        await m.conn.choose("inv", words: NfcUiTest.words)
        XCTAssertTrue(fake.calls.contains("prepare:inv"))
        await NfcUiTest.until { m.mode == "idle" && !fake.connWritten.isEmpty }
        XCTAssertEqual(fake.connWritten, [NfcTagV2.prefix + "{\"k\":\"inv\"}"])
        XCTAssertEqual(m.status, "✓ " + NfcUiTest.w("nfc.written"))

        // Too small: the design's words for a connection card.
        fake.readError = NfcWriteFailure(.tooSmall, needed: 300, available: 137)
        m.action("write")
        await m.conn.choose("inv", words: NfcUiTest.words)
        await NfcUiTest.until { m.mode == "idle" && m.message == "too-small" }
        XCTAssertEqual(m.status, NfcUiTest.w("nfc.tooSmall"))
    }

    func testWritingNeedsTheActiveRoom() {
        let rec = NfcUiRecorder()
        let m = panel(FakeNfcUi(), rec)
        m.host = nil
        m.activeCard = { nil }
        m.action("write")
        XCTAssertFalse(m.conn.choosing)
    }

    func testBeingTheTagNeedsHceAndSaysWhy() async {
        let fake = FakeNfcUi()
        let m = panel(fake)
        m.action("emulate")
        await m.conn.choose("inv", words: NfcUiTest.words)
        await NfcUiTest.until { m.mode == "idle" && !m.message.isEmpty }
        XCTAssertTrue(m.message.contains("HCE"), m.message)

        let hce = FakeNfcUi(hce: true)
        hce.modelReadDelay = .zero
        let m2 = panel(hce)
        m2.action("emulate")
        await m2.conn.choose("inv", words: NfcUiTest.words)
        await NfcUiTest.until { !hce.emulated.isEmpty }
        XCTAssertEqual(hce.emulated.count, 1)
        m2.stop()
        XCTAssertEqual(m2.mode, "idle")
        XCTAssertTrue(hce.calls.contains("stopEmulation"))
    }

    // MARK: the install (Bootstrap)

    func testTheNfcPartsAreInstalled() throws {
        let model = AppModel()
        NfcParts.install(into: model)
        let services = model.design
        for slot in ["nfcPanel", "nfcWork", "nfcBuilder"] { XCTAssertTrue(services.slots.has(slot), slot) }
        for action in ["nfc.read", "nfc.write", "nfc.emulate", "nfc.stop"] { XCTAssertTrue(services.actions.handles(action), action) }
        XCTAssertTrue(CoreModels.shared.variables.has("nfc", "nfc"))
        let nfc = try XCTUnwrap(CoreModels.shared.variables.values(for: "nfc")["nfc"])
        XCTAssertNotNil(nfc["available"].boolValue)
        XCTAssertEqual(nfc["state"], "idle")

        // M5NFC's texts speak the design's words, in the app's language — and follow a change of language.
        services.setLang("en")
        NfcParts.installTexts(services)
        XCTAssertEqual(NfcTexts.t("nfc.model.done", "x"), services.design.t("nfc.model.done", lang: "en"))
        services.setLang("cs")
        NfcParts.installTexts(services)
        XCTAssertEqual(NfcTexts.t("nfc.model.done", "x"), services.design.t("nfc.model.done", lang: "cs"))
        XCTAssertNotEqual(NfcTexts.t("nfc.model.done", "x"), services.design.t("nfc.model.done", lang: "en"))
        XCTAssertEqual(NfcTexts.t("nfc.no.such.key", "fallback"), "fallback")
        XCTAssertTrue(NfcTexts.n("nfc.emv.sum.apps", 1, "x").contains("1"))
        services.setLang("")
        NfcParts.installTexts(services)
    }

    /// The design's NFC screens draw (iPhone and iPad, light and dark) with the parts in their slots.
    func testTheNfcScreensDrawWithTheirParts() throws {
        let host = RendererTestSupport.host()
        let model = AppModel()
        NfcParts.install(into: model)
        for name in ["nfcWork", "nfcBuilder", "nfcPanel"] {
            let ctx = try slotContext(host, screen: name == "nfcBuilder" ? "nfc.builder" : "nfc", slot: name)
            let view = model.design.slots.view(ctx)
            for (size, regular) in [(RendererTestSupport.iPhone, false), (RendererTestSupport.iPadLandscape, true)] {
                for dark in [false, true] {
                    let vc = RendererTestSupport.layOut(view, size: size, regular: regular, dark: dark)
                    let image = RendererTestSupport.draw(vc.view)
                    XCTAssertEqual(image.size, size, "\(name) dark \(dark)")
                }
            }
        }
    }

    private func slotContext(_ host: DesignHost, screen: String, slot: String) throws -> SlotContext {
        let scope = host.scope(for: screen)
        let node = try XCTUnwrap(host.resolve(screen, scope: scope))
        let s = try XCTUnwrap(node.find("panel"))
        return SlotContext(name: slot, node: s, context: host.renderContext(), horizontalSizeClass: .compact, host: host)
    }
}
