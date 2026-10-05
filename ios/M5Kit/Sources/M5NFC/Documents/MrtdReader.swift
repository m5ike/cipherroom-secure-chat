// MRTD reader (6.5, deep read 6.6) — e-passport / e-ID, ICAO 9303 —
// A/nfc/MrtdReader.java (mrtd.ts). Opens the holder's own document with the key
// they supply — PACE with the CAN printed on it (or the MRZ) where the chip
// offers a variant this reader runs, else BAC with the MRZ: the document's own
// access control — then reads over secure messaging everything a border reader
// may read: EF.COM, EF.SOD, DG1 (the MRZ), DG2 (the faces), DG5 / DG7 (portrait,
// signature), DG11 / DG12, DG13, DG14, DG15, DG16. DG3 / DG4 (fingerprints, iris)
// need Extended Access Control and are never selected. Read-only. Each group
// read is checked against its hash in EF.SOD (passive authentication of what
// was read; the signer is not checked against a CSCA list). Pictures come out as
// their bytes (JPEG, JPEG 2000, PNG) — decoding them is the app's.
//
// The result is the `mrtd` object of the NfcResult contract (command.ts MrtdData).

import Foundation

public enum MrtdReader {
    public static let aid: [UInt8] = [0xa0, 0x00, 0x00, 0x02, 0x47, 0x10, 0x01]
    static let efCardAccess = 0x011c, efCom = 0x011e, efSod = 0x011d

    static func dgFid(_ n: Int) -> Int { 0x0100 + n }

    /// EF.COM tag-list byte → data group.
    static let dgTag: [Int: Int] = {
        let tags = [0x61, 0x75, 0x63, 0x76, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70]
        var m = [Int: Int]()
        for (i, t) in tags.enumerated() { m[t] = i + 1 }
        return m
    }()
    /// How much of each group to read at most (the face can be large; the rest is small).
    static let cap: [Int: Int] = [1: 512, 2: 98_304, 5: 98_304, 7: 65_536, 11: 65_536, 12: 131_072, 13: 32_768, 14: 8192, 15: 4096, 16: 16_384]
    /// Groups that hold only pictures.
    static let imageGroups: Set<Int> = [2, 5, 7]
    /// Fingerprints and iris: Extended Access Control (a terminal certificate), not readable here.
    static let eacGroups: Set<Int> = [3, 4]

    /// How the holder opens their document, and what to read (command.ts MrtdAccessArgs).
    public struct Options: Sendable, Hashable {
        /// The whole MRZ (2 or 3 lines) — the BAC key is derived from it.
        public var mrz: String?
        /// Or just the three fields the BAC key needs.
        public var key: MrzKey?
        /// A 6-digit Card Access Number (PACE).
        public var can: String?
        /// Read the images (DG2, DG5, DG7, scans in DG11 / DG12) — default true.
        public var readPhoto = true
        /// Read every group the document lists, not only DG1 / DG2 — default true.
        public var all = true
        /// iOS: select the master file (3F00) when EF.CardAccess is not found where the session left the
        /// chip — a CoreNFC session has already selected one of its listed AIDs. Default false (Android's order).
        public var selectMasterFileForCardAccess = false

        public init(mrz: String? = nil, key: MrzKey? = nil, can: String? = nil, readPhoto: Bool = true, all: Bool = true, selectMasterFileForCardAccess: Bool = false) {
            self.mrz = mrz; self.key = key; self.can = can; self.readPhoto = readPhoto; self.all = all
            self.selectMasterFileForCardAccess = selectMasterFileForCardAccess
        }

        /// From an op's `args`: mrz, documentNumber + dateOfBirth + dateOfExpiry, can, readPhoto, all (snake_case too).
        public static func from(args: NfcJSONObject?) -> Options {
            var o = Options()
            guard let args else { return o }
            func str(_ camel: String, _ snake: String) -> String? { (args.has(camel) ? args[camel] : args[snake])?.stringValue }
            if let mrz = str("mrz", "mrz") { o.mrz = mrz }
            if let dn = str("documentNumber", "document_number"), let dob = str("dateOfBirth", "date_of_birth"), let exp = str("dateOfExpiry", "date_of_expiry") {
                o.key = MrzKey(dn, dob, exp)
            }
            if let can = str("can", "can") { o.can = can }
            let rp = args.has("readPhoto") ? args["readPhoto"] : args["read_photo"]
            if rp?.boolValue == false { o.readPhoto = false }
            if args["all"]?.boolValue == false { o.all = false }
            return o
        }
    }

    /// One command to the chip, plain or over secure messaging.
    typealias Send = ([UInt8]) async throws -> SmReply

    /// 6282: end of file before Le — the bytes that came are good.
    static func readable(_ sw: Int) -> Bool { Apdu.isOk(sw) || sw == 0x6282 }

    /* ------------------------------------------------------------ BAC */

    static func doBac(_ t: any ApduChannel, _ key: MrzKey) async throws -> SecureMessagingChannel {
        let k = Bac.keys(key)
        let chal = Apdu.split(try await t.transmit(Apdu.build(0x00, 0x84, 0x00, 0x00, le: 8))) // GET CHALLENGE
        guard Apdu.isOk(chal.sw), chal.data.count >= 8 else { throw NfcError.io("the document did not answer GET CHALLENGE") }
        let rndIcc = Array(chal.data[0..<8])
        let rndIfd = NfcCrypto.random(8), kifd = NfcCrypto.random(16)
        let cmdData = try Bac.mutualAuthCommand(kenc: k.kenc, kmac: k.kmac, rndIfd: rndIfd, rndIcc: rndIcc, kifd: kifd)
        let auth = Apdu.split(try await t.transmit(Apdu.build(0x00, 0x82, 0x00, 0x00, data: cmdData, le: 0x28))) // EXTERNAL AUTHENTICATE
        guard Apdu.isOk(auth.sw) else { throw NfcError(.authFailed, "BAC failed — check the document number, date of birth and expiry") }
        return BacChannel(t, try Bac.session(kenc: k.kenc, kmac: k.kmac, rndIfd: rndIfd, rndIcc: rndIcc, kifd: kifd, response: auth.data))
    }

    /* ------------------------------------------------------------ reading files */

    /// A file read: its bytes (complete or capped) — or the status word that refused it.
    struct FileRead { let bytes: [UInt8]?; let complete: Bool; let sw: Int
        static func of(_ b: [UInt8], _ complete: Bool) -> FileRead { FileRead(bytes: b, complete: complete, sw: 0x9000) }
        static func refused(_ sw: Int) -> FileRead { FileRead(bytes: nil, complete: false, sw: sw) }
    }

    /// The length of a BER-TLV object from its first bytes: (headerLength, total), or nil.
    static func derLength(_ head: [UInt8]) -> (Int, Int)? {
        guard head.count >= 2 else { return nil }
        var i = 1
        if head[0] & 0x1f == 0x1f { while i < head.count && head[i] & 0x80 != 0 { i += 1 }; i += 1 }
        guard i < head.count else { return nil }
        var len = UInt64(head[i]); i += 1
        if len & 0x80 != 0 {
            let n = len & 0x7f
            len = 0
            var j: UInt64 = 0
            while j < n && i < head.count { len = (len &<< 8) | UInt64(head[i]); i += 1; j += 1 }
        }
        // Capped (Int is 32 bits on Apple Watch); every read is capped far below anyway.
        return (i, i + Int(min(len, UInt64(Int32.max / 2))))
    }

    /// READ BINARY beyond 32 KB: INS B1 with the offset in DO 54, the data in DO 53.
    static func readBinaryAt(_ send: Send, _ offset: Int, _ le: Int) async throws -> SmReply {
        if offset < 0x8000 { return try await send(Apdu.readBinary(offset, le: le)) }
        let off = Bytes.u8(0x54, 0x03, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff)
        let r = try await send(Apdu.build(0x00, 0xb1, 0x00, 0x00, data: off, le: le))
        let do53 = r.data.isEmpty ? nil : BerTlv.find(BerTlv.decode(r.data, recurse: false), 0x53)
        return SmReply(data: do53?.value ?? r.data, sw: r.sw)
    }

    /// Selects an EF (by file id) and reads all of it, up to `cap` bytes.
    static func readFile(_ send: Send, _ fid: Int, _ cap: Int) async throws -> FileRead {
        let sel = try await send(Apdu.build(0x00, 0xa4, 0x02, 0x0c, data: Bytes.u8((fid >> 8) & 0xff, fid & 0xff)))
        if !Apdu.isOk(sel.sw) { return .refused(sel.sw) }
        let head = try await send(Apdu.readBinary(0, le: 8))
        if !readable(head.sw) || head.data.isEmpty { return .refused(head.sw != 0 ? head.sw : 0x6f00) }
        let want = derLength(head.data)?.1 ?? head.data.count
        let total = min(want, cap)
        var out = Bytes.slice(head.data, 0, min(head.data.count, total))
        var offset = out.count, guardCount = 0
        while offset < total && guardCount < 1024 {
            guardCount += 1
            let r = try await readBinaryAt(send, offset, min(0xe0, total - offset))
            if !readable(r.sw) || r.data.isEmpty { break }
            out += r.data
            offset += r.data.count
        }
        return .of(out, out.count >= want)
    }

    static func statusOf(_ sw: Int) -> String {
        if sw == 0x6a82 || sw == 0x6a83 { return "absent" }
        if sw == 0x6982 || sw == 0x6985 || sw == 0x6986 { return "protected" }
        return "error"
    }

    /* ------------------------------------------------------------ parsing */

    static func datesFromYYMMDD(_ s: String, future: Bool) -> String {
        guard s.fullMatch("\\d{6}") else { return s }
        let yy = Int(Bac.sub(s, 0, 2))!
        let nowYY = Calendar(identifier: .gregorian).component(.year, from: Date()) % 100
        let century = future ? (yy < nowYY + 20 ? 2000 : 1900) : (yy <= nowYY ? 2000 : 1900)
        return "\(century + yy)-\(Bac.sub(s, 2, 4))-\(Bac.sub(s, 4, 6))"
    }

    static func putNames(_ out: inout NfcJSONObject, _ field: String) {
        let parts = field.components(separatedBy: "<<")
        let surname = parts.first ?? "", given = parts.count > 1 ? parts[1] : ""
        out["surname"] = .string(JSText.trim(surname.replacingOccurrences(of: "<", with: " ")))
        out["givenNames"] = .string(JSText.trim(given.replacingOccurrences(of: "<", with: " ")))
    }

    static func noFill(_ s: String) -> String { s.replacingOccurrences(of: "<", with: "") }

    /// Parses a TD1 / TD2 / TD3 MRZ into fields (mrtd.ts parseMrz).
    public static func parseMrz(_ mrz: String) -> NfcJSONObject {
        let raw = JSText.upperASCII(mrz.replacingRegex("[^A-Za-z0-9<\\n]", with: ""))
        var out: NfcJSONObject = ["mrz": .string(raw)]
        let flat = raw.replacingOccurrences(of: "\n", with: "")
        let s = Bac.sub
        if raw.count == 88 || flat.count == 88 { // TD3 (passport): 2 × 44
            let l1 = s(flat, 0, 44), l2 = s(flat, 44, 88)
            out["documentCode"] = .string(noFill(s(l1, 0, 2)))
            out["issuer"] = .string(noFill(s(l1, 2, 5)))
            putNames(&out, s(l1, 5, 44))
            out["documentNumber"] = .string(noFill(s(l2, 0, 9)))
            out["nationality"] = .string(noFill(s(l2, 10, 13)))
            out["dateOfBirth"] = .string(datesFromYYMMDD(s(l2, 13, 19), future: false))
            out["sex"] = .string(noFill(s(l2, 20, 21)))
            out["dateOfExpiry"] = .string(datesFromYYMMDD(s(l2, 21, 27), future: true))
            out["optionalData"] = .string(noFill(s(l2, 28, 42).replacingRegex("<+$", with: "")))
            return out
        }
        if flat.count == 90 { // TD1 (ID card): 3 × 30
            let l1 = s(flat, 0, 30), l2 = s(flat, 30, 60), l3 = s(flat, 60, 90)
            out["documentCode"] = .string(noFill(s(l1, 0, 2)))
            out["issuer"] = .string(noFill(s(l1, 2, 5)))
            out["documentNumber"] = .string(noFill(s(l1, 5, 14)))
            out["optionalData"] = .string(noFill(s(l1, 15, 30).replacingRegex("<+$", with: "")))
            out["dateOfBirth"] = .string(datesFromYYMMDD(s(l2, 0, 6), future: false))
            out["sex"] = .string(noFill(s(l2, 7, 8)))
            out["dateOfExpiry"] = .string(datesFromYYMMDD(s(l2, 8, 14), future: true))
            out["nationality"] = .string(noFill(s(l2, 15, 18)))
            putNames(&out, l3)
            return out
        }
        if flat.count == 72 { // TD2 (ID card): 2 × 36
            let l1 = s(flat, 0, 36), l2 = s(flat, 36, 72)
            out["documentCode"] = .string(noFill(s(l1, 0, 2)))
            out["issuer"] = .string(noFill(s(l1, 2, 5)))
            putNames(&out, s(l1, 5, 36))
            out["documentNumber"] = .string(noFill(s(l2, 0, 9)))
            out["nationality"] = .string(noFill(s(l2, 10, 13)))
            out["dateOfBirth"] = .string(datesFromYYMMDD(s(l2, 13, 19), future: false))
            out["sex"] = .string(noFill(s(l2, 20, 21)))
            out["dateOfExpiry"] = .string(datesFromYYMMDD(s(l2, 21, 27), future: true))
            return out
        }
        return out
    }

    /// DG1 → the MRZ fields.
    public static func mrzFromDg1(_ dg1: [UInt8]) -> NfcJSONObject? {
        let tlv = BerTlv.decode(dg1, recurse: true)
        guard let mrz = BerTlv.find(tlv, 0x5f1f) ?? BerTlv.find(BerTlv.find(tlv, 0x61)?.children, 0x5f1f) else { return nil }
        return parseMrz(Bytes.latin1String(mrz.value))
    }

    /// EF.COM, parsed: the data groups its tag list (5C) names, and the LDS / Unicode versions.
    public struct Com: Sendable { public var groups = [Int](); public var lds: String?; public var unicode: String? }

    public static func parseCom(_ com: [UInt8]) -> Com {
        var out = Com()
        let tlv = BerTlv.decode(com, recurse: true)
        if let list = BerTlv.find(tlv, 0x5c) { for b in list.value { if let g = dgTag[Int(b)] { out.groups.append(g) } } }
        if let lds = BerTlv.find(tlv, 0x5f01), !lds.value.isEmpty {
            let s = Bytes.latin1String(lds.value)
            out.lds = s.count == 4 && s.fullMatch("\\d{4}") ? "\(Int(Bac.sub(s, 0, 2))!).\(Int(Bac.sub(s, 2, 4))!)" : s
        }
        if let uni = BerTlv.find(tlv, 0x5f36), !uni.value.isEmpty {
            let s = Bytes.latin1String(uni.value)
            out.unicode = s.count == 6 && s.fullMatch("\\d{6}") ? "\(Int(Bac.sub(s, 0, 2))!).\(Int(Bac.sub(s, 2, 4))!).\(Int(Bac.sub(s, 4, 6))!)" : s
        }
        return out
    }

    /// The data groups EF.COM lists ("DG1", "DG2", …).
    public static func dataGroups(fromCom com: [UInt8]) -> [String] { parseCom(com).groups.map { "DG\($0)" } }

    /// An image (face, portrait, signature, document scan): its MIME type and bytes.
    public struct Image: Sendable, Hashable { public let mime: String; public let data: [UInt8] }

    /// An image found by its signature inside a data object (JPEG, JPEG 2000, PNG).
    public static func image(in b: [UInt8]) -> Image? {
        var i = 0
        while i + 5 < b.count {
            let (b0, b1, b2, b3, b4, b5) = (b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4], b[i + 5])
            if b0 == 0xff && b1 == 0xd8 && b2 == 0xff { return Image(mime: "image/jpeg", data: Array(b[i...])) }
            if b0 == 0x00 && b1 == 0x00 && b2 == 0x00 && b3 == 0x0c && b4 == 0x6a && b5 == 0x50 { return Image(mime: "image/jp2", data: Array(b[i...])) }
            if b0 == 0xff && b1 == 0x4f && b2 == 0xff && b3 == 0x51 { return Image(mime: "image/jp2", data: Array(b[i...])) } // JPEG 2000 codestream
            if b0 == 0x89 && b1 == 0x50 && b2 == 0x4e && b3 == 0x47 { return Image(mime: "image/png", data: Array(b[i...])) }
            i += 1
        }
        return nil
    }

    /// Every face in DG2 (each biometric data block, 5F2E / 7F2E).
    public static func faces(fromDg2 dg2: [UInt8]) -> [Image] {
        let nodes = BerTlv.decode(dg2, recurse: true)
        let blocks = BerTlv.findAll(nodes, 0x5f2e) + BerTlv.findAll(nodes, 0x7f2e)
        var out = blocks.compactMap { image(in: $0.value) }
        if out.isEmpty, let one = image(in: dg2) { out.append(one) }
        return out
    }

    /// The face of DG2 by its signature (JPEG, JPEG 2000 or PNG).
    public static func face(fromDg2 dg2: [UInt8]) -> Image? { faces(fromDg2: dg2).first ?? image(in: dg2) }

    static func mrzText(_ s: String) -> String {
        JSText.trim(s.replacingRegex("<<+", with: ", ").replacingOccurrences(of: "<", with: " ").replacingRegex("\\s+", with: " "))
    }

    /// A date that may be BCD (YYYYMMDD in 4 bytes) or ASCII digits.
    static func dateField(_ v: [UInt8]) -> String {
        let s = v.count == 4 || v.count == 7 ? Hex.encode(v) : JSText.trim(Asn1.text(v))
        let sub = Bac.sub
        if s.fullMatch("\\d{14}") { return "\(sub(s, 0, 4))-\(sub(s, 4, 6))-\(sub(s, 6, 8)) \(sub(s, 8, 10)):\(sub(s, 10, 12)):\(sub(s, 12, 14))" }
        if s.fullMatch("\\d{8}") { return "\(sub(s, 0, 4))-\(sub(s, 4, 6))-\(sub(s, 6, 8))" }
        return s
    }

    static func extOf(_ mime: String) -> String {
        switch mime { case "image/jpeg": return "jpg"; case "image/jp2": return "jp2"; case "image/png": return "png"; default: return "bin" }
    }

    static func b64(_ b: [UInt8]) -> String { Data(b).base64EncodedString() }

    /// The images found while parsing (command.ts MrtdImage).
    struct Found {
        var images = [NfcJSONObject]()
        func count(_ kind: String) -> Int { images.filter { $0.optString("kind") == kind }.count }

        mutating func push(_ group: Int, _ kind: String, _ bytes: [UInt8], _ label: String) {
            guard let img = MrtdReader.image(in: bytes) else { return }
            let n = count(kind)
            images.append(["group": .string("DG\(group)"), "kind": .string(kind), "mime": .string(img.mime), "data": .string(MrtdReader.b64(img.data)),
                           "name": .string(label + (n > 0 ? "-\(n + 1)" : "") + "." + MrtdReader.extOf(img.mime))])
        }
    }

    static func val(_ t: [Tlv]?, _ tag: Int) -> [UInt8]? { BerTlv.find(t, tag)?.value }
    static func txt(_ t: [Tlv]?, _ tag: Int) -> String? { val(t, tag).flatMap { $0.isEmpty ? nil : JSText.trim(Asn1.text($0)) } }

    static func texts(_ t: [Tlv], _ tag: Int) -> [String] {
        BerTlv.findAll(t, tag).map { mrzText(JSText.trim(Asn1.text($0.value))) }.filter { !$0.isEmpty }
    }

    /// DG11: additional personal details (command.ts MrtdPersonal).
    public static func parseDg11(_ dg: [UInt8]) -> NfcJSONObject { var f: Found? = nil; return parseDg11(dg, &f) }

    static func parseDg11(_ dg: [UInt8], _ found: inout Found?) -> NfcJSONObject {
        let t = BerTlv.decode(dg, recurse: true)
        var out = NfcJSONObject()
        func putIf(_ k: String, _ v: String?) { if let v, !v.isEmpty { out[k] = .string(v) } }
        if let full = txt(t, 0x5f0e) { putIf("fullName", mrzText(full)) }
        let others = texts(t, 0x5f0f); if !others.isEmpty { out["otherNames"] = NfcJSON(others) }
        if let pn = txt(t, 0x5f10) { putIf("personalNumber", pn.replacingOccurrences(of: "<", with: "")) }
        if let dob = val(t, 0x5f2b), !dob.isEmpty { putIf("fullDateOfBirth", dateField(dob)) }
        if let pob = txt(t, 0x5f11) { putIf("placeOfBirth", mrzText(pob)) }
        if let addr = txt(t, 0x5f42) { putIf("address", mrzText(addr)) }
        putIf("telephone", txt(t, 0x5f12))
        if let prof = txt(t, 0x5f13) { putIf("profession", mrzText(prof)) }
        if let title = txt(t, 0x5f14) { putIf("title", mrzText(title)) }
        if let sum = txt(t, 0x5f15) { putIf("personalSummary", mrzText(sum)) }
        if let td = txt(t, 0x5f17) {
            let docs = td.components(separatedBy: "<").filter { !$0.isEmpty }
            if !docs.isEmpty { out["otherTravelDocuments"] = NfcJSON(docs) }
        }
        if let cust = txt(t, 0x5f18) { putIf("custody", mrzText(cust)) }
        if let proof = val(t, 0x5f16), found != nil { found!.push(11, "document", proof, "proof-of-citizenship") }
        return out
    }

    /// DG12: additional document details (command.ts MrtdDocument).
    public static func parseDg12(_ dg: [UInt8]) -> NfcJSONObject { var f: Found? = nil; return parseDg12(dg, &f) }

    static func parseDg12(_ dg: [UInt8], _ found: inout Found?) -> NfcJSONObject {
        let t = BerTlv.decode(dg, recurse: true)
        var out = NfcJSONObject()
        func putIf(_ k: String, _ v: String?) { if let v, !v.isEmpty { out[k] = .string(v) } }
        if let auth = txt(t, 0x5f19) { putIf("issuingAuthority", mrzText(auth)) }
        if let doi = val(t, 0x5f26), !doi.isEmpty { putIf("dateOfIssue", dateField(doi)) }
        let persons = texts(t, 0x5f1a); if !persons.isEmpty { out["otherPersons"] = NfcJSON(persons) }
        putIf("endorsements", txt(t, 0x5f1b))
        putIf("taxExit", txt(t, 0x5f1c))
        if let pt = val(t, 0x5f55), !pt.isEmpty { putIf("personalizationTime", dateField(pt)) }
        putIf("personalizationDevice", txt(t, 0x5f56))
        if found != nil {
            if let front = val(t, 0x5f1d) { found!.push(12, "document", front, "document-front") }
            if let rear = val(t, 0x5f1e) { found!.push(12, "document", rear, "document-rear") }
        }
        return out
    }

    /// DG16: persons to notify ("name · telephone · address").
    public static func parseDg16(_ dg: [UInt8]) -> [String] {
        let t = BerTlv.decode(dg, recurse: true)
        let people = BerTlv.findAll(t, 0xa1) + BerTlv.findAll(t, 0xa2) + BerTlv.findAll(t, 0xa3)
        var out = [String]()
        for p in people {
            var bits = [String]()
            if let name = txt(p.children, 0x5f51), !mrzText(name).isEmpty { bits.append(mrzText(name)) }
            if let tel = txt(p.children, 0x5f52) { bits.append(tel) }
            if let addr = txt(p.children, 0x5f53), !mrzText(addr).isEmpty { bits.append(mrzText(addr)) }
            if !bits.isEmpty { out.append(bits.joined(separator: " · ")) }
        }
        return out
    }

    /// DG13 (optional, country-defined): readable text when it is text, else hex.
    static func optionalText(_ dg: [UInt8]) -> String {
        let t = BerTlv.decode(dg, recurse: false)
        let body = t.first?.value ?? dg
        let printable = body.filter { $0 >= 0x20 && $0 < 0x7f }.count
        let s = Double(printable) > Double(body.count) * 0.85 ? JSText.trim(Asn1.text(body)) : Hex.encode(body)
        return JSText.length(s) > 4000 ? JSText.prefix(s, 4000) : s
    }

    /// The body of a data group (the value inside its outer tag).
    static func body(_ dg: [UInt8]) -> [UInt8] { BerTlv.decode(dg, recurse: false).first?.value ?? dg }

    /// DG15: the Active Authentication public key — its algorithm and size ("RSA 1024", "EC brainpoolP256r1 (256 bit)").
    public static func aaKeyText(_ dg: [UInt8]) -> String {
        let t = Asn1.der(dg)
        let top = Asn1.at(t, 0)
        let spki = top != nil && top!.tag != Asn1.SEQ ? Asn1.at(Asn1.kids(top), 0) : top
        let sk = Asn1.kids(spki)
        let alg = Asn1.at(sk, 0), key = Asn1.at(sk, 1)
        let ak = Asn1.kids(alg)
        guard let algOid = Asn1.at(ak, 0), algOid.tag == Asn1.OID else { return "" }
        let params = Asn1.at(ak, 1)
        let name = Asn1.oidName(Asn1.oidText(algOid.value))
        if name == "RSA", let key, key.tag == Asn1.BITS {
            // BIT STRING { RSAPublicKey { modulus, exponent } }
            if let mod = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(key), 0)), 0) {
                var len = mod.value.count
                if len > 0 && mod.value[0] == 0 { len -= 1 }
                return "RSA \(len * 8)"
            }
            return "RSA"
        }
        if name == "EC" {
            let curve = params.flatMap { $0.tag == Asn1.OID ? Asn1.oidName(Asn1.oidText($0.value)) : nil } ?? "explicit parameters"
            let bits = key.flatMap { $0.tag == Asn1.BITS ? Int((Double($0.value.count - 2) / 2.0 * 8).rounded()) : nil } ?? 0
            return "EC \(curve)" + (bits != 0 ? " (\(bits) bit)" : "")
        }
        return name
    }

    /// EF.SOD, parsed: the hash algorithm, each group's hash, the document signer and its certificate.
    public struct Sod: Sendable {
        public var hashAlgorithm: String?
        public var hashes = [Int: [UInt8]]()
        public var signer: NfcJSONObject?
        public var certificate: [UInt8]?
    }

    static func derLen(_ n: Int) -> [UInt8] {
        if n < 0x80 { return Bytes.u8(n) }
        if n < 0x100 { return Bytes.u8(0x81, n) }
        if n < 0x10000 { return Bytes.u8(0x82, n >> 8, n) }
        return Bytes.u8(0x83, n >> 16, n >> 8, n)
    }

    public static func parseSod(_ sod: [UInt8]) -> Sod {
        var out = Sod()
        let top = Asn1.der(sod)
        let t0 = Asn1.at(top, 0)
        let ci = t0 != nil && t0!.tag == 0x77 ? Asn1.at(Asn1.kids(t0), 0) : t0 // ContentInfo
        let signedData = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(ci), 1)), 0)
        let sd = Asn1.kids(signedData)
        let encap = sd.dropFirst(2).first { $0.tag == Asn1.SEQ }
        let eContent = Asn1.at(Asn1.kids(Asn1.at(Asn1.kids(encap), 1)), 0)
        if let eContent, eContent.tag == Asn1.OCTETS {
            let lds = Asn1.kids(Asn1.at(Asn1.der(eContent.value), 0))
            let seqs = lds.filter { $0.tag == Asn1.SEQ }
            if let algOid = Asn1.at(Asn1.kids(Asn1.at(seqs, 0)), 0), algOid.tag == Asn1.OID { out.hashAlgorithm = Asn1.oidName(Asn1.oidText(algOid.value)) }
            for item in Asn1.kids(Asn1.at(seqs, 1)) {
                let k = Asn1.kids(item)
                if let num = Asn1.at(k, 0), let value = Asn1.at(k, 1), let last = num.value.last { out.hashes[Int(last)] = value.value }
            }
        }
        guard let cert = Asn1.at(Asn1.kids(sd.first { $0.tag == 0xa0 }), 0) else { return out }
        out.signer = Asn1.certInfo(cert)
        // The certificate's own bytes (header + value), for the download.
        out.certificate = [0x30] + derLen(cert.value.count) + cert.value
        return out
    }

    static func rawFile(_ name: String, _ bytes: [UInt8], _ mime: String = "application/octet-stream") -> NfcJSON {
        ["name": .string(name), "mime": .string(mime), "data": .string(b64(bytes))]
    }

    static func fileInfo(_ name: String, _ fid: Int, _ status: String) -> NfcJSONObject {
        ["name": .string(name), "fid": .string(String(format: "%04X", fid & 0xffff)), "status": .string(status)]
    }

    /* ------------------------------------------------------------ public */

    /// Reads an MRTD (passport / e-ID) into the `mrtd` object (command.ts MrtdData). The holder supplies the
    /// MRZ (or its three fields) or the CAN. PACE is used when the chip offers a variant this reader runs,
    /// BAC otherwise. Never throws: what could not be read says why.
    public static func read(_ t: any ApduChannel, _ opts: Options = Options()) async -> NfcJSONObject {
        var out: NfcJSONObject = ["present": true, "access": "none"]
        var files = [NfcJSON]()
        var rawFiles = [NfcJSON]()
        var found: Found? = Found()
        var protocols = [String]()
        var security = NfcJSONObject()
        let plainSend: Send = { cmd in let r = Apdu.split(try await t.transmit(cmd)); return SmReply(data: r.data, sw: r.sw) }

        // EF.CardAccess sits in the master file, readable without a key: it says whether the chip runs PACE.
        var paceInfos = [Pace.Info]()
        do {
            var ca = try await readFile(plainSend, efCardAccess, 2048)
            if ca.bytes == nil && opts.selectMasterFileForCardAccess && ca.sw == 0x6a82 {
                _ = try? await plainSend(Apdu.build(0x00, 0xa4, 0x00, 0x0c, data: [0x3f, 0x00]))
                ca = try await readFile(plainSend, efCardAccess, 2048)
            }
            if let bytes = ca.bytes {
                let sec = Pace.parseSecurityInfos(bytes)
                paceInfos = sec.pace
                protocols += sec.protocols
                files.append(.object(fileInfo("CardAccess", efCardAccess, "read").with("size", NfcJSON(bytes.count))))
                rawFiles.append(rawFile("EF.CardAccess.bin", bytes))
            }
        } catch { /* an older chip: no EF.CardAccess */ }
        let pace = Pace.choose(paceInfos)
        var paceJson = NfcJSONObject()
        if !paceInfos.isEmpty {
            let shown = pace ?? paceInfos[0]
            paceJson["supported"] = true
            paceJson["protocol"] = .string(shown.name)
            if let p = shown.parameterId { paceJson["parameterId"] = NfcJSON(p) }
        } else { paceJson["supported"] = false }
        out["pace"] = .object(paceJson)

        let key = opts.key ?? opts.mrz.flatMap { Bac.mrzKey(fromMrz: $0) }
        let canTrim = opts.can.map(JSText.trim)
        let can = canTrim.flatMap { $0.fullMatch("\\d{6}") ? $0 : nil }
        if key == nil && can == nil {
            if !protocols.isEmpty { out["security"] = ["protocols": NfcJSON(protocols)] }
            out["files"] = .array(files)
            out["message"] = .string(NfcTexts.t("nfc.eid.needKey", "Give the MRZ (document number, date of birth, expiry) or the CAN printed on the document to open the chip."))
            return out
        }

        // Open the document: PACE when the chip offers a variant this reader runs, else BAC.
        var ch: SecureMessagingChannel? = nil
        var failures = [String]()
        if let pace {
            do {
                let session = try await Pace.establish(t, pace, can != nil ? .can(can!) : .mrz(key!))
                let sel = try await session.send(Apdu.build(0x00, 0xa4, 0x04, 0x0c, data: aid))
                guard Apdu.isOk(sel.sw) else { throw NfcError.io("the eMRTD application did not open after PACE") }
                ch = session
                out["access"] = "pace"
                paceJson["used"] = true
                paceJson["password"] = .string(can != nil ? "can" : "mrz")
                out["pace"] = .object(paceJson)
            } catch { ch = nil; failures.append("PACE: " + errorText(error)) }
        } else if !paceInfos.isEmpty {
            let names = paceInfos.map { p in p.name + (p.parameterId.map { " (\(Pace.parameters[$0] ?? String($0)))" } ?? "") }
            failures.append("PACE: " + names.joined(separator: ", ") + " — not a variant this reader runs")
        }
        if ch == nil, let key {
            do {
                _ = try? await t.transmit(Apdu.selectByAid(aid)) // some chips select on first read
                ch = try await doBac(t, key)
                out["access"] = "bac"
            } catch { failures.append("BAC: " + errorText(error)) }
        }
        guard let channel = ch else {
            let hint = key == nil && can != nil && pace == nil ? " — " + NfcTexts.t("nfc.eid.needsMrz", "this document needs the MRZ (BAC)") : ""
            if !protocols.isEmpty { out["security"] = ["protocols": NfcJSON(protocols)] }
            out["files"] = .array(files)
            out["message"] = .string((failures.isEmpty ? NfcTexts.t("nfc.eid.notOpened", "the document could not be opened") : failures.joined(separator: "; ")) + hint)
            return out
        }
        let send: Send = { try await channel.send($0) }

        // EF.COM — which groups are there.
        var groups = [Int]()
        let com = (try? await readFile(send, efCom, 1024)) ?? .refused(0x6f00)
        if let bytes = com.bytes {
            let c = parseCom(bytes)
            groups = c.groups
            if let l = c.lds { out["ldsVersion"] = .string(l) }
            if let u = c.unicode { out["unicodeVersion"] = .string(u) }
            files.append(.object(fileInfo("COM", efCom, "read").with("size", NfcJSON(bytes.count))))
            rawFiles.append(rawFile("EF.COM.bin", bytes))
        } else { files.append(.object(fileInfo("COM", efCom, statusOf(com.sw)))) }
        if groups.isEmpty { groups = !opts.all ? [1, 2] : [1, 2, 5, 7, 11, 12, 13, 14, 15, 16] }
        out["dataGroups"] = NfcJSON(groups.map { "DG\($0)" })

        // EF.SOD — the hashes every group is checked against, and the signer.
        var sod: Sod? = nil
        if opts.all {
            let s = (try? await readFile(send, efSod, 32_768)) ?? .refused(0x6f00)
            if let bytes = s.bytes {
                sod = parseSod(bytes)
                files.append(.object(fileInfo("SOD", efSod, "read").with("size", NfcJSON(bytes.count))))
                rawFiles.append(rawFile("EF.SOD.bin", bytes))
                if let cert = sod?.certificate { rawFiles.append(rawFile("document-signer.cer", cert, "application/pkix-cert")) }
            } else { files.append(.object(fileInfo("SOD", efSod, statusOf(s.sw)))) }
        }

        var checked = 0, mismatched = 0
        for n in groups.sorted() {
            let name = "DG\(n)"
            let fid = dgFid(n)
            if eacGroups.contains(n) {
                files.append(.object(fileInfo(name, fid, "protected").with("message", .string(NfcTexts.t("nfc.eid.eac", "Extended Access Control (a government terminal certificate)")))))
                continue
            }
            if !opts.all && n > 2 { continue }
            if !opts.readPhoto && imageGroups.contains(n) {
                files.append(.object(fileInfo(name, fid, "absent").with("message", .string(NfcTexts.t("nfc.eid.imagesOff", "not read (images off)")))))
                continue
            }
            let r: FileRead
            do { r = try await readFile(send, fid, cap[n] ?? 32_768) } catch {
                files.append(.object(fileInfo(name, fid, "error").with("message", .string(errorText(error)))))
                continue
            }
            guard let bytes = r.bytes else { files.append(.object(fileInfo(name, fid, statusOf(r.sw)))); continue }
            var info = fileInfo(name, fid, "read").with("size", NfcJSON(bytes.count))
            if !r.complete { info["message"] = "truncated" }
            // Passive authentication of what was read: the group's hash against EF.SOD.
            if let want = sod?.hashes[n], let alg = sod?.hashAlgorithm, r.complete, let got = NfcHash.digest(alg, bytes) {
                let ok = got == want
                info["hashOk"] = .bool(ok)
                checked += 1
                if !ok { mismatched += 1 }
            }
            switch n {
            case 1:
                if let m = mrzFromDg1(bytes) { out["mrzInfo"] = .object(m) }
                rawFiles.append(rawFile("DG1.bin", bytes))
            case 2:
                for (i, f) in faces(fromDg2: bytes).enumerated() {
                    found!.images.append(["group": "DG2", "kind": "face", "mime": .string(f.mime), "data": .string(b64(f.data)),
                                          "name": .string("face" + (i > 0 ? "-\(i + 1)" : "") + "." + extOf(f.mime))])
                }
            case 5: for p in BerTlv.findAll(BerTlv.decode(bytes, recurse: true), 0x5f40) { found!.push(5, "portrait", p.value, "portrait") }
            case 7: for p in BerTlv.findAll(BerTlv.decode(bytes, recurse: true), 0x5f43) { found!.push(7, "signature", p.value, "signature") }
            case 11:
                var f: Found? = opts.readPhoto ? found : nil
                let p = parseDg11(bytes, &f)
                if opts.readPhoto { found = f }
                if !p.isEmpty { out["personal"] = .object(p) }
                rawFiles.append(rawFile("DG11.bin", bytes))
            case 12:
                var f: Found? = opts.readPhoto ? found : nil
                let d = parseDg12(bytes, &f)
                if opts.readPhoto { found = f }
                if !d.isEmpty { out["document"] = .object(d) }
                rawFiles.append(rawFile("DG12.bin", bytes))
            case 13:
                out["optional"] = .string(optionalText(bytes))
                rawFiles.append(rawFile("DG13.bin", bytes))
            case 14:
                for p in Pace.parseSecurityInfos(body(bytes)).protocols where !protocols.contains(p) { protocols.append(p) }
                rawFiles.append(rawFile("DG14.bin", bytes))
            case 15:
                let k = aaKeyText(body(bytes))
                if !k.isEmpty { security["activeAuthKey"] = .string(k) }
                if !protocols.contains("Active Authentication") { protocols.append("Active Authentication") }
                rawFiles.append(rawFile("DG15.bin", bytes))
            case 16:
                let p = parseDg16(bytes)
                if !p.isEmpty { out["personsToNotify"] = NfcJSON(p) }
                rawFiles.append(rawFile("DG16.bin", bytes))
            default: rawFiles.append(rawFile(name + ".bin", bytes))
            }
            files.append(.object(info))
        }

        if let alg = sod?.hashAlgorithm { security["hashAlgorithm"] = .string(alg) }
        if let signer = sod?.signer, signer.has("subject") || signer.has("issuer") { security["signer"] = .object(signer) }
        security["passive"] = .string(sod == nil || checked == 0 ? "unchecked" : mismatched > 0 ? "mismatch" : "ok")
        if !protocols.isEmpty { security["protocols"] = NfcJSON(protocols) }
        out["security"] = .object(security)
        let images = found?.images ?? []
        if !images.isEmpty {
            out["images"] = .array(images.map { .object($0) })
            if let face = images.first(where: { $0.optString("kind") == "face" }) {
                out["photo"] = .string(face.optString("data")); out["photoMime"] = .string(face.optString("mime"))
            }
        }
        out["files"] = .array(files)
        if !rawFiles.isEmpty { out["raw"] = .array(rawFiles) }
        if !failures.isEmpty { out["message"] = .string(failures.joined(separator: "; ")) }
        return out
    }

    /// The NfcResult status for an MRTD read (web-executor.ts): ok when anything opened.
    public static func status(_ mrtd: NfcJSONObject) -> String {
        mrtd.has("mrzInfo") || mrtd.optString("access", "none") != "none" ? "ok" : "auth-failed"
    }

    /// A one-line summary for a log / flash (mrtd.ts mrtdSummary).
    public static func summary(_ d: NfcJSONObject) -> String {
        guard let m = d.optObject("mrzInfo") else {
            if !d.optString("message").isEmpty { return d.optString("message") }
            return d.optBool("present") ? NfcTexts.t("nfc.eid.sum.present", "MRTD present") : NfcTexts.t("nfc.eid.sum.none", "no MRTD")
        }
        var bits = [String]()
        let name = JSText.trim(m.optString("givenNames") + " " + m.optString("surname"))
        if !name.isEmpty { bits.append(name) }
        if !m.optString("documentNumber").isEmpty { bits.append(m.optString("documentNumber")) }
        if !m.optString("nationality").isEmpty { bits.append(m.optString("nationality")) }
        let access = d.optString("access", "none")
        if !access.isEmpty && access != "none" { bits.append(JSText.upperASCII(access)) }
        let imgs = d.optArray("images")?.count ?? (!d.optString("photo").isEmpty ? 1 : 0)
        if imgs > 0 { bits.append(NfcTexts.n("nfc.eid.sum.images", imgs, imgs > 1 ? "{n} images" : "{n} image")) }
        return bits.joined(separator: " · ")
    }
}
