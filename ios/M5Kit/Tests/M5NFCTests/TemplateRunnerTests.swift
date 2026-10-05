// The 6.10 template runner against simulated cards (TemplateRunnerTest.java): every template of the
// standard set (android/app/src/test/resources/nfc/standard-apdu-templates.json — kept equal to
// apdu-templates.ts STANDARD_APDU_TEMPLATES) runs end to end on a card of its type; every APDU that
// reaches the card is recorded (the e-ID read's secure messaging too); optional steps are tolerated;
// for-each-aid reads every application the directory lists; older entries still run; a cancel or a card
// that leaves ends the run with what was read. Nothing writes: G-18 stops a non-read before the card.

import Testing
import Foundation
import Synchronization
@testable import M5NFC

enum Templates {
    static let standard: [NfcJSON] = try! Repo.json("android/app/src/test/resources/nfc/standard-apdu-templates.json").arrayValue!

    static func template(_ labelStart: String) -> ApduTemplates.Template {
        ApduTemplates.parse(standard).first { $0.label.hasPrefix(labelStart) }!
    }

    static func one(_ t: NfcJSONObject) -> ApduTemplates.Template { ApduTemplates.parse(.object(t), index: 0) }

    static func commands(_ r: TemplateRunResult) -> [String] { r.exchanges.map(\.command) }

    static func step(_ r: TemplateRunResult, _ op: String, _ aid: String?) -> TemplateStepResult? {
        r.steps.first { $0.op == op && (aid == nil || $0.aid == aid || $0.label.contains(aid!)) }
    }

    static func count(_ r: TemplateRunResult, _ op: String) -> Int { r.steps.filter { $0.op == op }.count }

    /// Every exchange the card saw is in the transcript, in order, and each step's exchanges carry its number and label.
    static func everyApduRecorded(_ card: SimCard, _ r: TemplateRunResult) {
        #expect(card.seen == commands(r))
        var last = 0
        for e in r.exchanges {
            #expect(e.step >= last, "steps in order")
            last = e.step
            let s = r.steps[e.step - 1]
            #expect(s.step == e.step && s.label == e.label && s.op == e.op)
            #expect(["ok", "warn", "error"].contains(e.status))
        }
        #expect(card.forbidden.isEmpty)
    }
}

@Suite struct TemplateRunnerTests {
    typealias X = Templates

    @Test func theStandardSetIsRunnableAndGroupedByCardType() {
        let all = ApduTemplates.parse(X.standard)
        #expect(all.count == 16)
        for t in all {
            #expect(t.runnable, "\(t.label): \(t.problems)")
            #expect(t.legacy == nil)
            #expect(!t.note.isEmpty)
        }
        let cards = all.map(\.cardType)
        #expect(cards.filter { $0 == "emv" }.count == 12)
        #expect(cards.filter { $0 == "emrtd" }.count == 2)
        #expect(cards.filter { $0 == "desfire" }.count == 1)
        #expect(cards.filter { $0 == "iso7816" }.count == 1)
        #expect(X.template("e-ID / e-passport (PACE").eidRead != nil)
        #expect(X.template("Visa (credit").eidRead == nil)
    }

    @Test func everyApplicationOfAPaymentCardIsReadCompletely() async throws {
        let card = EmvSim(ppse: true, pse: false, "A0000000031010", "A0000000041010")
        let progress = Locked([String]())
        let r = await TemplateRunner(X.template("Payment card (EMV) — every"), onStep: { n, total, label in progress.with { $0.append("\(n)/\(total) \(label)") } }).run(card)
        X.everyApduRecorded(card, r)
        #expect(r.error == nil && !r.cancelled)
        #expect(r.card == "emv")
        let emv = try #require(r.emv)
        #expect(emv.strings("aids") == ["A0000000031010", "A0000000041010"])
        #expect(emv.optBool("deep"))
        let apps = emv.objects("apps")
        #expect(apps.count == 2)
        let visa = apps[0], mc = apps[1]
        #expect(visa.optString("aid") == "A0000000031010")
        #expect(visa.optString("scheme") == "Visa")
        #expect(visa.optString("pan") == "4111111111111111")
        #expect(mc.optString("scheme") == "Mastercard")
        #expect(mc.optString("expiry") == "2028-12")
        #expect(mc.optString("cardholder") == "NOVAK / JAN")
        #expect(mc.optInt("atc") == 42)
        #expect(mc.optInt("pinTryCounter") == 3)
        #expect(mc.arrayCount("log") == 2)
        #expect(mc.objects("log")[0].optString("merchant") == "BILLA")
        // The AFL's records, the file only the deep read finds, and the log's own records.
        #expect(mc.objects("records").map { "\($0.optInt("sfi")):\($0.optInt("record"))" } == ["1:1", "2:1", "3:1", "11:1", "11:2"])
        // Each application: SELECT, GET DATA, the log, GPO, the AFL, the other files — in that order.
        #expect(X.count(r, "select-aid") == 2)
        #expect(X.count(r, "gpo") == 2)
        #expect(X.step(r, "gpo", "A0000000041010")?.status == "ok")
        #expect(X.step(r, "read-log", "A0000000041010")?.status == "ok")
        #expect(X.step(r, "for-each-aid", nil)?.noteKey == "nfc.tpl.n.apps")
        #expect(X.step(r, "for-each-aid", nil)?.noteArgs.first == "2")
        let log = card.seen.firstIndex(of: "00B2015C00") ?? -1, gpo = card.seen.firstIndex { $0.hasPrefix("80A8") } ?? -1
        #expect(log > -1 && gpo > log) // the history before GPO (outside a transaction)
        // A missing GET DATA tag is tolerated (9F6E), not an error.
        let missing = r.exchanges.filter { $0.command == "80CA9F6E00" }
        #expect(!missing.isEmpty)
        for e in missing { #expect(e.sw == "6A88" && e.status == "warn") }
        #expect(r.status == "ok")
        // Progress: the template's two steps, the nested ones naming their application.
        let p = progress.with { $0 }
        #expect(p.first == "1/2 SELECT PPSE (2PAY.SYS.DDF01)")
        #expect(p.contains("2/2 A0000000041010 · GET PROCESSING OPTIONS (no transaction)"))
        #expect(emv.optInt("apdus") == r.exchanges.count)
    }

    @Test func theContactDirectoryListsTheApplicationsForAUsbReader() async {
        let card = EmvSim(ppse: false, pse: true, "A0000000041010")
        let r = await TemplateRunner(X.template("Payment card (EMV, contact")).run(card)
        X.everyApduRecorded(card, r)
        let pse = r.steps[0]
        #expect(pse.op == "select-pse" && pse.status == "ok" && pse.noteArgs.first == "1")
        #expect(card.seen.contains("00B2010C00")) // the directory's record (SFI 1)
        #expect(r.emv?.strings("aids") == ["A0000000041010"])
        #expect(r.emv?.objects("apps").first?.optString("pan") == "5413330089020011")
        #expect(r.emv?.optString("tree").contains("4F (7) A0 00 00 00 04 10 10") == true)
    }

    @Test func everySchemeTemplateReadsItsOwnApplication() async {
        var schemes = 0
        for t in ApduTemplates.parse(X.standard) where t.card == "emv" && !t.aid.isEmpty {
            schemes += 1
            let card = EmvSim(ppse: true, pse: false, t.aid)
            let r = await TemplateRunner(t).run(card)
            X.everyApduRecorded(card, r)
            #expect(r.status == "ok", "\(t.label)")
            let apps = r.emv?.objects("apps") ?? []
            #expect(apps.count == 1, "\(t.label)")
            #expect(apps.first?.optString("aid") == t.aid)
            #expect(apps.first?.arrayCount("log") == 2, "\(t.label)")
            #expect(r.steps.count == 7) // the directory, then SELECT, counters, history, GPO, the AFL, the other files
        }
        #expect(schemes == 10)
    }

    @Test func aSchemeTemplateOnAnotherCardSaysTheApplicationIsMissing() async {
        let card = EmvSim(ppse: true, pse: false, "A0000000041010")
        let r = await TemplateRunner(X.template("Visa (credit")).run(card)
        X.everyApduRecorded(card, r)
        let sel = X.step(r, "select-aid", nil)
        #expect(sel?.status == "error")
        #expect(sel?.noteKey == "nfc.tpl.n.notSelected")
        #expect(r.exchanges.last?.status == "error")
        #expect(r.steps.count == 2) // nothing after the SELECT that failed
        for c in card.seen { #expect(!c.hasPrefix("80A8")) }
        #expect(r.status == "error")
        #expect(r.emv?.arrayCount("apps") == 0)
    }

    @Test func withoutADirectoryForEachAidTriesTheKnownApplications() async {
        let card = EmvSim(ppse: false, pse: false, "A0000000041010")
        let r = await TemplateRunner(X.template("Payment card (EMV) — every")).run(card)
        X.everyApduRecorded(card, r)
        #expect(r.steps[0].status == "warn") // the optional PPSE
        #expect(r.steps[0].noteKey == "nfc.tpl.n.noDir")
        let apps = r.emv?.objects("apps") ?? []
        #expect(apps.count == 1)
        #expect(apps.first?.optString("aid") == "A0000000041010")
        // The probes that missed are warnings, not errors.
        for s in r.steps where s.op == "select-aid" && !s.label.contains("A0000000041010") { #expect(s.status == "warn") }
        #expect(r.status == "warn")
    }

    /* ------------------------------------------------------------ e-ID */

    @Test func theEidTemplateOpensTheDocumentAndRecordsEverySecureMessagingApdu() async {
        let chip = BacChip(Doc.key, Doc.files())
        let t = X.template("e-ID / e-passport (PACE")
        let args = t.eidRead!.args
        let o = MrtdReader.Options(mrz: Doc.mrz, readPhoto: args.optBool("readPhoto", true), all: args.optBool("all", true))
        let r = await TemplateRunner(t, mrtd: o).run(chip)
        #expect(r.card == "emrtd")
        #expect(chip.log == X.commands(r)) // every APDU, the protected ones too
        #expect(r.exchanges.count > 20)
        #expect(r.exchanges.filter { $0.command.hasPrefix("0C") }.count > 10)
        #expect(r.steps[0].status == "ok")
        #expect(r.mrtd?.optString("access") == "bac")
        #expect(r.mrtd?.optObject("mrzInfo")?.optString("surname") == "ERIKSSON")
        #expect(chip.selected.contains(0x0102)) // the face
        #expect(r.emv == nil)
    }

    @Test func theMrzOnlyTemplateReadsNoPicture() async {
        let chip = BacChip(Doc.key, Doc.files())
        let t = X.template("e-ID / e-passport — MRZ")
        let args = t.eidRead!.args
        let o = MrtdReader.Options(key: Doc.key, readPhoto: args.optBool("readPhoto", true), all: args.optBool("all", true))
        #expect(!o.readPhoto)
        let r = await TemplateRunner(t, mrtd: o).run(chip)
        #expect(chip.log == X.commands(r))
        #expect(chip.selected.contains(0x0101))
        #expect(!chip.selected.contains(0x0102))
        #expect(r.mrtd?.optObject("mrzInfo")?.optString("documentNumber") == "L898902C")
    }

    @Test func withoutTheHoldersKeyTheEidReadSaysWhatItNeeds() async {
        let chip = BacChip(Doc.key, Doc.files())
        let r = await TemplateRunner(X.template("e-ID / e-passport (PACE")).run(chip)
        #expect(r.steps[0].status == "error")
        #expect(r.steps[0].note?.contains("MRZ") == true)
        #expect(chip.log == X.commands(r))
    }

    /* ------------------------------------------------------------ DESFire / ISO 7816 */

    @Test func theDesfireTemplateRunsEveryCommand() async {
        let card = DesfireSim()
        let r = await TemplateRunner(X.template("MIFARE DESFire")).run(card)
        X.everyApduRecorded(card, r)
        #expect(X.commands(r) == ["9060000000", "90AF000000", "90AF000000", "906A000000", "906E000000", "9045000000"])
        for e in r.exchanges { #expect(e.status == "ok", "\(e.command)") } // 91AF is what the first two expect
        #expect(r.exchanges[0].sw == "91AF")
        #expect(r.steps[0].data == "04010101001A05")
        #expect(r.status == "ok")
        #expect(r.emv == nil)
    }

    @Test func theIso7816TemplateFollowsGetResponseAndWrongLe() async {
        let card = IsoSim()
        let r = await TemplateRunner(X.template("Smart card (ISO 7816-4)")).run(card)
        X.everyApduRecorded(card, r)
        let cmds = X.commands(r)
        // 61xx → GET RESPONSE, inside the same step; 6Cxx → the command again with the right Le.
        let rec1 = cmds.firstIndex(of: "00B2010400")!
        #expect(cmds[rec1 + 1] == "00C00000" + String(format: "%02X", Sim.dir1.count))
        #expect(r.exchanges[rec1].step == r.exchanges[rec1 + 1].step)
        #expect(r.exchanges[rec1].status == "ok")
        let bin = cmds.firstIndex(of: "00B0000000")!
        #expect(r.exchanges[bin].sw == "6C08")
        #expect(cmds[bin + 1] == "00B0000008")
        let rec1Step = r.steps[r.exchanges[rec1].step - 1]
        #expect(rec1Step.data == H(Sim.dir1))
        #expect(rec1Step.sw == "9000")
        // Records 3 to 8 are not there: optional, so warnings.
        for i in 4...9 { #expect(r.steps[i].status == "warn" && r.steps[i].sw == "6A83") }
        #expect(r.steps[11].data == H(Sim.atr))
        #expect(r.status == "warn")
    }

    /* ------------------------------------------------------------ steps, expect, optional */

    /// 6.10: a command answered in frames (DESFire 91AF) follows `more` only while the card says so; the frames are joined.
    @Test func moreFollowsTheFramesOnlyWhileTheCardSaysSo() async {
        let tpl: NfcJSONObject = ["label": "apps", "card": "desfire", "steps": [["apdu": "906A000000", "more": "90AF000000", "label": "GetApplicationIDs", "expect": ["9100"]]]]
        #expect(X.one(tpl).problems.isEmpty)
        var seen = [String]()
        let card = FnCard { cmd in
            let h = H(cmd)
            seen.append(h)
            var o = [UInt8]()
            let range = h == "906A000000" ? 0..<19 : 19..<20
            for i in range { o += [0x01, 0x00, UInt8(i + 1)] }
            return o + [0x91, h == "906A000000" ? 0xaf : 0x00]
        }
        let r = await TemplateRunner(X.one(tpl)).run(card)
        #expect(seen == ["906A000000", "90AF000000"])
        #expect(r.steps[0].status == "ok")
        #expect(r.steps[0].sw == "9100")
        #expect(r.steps[0].data.count == 20 * 3 * 2)
        // A follow-up that is not a read is refused before anything is sent.
        let bad: NfcJSONObject = ["label": "x", "steps": [["apdu": "906A000000", "more": "90C4000000"]]]
        #expect(!X.one(bad).problems.isEmpty)
    }

    @Test func aFixedCommandSucceedsByWhatItExpects() async {
        let t: NfcJSONObject = ["label": "DESFire by hand", "steps": [
            ["apdu": "90 60 00 00 00", "expect": ["91xx"]],
            ["apdu": "9060000000"],                       // 91AF ≠ 9000: an error
            ["apdu": "906E000000", "optional": true],      // 9100 ≠ 9000: optional, a warning
        ]]
        let r = await TemplateRunner(X.one(t)).run(DesfireSim())
        #expect(r.steps.map(\.status) == ["ok", "error", "warn"])
        #expect(r.exchanges.map(\.status) == ["ok", "error", "warn"])
        #expect(r.steps[0].label == "9060000000")
        #expect(r.status == "error")
        #expect(TemplateRunner.expected(["6Cxx", "9000"], 0x6c10))
        #expect(!TemplateRunner.expected([], 0x9100))
    }

    @Test func forEachAidRunsItsOwnListAtMostMaxTimes() async {
        let card = EmvSim(ppse: true, pse: false, "A0000000031010", "A0000000041010")
        let t: NfcJSONObject = ["label": "two lists", "steps": [["op": "for-each-aid", "aids": ["A0000000041010", "A0000000031010"], "max": 1,
                                                                 "steps": [["op": "select-aid"], ["op": "gpo"], ["op": "read-afl"]]]]]
        let r = await TemplateRunner(X.one(t)).run(card)
        X.everyApduRecorded(card, r)
        #expect(r.emv?.arrayCount("apps") == 1)
        #expect(r.emv?.objects("apps").first?.optString("aid") == "A0000000041010")
        #expect(r.emv?.optBool("deep") == false)
        #expect(X.step(r, "for-each-aid", nil)?.noteArgs.first == "1")
        #expect(r.emv?.objects("apps").first?.arrayCount("records") == 2)
    }

    @Test func olderEntriesStillRun() async {
        // One command per line (≤ 6.9).
        let card = EmvSim(ppse: true, pse: false, "A0000000041010")
        let t = X.one(["label": "Select MC", "apdu": "00A4040007A0000000041010\n80CA9F1700\nzz"])
        #expect(t.legacy == "apdu")
        #expect(t.runnable)
        #expect(t.steps.count == 2)
        let r = await TemplateRunner(t).run(card)
        #expect(X.commands(r) == ["00A4040007A0000000041010", "80CA9F1700"])
        #expect(r.status == "ok")
        // One whole read with its preferred application: read first.
        let two = EmvSim(ppse: true, pse: false, "A0000000031010", "A0000000041010")
        let et = X.one(["label": "EMV", "op": "emv-read", "aid": "A0000000041010", "args": ["deep": false]])
        #expect(et.legacy == "op")
        #expect(et.steps[0].args.optString("aid") == "A0000000041010")
        let er = await TemplateRunner(et).run(two)
        X.everyApduRecorded(two, er)
        #expect(er.emv?.objects("apps").first?.optString("aid") == "A0000000041010")
        #expect(er.emv?.arrayCount("apps") == 2)
        #expect(er.steps[0].note?.contains("Mastercard") == true)
        // The e-ID op.
        let eid = X.one(["label": "ID", "op": "eid-read"])
        #expect(eid.eidRead != nil)
        #expect(eid.cardType == "emrtd")
        // A plain string is not a template (as on the web).
        #expect(ApduTemplates.parse(.string("00A40400"), index: 3).problems == ["not an object"])
    }

    @Test func theProblemsAreTheContracts() {
        #expect(ApduTemplates.templateProblems(nil) == ["not an object"])
        #expect(ApduTemplates.templateProblems(.object([:])) == ["no label", "nothing to run: no steps, op or apdu"])
        #expect(ApduTemplates.templateProblems(.array([])) == ["no label", "nothing to run: no steps, op or apdu"])
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [["apdu": "00A4"]]]) == ["bad command 00A4"])
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [["apdu": "00A4040"]]]) == ["bad command 00A4040"])
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [["op": "select-aid", "aid": "A0"]]]) == ["bad AID A0"])
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [["op": "get-data", "tags": ["9F"]]]]) == ["get-data needs 2-byte tags"])
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [["op": "get-data"]]]) == ["get-data needs 2-byte tags"])
        let deep: NfcJSON = ["op": "for-each-aid", "steps": [["op": "for-each-aid", "steps": [["op": "for-each-aid", "steps": [["op": "gpo"]]]]]]]
        #expect(ApduTemplates.templateProblems(["label": "x", "steps": [deep]]) == ["for-each-aid nested too deep"])
        #expect(ApduTemplates.templateProblems(["label": "x", "apduHex": "00A40400"]) == [])
        // The standard set has none.
        for t in X.standard { #expect(ApduTemplates.templateProblems(t) == []) }
        // A template with a problem is listed but does not run.
        let bad = ApduTemplates.parse(["label": "bad", "steps": [["apdu": "zz"]]], index: 2)
        #expect(!bad.runnable)
        #expect(bad.label == "bad")
    }

    /* ------------------------------------------------------------ G-18: read-only */

    @Test func onlyReadCommandsAreAllowed() {
        for ok in ["00A4040007A0000000041010", "00A4000C023F00", "00B0000000", "0CB0000000", "00B2010C00", "80CA9F1700", "00CA9F7F00",
                   "80A8000002830000", "00C0000010", "80C0000010", "9060000000", "90AF000000", "906A000000", "906E000000", "9045000000"] {
            #expect(ApduTemplates.commandProblem(ok) == nil, "\(ok)")
        }
        #expect(ApduTemplates.commandProblem("0020008008241234FFFFFFFFFF") == "not a read command: 00 20 (VERIFY)")
        #expect(ApduTemplates.commandProblem("80AE80001D00") == "not a read command: 80 AE (GENERATE AC)")
        #expect(ApduTemplates.commandProblem("00D6000002AABB") == "not a read command: 00 D6 (UPDATE BINARY)")
        #expect(ApduTemplates.commandProblem("00DC010C02AABB") == "not a read command: 00 DC (UPDATE RECORD)")
        #expect(ApduTemplates.commandProblem("80DA9F5A0101") == "not a read command: 80 DA (PUT DATA)")
        #expect(ApduTemplates.commandProblem("90FC000000") == "not a read command: 90 FC (FormatPICC)")
        #expect(ApduTemplates.commandProblem("90CA000005123456") == "not a read command: 90 CA (CreateApplication)")
        #expect(ApduTemplates.commandProblem("0084000008") == "not a read command: 00 84 (GET CHALLENGE)") // outside eid-read
        #expect(ApduTemplates.commandProblem("00B1000000") == "not a read command: 00 B1 (READ BINARY (odd))")
        // The e-ID reader's secure channel only inside eid-read.
        #expect(TemplateRunner.refusal(b("0084000008"), op: "eid-read") == nil)
        #expect(TemplateRunner.refusal(b("1086000000"), op: "eid-read") == nil)
        #expect(TemplateRunner.refusal(b("0022C1A4"), op: "eid-read") == nil)
        #expect(TemplateRunner.refusal(b("0084000008"), op: "select-aid") == "not a read command: 00 84 (GET CHALLENGE)")
        #expect(TemplateRunner.refusal(b("0020008008"), op: "eid-read") == "not a read command: 00 20 (VERIFY)")
    }

    @Test func aTemplateThatWritesIsRefusedAndNeverReachesTheCard() async {
        let t: NfcJSONObject = ["label": "PIN", "steps": [["apdu": "00A4040007A0000000041010"], ["apdu": "0020008008241234FFFFFFFFFF", "label": "VERIFY"], ["apdu": "80CA9F1700"]]]
        let tpl = ApduTemplates.parse(.object(t), index: 0)
        #expect(!tpl.runnable)
        #expect(tpl.problems == ["not a read command: 00 20 (VERIFY)"])
        #expect(ApduTemplates.templateProblems(["label": "old", "apdu": "80AE80001D00"]) == ["not a read command: 80 AE (GENERATE AC)"])
        // Run anyway (a caller that skips the problems): the runner stops it before the card.
        let card = EmvSim(ppse: true, pse: false, "A0000000041010")
        let r = await TemplateRunner(tpl).run(card)
        #expect(card.forbidden.isEmpty)
        #expect(!card.seen.contains("0020008008241234FFFFFFFFFF"))
        #expect(X.commands(r) == ["00A4040007A0000000041010", "80CA9F1700"])
        let verify = r.steps[1]
        #expect(verify.status == "error")
        #expect(verify.noteKey == "nfc.tpl.n.refused")
        #expect(verify.noteArgs.first == "not a read command: 00 20 (VERIFY)")
        #expect(r.steps[2].first == r.steps[1].first) // nothing recorded for it
        #expect(TemplateViews.readableText(r).contains("refused, never sent — not a read command: 00 20 (VERIFY)"))
    }

    /* ------------------------------------------------------------ cancel, a lost card */

    @Test func aCancelStopsBeforeTheNextCommand() async {
        let card = EmvSim(ppse: true, pse: false, "A0000000031010", "A0000000041010")
        let box = Locked<TemplateRunner?>(nil)
        let runner = TemplateRunner(X.template("Payment card (EMV) — every"), onExchange: { e in if e.command.hasPrefix("80A8") { box.with { $0?.cancel() } } })
        box.with { $0 = runner }
        let r = await runner.run(card)
        #expect(r.cancelled)
        #expect(card.seen == X.commands(r))
        #expect(card.seen.last?.hasPrefix("80A8") == true) // nothing after the GPO the cancel came in
        #expect(r.status == "error")
        #expect(r.emv?.arrayCount("apps") == 1) // what was read so far
        #expect(r.steps.last?.noteKey == "nfc.tpl.n.cancelled")
    }

    @Test func aCardThatLeavesEndsTheRunWithWhatWasRead() async {
        let card = IsoSim()
        card.leaveAfter = 3
        let r = await TemplateRunner(X.template("Smart card (ISO 7816-4)")).run(card)
        #expect(r.error == "Tag was lost.")
        #expect(r.exchanges.count == 4) // three answered, the fourth went unanswered
        #expect(r.exchanges[3].sw == "")
        #expect(r.exchanges[3].status == "error")
        #expect(r.steps.last?.status == "error")
        #expect(r.steps.last?.noteKey == "nfc.tpl.n.lost")
        #expect(r.steps.count < 8)
        #expect(r.status == "error")
    }

    @Test func aCancelledTaskStopsTheRunToo() async {
        let card = DesfireSim()
        let task = Task { () -> TemplateRunResult in
            withUnsafeCurrentTask { $0?.cancel() }
            return await TemplateRunner(X.template("MIFARE DESFire")).run(card)
        }
        let r = await task.value
        #expect(r.cancelled)
        #expect(r.exchanges.isEmpty)
    }
}
