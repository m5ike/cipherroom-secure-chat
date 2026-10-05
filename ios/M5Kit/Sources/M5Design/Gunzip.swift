// gzip (RFC 1952) as java.util.zip.GZIPInputStream reads it: the header's
// optional fields, raw DEFLATE (the Compression framework, streamed so a
// limit holds), the CRC-32 and size trailer checked, further members read,
// trailing garbage after a member ignored. Also the small encoder the tests
// use to build containers.

import Compression
import Foundation

public enum Gzip {
    public struct Failure: Error, Sendable, Equatable {
        public let message: String
        /// The output went past the limit.
        public let tooLarge: Bool
    }

    /// The decompressed bytes; throws when the data is not gzip, is corrupt, or decompresses past `limit`.
    public static func decompress(_ data: Data, limit: Int) throws -> Data {
        let bytes = [UInt8](data)
        var out = Data()
        var at = 0
        var member = 0
        while true {
            // A header (the first one must be there; after a member, anything that is not one is ignored).
            guard bytes.count - at >= 10, bytes[at] == 0x1F, bytes[at + 1] == 0x8B else {
                if member == 0 { throw Failure(message: "Not in GZIP format", tooLarge: false) }
                break
            }
            guard bytes[at + 2] == 8 else {
                if member == 0 { throw Failure(message: "Unsupported compression method", tooLarge: false) }
                break
            }
            let flags = bytes[at + 3]
            var p = at + 10
            if flags & 0x04 != 0 {
                guard p + 2 <= bytes.count else { throw Failure(message: "Unexpected end of ZLIB input stream", tooLarge: false) }
                p += 2 + (Int(bytes[p]) | Int(bytes[p + 1]) << 8)
            }
            if flags & 0x08 != 0 { while p < bytes.count && bytes[p] != 0 { p += 1 }; p += 1 }
            if flags & 0x10 != 0 { while p < bytes.count && bytes[p] != 0 { p += 1 }; p += 1 }
            if flags & 0x02 != 0 { p += 2 }
            guard p <= bytes.count else { throw Failure(message: "Unexpected end of ZLIB input stream", tooLarge: false) }
            let (inflated, consumed) = try inflate(bytes, from: p, limit: limit - out.count)
            p += consumed
            guard p + 8 <= bytes.count else { throw Failure(message: "Unexpected end of ZLIB input stream", tooLarge: false) }
            let crc = UInt32(bytes[p]) | UInt32(bytes[p + 1]) << 8 | UInt32(bytes[p + 2]) << 16 | UInt32(bytes[p + 3]) << 24
            let size = UInt32(bytes[p + 4]) | UInt32(bytes[p + 5]) << 8 | UInt32(bytes[p + 6]) << 16 | UInt32(bytes[p + 7]) << 24
            guard crc == crc32(inflated), size == UInt32(truncatingIfNeeded: inflated.count) else {
                throw Failure(message: "Corrupt GZIP trailer", tooLarge: false)
            }
            out.append(inflated)
            at = p + 8
            member += 1
            if at >= bytes.count { break }
        }
        return out
    }

    /// Raw DEFLATE from `from`: the bytes and how much input the stream took.
    /// Raw DEFLATE from `start`: the bytes and how much input the stream took. (The Compression
    /// framework's decoder swallows what follows the stream, so the gzip trailer could not be
    /// found after it — this small inflater stops exactly at the last block.)
    static func inflate(_ input: [UInt8], from start: Int, limit: Int) throws -> (Data, Int) {
        var inf = Inflater(input, start: start, limit: limit)
        try inf.run()
        return (Data(inf.out), inf.consumed - start)
    }

    /// RFC 1951: stored, fixed and dynamic Huffman blocks; 15-bit lookup tables.
    struct Inflater {
        let src: [UInt8]
        var pos: Int
        var bitBuf: UInt64 = 0
        var bitCnt = 0
        var out: [UInt8] = []
        let limit: Int

        init(_ src: [UInt8], start: Int, limit: Int) { self.src = src; pos = start; self.limit = limit; out.reserveCapacity(min(limit, 1 << 20)) }

        /// The input position after the stream (whole unused bytes given back).
        var consumed: Int { pos - bitCnt / 8 }

        static let end = Failure(message: "Unexpected end of ZLIB input stream", tooLarge: false)
        static let invalid = Failure(message: "invalid deflate data", tooLarge: false)

        mutating func need(_ n: Int) throws {
            while bitCnt < n {
                if pos >= src.count + 8 { throw Self.end }
                let b: UInt64 = pos < src.count ? UInt64(src[pos]) : 0
                pos += 1
                bitBuf |= b << UInt64(bitCnt)
                bitCnt += 8
            }
        }

        mutating func bits(_ n: Int) throws -> Int {
            if n == 0 { return 0 }
            try need(n)
            let v = Int(bitBuf & ((1 << UInt64(n)) - 1))
            bitBuf >>= UInt64(n)
            bitCnt -= n
            return v
        }

        struct Huffman {
            /// Indexed by the next 15 input bits: (symbol << 4) | length, 0 = no code.
            var table: [UInt16]

            init(lengths: [Int]) throws {
                var count = [Int](repeating: 0, count: 16)
                for l in lengths { count[l] += 1 }
                count[0] = 0
                var left = 1
                for len in 1...15 {
                    left <<= 1
                    left -= count[len]
                    if left < 0 { throw Inflater.invalid } // over-subscribed
                }
                var next = [Int](repeating: 0, count: 16)
                var code = 0
                for len in 1...15 { code = (code + count[len - 1]) << 1; next[len] = code }
                table = [UInt16](repeating: 0, count: 1 << 15)
                for (sym, len) in lengths.enumerated() where len > 0 {
                    let c = next[len]
                    next[len] += 1
                    var r = 0
                    for i in 0..<len where c & (1 << i) != 0 { r |= 1 << (len - 1 - i) }
                    let entry = UInt16(sym << 4 | len)
                    var k = r
                    while k < 1 << 15 { table[k] = entry; k += 1 << len }
                }
            }
        }

        mutating func decode(_ h: Huffman) throws -> Int {
            try need(15)
            let e = h.table[Int(bitBuf & 0x7FFF)]
            if e == 0 { throw Self.invalid }
            let len = Int(e & 15)
            bitBuf >>= UInt64(len)
            bitCnt -= len
            return Int(e >> 4)
        }

        static let lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
        static let lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
        static let distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
        static let distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
        static let fixed: (Huffman, Huffman) = {
            var l = [Int](repeating: 8, count: 288)
            for i in 144..<256 { l[i] = 9 }
            for i in 256..<280 { l[i] = 7 }
            return (try! Huffman(lengths: l), try! Huffman(lengths: [Int](repeating: 5, count: 30)))
        }()

        mutating func run() throws {
            var final = 0
            repeat {
                final = try bits(1)
                switch try bits(2) {
                case 0: try stored()
                case 1: try codes(Self.fixed.0, Self.fixed.1)
                case 2:
                    let (l, d) = try dynamic()
                    try codes(l, d)
                default: throw Self.invalid
                }
            } while final == 0
            if consumed > src.count { throw Self.end }
        }

        mutating func stored() throws {
            let drop = bitCnt % 8
            bitBuf >>= UInt64(drop)
            bitCnt -= drop
            let len = try bits(16), nlen = try bits(16)
            if len != (~nlen & 0xFFFF) { throw Self.invalid }
            for _ in 0..<len { out.append(UInt8(try bits(8))) }
            if out.count > limit { throw Failure(message: "too large", tooLarge: true) }
            if consumed > src.count { throw Self.end }
        }

        mutating func dynamic() throws -> (Huffman, Huffman) {
            let nlen = try bits(5) + 257, ndist = try bits(5) + 1, ncode = try bits(4) + 4
            if nlen > 286 || ndist > 30 { throw Self.invalid }
            let order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
            var cl = [Int](repeating: 0, count: 19)
            for i in 0..<ncode { cl[order[i]] = try bits(3) }
            let lencode = try Huffman(lengths: cl)
            var lengths: [Int] = []
            while lengths.count < nlen + ndist {
                let sym = try decode(lencode)
                if sym < 16 { lengths.append(sym); continue }
                var repeatLen = 0, n = 0
                switch sym {
                case 16:
                    guard let last = lengths.last else { throw Self.invalid }
                    repeatLen = last; n = 3 + (try bits(2))
                case 17: n = 3 + (try bits(3))
                default: n = 11 + (try bits(7))
                }
                if lengths.count + n > nlen + ndist { throw Self.invalid }
                lengths.append(contentsOf: repeatElement(repeatLen, count: n))
            }
            if lengths[256] == 0 { throw Self.invalid }
            return (try Huffman(lengths: Array(lengths[0..<nlen])), try Huffman(lengths: Array(lengths[nlen...])))
        }

        mutating func codes(_ lit: Huffman, _ dist: Huffman) throws {
            while true {
                let sym = try decode(lit)
                if sym < 256 {
                    out.append(UInt8(sym))
                } else if sym == 256 {
                    break
                } else {
                    let i = sym - 257
                    if i >= 29 { throw Self.invalid }
                    let len = Self.lengthBase[i] + (try bits(Self.lengthExtra[i]))
                    let ds = try decode(dist)
                    if ds >= 30 { throw Self.invalid }
                    let d = Self.distBase[ds] + (try bits(Self.distExtra[ds]))
                    if d > out.count { throw Self.invalid }
                    // The run from `from` repeats with period d: copy what is there, doubling.
                    let from = out.count - d
                    var remaining = len
                    while remaining > 0 {
                        let n = min(remaining, out.count - from)
                        // A copy first: appending a slice of `out` itself would copy the whole buffer.
                        let chunk = Array(out[from..<(from + n)])
                        out.append(contentsOf: chunk)
                        remaining -= n
                    }
                }
                if out.count > limit { throw Failure(message: "too large", tooLarge: true) }
            }
            if consumed > src.count { throw Self.end }
        }
    }

    /// gzip of `data` (one member, no name) — what the server's gzipSync writes, for tests and tools.
    public static func compress(_ data: Data) throws -> Data {
        var deflated = Data()
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { stream.deallocate() }
        guard compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw Failure(message: "deflater", tooLarge: false)
        }
        defer { compression_stream_destroy(stream) }
        let chunk = 64 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
        defer { buffer.deallocate() }
        let bytes = [UInt8](data)
        try bytes.withUnsafeBufferPointer { src in
            stream.pointee.src_ptr = src.baseAddress ?? UnsafePointer(buffer)
            stream.pointee.src_size = bytes.count
            while true {
                stream.pointee.dst_ptr = buffer
                stream.pointee.dst_size = chunk
                let status = compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                deflated.append(buffer, count: chunk - stream.pointee.dst_size)
                if status == COMPRESSION_STATUS_END { return }
                if status != COMPRESSION_STATUS_OK { throw Failure(message: "deflate failed", tooLarge: false) }
            }
        }
        var out = Data([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF])
        out.append(deflated)
        let crc = crc32(data), n = UInt32(truncatingIfNeeded: data.count)
        for v in [crc, n] { out.append(contentsOf: [UInt8(v & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 24 & 0xFF)]) }
        return out
    }

    private static let table: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    /// CRC-32 (IEEE 802.3), as gzip's trailer has it.
    public static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in data { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }
}
