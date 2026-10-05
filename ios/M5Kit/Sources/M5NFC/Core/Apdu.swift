// ISO 7816-4 APDU helpers, status-word checks and a BER-TLV codec (6.5) —
// A/nfc/Apdu.java (the port of client/src/lib/nfc/cards/apdu.ts): what the EMV
// and MRTD readers need. Pure functions, plus `transmitSmart` over an `ApduChannel`.

import Foundation

public enum Apdu {
    /// A short-form case 1..4 APDU. `le` nil = no Le; 0 = "256 / as much as possible".
    public static func build(_ cla: Int, _ ins: Int, _ p1: Int, _ p2: Int, data: [UInt8]? = nil, le: Int? = nil) -> [UInt8] {
        var w: [UInt8] = [UInt8(truncatingIfNeeded: cla), UInt8(truncatingIfNeeded: ins), UInt8(truncatingIfNeeded: p1), UInt8(truncatingIfNeeded: p2)]
        if let d = data, !d.isEmpty { w.append(UInt8(truncatingIfNeeded: d.count)); w.append(contentsOf: d) }
        if let l = le { w.append(UInt8(truncatingIfNeeded: l)) }
        return w
    }

    /// A response split into its data and status word.
    public struct Response: Sendable, Hashable {
        public let data: [UInt8]
        public let sw1: Int, sw2: Int
        public var sw: Int { sw1 << 8 | sw2 }
        public init(data: [UInt8], sw1: Int, sw2: Int) { self.data = data; self.sw1 = sw1; self.sw2 = sw2 }
    }

    /// data ‖ SW1 SW2 → the parts; fewer than two bytes is 6F00 (no precise diagnosis).
    public static func split(_ raw: [UInt8]?) -> Response {
        guard let r = raw, r.count >= 2 else { return Response(data: [], sw1: 0x6f, sw2: 0x00) }
        return Response(data: Array(r[0..<(r.count - 2)]), sw1: Int(r[r.count - 2]), sw2: Int(r[r.count - 1]))
    }

    /// 9000, 61xx (more data) and DESFire's 9100.
    public static func isOk(_ sw: Int) -> Bool { sw == 0x9000 || (sw >> 8) == 0x61 || sw == 0x9100 }

    /// Transmit with the ISO 7816-4 transport dance handled: 6Cxx → retry with the
    /// suggested Le, 61xx → GET RESPONSE until drained (apdu.ts transmitSmart).
    public static func transmitSmart(_ t: any ApduChannel, _ cmd: [UInt8]) async throws -> Response {
        var r = split(try await t.transmit(cmd))
        if r.sw1 == 0x6c && cmd.count >= 5 {
            var fixed = cmd
            fixed[fixed.count - 1] = UInt8(r.sw2)
            r = split(try await t.transmit(fixed))
        }
        var chunks = r.data
        var guardCount = 0
        while r.sw1 == 0x61 && guardCount < 64 {
            guardCount += 1
            r = split(try await t.transmit(Bytes.u8(Int(cmd[0]) & 0xf0, 0xc0, 0x00, 0x00, r.sw2)))
            chunks.append(contentsOf: r.data)
        }
        return Response(data: chunks, sw1: r.sw1, sw2: r.sw2)
    }

    /* ---------- common ISO 7816 commands (apdu.ts ISO) ---------- */

    public static func selectByAid(_ aid: [UInt8]) -> [UInt8] { build(0x00, 0xa4, 0x04, 0x00, data: aid, le: 0x00) }
    public static func selectByFid(_ fid: Int, p2: Int) -> [UInt8] { build(0x00, 0xa4, 0x00, p2, data: Bytes.u8((fid >> 8) & 0xff, fid & 0xff)) }
    public static func readBinary(_ offset: Int, le: Int) -> [UInt8] { build(0x00, 0xb0, (offset >> 8) & 0x7f, offset & 0xff, le: le) }
    public static func readRecord(_ rec: Int, sfi: Int) -> [UInt8] { build(0x00, 0xb2, rec, (sfi << 3) | 0x04, le: 0x00) }
}

/// One BER-TLV element.
public struct Tlv: Sendable, Hashable {
    /// The tag, packed big-endian (0x5F24, 0xBF0C).
    public let tag: Int
    public let tagBytes: [UInt8]
    public let length: Int
    public let value: [UInt8]
    public let constructed: Bool
    /// The elements inside a constructed one (nil when not parsed: primitive, or nested too deep).
    public var children: [Tlv]?
}

/// The BER-TLV codec (Apdu.java decodeTlv / findTlv / formatTlv).
public enum BerTlv {
    /// 6.7 (audit N18): how deep constructed tags are opened — a card's nesting cannot overflow the stack.
    public static let maxDepth = 32

    static func readTag(_ buf: [UInt8], _ off: Int) -> (tag: Int, size: Int) {
        var tag = Int(buf[off]), size = 1
        if tag & 0x1f == 0x1f {
            repeat {
                if off + size >= buf.count { break }
                tag = appendTagByte(tag, buf[off + size])
                size += 1
            } while buf[off + size - 1] & 0x80 != 0
        }
        return (tag, size)
    }

    static func readLength(_ buf: [UInt8], _ off: Int) -> (length: Int, size: Int) {
        let first = Int(buf[off])
        if first < 0x80 { return (first, 1) }
        let n = first & 0x7f
        if n == 0 || n > 4 || off + n >= buf.count { return (-1, 1) }
        var length: UInt64 = 0
        for i in 1...n { length = (length << 8) | UInt64(buf[off + i]) }
        // Int is 32 bits on Apple Watch: no card object is near this size.
        return length > UInt64(Int32.max) ? (-1, 1) : (Int(length), 1 + n)
    }

    /// Parses a sequence of BER-TLV elements; constructed ones recurse into children. 00 / FF padding is skipped;
    /// a malformed tail ends the walk (never traps).
    public static func decode(_ buf: [UInt8], recurse: Bool = true) -> [Tlv] { decode(buf, recurse: recurse, depth: 0) }

    private static func decode(_ buf: [UInt8], recurse: Bool, depth: Int) -> [Tlv] {
        var out = [Tlv]()
        var off = 0
        while off < buf.count {
            if buf[off] == 0x00 || buf[off] == 0xff { off += 1; continue }
            let t = readTag(buf, off)
            if off + t.size >= buf.count { break }
            let l = readLength(buf, off + t.size)
            if l.length < 0 { break }
            let start = off + t.size + l.size
            if l.length > buf.count - start { break }
            let value = Array(buf[start..<(start + l.length)])
            let constructed = buf[off] & 0x20 != 0
            var node = Tlv(tag: t.tag, tagBytes: Array(buf[off..<(off + t.size)]), length: l.length, value: value, constructed: constructed, children: nil)
            if constructed && recurse && depth < maxDepth { node.children = decode(value, recurse: true, depth: depth + 1) }
            out.append(node)
            off = start + l.length
        }
        return out
    }

    /// Depth-first search for a tag.
    public static func find(_ list: [Tlv]?, _ tag: Int) -> Tlv? {
        guard let list else { return nil }
        for n in list {
            if n.tag == tag { return n }
            if let inner = find(n.children, tag) { return inner }
        }
        return nil
    }

    public static func findAll(_ list: [Tlv]?, _ tag: Int) -> [Tlv] {
        var acc = [Tlv]()
        func walk(_ l: [Tlv]?) {
            guard let l else { return }
            for n in l { if n.tag == tag { acc.append(n) }; walk(n.children) }
        }
        walk(list)
        return acc
    }

    /// A TLV tree as text — the PPSE directory of EmvData.tree (apdu.ts formatTlv).
    public static func format(_ list: [Tlv], depth: Int = 0) -> String {
        var sb = ""
        let pad = String(repeating: "  ", count: depth)
        for n in list {
            let tagHex = Hex.encode(n.tagBytes)
            if let kids = n.children, !kids.isEmpty {
                sb += "\(pad)\(tagHex) (\(n.length))\n"
                sb += format(kids, depth: depth + 1) + "\n"
            } else {
                sb += "\(pad)\(tagHex) (\(n.length)) \(hexSpaced(n.value))"
                // Printable values also as text.
                if !n.value.isEmpty && n.value.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) { sb += "  \"\(Bytes.asciiString(n.value))\"" }
                sb += "\n"
            }
        }
        if sb.hasSuffix("\n") { sb.removeLast() }
        return sb
    }

    static func hexSpaced(_ b: [UInt8]) -> String { b.map { String(format: "%02X", $0) }.joined(separator: " ") }

    /// One more byte of a multi-byte tag, kept to 32 bits on every platform (Int is 32 bits on Apple Watch).
    @inline(__always) static func appendTagByte(_ tag: Int, _ b: UInt8) -> Int {
        Int(truncatingIfNeeded: UInt32(truncatingIfNeeded: tag) << 8 | UInt32(b))
    }

    /// 0x5F24 → "5F24", 0x50 → "50" — the EMV tag key (upper hex, even length).
    public static func tagHex(_ tag: Int) -> String {
        var h = String(UInt32(truncatingIfNeeded: tag), radix: 16, uppercase: true)
        if h.count % 2 != 0 { h = "0" + h }
        return h
    }

    /// Encodes one element (tag up to 4 bytes, definite length) — PaceProtocol.tlv.
    public static func encode(_ tag: Int, _ value: [UInt8]) -> [UInt8] {
        var t: [UInt8]
        if tag & ~0xff == 0 { t = [UInt8(tag)] }
        else if tag & ~0xffff == 0 { t = Bytes.u8(tag >> 8, tag) }
        else if tag & ~0xff_ffff == 0 { t = Bytes.u8(tag >> 16, tag >> 8, tag) }
        else { t = Bytes.u8(tag >> 24, tag >> 16, tag >> 8, tag) }
        let n = value.count
        let l: [UInt8]
        if n < 0x80 { l = Bytes.u8(n) }
        else if n <= 0xff { l = Bytes.u8(0x81, n) }
        else if n <= 0xffff { l = Bytes.u8(0x82, n >> 8, n) }
        else if n <= 0xff_ffff { l = Bytes.u8(0x83, n >> 16, n >> 8, n) }
        else { l = Bytes.u8(0x84, n >> 24, n >> 16, n >> 8, n) }
        return t + l + value
    }

    /// Encodes one element whose value is the concatenation of `values`.
    public static func encode(_ tag: Int, _ values: [UInt8]...) -> [UInt8] { encode(tag, Bytes.concat(values)) }
}
