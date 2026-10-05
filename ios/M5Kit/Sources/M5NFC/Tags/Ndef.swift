// NDEF (NFC Data Exchange Format) — the message codec and the Type 2 / Type 4
// tag layouts: client/src/lib/nfc/cards/ndef.ts, plus what Android takes from
// android.nfc (NdefMessage / NdefRecord) and the pure byte layouts of
// A/nfc/CardOps.java (the NDEF TLV, the MIFARE Classic MAD). CoreNFC hands the
// app NFCNDEFPayload records; the app maps them to `NdefRecord` (tnf, type,
// identifier, payload) and back. Pure.

import Foundation

/// The type name format of a record (3 bits).
public enum Tnf: UInt8, Sendable {
    case empty = 0x00, wellKnown = 0x01, mime = 0x02, absoluteUri = 0x03, external = 0x04, unknown = 0x05, unchanged = 0x06, reserved = 0x07
}

/// One NDEF record.
public struct NdefRecord: Sendable, Hashable {
    public var tnf: UInt8
    public var type: [UInt8]
    public var id: [UInt8]
    public var payload: [UInt8]

    public init(tnf: UInt8, type: [UInt8] = [], id: [UInt8] = [], payload: [UInt8] = []) {
        self.tnf = tnf; self.type = type; self.id = id; self.payload = payload
    }

    /// The record type as text.
    public var typeString: String { Bytes.asciiString(type) }
}

public enum Ndef {
    /// NFC Forum URI identifier codes (URI RTD, table 3). Index = the prefix byte.
    public static let uriPrefixes: [String] = [
        "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
        "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://",
        "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
        "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:",
        "urn:epc:raw:", "urn:epc:", "urn:nfc:",
    ]

    /* ------------------------------------------------------------ builders */

    public static func textRecord(_ text: String, lang: String = "en", utf16: Bool = false) throws -> NdefRecord {
        let langBytes = Array(lang.utf8)
        guard langBytes.count <= 63 else { throw NfcError(.invalidArgument, "Language code too long") }
        let status = UInt8((utf16 ? 0x80 : 0) | langBytes.count)
        let body = utf16 ? utf16beEncode(text) : Array(text.utf8)
        return NdefRecord(tnf: Tnf.wellKnown.rawValue, type: Array("T".utf8), payload: [status] + langBytes + body)
    }

    public static func uriRecord(_ uri: String) -> NdefRecord {
        var code = 0
        var rest = uri
        for i in 1..<uriPrefixes.count {
            let p = uriPrefixes[i]
            if uri.hasPrefix(p) && p.count > uriPrefixes[code].count { code = i; rest = String(uri.dropFirst(p.count)) }
        }
        return NdefRecord(tnf: Tnf.wellKnown.rawValue, type: Array("U".utf8), payload: [UInt8(code)] + Array(rest.utf8))
    }

    public static func mimeRecord(_ mime: String, _ payload: [UInt8], id: [UInt8] = []) -> NdefRecord {
        NdefRecord(tnf: Tnf.mime.rawValue, type: Array(mime.utf8), id: id, payload: payload)
    }

    /// An NFC Forum external record ("domain:type"; Android NdefRecord.createExternal lower-cases it).
    public static func externalRecord(_ domainType: String, _ payload: [UInt8]) -> NdefRecord {
        NdefRecord(tnf: Tnf.external.rawValue, type: Array(domainType.lowercased().utf8), payload: payload)
    }

    public static func absoluteUriRecord(_ uri: String) -> NdefRecord { NdefRecord(tnf: Tnf.absoluteUri.rawValue, type: Array(uri.utf8)) }

    public static func emptyRecord() -> NdefRecord { NdefRecord(tnf: Tnf.empty.rawValue) }

    /// A Smart Poster: the URI, optional titles and an action (0 do, 1 save, 2 open for editing).
    public static func smartPosterRecord(_ uri: String, titles: [(text: String, lang: String)] = [], action: Int? = nil) throws -> NdefRecord {
        var inner = [uriRecord(uri)]
        for t in titles { inner.append(try textRecord(t.text, lang: t.lang)) }
        if let a = action { inner.append(NdefRecord(tnf: Tnf.wellKnown.rawValue, type: Array("act".utf8), payload: [UInt8(a & 0xff)])) }
        return NdefRecord(tnf: Tnf.wellKnown.rawValue, type: Array("Sp".utf8), payload: try encodeMessage(inner))
    }

    /* ------------------------------------------------------------ encode */

    public static func encodeRecord(_ r: NdefRecord, first: Bool, last: Bool) throws -> [UInt8] {
        let sr = r.payload.count < 256
        let il = !r.id.isEmpty
        var flags = (r.tnf & 0x07) | (sr ? 0x10 : 0) | (il ? 0x08 : 0) | (first ? 0x80 : 0) | (last ? 0x40 : 0)
        if r.tnf == Tnf.empty.rawValue { flags = (flags & 0xf8) | Tnf.empty.rawValue }
        guard r.type.count <= 255 else { throw NfcError(.invalidArgument, "NDEF type longer than 255 bytes") }
        var out: [UInt8] = [flags, UInt8(r.type.count)]
        let n = r.payload.count
        if sr { out.append(UInt8(n)) } else { out += Bytes.u8(n >> 24, n >> 16, n >> 8, n) }
        if il { out.append(UInt8(r.id.count)) }
        out += r.type
        if il { out += r.id }
        out += r.payload
        return out
    }

    /// The message bytes (an empty record for no records).
    public static func encodeMessage(_ records: [NdefRecord]) throws -> [UInt8] {
        if records.isEmpty { return try encodeRecord(emptyRecord(), first: true, last: true) }
        var out = [UInt8]()
        for (i, r) in records.enumerated() { out += try encodeRecord(r, first: i == 0, last: i == records.count - 1) }
        return out
    }

    /* ------------------------------------------------------------ decode */

    /// Parses a message (ndef.ts decodeNdefMessage): stops at ME, reassembles chunked records,
    /// throws on truncation; `strict` also requires MB on the first record.
    public static func decodeMessage(_ buf: [UInt8], strict: Bool = true) throws -> [NdefRecord] {
        var out = [NdefRecord]()
        var off = 0
        var chunk: (rec: NdefRecord, parts: [UInt8])? = nil
        var guardCount = 0
        while off < buf.count && guardCount < 4096 {
            guardCount += 1
            let flags = buf[off]; off += 1
            let mb = flags & 0x80 != 0, me = flags & 0x40 != 0, cf = flags & 0x20 != 0, sr = flags & 0x10 != 0, il = flags & 0x08 != 0
            let tnf = flags & 0x07
            if strict && out.isEmpty && chunk == nil && !mb { throw NfcError.protocolError("NDEF: first record lacks MB flag") }
            guard off < buf.count else { throw NfcError.protocolError("NDEF: truncated header") }
            let typeLen = Int(buf[off]); off += 1
            var payloadLen: Int
            if sr {
                guard off < buf.count else { throw NfcError.protocolError("NDEF: truncated header") }
                payloadLen = Int(buf[off]); off += 1
            } else {
                guard off + 4 <= buf.count else { throw NfcError.protocolError("NDEF: truncated payload length") }
                let n32 = UInt32(buf[off]) << 24 | UInt32(buf[off + 1]) << 16 | UInt32(buf[off + 2]) << 8 | UInt32(buf[off + 3])
                guard n32 <= UInt32(buf.count) else { throw NfcError.protocolError("NDEF: record truncated") }
                payloadLen = Int(n32)
                off += 4
            }
            var idLen = 0
            if il {
                guard off < buf.count else { throw NfcError.protocolError("NDEF: truncated header") }
                idLen = Int(buf[off]); off += 1
            }
            guard typeLen + idLen <= buf.count - off, payloadLen <= buf.count - off - typeLen - idLen else { throw NfcError.protocolError("NDEF: record truncated") }
            let type = Array(buf[off..<(off + typeLen)]); off += typeLen
            let id = Array(buf[off..<(off + idLen)]); off += idLen
            let payload = Array(buf[off..<(off + payloadLen)]); off += payloadLen
            if var c = chunk {
                guard tnf == Tnf.unchanged.rawValue else { throw NfcError.protocolError("NDEF: chunk continuation must use TNF UNCHANGED") }
                c.parts += payload
                if !cf { var r = c.rec; r.payload = c.parts; out.append(r); chunk = nil } else { chunk = c }
            } else if cf {
                chunk = (NdefRecord(tnf: tnf, type: type, id: id), payload)
            } else {
                out.append(NdefRecord(tnf: tnf, type: type, id: id, payload: payload))
            }
            if me && chunk == nil { break }
        }
        if chunk != nil { throw NfcError.protocolError("NDEF: unterminated chunked record") }
        return out
    }

    /* ------------------------------------------------------------ interpretation */

    /// What a record says (ndef.ts DecodedRecord).
    public enum Decoded: Sendable, Hashable {
        case text(text: String, lang: String, utf16: Bool)
        case uri(String)
        case smartPoster(uri: String?, titles: [String], action: Int?)
        case mime(type: String, payload: [UInt8])
        case external(type: String, payload: [UInt8])
        case absoluteUri(String)
        case empty
        case unknown(tnf: UInt8, type: String, payload: [UInt8])
    }

    public static func decodeRecord(_ r: NdefRecord) -> Decoded {
        let t = r.typeString
        switch r.tnf {
        case Tnf.empty.rawValue: return .empty
        case Tnf.wellKnown.rawValue:
            if t == "T" {
                if r.payload.isEmpty { return .text(text: "", lang: "", utf16: false) }
                let status = r.payload[0]
                let langLen = min(Int(status & 0x3f), r.payload.count - 1)
                let utf16 = status & 0x80 != 0
                let lang = Bytes.asciiString(Array(r.payload[1..<(1 + langLen)]))
                let body = Array(r.payload[(1 + langLen)...])
                return .text(text: utf16 ? utf16Decode(body) : String(decoding: body, as: UTF8.self), lang: lang, utf16: utf16)
            }
            if t == "U" { return .uri(uriText(r.payload)) }
            if t == "Sp" {
                var uri: String? = nil
                var titles = [String]()
                var action: Int? = nil
                for i in (try? decodeMessage(r.payload, strict: false)) ?? [] {
                    switch decodeRecord(i) {
                    case .uri(let u) where uri == nil: uri = u
                    case .text(let text, _, _): titles.append(text)
                    default: if i.tnf == Tnf.wellKnown.rawValue && i.typeString == "act", let a = i.payload.first { action = Int(a) }
                    }
                }
                return .smartPoster(uri: uri, titles: titles, action: action)
            }
            return .unknown(tnf: r.tnf, type: t, payload: r.payload)
        case Tnf.mime.rawValue: return .mime(type: t, payload: r.payload)
        case Tnf.absoluteUri.rawValue: return .absoluteUri(t)
        case Tnf.external.rawValue: return .external(type: t, payload: r.payload)
        default: return .unknown(tnf: r.tnf, type: t, payload: r.payload)
        }
    }

    /// A URI record's payload as the URI (prefix code + the rest).
    public static func uriText(_ p: [UInt8]) -> String {
        guard let code = p.first else { return "" }
        return (Int(code) < uriPrefixes.count ? uriPrefixes[Int(code)] : "") + String(decoding: p.dropFirst(), as: UTF8.self)
    }

    /// One line for a record list (ndef.ts describeRecord).
    public static func describe(_ r: NdefRecord) -> String {
        switch decodeRecord(r) {
        case .text(let text, let lang, _): return "Text [\(lang.isEmpty ? "-" : lang)] \(NfcJSON.quote(text))"
        case .uri(let u): return "URI \(u)"
        case .smartPoster(let uri, let titles, _): return "Smart Poster \(uri ?? "?")\(titles.isEmpty ? "" : " \"\(titles[0])\"")"
        case .mime(let type, let payload): return "MIME \(type) (\(payload.count) B)"
        case .external(let type, let payload): return "External \(type) (\(payload.count) B)"
        case .absoluteUri(let u): return "Absolute URI \(u)"
        case .empty: return "Empty record"
        case .unknown(let tnf, let type, let payload): return "TNF \(tnf) type \(NfcJSON.quote(type)) (\(payload.count) B)"
        }
    }

    static func utf16beEncode(_ s: String) -> [UInt8] {
        var out: [UInt8] = [0xfe, 0xff]
        for u in s.utf16 { out.append(UInt8(u >> 8)); out.append(UInt8(u & 0xff)) }
        return out
    }

    /// UTF-16 with an optional BOM, big-endian without one (Java's UTF_16 / ndef.ts utf16beDecode).
    static func utf16Decode(_ b: [UInt8]) -> String {
        var le = false, off = 0
        if b.count >= 2 && b[0] == 0xff && b[1] == 0xfe { le = true; off = 2 } else if b.count >= 2 && b[0] == 0xfe && b[1] == 0xff { off = 2 }
        var units = [UInt16]()
        var i = off
        while i + 1 < b.count { units.append(le ? UInt16(b[i]) | UInt16(b[i + 1]) << 8 : UInt16(b[i]) << 8 | UInt16(b[i + 1])); i += 2 }
        return String(decoding: units, as: UTF16.self)
    }

    /* ------------------------------------------------------------ Type 2 tags (Ultralight / NTAG) */

    /// The NDEF Message TLV: 03, the length (1 byte, or FF + u16 from 255), the message, FE (CardOps.ndefTlv).
    public static func ndefTlv(_ ndef: [UInt8]) -> [UInt8] {
        var w: [UInt8] = [0x03]
        if ndef.count < 0xff { w.append(UInt8(ndef.count)) } else { w += [0xff, UInt8((ndef.count >> 8) & 0xff), UInt8(ndef.count & 0xff)] }
        return w + ndef + [0xfe]
    }

    /// The 4-byte capability container of a Type 2 tag (page 3).
    public struct T2Capability: Sendable, Hashable { public let version: String; public let dataBytes: Int; public let readOnly: Bool }

    public static func parseT2Cc(_ cc: [UInt8]) -> T2Capability? {
        guard cc.count >= 4, cc[0] == 0xe1 else { return nil }
        return T2Capability(version: "\(cc[1] >> 4).\(cc[1] & 0x0f)", dataBytes: Int(cc[2]) * 8, readOnly: cc[3] & 0x0f != 0)
    }

    /// The NDEF message inside a Type 2 data area (the bytes from page 4 on), or nil.
    public static func extractT2Ndef(_ area: [UInt8]) -> [UInt8]? {
        var off = 0
        while off < area.count {
            let t = area[off]
            if t == 0x00 { off += 1; continue }
            if t == 0xfe { return nil }
            if off + 1 >= area.count { return nil }
            var len = Int(area[off + 1]), hdr = 2
            if len == 0xff {
                if off + 3 >= area.count { return nil }
                len = Int(area[off + 2]) << 8 | Int(area[off + 3]); hdr = 4
            }
            if t == 0x03 { let start = off + hdr; return Array(area[start..<min(area.count, start + len)]) }
            off += hdr + len
        }
        return nil
    }

    /// The pages a Type 2 tag write lays down for `ndef` (CardOps.ultralightNdefWrite): the CC on a blank tag
    /// (page 3, only when `writeCc`), then the TLV from page 4 in whole pages. Throws when it does not fit.
    public static func t2WritePages(_ ndef: [UInt8], capacity: Int, writeCc: Bool) throws -> [(page: Int, data: [UInt8])] {
        let tlv = ndefTlv(ndef)
        if capacity > 0 && tlv.count > capacity { throw NfcError(.invalidArgument, "too-small (needs \(tlv.count) B, holds \(capacity) B)") }
        var pages = [(page: Int, data: [UInt8])]()
        if writeCc { pages.append((3, [0xe1, 0x10, UInt8(((capacity > 0 ? capacity : 48) / 8) & 0xff), 0x00])) }
        var buf = tlv
        while buf.count % 4 != 0 { buf.append(0) }
        for p in 0..<(buf.count / 4) { pages.append((4 + p, Array(buf[(p * 4)..<(p * 4 + 4)]))) }
        return pages
    }

    /* ------------------------------------------------------------ Type 4 tags (ISO-DEP) */

    /// The NDEF Tag Application (NFC Forum Type 4).
    public static let t4tAid: [UInt8] = [0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01]
    public static let t4tCcFid = 0xe103, t4tNdefFid = 0xe104

    /// A mapping 2.0 capability container (15 bytes).
    public static func t4tCc(maxLe: Int = 0x00ff, maxLc: Int = 0x00ff, ndefFileSize: Int = 0x0400, readOnly: Bool = false) -> [UInt8] {
        Bytes.u8(0x00, 0x0f, 0x20, maxLe >> 8, maxLe, maxLc >> 8, maxLc, 0x04, 0x06, 0xe1, 0x04, ndefFileSize >> 8, ndefFileSize, 0x00, readOnly ? 0xff : 0x00)
    }

    /// The NDEF file of a Type 4 tag: NLEN (2 bytes, big-endian) + the message.
    public static func t4tNdefFile(_ ndef: [UInt8]) -> [UInt8] { Bytes.u8(ndef.count >> 8, ndef.count) + ndef }
}

/// The byte layout of an NDEF-formatted MIFARE Classic (CardOps.java): the data sectors,
/// their capacity, MAD1 / MAD2 and their CRC. **iOS cannot talk to MIFARE Classic** (no
/// CoreNFC support) — kept for parity, dumps and an external reader.
public enum MifareClassicLayout {
    public static let madKeyA = Hex.decode("A0A1A2A3A4A5")
    public static let ndefKeyA = Hex.decode("D3F7D3F7D3F7")
    public static let factoryKey = Hex.decode("FFFFFFFFFFFF")
    public static let madTrailerV1 = Hex.decode("A0A1A2A3A4A5787788C1FFFFFFFFFFFF")
    public static let madTrailerV2 = Hex.decode("A0A1A2A3A4A5787788C2FFFFFFFFFFFF")
    public static let ndefTrailer = Hex.decode("D3F7D3F7D3F77F078840FFFFFFFFFFFF")
    static let ndefAid: [UInt8] = [0x03, 0xe1]

    /// Blocks in a sector: 4 for the first 32 sectors, 16 for the large 4K sectors.
    public static func blocksInSector(_ sector: Int) -> Int { sector < 32 ? 4 : 16 }

    /// The NDEF data sectors (all but the MAD sectors 0 and — on 4K — 16).
    public static func ndefDataSectors(_ sectorCount: Int) -> [Int] {
        (0..<max(0, sectorCount)).filter { !($0 == 0 || ($0 == 16 && sectorCount > 16)) }
    }

    /// The usable NDEF-TLV bytes (1K → 720, 4K → 3360).
    public static func dataCapacity(_ sectorCount: Int) -> Int { ndefDataSectors(sectorCount).reduce(0) { $0 + (blocksInSector($1) - 1) * 16 } }

    /// MAD1 (32 bytes: block 1 ‖ block 2) marking sectors 1–15 that carry NDEF.
    public static func mad1(_ used: [Bool]) -> [UInt8] {
        var mad = [UInt8](repeating: 0, count: 32)
        mad[1] = 0x01
        for s in 1...15 where s < used.count && used[s] { mad[2 * s] = ndefAid[0]; mad[2 * s + 1] = ndefAid[1] }
        mad[0] = crc(Array(mad[1..<32]))
        return mad
    }

    /// MAD2 (48 bytes) marking sectors 17–39 (4K).
    public static func mad2(_ used: [Bool], sectorCount: Int) -> [UInt8] {
        var mad = [UInt8](repeating: 0, count: 48)
        for s in 17...39 where s < sectorCount && s < used.count && used[s] {
            let i = s - 17
            mad[2 + 2 * i] = ndefAid[0]; mad[3 + 2 * i] = ndefAid[1]
        }
        mad[0] = crc(Array(mad[1..<48]))
        return mad
    }

    /// The MAD CRC-8 (polynomial 0x1D, preset 0xC7) over the bytes after the CRC byte.
    public static func crc(_ data: [UInt8]) -> UInt8 {
        var crc = 0xc7
        for v in data {
            crc ^= Int(v)
            for _ in 0..<8 { crc = crc & 0x80 != 0 ? ((crc << 1) ^ 0x1d) & 0xff : (crc << 1) & 0xff }
        }
        return UInt8(crc)
    }

    /// A key dictionary the USER supplies — 6-byte keys, seeded with the factory key (CardOps.keyDictionary).
    public static func keyDictionary(_ text: String?) -> [[UInt8]] {
        var keys: [[UInt8]] = [factoryKey]
        for line in (text ?? "").split(whereSeparator: { " \t\n\r,;".contains($0) }) {
            let h = String(line).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ":", with: "")
            if h.utf8.count == 12, let k = Hex.decodeStrict(h), !keys.contains(k) { keys.append(k) }
        }
        return keys
    }
}
