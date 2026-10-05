// Runs an APDU application template (6.10) — A/nfc/TemplateRunner.java, the
// native side of the contract in apdu-templates.ts (the web runs the same in
// template-runner.ts). Every step, one after another, over the card:
//
//  - a fixed command is sent as written; 61xx is followed by GET RESPONSE and
//    6Cxx re-sent with the Le the card asked for; `more` fetches the next frame
//    while the card answers 91AF (DESFire); the answer counts as success when its
//    status word is one the step `expect`s (9000 by default), else the step is a
//    warning when `optional`, an error otherwise;
//  - a reader operation runs the EMV reader's own steps or the e-ID read.
//
// Every APDU that goes to the card is recorded — the channel is wrapped, so the
// e-ID read's secure-messaging commands are in the transcript too. It never
// throws: a card that leaves the field ends the run with what was read so far.
// `cancel()` (any thread) or the task's cancellation stops it before the next
// command. Read-only (G-18): every command is checked before it goes — a fixed
// command must be a read, the readers' own commands too, the document's
// secure-channel commands only inside eid-read. Anything else never reaches the
// card: the step is an error that says why.

import Foundation
import Synchronization

/// One recorded exchange of a run (apdu-templates.ts TemplateExchange).
public struct TemplateExchange: Sendable, Hashable {
    /// The step that sent it (1-based, in the order the steps ran).
    public let step: Int
    public let label: String
    /// The reader operation that sent it, "" for a fixed command.
    public let op: String
    public let command: String
    /// The response data (hex, without the status word).
    public let response: String
    /// The status word ("9000"), "" when the card gave no answer.
    public let sw: String
    /// ok (expected), warn (an optional step / a tolerated status), error.
    public var status: String
    public let ms: Int

    public init(step: Int, label: String, op: String, command: String, response: String, sw: String, status: String, ms: Int) {
        self.step = step; self.label = label; self.op = op; self.command = command; self.response = response; self.sw = sw; self.status = status; self.ms = ms
    }

    /// The exchange as the contract's object.
    public var json: NfcJSON {
        ["step": NfcJSON(step), "label": .string(label), "op": .string(op), "command": .string(command), "response": .string(response),
         "sw": .string(sw), "status": .string(status), "ms": NfcJSON(ms)]
    }
}

/// What one step did (the readable view's list of steps).
public struct TemplateStepResult: Sendable, Hashable {
    public let step: Int
    public let label: String
    public let op: String
    /// The application it ran for (a for-each-aid's), or nil.
    public let aid: String?
    public let optional: Bool
    /// ok, warn, error.
    public var status = "ok"
    /// A note the view localizes (TemplateViews keys, {0}… the args), or nil.
    public var noteKey: String?
    public var noteArgs = [String]()
    /// A note as it is (a reader's own summary), or nil.
    public var note: String?
    /// Its exchanges: [first, last) of the result's exchanges.
    public var first = 0, last = 0
    /// A fixed command: the command, the whole answer (after GET RESPONSE / frames) and its status word.
    public var command = "", data = "", sw = ""

    mutating func setNote(_ key: String, _ args: String...) { noteKey = key; noteArgs = args }
}

/// A whole run.
public struct TemplateRunResult: Sendable {
    public let label: String
    /// emv / emrtd / desfire / iso7816 / "".
    public let card: String
    public let note: String
    public var exchanges = [TemplateExchange]()
    public var steps = [TemplateStepResult]()
    /// The EMV read (command.ts EmvData), or nil when no EMV step ran.
    public var emv: NfcJSONObject?
    /// The e-ID read (command.ts MrtdData), or nil.
    public var mrtd: NfcJSONObject?
    /// The detected card (uid, label, sak, atqa, ats…) — the caller's.
    public var cardInfo: NfcJSONObject?
    public var cancelled = false
    /// Why the run stopped before its end (the card stopped answering), or nil.
    public var error: String?
    public var ms = 0

    /// ok / warn / error over the steps (a cancelled or broken run is an error).
    public var status: String {
        if cancelled || error != nil { return "error" }
        var s = "ok"
        for r in steps { if r.status == "error" { return "error" }; if r.status == "warn" { s = "warn" } }
        return s
    }
}

public final class TemplateRunner: Sendable {
    /// Progress: a step starts (the template's step n of total; a for-each-aid's steps say their application in the label).
    public typealias StepListener = @Sendable (_ n: Int, _ total: Int, _ label: String) -> Void
    /// A command went and its answer came back.
    public typealias ExchangeListener = @Sendable (_ exchange: TemplateExchange) -> Void

    public let template: ApduTemplates.Template
    let mrtdOptions: MrtdReader.Options?
    let onStep: StepListener?
    let onExchange: ExchangeListener?
    private let cancelFlag = Mutex(false)

    /// `mrtd`: the holder's key for an eid-read step (asked on the device); without one the e-ID read says what it needs.
    public init(_ template: ApduTemplates.Template, mrtd: MrtdReader.Options? = nil, onStep: StepListener? = nil, onExchange: ExchangeListener? = nil) {
        self.template = template; self.mrtdOptions = mrtd; self.onStep = onStep; self.onExchange = onExchange
    }

    /// Stops the run before its next command (from any thread).
    public func cancel() { cancelFlag.withLock { $0 = true } }

    public var cancelled: Bool { cancelFlag.withLock { $0 } || Task.isCancelled }

    /// Runs every step over `channel`; never throws.
    public func run(_ channel: any ApduChannel) async -> TemplateRunResult {
        let state = RunState(self, channel)
        return await state.run()
    }

    /* ------------------------------------------------------------ the rules */

    /// Why a command may not go to the card in a step of `op` (G-18), or nil: a read; inside eid-read also
    /// the document's own secure channel (GET CHALLENGE, EXTERNAL / GENERAL AUTHENTICATE, MSE, READ BINARY odd).
    public static func refusal(_ apdu: [UInt8], op: String) -> String? {
        guard apdu.count >= 4 else { return "not a command" }
        let cla = Int(apdu[0]), ins = Int(apdu[1])
        if ApduTemplates.readCommand(cla, ins) { return nil }
        if op == "eid-read" && ApduTemplates.secureChannelCommand(cla, ins) { return nil }
        return ApduTemplates.commandProblem(Hex.encode(apdu)) ?? "not a read command"
    }

    /// A status a reader operation goes on from: success, more data (61xx), a Le to fix (6Cxx), the end of a file (6282).
    static func tolerated(_ sw: String) -> Bool {
        let v = StatusWords.parse(sw)
        if v < 0 { return false }
        return Apdu.isOk(v) || (v >> 8) == 0x6c || v == 0x6282
    }

    /// Whether a status word is one the step expects ("X" a wildcard nibble); none given: 9000.
    public static func expected(_ expect: [String], _ sw: Int) -> Bool {
        let h = Array(StatusWords.hex(sw))
        if expect.isEmpty { return sw == 0x9000 }
        for e in expect {
            let p = Array(JSText.upperASCII(e.replacingRegex("\\s", with: "")))
            if p.count != 4 { continue }
            if (0..<4).allSatisfy({ p[$0] == "X" || p[$0] == h[$0] }) { return true }
        }
        return false
    }

    /// The label a step shows: its own, else what its op does; a for-each-aid's steps name their application.
    static func labelOf(_ s: ApduTemplates.Step, _ aid: String?) -> String {
        func rangeText(_ r: ClosedRange<Int>?, _ lo: Int, _ hi: Int) -> String {
            let a = r?.lowerBound ?? lo, b = r?.upperBound ?? hi
            return a == b ? "\(a)" : "\(a)–\(b)"
        }
        var l: String
        if let own = s.label { l = own } else {
            switch s.op {
            case "": l = s.apdu ?? ""
            case "select-ppse": l = "SELECT PPSE (2PAY.SYS.DDF01)"
            case "select-pse": l = "SELECT PSE (1PAY.SYS.DDF01)"
            case "select-aid": l = "SELECT " + (s.aid ?? aid ?? "AID")
            case "get-data": l = "GET DATA " + s.tags.joined(separator: " ")
            case "read-log": l = NfcTexts.t("nfc.tpl.step.readLog", "Transaction history")
            case "gpo": l = "GET PROCESSING OPTIONS"
            case "read-afl": l = "READ RECORD (AFL)"
            case "read-files": l = "READ RECORD SFI \(rangeText(s.sfi, 1, 30)), records \(rangeText(s.records, 1, 16))"
            case "for-each-aid": l = NfcTexts.t("nfc.tpl.step.eachApp", "Each application")
            case "eid-read": l = NfcTexts.t("nfc.tpl.step.eidRead", "e-ID / e-passport read")
            case "emv-read": l = NfcTexts.t("nfc.tpl.step.emvRead", "EMV read")
            default: l = s.op
            }
        }
        if let aid, !l.contains(aid) { l = aid + " · " + l }
        return l
    }
}

/* ================================================================ one run */

/// The commands stopped: cancelled, or the card no longer answers.
struct TemplateHalt: Error, LocalizedError { let message: String; var errorDescription: String? { message } }

/// One run's state (not shared: the runner makes one per `run`).
final class RunState {
    let runner: TemplateRunner
    let inner: any ApduChannel
    var result: TemplateRunResult
    var currentIndex: Int? = nil
    var stepNo = 0, topIndex = 0, topTotal = 0
    var dirAids = [String]()
    var dirRead = false, deep = false, emvRan = false
    var tree = ""
    var app: EmvReader.AppRead? = nil
    var appSelected = false
    var apps = [NfcJSON]()
    var readAids = [String]()
    var budget = 480
    // The recorder's state.
    var failure: Error? = nil
    var refused: String? = nil
    lazy var recorder = Recorder(self)
    lazy var sender = EmvReader.Sender(recorder)

    init(_ runner: TemplateRunner, _ inner: any ApduChannel) {
        self.runner = runner; self.inner = inner
        result = TemplateRunResult(label: runner.template.label, card: runner.template.cardType, note: runner.template.note)
    }

    var current: TemplateStepResult? { currentIndex.map { result.steps[$0] } }
    var halted: Bool { runner.cancelled || failure != nil }

    /// The card behind a recorder: every APDU becomes an exchange of the current step.
    final class Recorder: ApduChannel {
        unowned let state: RunState
        init(_ s: RunState) { state = s }

        func transmit(_ apdu: [UInt8]) async throws -> [UInt8] {
            if state.runner.cancelled { throw TemplateHalt(message: "cancelled") }
            if state.failure != nil { throw TemplateHalt(message: NfcTexts.t("nfc.tpl.cardGone", "the card stopped answering")) }
            // G-18: only reads reach the card — whatever step sends it.
            if let why = TemplateRunner.refusal(apdu, op: state.current?.op ?? "") { state.refused = why; throw NfcError(.notARead, why) }
            let clock = ContinuousClock(), t0 = clock.now
            do {
                let resp = try await state.inner.transmit(apdu)
                add(apdu, resp, clock.now - t0)
                return resp
            } catch {
                state.failure = error
                add(apdu, nil, clock.now - t0)
                throw error
            }
        }

        func add(_ apdu: [UInt8], _ resp: [UInt8]?, _ d: Duration) {
            let ms = max(0, Int((Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15).rounded()))
            let data: String, sw: String
            if let r = resp {
                if r.count < 2 { data = Hex.encode(r); sw = "" } else { data = Hex.encode(r[0..<(r.count - 2)]); sw = StatusWords.hex(Int(r[r.count - 2]) << 8 | Int(r[r.count - 1])) }
            } else { data = ""; sw = "" }
            let c = state.current
            let status = resp == nil ? "error" : TemplateRunner.tolerated(sw) ? "ok" : "warn"
            let e = TemplateExchange(step: c?.step ?? 0, label: c?.label ?? "", op: c?.op ?? "", command: Hex.encode(apdu), response: data, sw: sw, status: status, ms: ms)
            state.result.exchanges.append(e)
            state.runner.onExchange?(e)
        }
    }

    func run() async -> TemplateRunResult {
        let clock = ContinuousClock(), t0 = clock.now
        topTotal = runner.template.steps.count
        _ = await runBlock(runner.template.steps, depth: 0, aid: nil)
        finishApp()
        if emvRan { result.emv = EmvReader.emvData(dirRead && !dirAids.isEmpty ? dirAids : readAids, apps, tree, deep, countEmv()) }
        result.cancelled = runner.cancelled
        if let f = failure, !(f is TemplateHalt), result.error == nil { result.error = errorText(f) }
        let d = clock.now - t0
        result.ms = Int((Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15).rounded())
        return result
    }

    func countEmv() -> Int { result.exchanges.filter { !$0.op.isEmpty && $0.op != "eid-read" }.count }

    /// Runs a list of steps; false when its select-aid did not select (the rest of that application's steps are skipped).
    func runBlock(_ steps: [ApduTemplates.Step], depth: Int, aid: String?) async -> Bool {
        for (i, s) in steps.enumerated() {
            if halted { return true }
            if depth == 0 { topIndex = i + 1 }
            let r = await runStep(s, depth: depth, aid: aid)
            if s.op == "select-aid" && r.status != "ok" { return false }
        }
        return true
    }

    func mutateCurrent(_ f: (inout TemplateStepResult) -> Void) { if let i = currentIndex { f(&result.steps[i]) } }

    func runStep(_ s: ApduTemplates.Step, depth: Int, aid: String?) async -> TemplateStepResult {
        stepNo += 1
        var r = TemplateStepResult(step: stepNo, label: TemplateRunner.labelOf(s, aid), op: s.op, aid: aid, optional: s.optional)
        r.first = result.exchanges.count
        result.steps.append(r)
        let index = result.steps.count - 1
        currentIndex = index
        let brokenBefore = failure != nil, cancelledBefore = runner.cancelled
        runner.onStep?(topIndex, topTotal, r.label)
        do {
            switch s.op {
            case "": try await fixed(s, index)
            case "select-ppse", "select-pse": try await directory(s, index)
            case "select-aid": await selectAid(s, index, aid)
            case "get-data":
                emvRan = true
                let n = await appRead(aid).getData(sender, s.tags)
                result.steps[index].setNote("nfc.tpl.n.getData", String(n), String(s.tags.count))
                if n == 0 { result.steps[index].status = "warn" }
            case "read-log":
                emvRan = true
                let n = await appRead(aid).history(sender, ask: true)
                if n < 0 { result.steps[index].status = "warn"; result.steps[index].setNote("nfc.tpl.n.noLog") }
                else { result.steps[index].setNote("nfc.tpl.n.log", String(n)) }
            case "gpo":
                emvRan = true
                let a = appRead(aid)
                if await a.gpo(sender) { result.steps[index].setNote("nfc.tpl.n.gpo", a.x.aip.map { Hex.encode($0) } ?? "—", a.x.afl.map { Hex.encode($0) } ?? "—") }
                else { result.steps[index].status = s.optional ? "warn" : "error"; result.steps[index].setNote("nfc.tpl.n.gpoRefused") }
            case "read-afl":
                emvRan = true
                let a = appRead(aid)
                if !a.hasAfl { result.steps[index].status = "warn"; result.steps[index].setNote("nfc.tpl.n.noAfl") }
                else { result.steps[index].setNote("nfc.tpl.n.records", String(await a.readAfl(sender, light: false))) }
            case "read-files":
                emvRan = true
                deep = true
                let sfi = s.sfi ?? 1...30, recs = s.records ?? 1...16
                var b = budget
                let n = await appRead(aid).scan(sender, budget: &b, sfiFrom: sfi.lowerBound, sfiTo: sfi.upperBound, recFrom: recs.lowerBound, recTo: recs.upperBound)
                budget = b
                result.steps[index].setNote("nfc.tpl.n.records", String(n))
            case "for-each-aid": await forEachAid(s, index, depth)
            case "eid-read": await eidRead(s, index)
            case "emv-read": await emvRead(s, index)
            default: result.steps[index].status = "error"; result.steps[index].setNote("nfc.tpl.n.unknownOp", s.op)
            }
        } catch {
            result.steps[index].status = "error"
            if !(error is TemplateHalt) { result.steps[index].note = errorText(error) }
        }
        currentIndex = index
        result.steps[index].last = result.exchanges.count
        r = result.steps[index]
        if let why = refused {
            // A command that is not a read was stopped before the card (G-18).
            r.status = "error"; r.note = nil; r.setNote("nfc.tpl.n.refused", why)
            refused = nil
        } else if !brokenBefore && failure != nil {
            // The card stopped answering during this step (the result says why).
            r.status = "error"
            if r.op != "for-each-aid" { r.note = nil; r.setNote("nfc.tpl.n.lost") }
        } else if !cancelledBefore && runner.cancelled {
            if r.status != "error" || r.last == r.first { r.status = "warn" }
            r.setNote("nfc.tpl.n.cancelled")
        }
        result.steps[index] = r
        // A reader step that failed: its last command says so (the commands before it went as they should).
        if !r.op.isEmpty && r.status != "ok" && r.last > r.first && r.op != "for-each-aid" {
            if result.exchanges[r.last - 1].status != "error" { result.exchanges[r.last - 1].status = r.status }
        }
        return r
    }

    /// The application the EMV steps act on: the selected one, else one without a SELECT (its data still kept).
    func appRead(_ aid: String?) -> EmvReader.AppRead {
        if let a = app { return a }
        let a = EmvReader.AppRead(aid ?? "", nil)
        app = a; appSelected = false
        return a
    }

    /// The application read so far goes into the result.
    func finishApp() {
        if let a = app, appSelected || !a.empty { apps.append(.object(a.build())) }
        app = nil
        appSelected = false
    }

    func fixed(_ s: ApduTemplates.Step, _ index: Int) async throws {
        let command = s.apdu ?? ""
        result.steps[index].command = command
        if !command.fullMatch("([0-9A-F]{2}){4,261}") { result.steps[index].status = "error"; result.steps[index].setNote("nfc.tpl.n.badCommand"); return }
        if let why = ApduTemplates.commandProblem(command) { result.steps[index].status = "error"; result.steps[index].setNote("nfc.tpl.n.refused", why); return } // G-18: never sent
        let cmd = Hex.decode(command)
        var resp = Apdu.split(try await recorder.transmit(cmd))
        if resp.sw1 == 0x6c && cmd.count >= 5 {
            var again = cmd
            again[again.count - 1] = UInt8(resp.sw2)
            resp = Apdu.split(try await recorder.transmit(again))
        }
        var data = resp.data
        var guardCount = 0
        while resp.sw1 == 0x61 && guardCount < 64 {
            guardCount += 1
            resp = Apdu.split(try await recorder.transmit(Bytes.u8(Int(cmd[0]) & 0xf0, 0xc0, 0x00, 0x00, resp.sw2)))
            data += resp.data
        }
        // 6.10: an answer in frames (DESFire 91AF) — `more` fetches the next one while the card says so; the frames are joined.
        if let more = s.more, !more.isEmpty {
            let whyMore = more.fullMatch("([0-9A-F]{2}){4,261}") ? ApduTemplates.commandProblem(more) : "bad follow-up command"
            if let why = whyMore { result.steps[index].status = "error"; result.steps[index].setNote("nfc.tpl.n.refused", why); return } // G-18: never sent
            let next = Hex.decode(more)
            var n = 0
            while n < 32 && resp.sw == 0x91af {
                resp = Apdu.split(try await recorder.transmit(next))
                data += resp.data
                n += 1
            }
        }
        result.steps[index].data = Hex.encode(data)
        result.steps[index].sw = StatusWords.hex(resp.sw)
        let status = TemplateRunner.expected(s.expect, resp.sw) ? "ok" : s.optional ? "warn" : "error"
        result.steps[index].status = status
        let first = result.steps[index].first, last = result.exchanges.count
        // The follow-ups (61xx, 6Cxx) went as they should; the last answer is the step's.
        for i in first..<last { result.exchanges[i].status = i == last - 1 ? status : "ok" }
    }

    func directory(_ s: ApduTemplates.Step, _ index: Int) async throws {
        emvRan = true
        let d = s.op == "select-pse" ? try await EmvReader.selectPse(sender) : try await EmvReader.selectPpse(sender)
        if !d.ok { result.steps[index].status = s.optional ? "warn" : "error"; result.steps[index].setNote("nfc.tpl.n.noDir"); return }
        dirRead = true
        for a in d.aids where !dirAids.contains(a) { dirAids.append(a) }
        if !d.tree.isEmpty { tree = tree.isEmpty ? d.tree : tree + "\n" + d.tree }
        result.steps[index].setNote("nfc.tpl.n.dir", String(d.aids.count))
    }

    func selectAid(_ s: ApduTemplates.Step, _ index: Int, _ loopAid: String?) async {
        emvRan = true
        guard let a = s.aid ?? loopAid else { result.steps[index].status = "error"; result.steps[index].setNote("nfc.tpl.n.noAid"); return }
        finishApp()
        let sel = await EmvReader.selectAid(sender, a)
        if !sel.ok {
            // In a for-each-aid the list may hold applications this card does not have.
            result.steps[index].status = s.optional || (s.aid == nil && loopAid != nil) ? "warn" : "error"
            result.steps[index].setNote("nfc.tpl.n.notSelected")
            return
        }
        app = EmvReader.AppRead(a, sel)
        appSelected = true
        if !readAids.contains(a) { readAids.append(a) }
        let shown = sel.label.flatMap { $0.isEmpty ? nil : $0 } ?? EmvTags.scheme(forAid: a) ?? a
        result.steps[index].setNote("nfc.tpl.n.selected", shown)
    }

    func forEachAid(_ s: ApduTemplates.Step, _ index: Int, _ depth: Int) async {
        var list = [String]()
        if !s.aids.isEmpty { list = s.aids } else if !dirAids.isEmpty { list = dirAids } else { list = EmvTags.candidateAids.map(\.aid) }
        let max = s.max > 0 ? min(16, s.max) : 8
        var read = 0
        for a in list {
            if read >= max || halted { break }
            finishApp()
            if await runBlock(s.steps, depth: depth + 1, aid: a) { read += 1 }
            finishApp()
        }
        currentIndex = index
        result.steps[index].setNote("nfc.tpl.n.apps", String(read))
        if read == 0 { result.steps[index].status = "warn" }
    }

    func eidRead(_ s: ApduTemplates.Step, _ index: Int) async {
        let o = runner.mrtdOptions ?? MrtdReader.Options.from(args: s.args)
        let m = await MrtdReader.read(recorder, o)
        result.mrtd = m
        let opened = m.has("mrzInfo") || m.optString("access", "none") != "none"
        if !opened { result.steps[index].status = s.optional ? "warn" : "error" }
        result.steps[index].note = MrtdReader.summary(m)
    }

    func emvRead(_ s: ApduTemplates.Step, _ index: Int) async {
        emvRan = true
        finishApp()
        let e = await EmvReader.read(recorder, EmvReader.Options.from(args: s.args))
        let got = e.optArray("apps") ?? []
        apps += got
        for a in e.optArray("aids") ?? [] { if let s = a.stringValue, !readAids.contains(s) { readAids.append(s) } }
        let t = e.optString("tree")
        if !t.isEmpty { tree = tree.isEmpty ? t : tree + "\n" + t }
        if e.optBool("deep") { deep = true }
        if got.isEmpty { result.steps[index].status = s.optional ? "warn" : "error" }
        result.steps[index].note = EmvReader.summary(e)
    }
}
