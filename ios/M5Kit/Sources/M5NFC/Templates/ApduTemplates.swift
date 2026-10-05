// APDU application templates (6.10) — A/nfc/ApduTemplates.java, the native side
// of client/src/lib/nfc/apdu-templates.ts: what an operator loads into
// m5mobile.define.apduTemplates (the console's Define, shared by Android and iOS).
// A template is the COMPLETE read of one card type: steps the `TemplateRunner`
// executes in order — a fixed command (`{ apdu, label?, optional?, expect?, more? }`)
// or a reader operation (`{ op: select-ppse | select-pse | select-aid | get-data |
// read-log | gpo | read-afl | read-files | for-each-aid | eid-read | emv-read }`).
// An older entry (≤ 6.9: one command, command lines, or one whole-read op) still
// runs as a one-step template (`templateSteps`).
//
// 6.10 security review (G-18): a template only READS — every fixed command must
// be one of `readOnlyCommands` (a write, VERIFY, GENERATE AC, UPDATE, PUT DATA is a
// problem: the template is listed but refused), and the runner checks every
// command again before it goes. Pure.

import Foundation
import M5Core

public enum ApduTemplates {
    /// The card types a template reads (they group the menu and pick the readable report).
    public static let emv = "emv", emrtd = "emrtd", desfire = "desfire", iso7816 = "iso7816"
    public static let cards = [emv, emrtd, desfire, iso7816]

    /// The reader operations a step may be (the contract's TemplateStep ops).
    public static let ops = ["select-ppse", "select-pse", "select-aid", "get-data", "read-log", "gpo", "read-afl", "read-files", "for-each-aid", "eid-read", "emv-read"]

    /// One step of a template, parsed.
    public struct Step: Sendable, Hashable {
        /// The reader operation, or "" for a fixed command.
        public let op: String
        /// The fixed command (hex, upper case, no spaces), or nil for an op.
        public let apdu: String?
        public let label: String?
        public let optional: Bool
        /// Status words that count as success (upper case, "X" a wildcard nibble); empty = 9000.
        public let expect: [String]
        /// select-aid: the application (nil: the current one of a for-each-aid).
        public let aid: String?
        /// get-data: the tags.
        public let tags: [String]
        /// read-files: the short files and the records ([from, to]), nil for the defaults.
        public let sfi: ClosedRange<Int>?, records: ClosedRange<Int>?
        /// for-each-aid: the steps run for every application, its own AIDs and the cap.
        public let steps: [Step]
        public let aids: [String]
        public let max: Int
        /// eid-read / emv-read: the op's args (never nil).
        public let args: NfcJSONObject
        /// 6.10: a fixed command's follow-up while the card answers "more frames" (DESFire 91AF), hex.
        public var more: String?

        public var fixed: Bool { op.isEmpty }

        /// A fixed command from code (tests, the legacy lines).
        public static func command(_ hex: String, label: String? = nil, optional: Bool = false, expect: [String] = []) -> Step {
            Step(op: "", apdu: clean(hex), label: label, optional: optional, expect: expect.map(JSText.upperASCII), aid: nil, tags: [],
                 sfi: nil, records: nil, steps: [], aids: [], max: 0, args: NfcJSONObject(), more: nil)
        }
    }

    /// One template of m5mobile.define.apduTemplates, parsed (with its problems — a template with any does not run).
    public struct Template: Sendable, Hashable {
        /// Its position in the define list.
        public let index: Int
        public let label: String
        /// emv / emrtd / desfire / iso7816, or "" when the template says none.
        public let card: String
        public let note: String
        public let aid: String
        public let steps: [Step]
        public let problems: [String]
        /// An older (≤ 6.9) entry: "apdu" (command lines) or "op" (one whole read); nil for a 6.10 template.
        public let legacy: String?

        public var runnable: Bool { problems.isEmpty && !steps.isEmpty }

        /// The first eid-read step (it needs the holder's document key, asked on the device), or nil.
        public var eidRead: Step? { Template.find(steps, "eid-read", 0) }

        /// The card type it reads: its own, else what its steps say.
        public var cardType: String {
            if !card.isEmpty { return card }
            if Template.find(steps, "eid-read", 0) != nil { return ApduTemplates.emrtd }
            for o in ["emv-read", "select-ppse", "select-pse", "select-aid", "gpo", "for-each-aid"] where Template.find(steps, o, 0) != nil { return ApduTemplates.emv }
            return ""
        }

        static func find(_ list: [Step], _ op: String, _ depth: Int) -> Step? {
            if depth > 3 { return nil }
            for s in list {
                if s.op == op { return s }
                if let inner = find(s.steps, op, depth + 1) { return inner }
            }
            return nil
        }
    }

    /* ------------------------------------------------------------ read-only (G-18) */

    /// The commands a template may send (apdu-templates.ts READ_ONLY_COMMANDS): by class, INS → name.
    public static let readOnlyCommands: [String: [Int: String]] = [
        "iso": [0xa4: "SELECT", 0xb0: "READ BINARY", 0xb2: "READ RECORD", 0xca: "GET DATA", 0xc0: "GET RESPONSE"],
        "emv": [0xa8: "GET PROCESSING OPTIONS", 0xca: "GET DATA", 0xc0: "GET RESPONSE"],
        "desfire": [0x60: "GetVersion", 0xaf: "GetVersion (additional frame)", 0x6a: "GetApplicationIDs", 0x6e: "GetFreeMemory", 0x45: "GetKeySettings"],
        "channel": [0x84: "GET CHALLENGE", 0x82: "EXTERNAL AUTHENTICATE", 0x22: "MANAGE SECURITY ENVIRONMENT", 0x86: "GENERAL AUTHENTICATE", 0xb1: "READ BINARY (odd)"],
    ]

    /// An interindustry class (ISO 7816-4: logical channels, secure messaging, chaining).
    static func isoClass(_ cla: Int) -> Bool { (cla & 0xe0) == 0x00 || (cla & 0xc0) == 0x40 }
    /// EMV's proprietary class (80 GET PROCESSING OPTIONS, 80 GET DATA).
    static func emvClass(_ cla: Int) -> Bool { (cla & 0xf0) == 0x80 }

    /// Whether a command only reads (G-18): SELECT, READ BINARY, READ RECORD, GET DATA (also 80 CA), GET
    /// PROCESSING OPTIONS (80 A8), GET RESPONSE and DESFire's 90 60 / AF / 6A / 6E / 45. Never a VERIFY,
    /// GENERATE AC, UPDATE, PUT DATA, a write or a key change.
    public static func readCommand(_ cla: Int, _ ins: Int) -> Bool {
        if isoClass(cla) { return readOnlyCommands["iso"]![ins] != nil }
        if emvClass(cla) { return readOnlyCommands["emv"]![ins] != nil }
        if cla == 0x90 { return readOnlyCommands["desfire"]![ins] != nil }
        return false
    }

    /// The e-ID reader's own secure-channel commands — allowed only inside eid-read.
    public static func secureChannelCommand(_ cla: Int, _ ins: Int) -> Bool { isoClass(cla) && readOnlyCommands["channel"]![ins] != nil }

    static let insNames: [Int: String] = [
        0x20: "VERIFY", 0x21: "VERIFY", 0x24: "CHANGE REFERENCE DATA", 0x2c: "RESET RETRY COUNTER", 0xae: "GENERATE AC",
        0xd6: "UPDATE BINARY", 0xd7: "UPDATE BINARY", 0xdc: "UPDATE RECORD", 0xdd: "UPDATE RECORD", 0xe2: "APPEND RECORD",
        0xda: "PUT DATA", 0xdb: "PUT DATA", 0xd0: "WRITE BINARY", 0xd1: "WRITE BINARY", 0xd2: "WRITE RECORD", 0xe0: "CREATE FILE",
        0xe4: "DELETE FILE", 0x0e: "ERASE BINARY", 0x0f: "ERASE BINARY", 0x44: "ACTIVATE FILE", 0x04: "DEACTIVATE FILE",
        0xe6: "TERMINATE DF", 0xe8: "TERMINATE CARD", 0x88: "INTERNAL AUTHENTICATE", 0x84: "GET CHALLENGE", 0x82: "EXTERNAL AUTHENTICATE",
        0x86: "GENERAL AUTHENTICATE", 0x22: "MANAGE SECURITY ENVIRONMENT", 0x2a: "PERFORM SECURITY OPERATION", 0x1e: "APPLICATION BLOCK",
        0x18: "APPLICATION UNBLOCK", 0x16: "CARD BLOCK", 0xb1: "READ BINARY (odd)",
    ]
    static let desfireNames: [Int: String] = [
        0xfc: "FormatPICC", 0xda: "DeleteApplication", 0xca: "CreateApplication", 0x3d: "WriteData", 0x3b: "WriteRecord",
        0xc4: "ChangeKey", 0x54: "ChangeKeySettings", 0x0a: "Authenticate", 0x1a: "AuthenticateISO", 0xaa: "AuthenticateAES",
        0xdf: "DeleteFile", 0x5f: "ChangeFileSettings", 0x0c: "Credit", 0xdc: "Debit", 0xc7: "CommitTransaction", 0x5c: "SetConfiguration",
    ]

    /// Why a template's fixed command may not run (G-18), or nil when it only reads: "not a read command: 00 20 (VERIFY)".
    public static func commandProblem(_ hex: String) -> String? {
        let h = clean(hex)
        guard h.utf8.count >= 4, h.fullMatch("[0-9A-F]+") else { return "not a read command: \(h)" }
        let b = Hex.decodeLenient(String(h.prefix(4)))
        let cla = Int(b[0]), ins = Int(b[1])
        if readCommand(cla, ins) { return nil }
        let name = cla == 0x90 ? desfireNames[ins] : insNames[ins]
        return "not a read command: \(h.prefix(2)) \(h.dropFirst(2).prefix(2))" + (name.map { " (\($0))" } ?? "")
    }

    /* ------------------------------------------------------------ the contract */

    static func clean(_ hex: String?) -> String { JSText.upperASCII((hex ?? "").replacingRegex("\\s", with: "")) }

    /// String(v) as JavaScript says it (the contract's checks run on the text); absent → "undefined".
    static func jsString(_ v: NfcJSON?) -> String { v?.jsString ?? "undefined" }

    /// The steps a saved template runs (apdu-templates.ts templateSteps): its own, or — an older entry —
    /// its one op, or its command lines turned into steps. Empty when it has nothing runnable.
    public static func templateSteps(_ x: NfcJSONObject?) -> [NfcJSON] {
        guard let x else { return [] }
        if let steps = x.optArray("steps"), !steps.isEmpty { return steps }
        let op = x.string("op") ?? ""
        let args = x.optObject("args")
        if op == "emv-read" {
            var a = args ?? NfcJSONObject()
            if let aid = x["aid"], aid.truthy { a["aid"] = aid }
            return [["op": "emv-read", "args": .object(a)]]
        }
        if op == "eid-read" { return [["op": "eid-read", "args": .object(args ?? NfcJSONObject())]] }
        let raw: NfcJSON? = x["apdu"].flatMap { $0.isNull ? nil : $0 } ?? x["apduHex"].flatMap { $0.isNull ? nil : $0 }
        var out = [NfcJSON]()
        for line in (raw?.jsString ?? "").replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let h = line.replacingRegex("[^0-9A-Fa-f]", with: "")
            if h.utf8.count >= 8 && h.utf8.count % 2 == 0 { out.append(["apdu": .string(JSText.upperASCII(h))]) }
        }
        return out
    }

    /// The problems of one template (apdu-templates.ts templateProblems) — the runners say them before running.
    public static func templateProblems(_ t: NfcJSON?) -> [String] {
        guard let t else { return ["not an object"] }
        if case .array = t { return ["no label", "nothing to run: no steps, op or apdu"] } // a JS array is an object too
        guard let x = t.objectValue else { return ["not an object"] }
        var out = [String]()
        if JSText.trim(x.string("label") ?? "").isEmpty { out.append("no label") }
        let steps = templateSteps(x)
        if steps.isEmpty { out.append("nothing to run: no steps, op or apdu") }
        walk(steps, 0, &out)
        return out
    }

    static func walk(_ list: [NfcJSON], _ depth: Int, _ out: inout [String]) {
        if depth > 2 { out.append("for-each-aid nested too deep"); return }
        for o in list {
            guard let s = o.objectValue else { continue }
            if s.has("apdu") {
                let text = jsString(s["apdu"])
                let h = text.replacingRegex("\\s", with: "")
                if !h.fullMatch("[0-9A-Fa-f]{8,522}") || h.utf8.count % 2 != 0 { out.append("bad command " + JSText.prefix(text, 20)) }
                else if let why = commandProblem(h) { out.append(why) } // G-18: a template only reads
                if let m = s["more"], !m.isNull {
                    let mt = jsString(m), mh = mt.replacingRegex("\\s", with: "")
                    if !mh.fullMatch("[0-9A-Fa-f]{8,522}") || mh.utf8.count % 2 != 0 { out.append("bad follow-up command " + JSText.prefix(mt, 20)) }
                    else if let why = commandProblem(mh) { out.append(why) }
                }
                continue
            }
            let op = s.string("op") ?? ""
            if op == "select-aid" && s.has("aid") && !jsString(s["aid"]).fullMatch("[0-9A-Fa-f]{10,32}") { out.append("bad AID " + jsString(s["aid"])) }
            if op == "get-data" {
                let tags = s.optArray("tags")
                let good = tags != nil && tags!.allSatisfy { jsString($0).fullMatch("[0-9A-Fa-f]{4}") }
                if !good { out.append("get-data needs 2-byte tags") }
            }
            if op == "for-each-aid" { walk(s.optArray("steps") ?? [], depth + 1, &out) }
        }
    }

    /* ------------------------------------------------------------ parsing */

    /// Every entry of m5mobile.define.apduTemplates, parsed (a problem keeps it in the list, not runnable).
    public static func parse(_ define: [NfcJSON]?) -> [Template] { (define ?? []).enumerated().map { parse($0.element, index: $0.offset) } }

    /// One entry.
    public static func parse(_ entry: NfcJSON?, index: Int) -> Template {
        let problems = templateProblems(entry)
        guard let x = entry?.objectValue else {
            let text = entry?.stringValue ?? ""
            return Template(index: index, label: text.isEmpty ? "APDU \(index + 1)" : text, card: "", note: "", aid: "", steps: [], problems: problems, legacy: "apdu")
        }
        let own = x.optArray("steps")
        let legacy: String? = own != nil && !own!.isEmpty ? nil : (x.optString("op") == "emv-read" || x.optString("op") == "eid-read" ? "op" : "apdu")
        var label = JSText.trim(x.string("label") ?? "")
        if label.isEmpty { label = JSText.trim(x.string("name") ?? "") }
        if label.isEmpty { label = "APDU \(index + 1)" }
        let card = x.string("card").flatMap { cards.contains($0) ? $0 : nil } ?? ""
        return Template(index: index, label: label, card: card, note: x.string("note") ?? "", aid: x.string("aid") ?? "",
                        steps: steps(templateSteps(x), 0), problems: problems, legacy: legacy)
    }

    static func strings(_ a: [NfcJSON]?, upper: Bool) -> [String] {
        (a ?? []).compactMap { $0.stringValue.map { upper ? JSText.upperASCII($0) : $0 } }
    }

    static func range(_ a: [NfcJSON]?) -> ClosedRange<Int>? {
        guard let a, a.count >= 2, let lo = a[0].intValue, let hi = a[1].intValue else { return nil }
        return min(lo, hi)...max(lo, hi)
    }

    static func steps(_ list: [NfcJSON], _ depth: Int) -> [Step] {
        if depth > 3 { return [] }
        var out = [Step]()
        for o in list {
            guard let s = o.objectValue else { continue }
            let label = s.string("label").flatMap { JSText.trim($0).isEmpty ? nil : JSText.trim($0) }
            let optional = s["optional"]?.boolValue == true
            if s.has("apdu") {
                var c = Step(op: "", apdu: clean(jsString(s["apdu"])), label: label, optional: optional, expect: strings(s.optArray("expect"), upper: true),
                             aid: nil, tags: [], sfi: nil, records: nil, steps: [], aids: [], max: 0, args: NfcJSONObject(), more: nil)
                if let m = s["more"], !m.isNull { c.more = clean(jsString(m)) }
                out.append(c)
                continue
            }
            let op = s.string("op") ?? "?"
            out.append(Step(op: op, apdu: nil, label: label, optional: optional, expect: [], aid: s.string("aid").map(JSText.upperASCII),
                            tags: strings(s.optArray("tags"), upper: true), sfi: range(s.optArray("sfi")), records: range(s.optArray("records")),
                            steps: steps(s.optArray("steps") ?? [], depth + 1), aids: strings(s.optArray("aids"), upper: true),
                            max: s["max"]?.intValue ?? 0, args: s.optObject("args") ?? NfcJSONObject(), more: nil))
        }
        return out
    }
}
