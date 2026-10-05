// EMV reader (6.5, deep read 6.6) — A/nfc/EmvReader.java (emv.ts): the public /
// holder data a contactless terminal reads, nothing more. Read-only: PPSE →
// SELECT AID → GET DATA (counters, the log format) → the transaction log →
// GET PROCESSING OPTIONS → READ RECORD (the AFL's records and, deep, every other
// short file); the records' BER-TLV parsed and the known elements labelled
// (EmvTags). It never verifies a PIN (9F17 is read as a counter), never runs
// GENERATE AC and writes nothing — the bytes a payment terminal sees.
//
// `read` produces the `emv` object of the NfcResult contract (command.ts EmvData).
// iOS: CoreNFC refuses payment AIDs (`NfcCapabilities.paymentAids`), so on an
// iPhone this runs only over a transport that has them (an external reader).

import Foundation

public enum EmvReader {
    static let ppse = Array("2PAY.SYS.DDF01".utf8)
    static let pse = Array("1PAY.SYS.DDF01".utf8)
    static let bullet = "•"

    /// EMV read options (command.ts EmvReadArgs).
    public struct Options: Sendable, Hashable {
        /// How many applications to open (default 8, at most 16).
        public var maxApps = 8
        /// Read the transaction log (default true).
        public var history = true
        /// Read every file the card has, not only the AFL's records (default true).
        public var deep = true
        /// 6.10: the preferred application (an older op template's `aid`): read first.
        public var aid: String? = nil

        public init(maxApps: Int = 8, history: Bool = true, deep: Bool = true, aid: String? = nil) {
            self.maxApps = maxApps; self.history = history; self.deep = deep; self.aid = aid
        }

        /// From an op's `args` (maxApps / history / deep / aid; snake_case accepted too).
        public static func from(args: NfcJSONObject?) -> Options {
            var o = Options()
            guard let args else { return o }
            let m = args.has("maxApps") ? args["maxApps"] : args["max_apps"]
            if let d = m?.doubleValue, d.isFinite { o.maxApps = Int(max(-1e6, min(1e6, d))) }
            if let h = args["history"]?.boolValue { o.history = h }
            if let d = args["deep"]?.boolValue { o.deep = d }
            if let aid = args.string("aid"), aid.fullMatch("[0-9A-Fa-f]{10,32}") { o.aid = JSText.upperASCII(aid) }
            return o
        }
    }

    /// Counts every command the read sends (EmvData.apdus).
    final class Sender {
        let t: any ApduChannel
        var apdus = 0
        init(_ t: any ApduChannel) { self.t = t }
        func send(_ cmd: [UInt8]) async throws -> Apdu.Response { apdus += 1; return try await Apdu.transmitSmart(t, cmd) }
    }

    /// Tag → value, insertion-ordered; a newer value keeps the first position (LinkedHashMap.put).
    struct TagMap {
        private(set) var keys = [String]()
        private var values = [String: [UInt8]]()
        subscript(key: String) -> [UInt8]? {
            get { values[key] }
            set {
                guard let v = newValue else { if values.removeValue(forKey: key) != nil { keys.removeAll { $0 == key } }; return }
                if values[key] == nil { keys.append(key) }
                values[key] = v
            }
        }
        mutating func putIfAbsent(_ key: String, _ value: [UInt8]) { if values[key] == nil { self[key] = value } }
        func has(_ key: String) -> Bool { values[key] != nil }
        var isEmpty: Bool { keys.isEmpty }
        var entries: [(String, [UInt8])] { keys.map { ($0, values[$0]!) } }
    }

    static func collectLeaves(_ nodes: [Tlv], into: inout TagMap) {
        for n in nodes {
            if n.constructed, let c = n.children { collectLeaves(c, into: &into) } else { into[BerTlv.tagHex(n.tag)] = n.value }
        }
    }

    /* ------------------------------------------------------------ GPO / PDOL */

    static let pdolDefaults: [String: [UInt8]] = [
        "9F66": [0x36, 0x00, 0x40, 0x00], "9F02": [0, 0, 0, 0, 0, 0], "9F03": [0, 0, 0, 0, 0, 0], "9F1A": [0x02, 0x03], "95": [0, 0, 0, 0, 0],
        "5F2A": [0x09, 0x78], "9A": [0x25, 0x01, 0x01], "9C": [0x00], "9F35": [0x22], "9F45": [0, 0], "9F4C": [0, 0, 0, 0, 0, 0, 0, 0],
        "9F34": [0, 0, 0], "9F21": [0, 0, 0], "9F40": [0, 0, 0, 0, 0], "9F1E": [0, 0, 0, 0, 0, 0, 0, 0],
    ]

    static func pdolValue(_ tag: String, _ len: Int) -> [UInt8] {
        if tag == "9F37" { return NfcCrypto.random(len) }
        var out = [UInt8](repeating: 0, count: len)
        if let d = pdolDefaults[tag] { for i in 0..<min(len, d.count) { out[i] = d[i] } }
        return out
    }

    static func fillDol(_ dol: [UInt8]) -> [UInt8] { parseDol(dol).flatMap { pdolValue($0.tag, $0.len) } }

    /* ------------------------------------------------------------ AFL records */

    struct Afl { let sfi: Int, first: Int, last: Int }

    static func parseAfl(_ afl: [UInt8]) -> [Afl] {
        var out = [Afl]()
        var i = 0
        while i + 3 < afl.count { out.append(Afl(sfi: Int(afl[i]) >> 3, first: Int(afl[i + 1]), last: Int(afl[i + 2]))); i += 4 }
        return out
    }

    /// One record as read (command.ts EmvRecord).
    struct Rec { let sfi: Int, record: Int, hex: String, log: Bool }

    static func has(_ records: [Rec], _ sfi: Int, _ rec: Int) -> Bool { records.contains { $0.sfi == sfi && $0.record == rec } }

    static func keepTlv(_ data: [UInt8], into: inout TagMap) { collectLeaves(BerTlv.decode(data, recurse: true), into: &into) }

    /// Reads records, parses their BER-TLV into `into`, keeps each one raw.
    static func readRecords(_ s: Sender, _ entries: [Afl], into: inout TagMap, records: inout [Rec]) async {
        for e in entries {
            var rec = e.first
            while rec <= e.last && rec > 0 {
                defer { rec += 1 }
                if has(records, e.sfi, rec) { continue }
                guard let r = try? await s.send(Apdu.readRecord(rec, sfi: e.sfi)) else { continue }
                if !Apdu.isOk(r.sw) || r.data.isEmpty { continue }
                records.append(Rec(sfi: e.sfi, record: rec, hex: Hex.encode(r.data), log: false))
                keepTlv(r.data, into: &into)
            }
        }
    }

    /// A deep read (6.6): every short file in `sfiFrom…sfiTo` (within 1–30), records `recFrom…recTo` (within 1–254),
    /// beyond what the AFL lists — a file that answers no record is left at once. READ RECORD only.
    static func scanFiles(_ s: Sender, into: inout TagMap, records: inout [Rec], skipSfi: Int?, budget: inout Int,
                          sfiFrom: Int, sfiTo: Int, recFrom: Int, recTo: Int) async {
        var sfi = max(1, sfiFrom)
        while sfi <= min(30, sfiTo) && budget > 0 {
            defer { sfi += 1 }
            if let skip = skipSfi, sfi == skip { continue }
            var rec = max(1, recFrom)
            while rec <= min(254, recTo) && budget > 0 {
                defer { rec += 1 }
                if has(records, sfi, rec) { continue }
                budget -= 1
                guard let r = try? await s.send(Apdu.readRecord(rec, sfi: sfi)) else { break }
                if !Apdu.isOk(r.sw) || r.data.isEmpty { break }
                records.append(Rec(sfi: sfi, record: rec, hex: Hex.encode(r.data), log: false))
                keepTlv(r.data, into: &into)
            }
        }
    }

    /* ------------------------------------------------------------ GET DATA */

    /// Data objects a terminal may ask for with GET DATA: counters, the log, balances.
    public static let getDataTags = ["9F36", "9F13", "9F17", "9F4D", "9F4F", "9F50", "9F51", "9F5D", "9F6D", "9F6E", "9F79", "DF60", "DF61", "DF62"]

    static func getData(_ s: Sender, _ tag: String) async -> [UInt8]? {
        let t = Int(tag, radix: 16) ?? 0
        guard let r = try? await s.send(Apdu.build(0x80, 0xca, (t >> 8) & 0xff, t & 0xff, le: 0x00)) else { return nil }
        if !Apdu.isOk(r.sw) || r.data.isEmpty { return nil }
        // The answer is the object itself (tag-length-value), or just its value.
        for n in BerTlv.decode(r.data, recurse: false) where n.tag == t { return n.value }
        return r.data
    }

    /* ------------------------------------------------------------ the log */

    /// One DOL entry (a tag and its length).
    public struct DolEntry: Sendable, Hashable { public let tag: String; public let len: Int
        public init(_ tag: String, _ len: Int) { self.tag = tag; self.len = len }
    }

    /// A DOL (tag-length list) → its entries.
    public static func parseDol(_ dol: [UInt8]) -> [DolEntry] {
        var out = [DolEntry]()
        var i = 0
        while i < dol.count {
            var tag = Int(dol[i]); i += 1
            if tag & 0x1f == 0x1f {
                while i < dol.count { let b = dol[i]; i += 1; tag = BerTlv.appendTagByte(tag, b); if b & 0x80 == 0 { break } }
            }
            let len = i < dol.count ? Int(dol[i]) : 0
            if i < dol.count { i += 1 }
            out.append(DolEntry(BerTlv.tagHex(tag), len))
        }
        return out
    }

    static let txType: [String: String] = [
        "00": "purchase", "01": "cash", "09": "purchase with cashback", "20": "refund", "21": "deposit", "30": "balance inquiry",
        "31": "balance inquiry", "40": "transfer", "50": "payment", "60": "load", "61": "unload",
    ]
    static let cid: [String: String] = ["00": "declined (AAC)", "40": "approved (TC)", "80": "online (ARQC)"]
    static let currencyExp: [String: Int] = ["0392": 0, "0410": 0, "0704": 0, "0152": 0, "0048": 3, "0414": 3, "0512": 3]

    static func amountText(_ h: String, _ currency: String?) -> String {
        var minor = h.replacingRegex("^0+(?=\\d)", with: "")
        if minor.isEmpty { minor = "0" }
        let exp = currency.flatMap { currencyExp[$0] } ?? 2
        if !minor.fullMatch("\\d+") { return h }
        if exp == 0 { return minor }
        let p = JSText.padStart(minor, exp + 1, "0")
        return String(p.dropLast(exp)) + "." + String(p.suffix(exp))
    }

    static func pad4(_ h: String) -> String { JSText.padStart(h, 4, "0") }

    static func sub(_ s: String, _ a: Int, _ b: Int) -> String { Bac.sub(s, a, b) }

    /// One log record decoded by the card's log format (command.ts EmvLogEntry). Empty slots give nil.
    public static func parseLogRecord(_ rec: [UInt8], _ dol: [DolEntry]) -> NfcJSONObject? {
        if rec.isEmpty || rec.allSatisfy({ $0 == 0x00 }) || rec.allSatisfy({ $0 == 0xff }) { return nil }
        var e = NfcJSONObject()
        var currencyCode: String? = nil
        var off = 0
        for d in dol {
            if d.tag == "5F2A" { currencyCode = pad4(Hex.encode(Bytes.slice(rec, off, off + d.len))); break }
            off += d.len
        }
        var i = 0
        for d in dol {
            let v = Bytes.slice(rec, i, i + d.len)
            i += d.len
            let h = Hex.encode(v)
            switch d.tag {
            case "9A": e["date"] = .string(h.count >= 6 ? "20\(sub(h, 0, 2))-\(sub(h, 2, 4))-\(sub(h, 4, 6))" : h)
            case "9F21": e["time"] = .string(h.count >= 6 ? "\(sub(h, 0, 2)):\(sub(h, 2, 4)):\(sub(h, 4, 6))" : h)
            case "9F02": e["amount"] = .string(amountText(h, currencyCode))
            case "9F03": e["otherAmount"] = .string(amountText(h, currencyCode))
            case "5F2A": e["currency"] = .string(EmvTags.currencyNum[pad4(h)] ?? h)
            case "9F1A": e["country"] = .string(EmvTags.countryNum[pad4(h)] ?? h)
            case "9C": e["type"] = .string(txType[h] ?? h)
            case "9F4E": e["merchant"] = .string(asciiOf(v))
            case "9F36": e["atc"] = .string(BigUInt(bytes: v).isZero ? "0" : decimal(v))
            case "9F27":
                let key = h.count < 2 ? "00" : String(format: "%02x", (Int(sub(h, 0, 2), radix: 16) ?? 0) & 0xc0)
                e["cid"] = .string(cid[key] ?? h)
            default: e[d.tag] = .string(h)
            }
        }
        e["raw"] = .string(Hex.encode(rec))
        return e
    }

    /// Big-endian unsigned bytes in decimal.
    static func decimal(_ v: [UInt8]) -> String {
        var n = BigUInt(bytes: v)
        if n.isZero { return "0" }
        var digits = [Character]()
        let ten = BigUInt(10)
        while !n.isZero {
            let (q, r) = BigUInt.divMod(n, ten)
            digits.append(Character(String(r.limbs.first ?? 0)))
            n = q
        }
        return String(digits.reversed())
    }

    static func readLog(_ s: Sender, sfi: Int, count: Int, dol: [DolEntry], records: inout [Rec]) async -> [NfcJSONObject] {
        var out = [NfcJSONObject]()
        let last = min(count > 0 ? count : 30, 50)
        var rec = 1
        while rec <= last {
            defer { rec += 1 }
            guard let r = try? await s.send(Apdu.readRecord(rec, sfi: sfi)) else { break }
            if !Apdu.isOk(r.sw) { break }
            records.append(Rec(sfi: sfi, record: rec, hex: Hex.encode(r.data), log: true))
            var e: NfcJSONObject? = nil
            if !dol.isEmpty { e = parseLogRecord(r.data, dol) } else if !r.data.isEmpty { e = ["raw": .string(Hex.encode(r.data))] }
            if let e { out.append(e) }
        }
        return out
    }

    /* ------------------------------------------------------------ formatting */

    static func asciiOf(_ b: [UInt8]) -> String {
        JSText.trim(String(decoding: b.filter { $0 >= 0x20 && $0 < 0x7f }, as: UTF8.self))
    }

    static func formatValue(_ tag: String, _ value: [UInt8], _ format: EmvTags.Format) -> String {
        let h = Hex.encode(value)
        switch format {
        case .ans, .an: let a = asciiOf(value); return a.isEmpty ? h : a
        case .cn: return h.replacingRegex("F+$", with: "")
        case .n: return value.count <= 6 ? String(value.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }) : h
        case .date: return h.count >= 6 ? "20\(sub(h, 0, 2))-\(sub(h, 2, 4))-\(sub(h, 4, 6))" : h
        case .month: return h.count >= 4 ? "20\(sub(h, 0, 2))-\(sub(h, 2, 4))" : h
        case .country: return EmvTags.countryNum[pad4(h)] ?? h
        case .currency: return EmvTags.currencyNum[pad4(h)] ?? h
        case .b, .hex: return h
        }
    }

    /// PAN and expiry from Track 2 equivalent (tag 57): the digits before "D", then YYMM.
    static func fromTrack2(_ h: String) -> (pan: String?, expiry: String?) {
        let t2 = JSText.upperASCII(h).replacingRegex("F+$", with: "")
        guard let sep = t2.firstIndex(of: "D") else { return (nil, nil) }
        let pan = String(t2[..<sep])
        let after = String(t2[t2.index(after: sep)...])
        let expiry = after.count >= 4 ? "20\(sub(after, 0, 2))-\(sub(after, 2, 4))" : nil
        return (pan.fullMatch("\\d{8,19}") ? pan : nil, expiry)
    }

    static func maskPan(_ pan: String) -> String {
        if pan.count < 10 { return pan }
        return String(pan.prefix(6)) + String(repeating: bullet, count: pan.count - 10) + String(pan.suffix(4))
    }

    static func num(_ v: [UInt8]?) -> Int64? {
        guard let v, !v.isEmpty, v.count <= 4 else { return nil }
        return v.reduce(Int64(0)) { $0 << 8 | Int64($1) }
    }

    static func tagJson(_ tag: String, _ value: [UInt8]) -> NfcJSON {
        let info = EmvTags.info(tag)
        return ["tag": .string(tag), "name": .string(info.name), "value": .string(formatValue(tag, value, info.format)), "hex": .string(Hex.encode(value))]
    }

    /// What one application gave besides its records' tags (emv.ts AppExtras).
    final class Extras {
        var aip: [UInt8]?, afl: [UInt8]?, logFormat: [UInt8]?
        var logSfi: Int?
        var log: [NfcJSONObject]?
        var getData = TagMap()
        var records = [Rec]()
    }

    static func buildApp(_ aid: String, _ tagsIn: TagMap, _ label: String?, _ x: Extras) -> NfcJSONObject {
        var tags = tagsIn
        // GET DATA answers fill in what the records did not carry.
        for (k, v) in x.getData.entries { tags.putIfAbsent(k, v) }
        var app = NfcJSONObject()
        app["aid"] = .string(aid)
        app["tags"] = .array(tags.entries.map { tagJson($0.0, $0.1) })
        if let scheme = EmvTags.scheme(forAid: aid) { app["scheme"] = .string(scheme) }
        if let label { app["label"] = .string(label) } else if let lbl = tags["50"] ?? tags["9F12"] { app["label"] = .string(asciiOf(lbl)) }
        // PAN: tag 5A, else from Track 2.
        let t2 = tags["57"] ?? tags["9F6B"]
        let fromT2: (pan: String?, expiry: String?) = t2.map { fromTrack2(Hex.encode($0)) } ?? (nil, nil)
        let pan = tags["5A"].map { Hex.encode($0).replacingRegex("F+$", with: "") } ?? fromT2.pan
        if let pan, pan.fullMatch("\\d{8,19}") { app["pan"] = .string(pan); app["panMasked"] = .string(maskPan(pan)) }
        var expiry = tags["5F24"].map { formatValue("5F24", $0, .month) } ?? fromT2.expiry
        if let e = expiry, e.count > 7 { expiry = String(e.prefix(7)) }
        if let e = expiry, !e.isEmpty { app["expiry"] = .string(e) }
        if let name = tags["5F20"] {
            let n = JSText.trim(asciiOf(name).replacingRegex("\\s*/\\s*", with: " / "))
            if !n.isEmpty && n != "/" { app["cardholder"] = .string(n) }
        }
        if let eff = tags["5F25"] { let d = formatValue("5F25", eff, .date); app["effective"] = .string(d.count >= 7 ? String(d.prefix(7)) : d) }
        if let country = tags["5F28"] { app["issuerCountry"] = .string(formatValue("5F28", country, .country)) }
        if let seq = tags["5F34"] { app["panSequence"] = .string(num(seq).map { String($0) } ?? "") }
        if let atc = num(tags["9F36"]) { app["atc"] = .number(Double(atc)) }
        if let lastOnline = num(tags["9F13"]) { app["lastOnlineAtc"] = .number(Double(lastOnline)) }
        if let ptc = num(tags["9F17"]) { app["pinTryCounter"] = .number(Double(ptc)) }
        if let aip = x.aip, !aip.isEmpty { app["aip"] = .string(Hex.encode(aip)) }
        if let afl = x.afl, !afl.isEmpty { app["afl"] = .string(Hex.encode(afl)) }
        if !x.getData.isEmpty { app["getData"] = .array(x.getData.entries.map { tagJson($0.0, $0.1) }) }
        if let f = x.logFormat, !f.isEmpty { app["logFormat"] = .string(Hex.encode(f)) }
        if let sfi = x.logSfi { app["logSfi"] = NfcJSON(sfi) }
        if let log = x.log { app["log"] = .array(log.map { .object($0) }) }
        if !x.records.isEmpty {
            app["records"] = .array(x.records.map { r in
                var o: NfcJSONObject = ["sfi": NfcJSON(r.sfi), "record": NfcJSON(r.record), "hex": .string(r.hex)]
                if r.log { o["log"] = true }
                return .object(o)
            })
        }
        return app
    }

    /* ------------------------------------------------------------ public */

    /// Candidate AIDs from a directory, by priority (tag 87) where present.
    static func aidsFromPpse(_ nodes: [Tlv]) -> [String] {
        var found = [(aid: String, prio: Int, order: Int)]()
        for (i, a) in BerTlv.findAll(nodes, 0x61).enumerated() {
            guard let aid = BerTlv.find(a.children, 0x4f) else { continue }
            let prio = BerTlv.find(a.children, 0x87).map { $0.value.first.map(Int.init) ?? 0xff } ?? 0xff
            found.append((Hex.encode(aid.value), prio, i))
        }
        found.sort { $0.prio != $1.prio ? $0.prio < $1.prio : $0.order < $1.order }
        var out = [String]()
        for f in found where !out.contains(f.aid) { out.append(f.aid) }
        return out
    }

    struct Fci { var ok = false; var fci = [Tlv](); var label: String?; var pdol: [UInt8]? }

    /// SELECT an application by its AID; keeps its FCI (the label, the PDOL).
    static func selectAid(_ s: Sender, _ aidHex: String) async -> Fci {
        var out = Fci()
        guard let r = try? await s.send(Apdu.selectByAid(Hex.decode(aidHex))), Apdu.isOk(r.sw) else { return out }
        out.ok = true
        out.fci = BerTlv.decode(r.data, recurse: true)
        let label = BerTlv.find(out.fci, 0x50) ?? BerTlv.find(out.fci, 0x9f12)
        out.label = label.map { asciiOf($0.value) }
        out.pdol = BerTlv.find(out.fci, 0x9f38)?.value
        return out
    }

    struct Gpo { var ok = false; var aip: [UInt8]?; var afl: [UInt8]?; var extra = [Tlv]() }

    /// GET PROCESSING OPTIONS with the PDOL filled with a terminal's neutral defaults (no transaction) → AIP + AFL.
    static func gpo(_ s: Sender, _ pdol: [UInt8]?) async -> Gpo {
        var out = Gpo()
        let data = pdol.map { $0.isEmpty ? [] : fillDol($0) } ?? []
        // The command data is tag 83 holding the filled PDOL (empty when the card has none).
        let field = [0x83, UInt8(data.count & 0xff)] + data
        guard let r = try? await s.send(Apdu.build(0x80, 0xa8, 0x00, 0x00, data: field, le: 0x00)), Apdu.isOk(r.sw) else { return out }
        out.ok = true
        let nodes = BerTlv.decode(r.data, recurse: true)
        if let fmt1 = BerTlv.find(nodes, 0x80) {
            out.aip = Bytes.slice(fmt1.value, 0, 2); out.afl = Bytes.slice(fmt1.value, 2); out.extra = nodes
            return out
        }
        if let resp = BerTlv.find(nodes, 0x77) {
            out.aip = BerTlv.find(resp.children, 0x82)?.value
            out.afl = BerTlv.find(resp.children, 0x94)?.value
            out.extra = resp.children ?? []
            return out
        }
        out.extra = nodes
        return out
    }

    /// Reads an EMV card's applications and everything they show a terminal — the records, the counters and
    /// the transaction log — into the `emv` object of the contract (command.ts EmvData). Never throws: a card
    /// that stops answering ends the read with what was read.
    public static func read(_ t: any ApduChannel, _ options: Options = Options()) async -> NfcJSONObject {
        let s = Sender(t)
        let maxApps = max(1, min(16, options.maxApps))
        let deep = options.deep
        var ppseTree = ""
        var aids = [String]()
        if let dir = try? await selectPpse(s), dir.ok { ppseTree = dir.tree; aids = dir.aids }
        // 6.10: the preferred application goes first.
        if let pref = options.aid, !aids.isEmpty { aids.removeAll { $0 == pref }; aids.insert(pref, at: 0) }
        if aids.isEmpty {
            // No directory: try the well-known AIDs and keep the ones the card selects.
            if let pref = options.aid, await selectAid(s, pref).ok { aids.append(pref) }
            for c in EmvTags.candidateAids {
                if aids.count >= maxApps { break }
                if aids.contains(c.aid) { continue }
                if await selectAid(s, c.aid).ok { aids.append(c.aid) }
            }
        }
        var apps = [NfcJSON]()
        var budget = 240
        for aidHex in aids.prefix(maxApps) {
            let sel = await selectAid(s, aidHex)
            if !sel.ok { continue }
            let app = AppRead(aidHex, sel)
            // Before the transaction starts: the counters, and the log the card keeps.
            _ = await app.getData(s, getDataTags)
            if options.history { _ = await app.history(s, ask: false) }
            _ = await app.gpo(s)
            _ = await app.readAfl(s, light: !deep)
            if deep { _ = await app.scan(s, budget: &budget, sfiFrom: 1, sfiTo: 30, recFrom: 1, recTo: 16) }
            apps.append(.object(app.build()))
        }
        return emvData(aids, apps, ppseTree, deep, s.apdus)
    }

    /* ------------------------------------------------------------ the steps (6.10) */

    /// A payment directory — PPSE (contactless) or PSE (contact): the AIDs by priority, and its tree.
    struct Directory { var ok = false; var aids = [String](); var tree = "" }

    /// SELECT 2PAY.SYS.DDF01: the contactless directory and the applications it lists.
    static func selectPpse(_ s: Sender) async throws -> Directory {
        var d = Directory()
        let r = try await s.send(Apdu.selectByAid(ppse))
        if !Apdu.isOk(r.sw) { return d }
        d.ok = true
        let nodes = BerTlv.decode(r.data, recurse: true)
        d.tree = BerTlv.format(nodes)
        d.aids = aidsFromPpse(nodes)
        return d
    }

    /// SELECT 1PAY.SYS.DDF01: the contact directory — its FCI names a short file (88) whose records list
    /// the applications (61 → 4F), read until the card has no more.
    static func selectPse(_ s: Sender) async throws -> Directory {
        var d = Directory()
        let r = try await s.send(Apdu.selectByAid(pse))
        if !Apdu.isOk(r.sw) { return d }
        d.ok = true
        let fci = BerTlv.decode(r.data, recurse: true)
        var tree = BerTlv.format(fci)
        let sfi = BerTlv.find(fci, 0x88).flatMap { $0.value.first.map { Int($0) & 0x1f } } ?? 1
        var entries = [Tlv]()
        var rec = 1
        while rec <= 16 && sfi > 0 {
            defer { rec += 1 }
            guard let rr = try? await s.send(Apdu.readRecord(rec, sfi: sfi)) else { break }
            if !Apdu.isOk(rr.sw) || rr.data.isEmpty { break }
            let nodes = BerTlv.decode(rr.data, recurse: true)
            entries += nodes
            if !tree.isEmpty { tree += "\n" }
            tree += BerTlv.format(nodes)
        }
        d.tree = tree
        d.aids = aidsFromPpse(entries)
        return d
    }

    /// One application as it is read, step by step — what `read` does for each AID, and what a 6.10
    /// template's select-aid, get-data, read-log, gpo, read-afl and read-files steps do one at a time.
    final class AppRead {
        let aid: String
        let label: String?
        let pdol: [UInt8]?
        var tags = TagMap()
        let x = Extras()

        /// `sel` nil: steps that ran with no application selected.
        init(_ aid: String, _ sel: Fci?) {
            self.aid = aid
            self.label = sel?.label
            self.pdol = sel?.pdol
            if let sel { EmvReader.collectLeaves(sel.fci, into: &tags) }
        }

        /// GET DATA for each tag; missing tags are not errors. Returns how many answered.
        func getData(_ s: Sender, _ list: [String]) async -> Int {
            var n = 0
            for tag in list {
                let k = JSText.upperASCII(tag)
                if let v = await EmvReader.getData(s, k) { x.getData[k] = v; n += 1 }
            }
            return n
        }

        /// The log entry (9F4D: SFI, number of records) from the FCI or GET DATA.
        var logEntry: [UInt8]? { tags["9F4D"] ?? x.getData["9F4D"] }

        /// The transaction log: 9F4D (SFI, count) and 9F4F (the format) → READ RECORD of each entry, decoded
        /// by the format. `ask`: GET DATA them when nothing carried them. The entries read, or −1 with no log.
        func history(_ s: Sender, ask: Bool) async -> Int {
            var entry = logEntry
            if entry == nil && ask, let v = await EmvReader.getData(s, "9F4D") { x.getData["9F4D"] = v; entry = v }
            guard let e = entry, e.count >= 2 else { return -1 }
            var fmt = x.getData["9F4F"] ?? tags["9F4F"]
            if fmt == nil && ask, let v = await EmvReader.getData(s, "9F4F") { x.getData["9F4F"] = v; fmt = v }
            x.logSfi = Int(e[0])
            if let fmt { x.logFormat = fmt }
            var records = x.records
            let log = await EmvReader.readLog(s, sfi: Int(e[0]), count: Int(e[1]), dol: fmt.map(EmvReader.parseDol) ?? [], records: &records)
            x.records = records
            x.log = log
            return log.count
        }

        /// GET PROCESSING OPTIONS (no transaction) → the AIP, the AFL, and what else the answer carries.
        func gpo(_ s: Sender) async -> Bool {
            let g = await EmvReader.gpo(s, pdol)
            EmvReader.collectLeaves(g.extra, into: &tags)
            x.aip = g.aip; x.afl = g.afl
            return g.ok
        }

        var hasAfl: Bool { !(x.afl ?? []).isEmpty }

        /// READ RECORD of every record the AFL lists; with no AFL, `light` scans the first files. Returns the records read.
        func readAfl(_ s: Sender, light: Bool) async -> Int {
            let before = x.records.count
            var records = x.records
            if hasAfl { await EmvReader.readRecords(s, EmvReader.parseAfl(x.afl!), into: &tags, records: &records) }
            else if light { await EmvReader.readRecords(s, (1...4).map { Afl(sfi: $0, first: 1, last: 8) }, into: &tags, records: &records) }
            x.records = records
            return x.records.count - before
        }

        /// The deep scan over short files and records beyond the AFL (the log's own file skipped). Returns the records read.
        func scan(_ s: Sender, budget: inout Int, sfiFrom: Int, sfiTo: Int, recFrom: Int, recTo: Int) async -> Int {
            let before = x.records.count
            var records = x.records
            await EmvReader.scanFiles(s, into: &tags, records: &records, skipSfi: x.logSfi, budget: &budget, sfiFrom: sfiFrom, sfiTo: sfiTo, recFrom: recFrom, recTo: recTo)
            x.records = records
            return x.records.count - before
        }

        /// Whether any step gave this application something.
        var empty: Bool { tags.isEmpty && x.getData.isEmpty && x.records.isEmpty && x.aip == nil && x.log == nil }

        func build() -> NfcJSONObject {
            // A stable sort by SFI, then record.
            x.records = x.records.enumerated().sorted { a, b in
                a.element.sfi != b.element.sfi ? a.element.sfi < b.element.sfi : a.element.record != b.element.record ? a.element.record < b.element.record : a.offset < b.offset
            }.map(\.element)
            return EmvReader.buildApp(aid, tags, label, x)
        }
    }

    /// The `emv` object of the contract from what a read gathered.
    static func emvData(_ aids: [String], _ apps: [NfcJSON], _ tree: String, _ deep: Bool, _ apdus: Int) -> NfcJSONObject {
        var emv = NfcJSONObject()
        let scheme = apps.first?.objectValue?.string("scheme") ?? aids.first.flatMap { EmvTags.scheme(forAid: $0) }
        if let scheme { emv["scheme"] = .string(scheme) }
        emv["aids"] = NfcJSON(aids)
        emv["apps"] = .array(apps)
        if !tree.isEmpty { emv["tree"] = .string(tree) }
        emv["deep"] = .bool(deep)
        emv["apdus"] = NfcJSON(apdus)
        return emv
    }

    /// A one-line summary for a log / flash (emv.ts emvSummary).
    public static func summary(_ d: NfcJSONObject) -> String {
        let apps = d.optArray("apps") ?? []
        if apps.isEmpty {
            let n = d.arrayCount("aids")
            return n > 0 ? NfcTexts.n("nfc.emv.sum.noRecords", n, "EMV: {n} application(s), no records read") : NfcTexts.t("nfc.emv.sum.none", "No EMV application found")
        }
        let a = apps[0].objectValue ?? NfcJSONObject()
        let history = apps.reduce(0) { $0 + ($1.objectValue?.arrayCount("log") ?? 0) }
        var bits = [String]()
        let head = a.optString("scheme", a.optString("label", ""))
        if !head.isEmpty { bits.append(head) }
        if !a.optString("panMasked").isEmpty { bits.append(a.optString("panMasked")) }
        if !a.optString("expiry").isEmpty { bits.append(a.optString("expiry")) }
        if history > 0 { bits.append(NfcTexts.n("nfc.emv.sum.transactions", history, history > 1 ? "{n} transactions" : "{n} transaction")) }
        if bits.isEmpty { return NfcTexts.n("nfc.emv.sum.apps", apps.count, "EMV: {n} application(s)") }
        return bits.joined(separator: " · ")
    }
}
