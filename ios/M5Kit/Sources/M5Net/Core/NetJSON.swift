// A JSON value for the wire (hub frames, REST answers, signed documents).
//
// Why not JSONSerialization / Codable models only: the server's frames are
// open-ended (envelopes, payloads, forwarded fields the client must hand on
// untouched), integers must stay integers (millisecond times, tree sizes —
// 2^53 is the limit, as in JavaScript), and a few documents are signed as
// TEXT (the device policy) and must never be re-serialized. NetJSON parses
// strictly (RFC 8259, a depth limit), keeps integers exact, and serializes
// deterministically (object keys sorted) the way JSON.stringify writes values:
// no spaces, "/" and non-ASCII not escaped.

import Foundation

public enum NetJSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([NetJSON])
    case object([String: NetJSON])
}

/* ------------------------------------------------------------- literals */

// (Not ExpressibleByNilLiteral: `json["x"] == nil` must mean "absent", never "is JSON null".)
extension NetJSON: ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
                   ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
                   ExpressibleByDictionaryLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: NetJSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, NetJSON)...) {
        var o: [String: NetJSON] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
}

/* ------------------------------------------------------------- reading */

extension NetJSON {
    public subscript(key: String) -> NetJSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public subscript(index: Int) -> NetJSON? {
        if case .array(let a) = self, index >= 0, index < a.count { return a[index] }
        return nil
    }

    public var isNull: Bool { if case .null = self { return true }; return false }
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var arrayValue: [NetJSON]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: NetJSON]? { if case .object(let o) = self { return o }; return nil }

    /// An integer: an `int`, or a `double` with no fraction inside the safe range.
    public var int64Value: Int64? {
        switch self {
        case .int(let i): return i
        case .double(let d):
            guard d.isFinite, d == d.rounded(), abs(d) <= 9_007_199_254_740_991 else { return nil }
            return Int64(d)
        default: return nil
        }
    }

    public var intValue: Int? { int64Value.flatMap { Int(exactly: $0) } }

    public var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }

    public var isNumber: Bool { if case .int = self { return true }; if case .double = self { return true }; return false }

    /// `optString` as org.json has it: the string, else "" (numbers and booleans are NOT coerced — the
    /// wire never relies on that, and coercion hides type confusion).
    public func str(_ key: String, _ fallback: String = "") -> String { self[key]?.stringValue ?? fallback }
    public func int(_ key: String, _ fallback: Int64 = 0) -> Int64 { self[key]?.int64Value ?? fallback }
    public func bool(_ key: String, _ fallback: Bool = false) -> Bool { self[key]?.boolValue ?? fallback }
    public func obj(_ key: String) -> NetJSON? { if let v = self[key], case .object = v { return v }; return nil }
    public func arr(_ key: String) -> [NetJSON]? { self[key]?.arrayValue }

    /// A copy with `key` set (objects only; anything else becomes an object).
    public func with(_ key: String, _ value: NetJSON?) -> NetJSON {
        var o = objectValue ?? [:]
        o[key] = value
        return .object(o)
    }
}

/* ------------------------------------------------------------- parsing */

public struct NetJSONError: Error, Sendable, CustomStringConvertible {
    public let message: String
    public let offset: Int
    public var description: String { "JSON: \(message) at \(offset)" }
}

extension NetJSON {
    /// Parses one JSON text (UTF-8). Strict: no trailing data, no comments, no NaN; depth ≤ 128.
    public static func parse(_ data: Data) throws -> NetJSON {
        var p = Parser(bytes: [UInt8](data))
        p.skipWhitespace()
        let v = try p.value(depth: 0)
        p.skipWhitespace()
        guard p.at == p.bytes.count else { throw p.fail("trailing data") }
        return v
    }

    public static func parse(_ text: String) throws -> NetJSON { try parse(Data(text.utf8)) }

    private struct Parser {
        let bytes: [UInt8]
        var at = 0

        func fail(_ m: String) -> NetJSONError { NetJSONError(message: m, offset: at) }

        mutating func skipWhitespace() {
            while at < bytes.count, bytes[at] == 0x20 || bytes[at] == 0x0A || bytes[at] == 0x0D || bytes[at] == 0x09 { at += 1 }
        }

        mutating func expect(_ word: String) throws {
            for b in word.utf8 {
                guard at < bytes.count, bytes[at] == b else { throw fail("expected \(word)") }
                at += 1
            }
        }

        mutating func value(depth: Int) throws -> NetJSON {
            guard depth < 128 else { throw fail("nested too deeply") }
            guard at < bytes.count else { throw fail("unexpected end") }
            switch bytes[at] {
            case UInt8(ascii: "{"): return try object(depth: depth)
            case UInt8(ascii: "["): return try array(depth: depth)
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return try number()
            }
        }

        mutating func object(depth: Int) throws -> NetJSON {
            at += 1
            var out: [String: NetJSON] = [:]
            skipWhitespace()
            if at < bytes.count, bytes[at] == UInt8(ascii: "}") { at += 1; return .object(out) }
            while true {
                skipWhitespace()
                guard at < bytes.count, bytes[at] == UInt8(ascii: "\"") else { throw fail("expected a key") }
                let key = try string()
                skipWhitespace()
                guard at < bytes.count, bytes[at] == UInt8(ascii: ":") else { throw fail("expected :") }
                at += 1
                skipWhitespace()
                // As JSON.parse: the last of repeated keys wins.
                out[key] = try value(depth: depth + 1)
                skipWhitespace()
                guard at < bytes.count else { throw fail("unexpected end") }
                if bytes[at] == UInt8(ascii: ",") { at += 1; continue }
                if bytes[at] == UInt8(ascii: "}") { at += 1; return .object(out) }
                throw fail("expected , or }")
            }
        }

        mutating func array(depth: Int) throws -> NetJSON {
            at += 1
            var out: [NetJSON] = []
            skipWhitespace()
            if at < bytes.count, bytes[at] == UInt8(ascii: "]") { at += 1; return .array(out) }
            while true {
                skipWhitespace()
                out.append(try value(depth: depth + 1))
                skipWhitespace()
                guard at < bytes.count else { throw fail("unexpected end") }
                if bytes[at] == UInt8(ascii: ",") { at += 1; continue }
                if bytes[at] == UInt8(ascii: "]") { at += 1; return .array(out) }
                throw fail("expected , or ]")
            }
        }

        mutating func hex4() throws -> UInt32 {
            guard at + 4 <= bytes.count else { throw fail("bad \\u escape") }
            var v: UInt32 = 0
            for _ in 0..<4 {
                let c = bytes[at]
                let d: UInt32
                switch c {
                case 0x30...0x39: d = UInt32(c - 0x30)
                case 0x41...0x46: d = UInt32(c - 0x41 + 10)
                case 0x61...0x66: d = UInt32(c - 0x61 + 10)
                default: throw fail("bad \\u escape")
                }
                v = v << 4 | d
                at += 1
            }
            return v
        }

        mutating func string() throws -> String {
            at += 1
            var out = [UInt8]()
            while true {
                guard at < bytes.count else { throw fail("unterminated string") }
                let c = bytes[at]
                if c == UInt8(ascii: "\"") { at += 1; break }
                if c < 0x20 { throw fail("control character in a string") }
                if c != UInt8(ascii: "\\") { out.append(c); at += 1; continue }
                at += 1
                guard at < bytes.count else { throw fail("unterminated escape") }
                let e = bytes[at]
                at += 1
                switch e {
                case UInt8(ascii: "\""): out.append(0x22)
                case UInt8(ascii: "\\"): out.append(0x5C)
                case UInt8(ascii: "/"): out.append(0x2F)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "u"):
                    var scalar = try hex4()
                    if (0xD800...0xDBFF).contains(scalar) {
                        // A surrogate pair; a lone surrogate becomes U+FFFD (Swift strings cannot hold one).
                        if at + 6 <= bytes.count, bytes[at] == UInt8(ascii: "\\"), bytes[at + 1] == UInt8(ascii: "u") {
                            let save = at
                            at += 2
                            let low = try hex4()
                            if (0xDC00...0xDFFF).contains(low) {
                                scalar = 0x10000 + ((scalar - 0xD800) << 10) + (low - 0xDC00)
                            } else {
                                at = save
                                scalar = 0xFFFD
                            }
                        } else {
                            scalar = 0xFFFD
                        }
                    } else if (0xDC00...0xDFFF).contains(scalar) {
                        scalar = 0xFFFD
                    }
                    out.append(contentsOf: Array(String(Character(Unicode.Scalar(scalar)!)).utf8))
                default: throw fail("bad escape")
                }
            }
            guard let s = String(validating: out, as: UTF8.self) else { throw fail("not UTF-8") }
            return s
        }

        mutating func number() throws -> NetJSON {
            let start = at
            var isInteger = true
            if at < bytes.count, bytes[at] == UInt8(ascii: "-") { at += 1 }
            guard at < bytes.count, (0x30...0x39).contains(bytes[at]) else { throw fail("bad number") }
            if bytes[at] == 0x30 { at += 1 } else { while at < bytes.count, (0x30...0x39).contains(bytes[at]) { at += 1 } }
            if at < bytes.count, bytes[at] == UInt8(ascii: ".") {
                isInteger = false
                at += 1
                guard at < bytes.count, (0x30...0x39).contains(bytes[at]) else { throw fail("bad number") }
                while at < bytes.count, (0x30...0x39).contains(bytes[at]) { at += 1 }
            }
            if at < bytes.count, bytes[at] == UInt8(ascii: "e") || bytes[at] == UInt8(ascii: "E") {
                isInteger = false
                at += 1
                if at < bytes.count, bytes[at] == UInt8(ascii: "+") || bytes[at] == UInt8(ascii: "-") { at += 1 }
                guard at < bytes.count, (0x30...0x39).contains(bytes[at]) else { throw fail("bad number") }
                while at < bytes.count, (0x30...0x39).contains(bytes[at]) { at += 1 }
            }
            let text = String(decoding: bytes[start..<at], as: UTF8.self)
            if isInteger, let i = Int64(text) { return .int(i) }
            guard let d = Double(text), d.isFinite else { throw fail("bad number") }
            return .double(d)
        }
    }
}

/* ------------------------------------------------------------- writing */

extension NetJSON {
    /// The JSON text: keys sorted, no whitespace, escapes as JSON.stringify writes them.
    public var text: String {
        var out = ""
        write(into: &out)
        return out
    }

    public var data: Data { Data(text.utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d): out += NetJSON.format(d)
        case .string(let s): NetJSON.quote(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                v.write(into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            for (i, k) in o.keys.sorted().enumerated() {
                if i > 0 { out += "," }
                NetJSON.quote(k, into: &out)
                out += ":"
                o[k]!.write(into: &out)
            }
            out += "}"
        }
    }

    /// A number as JavaScript prints it (integral values without ".0", exponents without leading zeros).
    static func format(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 1e21 {
            if abs(d) <= 9_007_199_254_740_991 { return String(Int64(d)) }
            return String(format: "%.0f", d)
        }
        var s = "\(d)"
        if let e = s.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            let mantissa = String(s[..<e])
            var exp = String(s[s.index(after: e)...])
            var sign = "+"
            if exp.hasPrefix("-") { sign = "-"; exp.removeFirst() } else if exp.hasPrefix("+") { exp.removeFirst() }
            while exp.count > 1, exp.hasPrefix("0") { exp.removeFirst() }
            s = mantissa + "e" + sign + exp
        }
        return s
    }

    static func quote(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }
}

extension NetJSON: CustomStringConvertible {
    public var description: String { text }
}

/* --------------------------------------------------------------- Codable */

extension NetJSON: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([NetJSON].self) { self = .array(a); return }
        if let o = try? c.decode([String: NetJSON].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/* ------------------------------------------------------------- helpers */

extension NetJSON {
    /// `.string` of `s`, or `.null` for nil.
    public static func string(_ s: String?) -> NetJSON { s.map { .string($0) } ?? .null }
    /// An array of strings.
    public static func strings(_ list: [String]) -> NetJSON { .array(list.map { .string($0) }) }
    /// An object without the nil values (an optional field is left out, as `...(x ? {x} : {})` does).
    public static func compact(_ fields: [String: NetJSON?]) -> NetJSON {
        var o: [String: NetJSON] = [:]
        for (k, v) in fields { if let v { o[k] = v } }
        return .object(o)
    }
}
