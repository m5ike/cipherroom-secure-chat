// The views of a template run (TemplateViewsTest.java, apdu-templates.ts TEMPLATE_VIEWS): io, raw and json
// exactly as the contract writes them, readable for people — the EMV report with the card number masked,
// the e-ID holder, a DESFire's version decoded, BER-TLV with the EMV names — and G-19 masking everywhere.

import Testing
import Foundation
@testable import M5NFC

@Suite struct TemplateViewsTests {
    typealias X = Templates

    static let sample = [
        TemplateExchange(step: 1, label: "SELECT PPSE (2PAY.SYS.DDF01)", op: "select-ppse", command: "00A404000E325041592E5359532E444446303100", response: "6F0A8408A000000004101000", sw: "9000", status: "ok", ms: 12),
        TemplateExchange(step: 2, label: "Counters / log \"format\"", op: "get-data", command: "80CA9F6E00", response: "", sw: "6A88", status: "warn", ms: 3),
        TemplateExchange(step: 3, label: "Záznam č. 1\tEF.DIR", op: "", command: "00B2010400", response: "", sw: "", status: "error", ms: 0),
    ]

    @Test func ioIsEveryCommandAndItsResponse() {
        #expect(TemplateViews.ioText(Self.sample) == "→ 00A404000E325041592E5359532E444446303100\n← 6F0A8408A000000004101000 9000 (OK)\n→ 80CA9F6E00\n← 6A88 (Referenced data not found)\n→ 00B2010400\n← (no answer)")
        #expect(TemplateViews.ioText([]) == "")
    }

    @Test func rawIsTheResponsesOnly() { #expect(TemplateViews.rawText(Self.sample) == "6F0A8408A000000004101000 9000\n6A88\n(no answer)") }

    @Test func jsonIsTheExchangesAsJsonStringifyWritesThem() throws {
        let json = TemplateViews.jsonText(Self.sample)
        #expect(json == """
        [
          {
            "step": 1,
            "label": "SELECT PPSE (2PAY.SYS.DDF01)",
            "op": "select-ppse",
            "command": "00A404000E325041592E5359532E444446303100",
            "response": "6F0A8408A000000004101000",
            "sw": "9000",
            "status": "ok",
            "ms": 12
          },
          {
            "step": 2,
            "label": "Counters / log \\"format\\"",
            "op": "get-data",
            "command": "80CA9F6E00",
            "response": "",
            "sw": "6A88",
            "status": "warn",
            "ms": 3
          },
          {
            "step": 3,
            "label": "Záznam č. 1\\tEF.DIR",
            "op": "",
            "command": "00B2010400",
            "response": "",
            "sw": "",
            "status": "error",
            "ms": 0
          }
        ]
        """)
        // It is JSON, and it says what the exchanges say.
        let back = try NfcJSON.parse(json)
        #expect(back.arrayValue?.count == 3)
        #expect(back[1]?["label"]?.stringValue == "Counters / log \"format\"")
        #expect(TemplateViews.jsonText([]) == "[]")
        #expect(NfcJSON.quote("a\u{01}b") == "\"a\\u0001b\"")
    }

    static func cs(_ key: String) -> String? { ["nfc.tpl.r.pan": "Číslo karty", "nfc.tpl.r.steps": "Kroky", "nfc.emv.expiry": "Platnost do"][key] ?? key }

    @Test func readableIsTheCardReportWithTheCardNumberMasked() async {
        let card = EmvSim(ppse: true, pse: false, "A0000000041010")
        var r = await TemplateRunner(X.template("Payment card (EMV) — every")).run(card)
        r.cardInfo = ["uid": "08A1B2C3", "label": "EMV payment card", "ats": "7880"]
        let text = TemplateViews.readableText(r, labels: Self.cs, cards: true)
        let title = "Payment card (EMV) — every application"
        #expect(text.hasPrefix(title + "\n" + String(repeating: "=", count: title.utf16.count) + "\nPPSE → each application"))
        #expect(text.contains("\nUID         08A1B2C3\n"))
        #expect(text.contains("Application — MASTERCARD\n------------------------"))
        #expect(text.contains("Číslo karty"))                 // the app's own words
        #expect(text.contains("541333••••••0011"))
        #expect(text.contains("Platnost do"))
        #expect(text.contains("2028-12"))
        #expect(text.contains("Transaction history — MASTERCARD (2)"))  // English where the app has no word
        #expect(text.contains("2025-09-14  18:30:05  123.45  CZK"))
        #expect(text.contains("BILLA"))
        #expect(text.contains("9F36 Application transaction counter (ATC)"))
        // The whole number never shows: records and elements carry it masked.
        #expect(!text.contains("5413330089020011"))
        #expect(text.contains("541333XXXXXX0011"))
        #expect(text.contains("SFI 11 ·  1 (log)"))
        // The steps, each with what it did.
        #expect(text.contains("\nKroky (8)\n"))
        #expect(text.contains("1 ✓  SELECT PPSE (2PAY.SYS.DDF01) — 1 application(s) listed"))
        #expect(text.contains("A0000000041010 · GET PROCESSING OPTIONS (no transaction) — AIP 1980 · AFL 0801010010010100"))
        #expect(text.hasSuffix("\n"))
        // Without the card sections (the workbench draws those) the steps stay.
        let generic = TemplateViews.readableText(r, labels: Self.cs, cards: false)
        #expect(!generic.contains("Číslo karty"))
        #expect(generic.contains("Kroky (8)"))
    }

    @Test func readableDecodesADesfiresVersion() async {
        let r = await TemplateRunner(X.template("MIFARE DESFire")).run(DesfireSim())
        let text = TemplateViews.readableText(r)
        #expect(text.contains("\nMIFARE DESFire\n--------------\n"))
        #expect(text.contains("Vendor               NXP"))
        #expect(text.contains("MIFARE DESFire EV1"))
        #expect(text.contains("1.0 (type 01, subtype 01)"))
        #expect(text.contains("Software             1.4"))
        #expect(text.contains("Storage              8 KB"))
        #expect(text.contains("UID                  04112233445566"))
        #expect(text.contains("Batch                BA7C123456"))
        #expect(text.contains("week 12 of 2019"))
        #expect(text.contains("123456, 0B0C0D"))
        #expect(text.contains("Free memory          4096 B"))
        #expect(text.contains("0F · 1 key(s), AES"))
        #expect(text.contains("master key changeable, applications listed without a key, applications created without a key, settings changeable"))
        #expect(text.contains("✓ 91AF — DESFire status af (ADDITIONAL_FRAME)"))
        #expect(TemplateViews.storage(0x17) == "2 KB – 4 KB")
        #expect(TemplateViews.product(0x01, 0x33) == "MIFARE DESFire EV3")
    }

    @Test func readableDecodesBerTlvWithTheNames() async {
        let r = await TemplateRunner(X.template("Smart card (ISO 7816-4)")).run(IsoSim())
        let text = TemplateViews.readableText(r)
        #expect(text.contains("3. READ RECORD 1 of EF.DIR"))
        #expect(text.contains("61 Application template\n  4F Application identifier (AID): A0000002471001\n  50 Application label: ICAO eMRTD  (4943414F20654D525444)"))
        #expect(text.contains("  51 Path: 3F00"))
        #expect(text.contains("43 Card service data: F0\n47 Card capabilities: 9481C1"))
        #expect(text.contains("⚠ 6A83 — Record not found"))
        #expect(TemplateViews.isTlv(Sim.dir2))
        #expect(!TemplateViews.isTlv(b("04010101001A05")))
    }

    @Test func readableShowsTheDocumentHolder() async {
        let chip = BacChip(Doc.key, Doc.files())
        let r = await TemplateRunner(X.template("e-ID / e-passport (PACE"), mrtd: MrtdReader.Options(key: Doc.key)).run(chip)
        let text = TemplateViews.readableText(r)
        #expect(text.contains("\nHolder\n------\n"))
        #expect(text.contains("ANNA MARIA ERIKSSON"))
        #expect(text.contains("L898902C"))
        #expect(text.contains("BAC (MRZ)"))
        #expect(text.contains("Personal details (DG11)"))
        #expect(text.contains("✓ every group read matches EF.SOD"))
        #expect(text.contains("Face · DG2"))
        #expect(!text.contains("/9j/")) // pictures are named, never dumped
    }

    /* ------------------------------------------------------------ G-19: masked card numbers */

    static func xs(_ n: Int) -> String { String(repeating: "X", count: n) }

    @Test func everyViewMasksTheCardNumberUnlessTheUserAsksForIt() async {
        let card = EmvSim(ppse: true, pse: false, "A0000000041010")
        let r = await TemplateRunner(X.template("Payment card (EMV) — every")).run(card)
        let pan = "5413330089020011", asciiPan = PanMask.asciiHex(pan)
        #expect(TemplateViews.pans(r).contains(pan))
        #expect(TemplateViews.masks(r))
        for v in TemplateViews.views {
            let text = TemplateViews.view(v, r)
            #expect(!text.contains(pan), "\(v)")
            #expect(!text.contains(asciiPan), "\(v)")
            #expect(!text.contains("1234567890"), "\(v)") // Track 2 / Track 1 discretionary data
        }
        let io = TemplateViews.view(TemplateViews.io, r)
        #expect(io.contains("5A08541333XXXXXX0011"))                                         // the PAN
        #expect(io.contains("5711541333XXXXXX0011D" + Self.xs(17)))                           // Track 2: the rest redacted
        #expect(io.contains("562C" + "42" + PanMask.asciiHex("541333") + Self.xs(12) + PanMask.asciiHex("0011") + Self.xs(54))) // Track 1 (ASCII)
        #expect(io.contains("9F1F0A" + Self.xs(20)))
        #expect(TemplateViews.view(TemplateViews.json, r).contains("541333XXXXXX0011"))
        // The full data only when asked for.
        #expect(TemplateViews.view(TemplateViews.io, r, full: true).contains("5A085413330089020011"))
        #expect(TemplateViews.view(TemplateViews.raw, r, full: true).contains(asciiPan))
        #expect(TemplateViews.view(TemplateViews.readable, r, full: true).contains(pan))
        // The readable view says it is masked; the full one does not.
        #expect(TemplateViews.view(TemplateViews.readable, r).contains("Card numbers and track data are masked."))
        #expect(!TemplateViews.view(TemplateViews.readable, r, full: true).contains("are masked"))
        // The masking never touches what the runner keeps.
        #expect(r.exchanges.contains { $0.response.contains(pan) })
    }

    @Test func theWorkbenchsEmvObjectIsMaskedToo() async throws {
        let r = await TemplateRunner(X.template("Mastercard")).run(EmvSim(ppse: true, pse: false, "A0000000041010"))
        let m = try #require(TemplateViews.maskedEmv(r.emv, pans: TemplateViews.pans(r)))
        let all = m.compact
        #expect(!all.contains("5413330089020011"))
        #expect(!all.contains(PanMask.asciiHex("5413330089020011")))
        let app = try #require(m.objects("apps").first)
        #expect(!app.has("pan"))
        #expect(app.optString("panMasked") == "541333••••••0011")
        #expect(r.emv?.objects("apps").first?.has("pan") == true) // the run's own object stays whole
    }

    @Test func aFixedCommandThatReadsTheCardNumberIsMaskedToo() async {
        let t = ApduTemplates.parse(["label": "by hand", "apdu": "00A4040007A0000000041010\n00B2010C00"], index: 0)
        let r = await TemplateRunner(t).run(EmvSim(ppse: false, pse: false, "A0000000041010"))
        #expect(r.emv == nil)
        #expect(TemplateViews.pans(r).contains("5413330089020011"))
        let readable = TemplateViews.view(TemplateViews.readable, r)
        #expect(!readable.contains("5413330089020011"))
        #expect(readable.contains("5A Application PAN: 541333XXXXXX0011"))
        #expect(!TemplateViews.view(TemplateViews.io, r).contains("5413330089020011"))
    }

    @Test func aRunWithoutCardNumbersMasksNothing() async {
        let r = await TemplateRunner(X.template("MIFARE DESFire")).run(DesfireSim())
        #expect(!TemplateViews.masks(r))
        #expect(TemplateViews.view(TemplateViews.io, r, full: true) == TemplateViews.view(TemplateViews.io, r))
        #expect(!TemplateViews.view(TemplateViews.readable, r).contains("are masked"))
    }

    @Test func aCancelledRunSaysSo() async {
        let runner = TemplateRunner(X.template("MIFARE DESFire"))
        runner.cancel()
        let r = await runner.run(DesfireSim())
        #expect(r.exchanges.isEmpty)
        #expect(TemplateViews.view(TemplateViews.readable, r).contains("Cancelled — this is what was read before."))
        #expect(TemplateViews.view(TemplateViews.io, r) == "")
        #expect(TemplateViews.view(TemplateViews.json, r) == "[]")
    }

    /* ------------------------------------------------------------ pan-mask.ts */

    @Test func panMaskInEveryForm() {
        #expect(PanMask.maskPanDigits("5413330089020011") == "541333XXXXXX0011")
        #expect(PanMask.maskPanDigits("5413330089020011", "•") == "541333••••••0011")
        #expect(PanMask.maskDigits("5413330089020011FF") == "541333XXXXXX0011FF")
        #expect(PanMask.maskDigits("12345") == "XXXXX")
        #expect(PanMask.maskValue("57", "5413330089020011D28122011234567890") == "541333XXXXXX0011D" + Self.xs(17))
        #expect(PanMask.maskValue("9F6B", "ABCEF012") == "ABCEF0XX")
        #expect(PanMask.maskValue("9F1F", "31323334") == "XXXXXXXX")
        let t1 = PanMask.asciiHex("B5413330089020011^NOVAK/JAN^2812")
        #expect(PanMask.maskValue("56", t1) == "42" + PanMask.asciiHex("541333") + Self.xs(12) + PanMask.asciiHex("0011") + Self.xs(t1.count - 2 - 12 - 12 - 8))
        #expect(PanMask.panOfElement("56", ascii("%B4111111111111111^X")) == "4111111111111111")
        #expect(PanMask.pansInHex(H(T(0x70, T(0x5a, b("4111111111111111"))))) == ["4111111111111111"])
        #expect(PanMask.maskPans("card 4111111111111111 " + PanMask.asciiHex("4111111111111111").lowercased(), ["4111111111111111"])
                == "card 411111XXXXXX1111 " + PanMask.asciiHex("411111") + Self.xs(12) + PanMask.asciiHex("1111"))
        #expect(PanMask.maskAnswer(H(T(0x70, T(0x5a, b("4111111111111111")))), []) == "700A5A08411111XXXXXX1111")
        #expect(!PanMask.answerMasks("6F00"))
    }
}
