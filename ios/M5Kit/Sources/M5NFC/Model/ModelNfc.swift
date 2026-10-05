// A Functions model's NFC command on this device (6.6) — A/nfc/ModelNfc.java,
// the native side of client/src/lib/nfc/command.ts and web-executor.ts. A
// model's `m5.nfc.scan()` / `emv.report()` / `eid.report()` reaches the app as a
// run interaction of kind "nfc" whose spec.command is an NfcCommand { op,
// reader?, tech?, timeout?, args? }; the device runs the op on a card and answers
// with an NfcResult { status, card?, ndef?, records?, emv?, mrtd?, data?, message? }.
//
// This is the part without the radio: reading the command (camelCase or
// snake_case args), deciding what may run (a model never writes or emulates a
// card: "denied"), which reader takes it, whether an e-ID read still needs the
// holder's document key (asked on the device, never sent), running the op on a
// `ModelNfcCard` and the result shapes. Read-only. An answer never carries a key,
// a PIN, a CAN or the args the command came with.
//
// 6.10 (G-17): an answer with card data leaves only with the holder's yes —
// `consent` lists what would go, the sheet asks, and "send masked" (the default,
// `masked`), "send everything" or "don't send" (`declined`) answers (consent.ts).

import Foundation
import M5Core

public enum ModelNfc {
    public static let defaultTimeout = 20, maxTimeout = 120
    /// How the messages name this platform.
    public static let platform = "iOS"

    /// The card reads this device runs for a model (enum aside, which needs no card).
    public static let reads = ["scan", "read-uid", "read-public", "ndef-read", "m5-read", "emv-public", "emv-read", "eid-public", "eid-read", "mrtd-read"]
    /// Ops every activated card answers whatever its technology.
    static let generic = ["scan", "read-uid", "read-public"]

    /* ------------------------------------------------------------ the command */

    /// What the model asked, normalized (command.ts normalizeCommand, plus snake_case args).
    public struct Command: Sendable, Hashable {
        /// The catalogue op id, "" when the command had none (or a malformed one).
        public let op: String
        /// internal | usb | bluetooth | serial, or nil: the device's own by default.
        public let reader: String?
        /// A catalogue technology the command narrows to, or nil.
        public let tech: String?
        /// Seconds to wait for a card (default 20, 1–120).
        public let timeout: Int
        /// The op's arguments, camelCase, without any raw key / PIN argument.
        public let args: NfcJSONObject
    }

    static let readerKinds = [NfcCatalog.readerInternal, NfcCatalog.readerUsb, NfcCatalog.readerBluetooth, NfcCatalog.readerSerial]
    /// Argument names that would be a card key or PIN (host-nfc.ts SECRET_ARG_RE) — dropped.
    static let secretArg = "(key|keys|key_?a|key_?b|pin|pins|pwd|pack|password|passphrase|secret|apikey|api_?key)"

    static func isSecret(_ k: String) -> Bool { k.lowercased().fullMatch(secretArg) }

    /// The command of an "nfc" interaction's spec ({ command }); none = a scan, as the web does.
    public static func parse(_ spec: NfcJSONObject?) -> Command {
        let raw = spec?.optObject("command") ?? ["op": "scan"]
        let op = raw.string("op").flatMap { $0.fullMatch("[a-z][a-z0-9-]{1,32}") ? $0 : nil } ?? ""
        let reader = raw.string("reader").flatMap { readerKinds.contains($0) ? $0 : nil }
        let tech = raw.string("tech").flatMap { $0.isEmpty ? nil : $0 }
        var timeout = defaultTimeout
        if let d = raw["timeout"]?.doubleValue, d.isFinite { timeout = Int(max(1, min(Double(maxTimeout), d.rounded()))) }
        return Command(op: op, reader: reader, tech: tech, timeout: timeout, args: normalizeArgs(raw.optObject("args")))
    }

    /// The args camelCase (max_apps → maxApps, document_number → documentNumber, photo → readPhoto),
    /// an explicit camelCase key winning over its snake_case twin, and no raw key / PIN argument.
    static func normalizeArgs(_ input: NfcJSONObject?) -> NfcJSONObject {
        var out = NfcJSONObject()
        guard let input else { return out }
        for e in input where !isSecret(e.key) && !e.key.contains("_") { out[e.key] = e.value }
        for e in input where !isSecret(e.key) && e.key.contains("_") {
            let c = camel(e.key)
            if !out.has(c) && !isSecret(c) { out[c] = e.value }
        }
        if !out.has("readPhoto"), let p = out["photo"] { out["readPhoto"] = p }
        return out
    }

    static func camel(_ k: String) -> String {
        var sb = ""
        var up = false
        for ch in k {
            if ch == "_" { up = !sb.isEmpty; continue }
            sb.append(up ? Character(ch.uppercased()) : ch)
            up = false
        }
        return sb
    }

    /* ------------------------------------------------------- what may run */

    /// What an op is to this device: "enum" (no card), "read" (run here), "write" / "emulate" (refused),
    /// "other" (a catalogue read not offered to a model — keys, raw APDUs, dumps), "unknown".
    public static func kindOf(_ op: String) -> String {
        if op == "enum" { return "enum" }
        if reads.contains(op) { return "read" }
        var read = false
        for ti in NfcCatalog.catalog { for o in ti.ops where o.id == op { if o.kind != "read" { return o.kind }; read = true } }
        return read ? "other" : "unknown"
    }

    /// e-ID / e-passport, by either name (eid.read() sends mrtd-read).
    public static func isEidRead(_ op: String) -> Bool { op == "eid-read" || op == "mrtd-read" }

    /// The answer a command gets before any card (a write refused, an unknown op, a technology that does
    /// not offer it) — nil when it goes on to a reader.
    public static func refusal(_ c: Command) -> NfcJSONObject? {
        let op = c.op
        if op.isEmpty { return result("unsupported", nil, "An NFC command needs an op (a catalogue op id, e.g. scan, read-uid, ndef-read, emv-read).") }
        switch kindOf(op) {
        case "write": return result("denied", nil, "\"\(op)\" is a write — run it in the NFC workbench, not from a model.")
        case "emulate": return result("denied", nil, "\"\(op)\" makes the phone act as a card — run it in the NFC workbench, not from a model.")
        case "other": return result("unsupported", nil, "\"\(op)\" is not available to a model on \(platform) — use the NFC workbench.")
        case "unknown": return result("unsupported", nil, "\"\(op)\" is not an NFC operation this device knows.")
        case "enum": return nil
        default: break
        }
        // A command narrowed to a technology that does not offer the op (web-executor.ts).
        if let tech = c.tech, tech != NfcCatalog.unknown, !generic.contains(op) {
            let ti = NfcCatalog.techInfo(tech)
            let asCatalog = op == "mrtd-read" ? "eid-read" : op
            if ti.tech == tech && !NfcCatalog.supportsOp(tech, asCatalog) { return result("unsupported", nil, "\(ti.label) does not support \"\(op)\".") }
        }
        return nil
    }

    /* ------------------------------------------------------------ the device */

    /// What the device has right now (the app builds it).
    public struct Device: Sendable {
        /// The device has an NFC controller (iPhone; not iPad, not Apple Watch)…
        public var hasNfc = false
        /// …and it is on (always, on iOS — there is no NFC switch).
        public var nfcOn = false
        /// What the internal reader can do (`NfcCapabilities.coreNFCiPhone`).
        public var internalCapabilities: NfcCapabilities = .coreNFCiPhone
        /// A Bluetooth adapter (no Bluetooth reader is driven from a model).
        public var bluetooth = false
        /// The workbench's reader choice (settings nfc.reader), "" for the default.
        public var preferred = ""
        /// Attached external (USB / CCID) readers.
        public var usb = [Usb]()

        public struct Usb: Sendable, Hashable {
            public let name: String
            /// The user already allowed it (the workbench asked).
            public let permitted: Bool
            public init(_ name: String, permitted: Bool) { self.name = name; self.permitted = permitted }
        }

        public init() {}

        var permittedUsb: Usb? { usb.first { $0.permitted } }
    }

    /// Where a command goes: a reader ("internal" / "usb"), or an answer straight away.
    public struct Route: Sendable {
        public let reader: String?
        public let result: NfcJSONObject?
        /// The device has NFC but it is off — the sheet offers the settings.
        public let nfcOff: Bool
    }

    /// The reader for a command: the device's own by default; an external reader when the command asks for
    /// one (or names none and the workbench chose it) and the user already allowed it. Bluetooth / serial
    /// readers are not driven from a model. iOS: an op the internal reader cannot do (payment AIDs) is refused.
    public static func route(_ c: Command, _ d: Device) -> Route {
        let r = c.reader
        if r == NfcCatalog.readerBluetooth { return Route(reader: nil, result: result("unsupported", nil, "A Bluetooth reader is not available to a model on \(platform) — use the phone's own NFC or a USB reader."), nfcOff: false) }
        if r == NfcCatalog.readerSerial { return Route(reader: nil, result: result("unsupported", nil, "A serial reader is not available on \(platform) — use the phone's own NFC or a USB reader."), nfcOff: false) }
        let usb = d.permittedUsb
        if r == NfcCatalog.readerUsb {
            if usb != nil { return Route(reader: NfcCatalog.readerUsb, result: nil, nfcOff: false) }
            return Route(reader: nil, result: result("unsupported", nil, d.usb.isEmpty ? "No USB reader is connected." : "Allow the USB reader in the NFC workbench first."), nfcOff: false)
        }
        if r == nil && usb != nil && (d.preferred == NfcCatalog.readerUsb || !d.hasNfc) { return Route(reader: NfcCatalog.readerUsb, result: nil, nfcOff: false) }
        if !d.hasNfc { return Route(reader: nil, result: result("unsupported", nil, "This device has no NFC reader."), nfcOff: false) }
        if !d.nfcOn { return Route(reader: nil, result: result("unsupported", nil, "NFC is switched off on this phone — turn it on in the settings and try again."), nfcOff: true) }
        if let why = NfcPlatform.limit(op: c.op == "mrtd-read" ? "eid-read" : c.op, tech: c.tech ?? "", capabilities: d.internalCapabilities) {
            return Route(reader: nil, result: result("unsupported", nil, why), nfcOff: false)
        }
        return Route(reader: NfcCatalog.readerInternal, result: nil, nfcOff: false)
    }

    /// The card technologies a reader talks to.
    static func technologies(_ reader: String, _ d: Device) -> [String] {
        if reader == NfcCatalog.readerUsb { return [NfcCatalog.isoDep, NfcCatalog.mifareDesfire, NfcCatalog.emv, NfcCatalog.eid] }
        return NfcPlatform.technologies(capabilities: d.internalCapabilities)
    }

    /// enum: what the device offers now — its readers and the card technologies they talk to, with the ops a
    /// model may run. No card is needed. The list travels as `data` (base64 JSON { readers, default,
    /// technologies, ops }) and `message` says it in words.
    public static func enumResult(_ c: Command, _ d: Device) -> NfcJSONObject {
        let only = c.reader
        var readers = [NfcJSON]()
        var techs = [String]()
        var words = [String]()
        func addTechs(_ list: [String]) { for t in list where !techs.contains(t) { techs.append(t) } }
        if only == nil || only == NfcCatalog.readerInternal {
            readers.append(["kind": .string(NfcCatalog.readerInternal), "name": "This device", "available": .bool(d.hasNfc), "enabled": .bool(d.hasNfc && d.nfcOn)])
            if d.hasNfc { addTechs(technologies(NfcCatalog.readerInternal, d)); words.append("This device (NFC \(d.nfcOn ? "on" : "off"))") }
        }
        if only == nil || only == NfcCatalog.readerUsb {
            for u in d.usb {
                readers.append(["kind": .string(NfcCatalog.readerUsb), "name": .string(u.name), "available": true, "enabled": .bool(u.permitted), "permitted": .bool(u.permitted)])
                if u.permitted { addTechs(technologies(NfcCatalog.readerUsb, d)) }
                words.append("\(u.name) (USB\(u.permitted ? "" : ", not allowed yet"))")
            }
        }
        if (only == nil || only == NfcCatalog.readerBluetooth) && d.bluetooth {
            readers.append(["kind": .string(NfcCatalog.readerBluetooth), "name": "Bluetooth reader", "available": false, "enabled": false, "note": .string("not driven from a model on \(platform)")])
        }
        let def = route(Command(op: "scan", reader: nil, tech: nil, timeout: defaultTimeout, args: NfcJSONObject()), d)
        let data: NfcJSONObject = ["readers": .array(readers), "default": def.reader.map { .string($0) } ?? .null, "technologies": NfcJSON(techs), "ops": NfcJSON(reads)]
        let msg = words.isEmpty ? "No NFC reader on this device." : "Readers: " + words.joined(separator: ", ") + ". Card technologies: " + techs.joined(separator: ", ") + "."
        var out = result("ok", nil, JSText.length(msg) > 480 ? JSText.prefix(msg, 479) + "…" : msg)
        out["data"] = .string(Data(data.compact.utf8).base64EncodedString())
        return out
    }

    /* ------------------------------------------- the holder's document key */

    /// An e-ID read whose args carry no document key (mrz, can, or all three of documentNumber + dateOfBirth +
    /// dateOfExpiry): the device asks the holder before the card. What they type stays on the device.
    public static func needsDocumentKey(_ c: Command) -> Bool { isEidRead(c.op) && !hasDocumentKey(c.args) }

    static func hasDocumentKey(_ a: NfcJSONObject) -> Bool {
        func filled(_ k: String) -> Bool { !JSText.trim(a.string(k) ?? "").isEmpty }
        return filled("mrz") || filled("can") || (filled("documentNumber") && filled("dateOfBirth") && filled("dateOfExpiry"))
    }

    /// What the holder typed in the sheet: the CAN, or the MRZ, or the three fields.
    public struct DocumentKey: Sendable, Hashable {
        public var can = "", mrz = "", documentNumber = "", dateOfBirth = "", dateOfExpiry = ""
        public init(can: String = "", mrz: String = "", documentNumber: String = "", dateOfBirth: String = "", dateOfExpiry: String = "") {
            self.can = can; self.mrz = mrz; self.documentNumber = documentNumber; self.dateOfBirth = dateOfBirth; self.dateOfExpiry = dateOfExpiry
        }
        var canDigits: String { can.replacingRegex("\\s", with: "") }
        var mrzText: String { JSText.upperASCII(JSText.trim(mrz)) }
        var doc: String { JSText.upperASCII(documentNumber.replacingRegex("\\s", with: "")) }
        static func date(_ s: String) -> String { s.replacingRegex("\\s", with: "") }
    }

    /// What is wrong with what the holder typed — a design string key — or nil when it can open a document:
    /// a CAN of 6 digits, or an MRZ the BAC key can be taken from, or the document number with both dates as YYMMDD.
    public static func checkDocumentKey(_ k: DocumentKey) -> String? {
        let can = k.canDigits, mrz = k.mrzText, doc = k.doc, dob = DocumentKey.date(k.dateOfBirth), exp = DocumentKey.date(k.dateOfExpiry)
        let fields = !doc.isEmpty || !dob.isEmpty || !exp.isEmpty
        if can.isEmpty && mrz.isEmpty && !fields { return "nfc.eid.needKey" }
        if !can.isEmpty && !can.fullMatch("\\d{6}") { return "nfc.model.key.badCan" }
        if !mrz.isEmpty && (Bac.mrzKey(fromMrz: mrz) == nil || !mrz.fullMatch("[A-Z0-9<\\s]+")) { return "nfc.model.key.badMrz" }
        if fields && mrz.isEmpty {
            if doc.isEmpty || dob.isEmpty || exp.isEmpty || !doc.fullMatch("[A-Z0-9<]{1,20}") { return "nfc.eid.needKey" }
            if !dob.fullMatch("\\d{6}") || !exp.fullMatch("\\d{6}") { return "nfc.model.key.badDate" }
        }
        return nil
    }

    /// The command with the holder's key in its args, for this read only (document-key.ts withDocumentKey).
    public static func withDocumentKey(_ c: Command, _ k: DocumentKey) -> Command {
        var a = c.args
        let can = k.canDigits, mrz = k.mrzText, doc = k.doc, dob = DocumentKey.date(k.dateOfBirth), exp = DocumentKey.date(k.dateOfExpiry)
        if !can.isEmpty { a["can"] = .string(can) }
        if !mrz.isEmpty { a["mrz"] = .string(mrz) }
        else if !doc.isEmpty && !dob.isEmpty && !exp.isEmpty { a["documentNumber"] = .string(doc); a["dateOfBirth"] = .string(dob); a["dateOfExpiry"] = .string(exp) }
        return Command(op: c.op, reader: c.reader, tech: c.tech, timeout: c.timeout, args: a)
    }

    /* --------------------------------------------------------------- a card */

    /// Runs a read on the card in the field. Never throws: a failure is an answer.
    public static func run(_ c: Command, _ card: any ModelNfcCard) async -> NfcJSONObject {
        var cardOut = cardField(card.identity())
        let op = c.op
        do {
            switch op {
            case "read-uid":
                return result("ok", cardOut, nil)
            case "scan", "read-public":
                var recs: [NdefRecord]? = nil
                do { recs = try await card.ndef() } catch let e as NfcError where e.code == .cardGone { throw e } catch { recs = nil }
                var out = result("ok", cardOut, nil)
                if let recs {
                    refineTech(&cardOut, recs)
                    out["card"] = .object(cardOut)
                    if !recs.isEmpty { out["ndef"] = ndefField(recs) }
                    if let m5 = m5Records(recs) { out["records"] = m5 }
                }
                return out
            case "ndef-read":
                guard let recs = try await card.ndef() else { return result("unsupported", cardOut, "Not an NDEF tag.") }
                refineTech(&cardOut, recs)
                var out = result("ok", cardOut, nil)
                out["ndef"] = ndefField(recs)
                return out
            case "m5-read":
                let recs = try await card.ndef()
                if let recs { refineTech(&cardOut, recs) }
                guard let m5 = recs.flatMap(m5Records) else { return result("ok", cardOut, "Not an M5Cet card.") }
                var out = result("ok", cardOut, nil)
                out["records"] = m5
                return out
            case "emv-public":
                guard let t = try await card.isoDep() else { return notIsoDep(cardOut) }
                return try await emvPublic(t, &cardOut)
            case "eid-public":
                guard let t = try await card.isoDep() else { return notIsoDep(cardOut) }
                let r = Apdu.split(try await t.transmit(Apdu.build(0x00, 0xa4, 0x04, 0x0c, data: MrtdReader.aid)))
                let present = Apdu.isOk(r.sw)
                if present { retech(&cardOut, NfcCatalog.eid) }
                return result("ok", cardOut, "MRTD \(present ? "present" : "absent") (\(StatusWords.hex(r.sw))). Public presence only — no BAC/PACE, no data.")
            case "emv-read", "eid-read", "mrtd-read":
                guard let t = try await card.isoDep() else { return notIsoDep(cardOut) }
                guard var r = await CardOps.readResult(op, t, c.args, selectMasterFileForCardAccess: card.autoSelectsAid) else {
                    return result("unsupported", cardOut, "\"\(op)\" is not available here.")
                }
                if let emv = r.optObject("emv"), emv.arrayCount("aids") + emv.arrayCount("apps") > 0 { retech(&cardOut, NfcCatalog.emv) }
                if let mrtd = r.optObject("mrtd"), mrtd.has("mrzInfo") || mrtd.optString("access", "none") != "none" { retech(&cardOut, NfcCatalog.eid) }
                r["card"] = .object(cardOut)
                return scrub(r, c)
            default:
                return result("unsupported", cardOut, "\"\(op)\" is not available to a model on \(platform).")
            }
        } catch let e as NfcError where e.code == .cardGone {
            return result("no-card", cardOut, "The card left the field before the read finished — hold it still until it is done.")
        } catch {
            let m = errorText(error)
            return scrub(result("error", cardOut, m.isEmpty ? String(describing: type(of: error)) : m), c)
        }
    }

    static func notIsoDep(_ cardOut: NfcJSONObject) -> NfcJSONObject {
        result("unsupported", cardOut, cardOut.optString("label", "This card") + " is not an ISO-DEP card — EMV cards and e-IDs talk ISO 14443-4.")
    }

    /// emv-public: SELECT the PPSE and list the applications it offers (no record read).
    static func emvPublic(_ t: any ApduChannel, _ cardOut: inout NfcJSONObject) async throws -> NfcJSONObject {
        let r = try await Apdu.transmitSmart(t, Apdu.selectByAid(EmvReader.ppse))
        if !Apdu.isOk(r.sw) { return result("ok", cardOut, "No PPSE (\(StatusWords.hex(r.sw)))") }
        let tree = BerTlv.decode(r.data)
        let aids = BerTlv.findAll(tree, 0x4f).map { Hex.upper($0.value) }
        if !aids.isEmpty { retech(&cardOut, NfcCatalog.emv) }
        let name = BerTlv.find(tree, 0x50).map { JSText.trim(Bytes.asciiString($0.value)) } ?? ""
        return result("ok", cardOut, "EMV: " + (name.isEmpty ? "" : name + " ") + "AIDs " + aids.joined(separator: ", "))
    }

    /* -------------------------------------------------------------- results */

    /// { status, card?, message? }.
    public static func result(_ status: String, _ card: NfcJSONObject?, _ message: String?) -> NfcJSONObject {
        var o: NfcJSONObject = ["status": .string(status)]
        if let card { o["card"] = .object(card) }
        if let m = message, !m.isEmpty { o["message"] = .string(m) }
        return o
    }

    /// The holder closed the sheet (or the run went away): what the web answers for an abort.
    public static func cancelled() -> NfcJSONObject { result("timeout", nil, "Cancelled") }

    /// No card came within the command's timeout.
    public static func timedOut(_ seconds: Int) -> NfcJSONObject { result("timeout", nil, "No card was presented within \(seconds) s.") }

    static let cardFields = ["uid", "tech", "label", "atqa", "sak", "ats", "atr", "memory"]

    /// The NfcResult card: uid, tech, label, atqa / sak / ats / atr, memory — nothing else of what the reader saw.
    static func cardField(_ seen: NfcJSONObject?) -> NfcJSONObject {
        let tech = seen?.string("tech") ?? NfcCatalog.unknown
        var out: NfcJSONObject = ["uid": .string(seen?.optString("uid") ?? ""), "tech": .string(tech)]
        let label = seen?.optString("label") ?? ""
        out["label"] = .string(label.isEmpty ? NfcCatalog.techInfo(tech).label : label)
        for k in cardFields where !out.has(k) { if let v = seen?.string(k), !v.isEmpty { out[k] = .string(v) } }
        return out
    }

    /// What the read found out the card is (an EMV card, an e-ID…), in the answer's card.
    static func retech(_ card: inout NfcJSONObject, _ tech: String) {
        let ti = NfcCatalog.techInfo(tech)
        card["tech"] = .string(tech); card["label"] = .string(ti.label)
        if ti.memory.isEmpty { card.remove("memory") } else { card["memory"] = .string(ti.memory) }
    }

    /// An NDEF tag that carries the app's own cards: the connection tag, an M5Cet card.
    static func refineTech(_ card: inout NfcJSONObject, _ recs: [NdefRecord]) {
        for r in recs {
            let type = r.typeString
            if r.tnf == Tnf.external.rawValue && type.lowercased() == M5Card.externalType && M5Card.isM5Card(r.payload) { retech(&card, NfcCatalog.m5cetCard); return }
            if r.tnf == Tnf.mime.rawValue && type == ConnectionCard.mime { retech(&card, NfcCatalog.connectionTag); return }
        }
    }

    /// The records of an M5Cet card as a model may see them — id, type, one-time — still sealed; nil when none.
    static func m5Records(_ recs: [NdefRecord]) -> NfcJSON? {
        for r in recs where r.tnf == Tnf.external.rawValue && r.typeString.lowercased() == M5Card.externalType && M5Card.isM5Card(r.payload) {
            let sealed = (try? M5Card.decodeContainer(r.payload)) ?? []
            return .array(sealed.map { ["id": NfcJSON($0.id), "type": .string($0.type), "oneTime": .bool($0.oneTime), "summary": .string($0.type)] })
        }
        return nil
    }

    /// The answer never repeats what opened the card: the CAN the holder gave is blanked out of any message.
    static func scrub(_ r: NfcJSONObject, _ c: Command) -> NfcJSONObject {
        let can = JSText.trim(c.args.optString("can"))
        if can.count < 4 { return r }
        var out = r
        if out.optString("message").contains(can) { out["message"] = .string(out.optString("message").replacingOccurrences(of: can, with: "******")) }
        if var m = out.optObject("mrtd"), m.optString("message").contains(can) {
            m["message"] = .string(m.optString("message").replacingOccurrences(of: can, with: "******"))
            out["mrtd"] = .object(m)
        }
        return out
    }

    /* ------------------------------------------------------------------ NDEF */

    /// NfcResult.ndef: { kind, type?, text?, lang?, data? } per record (web-executor.ts ndefField).
    static func ndefField(_ recs: [NdefRecord]) -> NfcJSON { .array(recs.map { .object(ndefRecord($0)) }) }

    static func ndefRecord(_ r: NdefRecord) -> NfcJSONObject {
        let t = r.typeString
        switch r.tnf {
        case Tnf.empty.rawValue: return ["kind": "empty"]
        case Tnf.wellKnown.rawValue:
            if t == "T" {
                guard case .text(let text, let lang, _) = Ndef.decodeRecord(r) else { return ["kind": "text", "text": "", "lang": ""] }
                return ["kind": "text", "text": .string(text), "lang": .string(lang)]
            }
            if t == "U" { return ["kind": "uri", "data": .string(Ndef.uriText(r.payload))] }
            if t == "Sp" {
                var sp: NfcJSONObject = ["kind": "smart-poster"]
                for i in (try? Ndef.decodeMessage(r.payload, strict: false)) ?? [] where i.tnf == Tnf.wellKnown.rawValue && i.typeString == "U" {
                    sp["data"] = .string(Ndef.uriText(i.payload)); break
                }
                return sp
            }
            return ["kind": "unknown", "type": .string(String(r.tnf))]
        case Tnf.mime.rawValue: return ["kind": "mime", "type": .string(t), "data": .string(Hex.upper(r.payload))]
        case Tnf.absoluteUri.rawValue: return ["kind": "uri", "data": .string(t)]
        case Tnf.external.rawValue: return ["kind": "external", "type": .string(t), "data": .string(Hex.upper(r.payload))]
        default: return ["kind": "unknown", "type": .string(String(r.tnf))]
        }
    }

    /* ------------------------------------------------- consent (6.10, G-17) */

    /// One line of what would be sent: a design key (nfc.consent.*) and its values.
    public struct ConsentLine: Sendable, Hashable {
        public let key: String
        public let vars: [String: String]
        init(_ key: String, _ kv: [(String, String)] = []) { self.key = key; vars = Dictionary(kv, uniquingKeysWith: { a, _ in a }) }
    }

    /// What a model's NFC result would send, masked and in full.
    public struct Consent: Sendable {
        /// What goes with "send masked".
        public let masked: [ConsentLine]
        /// What "send everything" adds.
        public let full: [ConsentLine]
        /// The result carries card data a model should not get without the holder's yes.
        public var sensitive: Bool { !masked.isEmpty || !full.isEmpty }
    }

    /// "5413330089020011" → "541333••••••0011" (as the sheet and the web show a card number).
    static func maskPanDigits(_ pan: String) -> String { PanMask.maskPanDigits(pan, "•") }

    /// A document number with all but its last three characters hidden.
    static func maskDocNumber(_ s: String) -> String { s.count > 3 ? String(repeating: "•", count: s.count - 3) + String(s.suffix(3)) : s }

    /// The result's card numbers: the EMV read's and any in its transcript.
    static func pans(_ r: NfcJSONObject) -> [String] {
        var out = PanMask.pansOfEmv(r.optObject("emv"))
        for e in r.objects("transcript") { for p in PanMask.pansInHex(e.optString("response")) where !out.contains(p) { out.append(p) } }
        return out
    }

    static func b64(_ s: String) -> [UInt8] { Data(base64Encoded: s).map { [UInt8]($0) } ?? [] }

    /// What a model's NFC result would send, masked and in full (consent.ts nfcConsent).
    public static func consent(_ r: NfcJSONObject?) -> Consent {
        var masked = [ConsentLine](), full = [ConsentLine]()
        guard let r else { return Consent(masked: masked, full: full) }
        let pans = pans(r)
        func or(_ a: String, _ b: String) -> String { a.isEmpty ? b : a }
        if let emv = r.optObject("emv") {
            let apps = emv.objects("apps"), aids = emv.strings("aids")
            if apps.count + aids.count > 0 {
                for a in apps {
                    let pan = a.optString("pan")
                    masked.append(ConsentLine("nfc.consent.emvApp", [("app", or(a.optString("scheme"), or(a.optString("label"), a.optString("aid")))),
                                                                       ("pan", or(a.optString("panMasked"), pan.isEmpty ? "—" : maskPanDigits(pan))),
                                                                       ("expiry", or(a.optString("expiry"), "—"))]))
                    if !a.optString("cardholder").isEmpty { masked.append(ConsentLine("nfc.consent.cardholder", [("name", a.optString("cardholder"))])) }
                    if a.arrayCount("log") > 0 { masked.append(ConsentLine("nfc.consent.history", [("n", String(a.arrayCount("log")))])) }
                    if a.arrayCount("records") > 0 { masked.append(ConsentLine("nfc.consent.records", [("n", String(a.arrayCount("records")))])) }
                }
                if apps.isEmpty { masked.append(ConsentLine("nfc.consent.aids", [("aids", aids.joined(separator: ", "))])) }
                if !pans.isEmpty { full.append(ConsentLine("nfc.consent.fullPan", [("n", String(pans.count))])) }
            }
        }
        if let m = r.optObject("mrtd"), m.optString("access", "none") != "none" || m.has("mrzInfo") {
            let z = m.optObject("mrzInfo") ?? NfcJSONObject()
            let name = JSText.trim(z.optString("givenNames") + " " + z.optString("surname"))
            let doc = z.optString("documentNumber")
            masked.append(ConsentLine("nfc.consent.holder", [("name", or(name, "—")), ("doc", doc.isEmpty ? "—" : maskDocNumber(doc))]))
            if !z.optString("mrz").isEmpty || !doc.isEmpty || !z.optString("optionalData").isEmpty { full.append(ConsentLine("nfc.consent.mrz")) }
            let images = m.has("images") ? m.arrayCount("images") : (!m.optString("photo").isEmpty ? 1 : 0)
            if images > 0 { full.append(ConsentLine("nfc.consent.images", [("n", String(images))])) }
            if m.has("personal") || m.has("document") || m.has("optional") || m.arrayCount("personsToNotify") > 0 { full.append(ConsentLine("nfc.consent.details")) }
            if m.arrayCount("raw") > 0 { full.append(ConsentLine("nfc.consent.files", [("n", String(m.arrayCount("raw")))])) }
        }
        if r.arrayCount("transcript") > 0 {
            masked.append(ConsentLine(pans.isEmpty ? "nfc.consent.transcript" : "nfc.consent.transcriptMasked", [("n", String(r.arrayCount("transcript")))]))
        }
        if !r.optString("data").isEmpty {
            let d = b64(r.optString("data"))
            if !PanMask.pansInHex(Hex.upper(d)).isEmpty { full.append(ConsentLine("nfc.consent.dataPan", [("n", String(d.count))])) }
            else { masked.append(ConsentLine("nfc.consent.data", [("n", String(d.count))])) }
        }
        return Consent(masked: masked, full: full)
    }

    /// A design text with its {name} placeholders filled.
    static func fill(_ text: String, _ vars: [String: String]) -> String {
        var out = text
        for (k, v) in vars { out = out.replacingOccurrences(of: "{\(k)}", with: v) }
        return out
    }

    /// The consent question as the sheet shows it (consent.ts consentPrompt): who asks and what goes,
    /// then what "send everything" adds.
    public static func consentText(_ c: Consent, model: String?, _ t: (String) -> String) -> String {
        let who = JSText.trim(model ?? "").isEmpty ? t("nfc.consent.aModel") : JSText.trim(model!)
        var lines = [fill(t("nfc.consent.text"), ["model": who])]
        for l in c.masked { lines.append("• " + fill(t(l.key), l.vars)) }
        if !c.full.isEmpty {
            lines.append(t("nfc.consent.fullAdds"))
            for l in c.full { lines.append("• " + fill(t(l.key), l.vars)) }
        }
        return lines.joined(separator: "\n")
    }

    /// The holder said no: what the model is told (the card's identity stays, as on the web).
    public static func declined(_ r: NfcJSONObject?) -> NfcJSONObject { result("denied", r?.optObject("card"), "The holder did not send the card's data to the model.") }

    /// The result as "send masked" sends it (consent.ts maskNfcResult).
    public static func masked(_ r: NfcJSONObject?) -> NfcJSONObject? {
        guard let r else { return nil }
        let pans = pans(r)
        var out = r
        if let emv = r.optObject("emv") { out["emv"] = TemplateViews.maskedEmv(emv, pans: pans).map { .object($0) } ?? .null }
        if let m = r.optObject("mrtd") { out["mrtd"] = .object(maskMrtd(m)) }
        if var tr = out.optArray("transcript") {
            for i in tr.indices {
                if var e = tr[i].objectValue, e.has("response") { e["response"] = .string(PanMask.maskAnswer(JSText.upperASCII(e.optString("response")), pans)); tr[i] = .object(e) }
            }
            out["transcript"] = .array(tr)
        }
        if !r.optString("data").isEmpty && !PanMask.pansInHex(Hex.upper(b64(r.optString("data")))).isEmpty { out.remove("data") }
        if r.has("message") {
            var msg = PanMask.maskPans(r.optString("message"), pans)
            let doc = r.optObject("mrtd")?.optObject("mrzInfo")?.optString("documentNumber") ?? ""
            if !doc.isEmpty { msg = msg.replacingOccurrences(of: doc, with: maskDocNumber(doc)) }
            out["message"] = .string(msg)
        }
        return out
    }

    /// What of a document "send masked" keeps: no MRZ lines or optional data, the document number masked,
    /// no photo, images, details or raw files.
    static func maskMrtd(_ d: NfcJSONObject) -> NfcJSONObject {
        var out = NfcJSONObject()
        for k in ["present", "access", "pace", "dataGroups", "ldsVersion", "unicodeVersion"] { if let v = d[k] { out[k] = v } }
        if var z = d.optObject("mrzInfo") {
            z.remove("mrz"); z.remove("optionalData")
            let doc = z.optString("documentNumber")
            if !doc.isEmpty { z["documentNumber"] = .string(maskDocNumber(doc)) }
            out["mrzInfo"] = .object(z)
        }
        for k in ["files", "security", "message"] { if let v = d[k] { out[k] = v } }
        return out
    }

    /* ---------------------------------------------------------- the sheet */

    /// The design key for what is asked, in plain words.
    public static func whatKey(_ op: String) -> String {
        switch op {
        case "emv-read": return "nfc.model.what.emv"
        case "emv-public": return "nfc.model.what.emvPublic"
        case "eid-read", "mrtd-read": return "nfc.model.what.eid"
        case "eid-public": return "nfc.model.what.eidPublic"
        case "read-uid": return "nfc.model.what.uid"
        case "ndef-read": return "nfc.model.what.ndef"
        case "m5-read": return "nfc.model.what.m5"
        default: return "nfc.model.what.scan"
        }
    }
}

/// A card in the field, behind whichever reader found it (ModelNfc.Card).
public protocol ModelNfcCard: AnyObject {
    /// The card as the reader sees it: uid, tech (a catalogue name), label, atqa / sak / ats / atr, memory.
    func identity() -> NfcJSONObject
    /// An ISO-DEP channel to the card; nil when the card has none.
    func isoDep() async throws -> (any ApduChannel)?
    /// The NDEF records (empty when it holds none); nil when it is not an NDEF tag.
    func ndef() async throws -> [NdefRecord]?
    /// The session selected an AID itself before handing the card over (CoreNFC).
    var autoSelectsAid: Bool { get }
}

extension ModelNfcCard {
    public var autoSelectsAid: Bool { false }
}

/// A `ModelNfcCard` over the app's `CardTransport`.
public final class TransportCard: ModelNfcCard {
    let transport: any CardTransport
    let seen: CardIdentity
    public init(_ transport: any CardTransport, identity: CardIdentity) { self.transport = transport; self.seen = identity }
    public func identity() -> NfcJSONObject { seen.json }
    public func isoDep() async throws -> (any ApduChannel)? { transport.capabilities.contains(.iso7816) ? transport : nil }
    public func ndef() async throws -> [NdefRecord]? { transport.capabilities.contains(.ndefRead) ? try await transport.readNdef() : nil }
    public var autoSelectsAid: Bool { transport.capabilities.contains(.autoSelectsAid) }
}
