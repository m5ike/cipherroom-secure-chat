// A JSON value as the web client sees it: objects keep their keys' order,
// `parse` is JavaScript's JSON.parse (strict), `stringify` JavaScript's
// JSON.stringify (no spaces, the same escapes and number forms) — so what the
// iOS app writes is byte for byte what the web writes. Integers are kept
// exactly (Int64) when they fit; equality compares numbers by value and
// objects regardless of key order.

import Foundation

public enum JSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(JSONNumber)
    case string(String)
    case array([JSON])
    case object(JSONObject)
}

/// A JSON number: an exact integer when it is one (and fits Int64), else a double.
public struct JSONNumber: Sendable, Hashable, CustomStringConvertible {
    public let int: Int64?
    public let double: Double

    public init(_ v: Int64) { int = v; double = Double(v) }
    public init(_ v: Int) { self.init(Int64(v)) }
    public init(_ v: Double) {
        if v.isFinite, v == v.rounded(), abs(v) < 9.3e18, let i = Int64(exactly: v) { int = i } else { int = nil }
        double = v
    }

    /// The number when it is a whole number that fits Int64.
    public var int64: Int64? { int }
    public var isInteger: Bool { int != nil }

    public static func == (a: JSONNumber, b: JSONNumber) -> Bool {
        if let x = a.int, let y = b.int { return x == y }
        return a.double == b.double
    }

    public func hash(into h: inout Hasher) { h.combine(double) }

    /// JavaScript's Number.prototype.toString for this value.
    public var description: String {
        if let i = int { return String(i) }
        return JSONNumber.jsString(double)
    }

    /// ECMAScript Number::toString(10): the shortest round-trip digits laid out as JavaScript does.
    public static func jsString(_ d: Double) -> String {
        if d.isNaN { return "NaN" }
        if d.isInfinite { return d < 0 ? "-Infinity" : "Infinity" }
        if d == 0 { return "0" }
        let negative = d < 0
        // Swift's description gives the shortest round-trip digits; take them apart.
        var text = "\(abs(d))"
        var exp10 = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exp10 = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        var intPart = text, frac = ""
        if let dot = text.firstIndex(of: ".") {
            intPart = String(text[..<dot])
            frac = String(text[text.index(after: dot)...])
        }
        var digits = intPart + frac
        var n = intPart.count + exp10 // value = 0.digits × 10^n
        while digits.hasPrefix("0") && digits.count > 1 { digits.removeFirst(); n -= 1 }
        while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
        let k = digits.count
        var out: String
        if k <= n && n <= 21 {
            out = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let i = digits.index(digits.startIndex, offsetBy: n)
            out = String(digits[..<i]) + "." + String(digits[i...])
        } else if -6 < n && n <= 0 {
            out = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let e = n - 1
            let sign = e < 0 ? "-" : "+"
            if k == 1 { out = digits + "e" + sign + String(abs(e)) }
            else { out = String(digits.first!) + "." + String(digits.dropFirst()) + "e" + sign + String(abs(e)) }
        }
        return negative ? "-" + out : out
    }
}

/// A JSON object: insertion-ordered keys (as JavaScript keeps them for string keys).
public struct JSONObject: Sendable, Hashable, Sequence {
    public private(set) var keys: [String] = []
    private var values: [String: JSON] = [:]

    public init() {}
    public init(_ pairs: [(String, JSON)]) { for (k, v) in pairs { self[k] = v } }

    public subscript(key: String) -> JSON? {
        get { values[key] }
        set {
            if let v = newValue {
                if values.updateValue(v, forKey: key) == nil { keys.append(key) }
            } else if values.removeValue(forKey: key) != nil {
                keys.removeAll { $0 == key }
            }
        }
    }

    public var count: Int { keys.count }
    public var isEmpty: Bool { keys.isEmpty }
    public func has(_ key: String) -> Bool { values[key] != nil }

    public func makeIterator() -> AnyIterator<(key: String, value: JSON)> {
        var i = 0
        let keys = self.keys, values = self.values
        return AnyIterator {
            guard i < keys.count else { return nil }
            defer { i += 1 }
            return (keys[i], values[keys[i]]!)
        }
    }

    /// A copy with `key` set (builder style).
    public func with(_ key: String, _ value: JSON?) -> JSONObject { var c = self; c[key] = value; return c }
    /// A copy without `key`.
    public func without(_ key: String) -> JSONObject { var c = self; c[key] = nil; return c }

    /// Order-insensitive equality (the vectors' deep equality).
    public static func == (a: JSONObject, b: JSONObject) -> Bool { a.values == b.values }
    public func hash(into h: inout Hasher) { h.combine(values) }

    /* --------------------------------------------- typed reads (org.json opt*) */

    public func string(_ key: String) -> String? { values[key]?.stringValue }
    public func optString(_ key: String, _ fallback: String = "") -> String { values[key]?.stringValue ?? fallback }
    public func int64(_ key: String) -> Int64? { values[key]?.int64Value }
    public func optInt64(_ key: String, _ fallback: Int64 = 0) -> Int64 { values[key]?.numberValue.map { Int64(exactly: $0.double.rounded(.towardZero)) ?? fallback } ?? fallback }
    /// org.json's optInt(key, fallback): a number (truncated toward zero), else the fallback.
    public func optInt(_ key: String, _ fallback: Int = 0) -> Int {
        guard let d = values[key]?.numberValue?.double else { return fallback }
        return Int(exactly: d.rounded(.towardZero)) ?? fallback
    }
    public func int(_ key: String) -> Int? { values[key]?.int64Value.flatMap { Int(exactly: $0) } }
    public func double(_ key: String) -> Double? { values[key]?.numberValue?.double }
    public func bool(_ key: String) -> Bool? { values[key]?.boolValue }
    public func object(_ key: String) -> JSONObject? { values[key]?.objectValue }
    public func array(_ key: String) -> [JSON]? { values[key]?.arrayValue }
    /// Present and not JSON null.
    public func isPresent(_ key: String) -> Bool { if let v = values[key] { return !v.isNull } else { return false } }
}

/* ------------------------------------------------------------- reads */

public extension JSON {
    var isNull: Bool { if case .null = self { return true } else { return false } }
    var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    var numberValue: JSONNumber? { if case .number(let n) = self { return n } else { return nil } }
    /// The number when it is an exact whole number (Int64).
    var int64Value: Int64? { numberValue?.int64 }
    var doubleValue: Double? { numberValue?.double }
    var arrayValue: [JSON]? { if case .array(let a) = self { return a } else { return nil } }
    var objectValue: JSONObject? { if case .object(let o) = self { return o } else { return nil } }

    subscript(key: String) -> JSON? { objectValue?[key] }
    subscript(index: Int) -> JSON? {
        guard let a = arrayValue, index >= 0, index < a.count else { return nil }
        return a[index]
    }

    static func int(_ v: Int64) -> JSON { .number(JSONNumber(v)) }
    static func int(_ v: Int) -> JSON { .number(JSONNumber(v)) }
    static func double(_ v: Double) -> JSON { .number(JSONNumber(v)) }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
                ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral, ExpressibleByFloatLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .number(JSONNumber(value)) }
    public init(floatLiteral value: Double) { self = .number(JSONNumber(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSON)...) { self = .object(JSONObject(elements)) }
    public init(nilLiteral: ()) { self = .null }
}

/* ---------------------------------------------------------- stringify */

public extension JSON {
    /// JavaScript's JSON.stringify(value): no white space, keys in order.
    func stringify() -> String {
        var out = ""
        JSON.write(self, into: &out, sortKeys: false)
        return out
    }

    /// The same with every object's keys sorted (ordinal UTF-16 order) — a canonical form.
    func canonical() -> String {
        var out = ""
        JSON.write(self, into: &out, sortKeys: true)
        return out
    }

    /// The UTF-8 of `stringify()`.
    var utf8Bytes: Bytes { Array(stringify().utf8) }

    private static func write(_ v: JSON, into out: inout String, sortKeys: Bool) {
        switch v {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += n.int != nil || n.double.isFinite ? n.description : "null"
        case .string(let s): out += quote(s)
        case .array(let a):
            out += "["
            for (i, x) in a.enumerated() {
                if i > 0 { out += "," }
                write(x, into: &out, sortKeys: sortKeys)
            }
            out += "]"
        case .object(let o):
            out += "{"
            let keys = sortKeys ? o.keys.sorted(by: Ordinal.less) : o.keys
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                out += quote(k)
                out += ":"
                write(o[k]!, into: &out, sortKeys: sortKeys)
            }
            out += "}"
        }
    }

    /// A JSON string literal as JSON.stringify writes it ("/" and non-ASCII unescaped).
    static func quote(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    let h = String(u.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - h.count) + h
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
        return out
    }
}

public extension JSONObject {
    func stringify() -> String { JSON.object(self).stringify() }
    var json: JSON { .object(self) }
}

/* -------------------------------------------------------------- parse */

public struct JSONParseError: Error, Sendable, CustomStringConvertible {
    public let offset: Int
    public let reason: String
    public var description: String { "JSON: \(reason) at \(offset)" }
}

public extension JSON {
    /// JavaScript's JSON.parse: strict JSON text (white space around it allowed).
    static func parse(_ text: String) throws -> JSON { try parse(Array(text.utf8)) }

    static func parse(_ bytes: Bytes) throws -> JSON {
        var p = Parser(b: bytes)
        p.skip()
        let v = try p.value(depth: 0)
        p.skip()
        if p.i != bytes.count { throw p.fail("unexpected text after the value") }
        return v
    }

    /// The parsed object, or nil when the text is not JSON or not an object.
    static func parseObject(_ text: String) -> JSONObject? { (try? parse(text))?.objectValue }
}

private struct Parser {
    let b: Bytes
    var i = 0
    static let maxDepth = 512

    init(b: Bytes) { self.b = b }

    func fail(_ reason: String) -> JSONParseError { JSONParseError(offset: i, reason: reason) }

    mutating func skip() {
        while i < b.count, b[i] == 0x20 || b[i] == 0x09 || b[i] == 0x0a || b[i] == 0x0d { i += 1 }
    }

    mutating func literal(_ word: String, _ v: JSON) throws -> JSON {
        let w = Array(word.utf8)
        if i + w.count <= b.count && Array(b[i..<i + w.count]) == w { i += w.count; return v }
        throw fail("unexpected character")
    }

    mutating func value(depth: Int) throws -> JSON {
        guard i < b.count else { throw fail("unexpected end") }
        if depth > Parser.maxDepth { throw fail("nested too deeply") }
        switch b[i] {
        case 0x7b: return try object(depth: depth)
        case 0x5b: return try array(depth: depth)
        case 0x22: return .string(try string())
        case 0x74: return try literal("true", .bool(true))
        case 0x66: return try literal("false", .bool(false))
        case 0x6e: return try literal("null", .null)
        case 0x2d, 0x30...0x39: return .number(try number())
        default: throw fail("unexpected character")
        }
    }

    mutating func object(depth: Int) throws -> JSON {
        i += 1
        var o = JSONObject()
        skip()
        if i < b.count && b[i] == 0x7d { i += 1; return .object(o) }
        while true {
            skip()
            guard i < b.count, b[i] == 0x22 else { throw fail("expected a key") }
            let k = try string()
            skip()
            guard i < b.count, b[i] == 0x3a else { throw fail("expected ':'") }
            i += 1
            skip()
            o[k] = try value(depth: depth + 1)
            skip()
            guard i < b.count else { throw fail("unexpected end") }
            if b[i] == 0x2c { i += 1; continue }
            if b[i] == 0x7d { i += 1; return .object(o) }
            throw fail("expected ',' or '}'")
        }
    }

    mutating func array(depth: Int) throws -> JSON {
        i += 1
        var a = [JSON]()
        skip()
        if i < b.count && b[i] == 0x5d { i += 1; return .array(a) }
        while true {
            skip()
            a.append(try value(depth: depth + 1))
            skip()
            guard i < b.count else { throw fail("unexpected end") }
            if b[i] == 0x2c { i += 1; continue }
            if b[i] == 0x5d { i += 1; return .array(a) }
            throw fail("expected ',' or ']'")
        }
    }

    mutating func hex4() throws -> UInt32 {
        guard i + 4 <= b.count else { throw fail("bad \\u escape") }
        var v: UInt32 = 0
        for _ in 0..<4 {
            let c = b[i]
            let d: UInt32
            switch c {
            case 0x30...0x39: d = UInt32(c - 0x30)
            case 0x61...0x66: d = UInt32(c - 0x57)
            case 0x41...0x46: d = UInt32(c - 0x37)
            default: throw fail("bad \\u escape")
            }
            v = v << 4 | d
            i += 1
        }
        return v
    }

    mutating func string() throws -> String {
        i += 1 // the opening quote
        var out = Bytes()
        var start = i
        while true {
            guard i < b.count else { throw fail("unterminated string") }
            let c = b[i]
            if c == 0x22 {
                out.append(contentsOf: b[start..<i])
                i += 1
                guard let s = String(validating: out, as: UTF8.self) else { throw fail("not UTF-8") }
                return s
            }
            if c < 0x20 { throw fail("control character in a string") }
            if c != 0x5c { i += 1; continue }
            out.append(contentsOf: b[start..<i])
            i += 1
            guard i < b.count else { throw fail("unterminated string") }
            let e = b[i]
            i += 1
            switch e {
            case 0x22: out.append(0x22)
            case 0x5c: out.append(0x5c)
            case 0x2f: out.append(0x2f)
            case 0x62: out.append(0x08)
            case 0x66: out.append(0x0c)
            case 0x6e: out.append(0x0a)
            case 0x72: out.append(0x0d)
            case 0x74: out.append(0x09)
            case 0x75:
                var u = try hex4()
                if (0xd800...0xdbff).contains(u), i + 6 <= b.count, b[i] == 0x5c, b[i + 1] == 0x75 {
                    let save = i
                    i += 2
                    let lo = try hex4()
                    if (0xdc00...0xdfff).contains(lo) { u = 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00) } else { i = save }
                }
                // A lone surrogate cannot live in a Swift string: U+FFFD (as a lossy decoder would).
                let scalar = Unicode.Scalar(u) ?? Unicode.Scalar(0xfffd)!
                out.append(contentsOf: Array(String(Character(scalar)).utf8))
            default: throw fail("bad escape")
            }
            start = i
        }
    }

    mutating func number() throws -> JSONNumber {
        let s = i
        if b[i] == 0x2d { i += 1 }
        guard i < b.count else { throw fail("bad number") }
        if b[i] == 0x30 { i += 1 }
        else if (0x31...0x39).contains(b[i]) { while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 } }
        else { throw fail("bad number") }
        var integral = true
        if i < b.count && b[i] == 0x2e {
            integral = false
            i += 1
            guard i < b.count, (0x30...0x39).contains(b[i]) else { throw fail("bad number") }
            while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 }
        }
        if i < b.count && (b[i] == 0x65 || b[i] == 0x45) {
            integral = false
            i += 1
            if i < b.count && (b[i] == 0x2b || b[i] == 0x2d) { i += 1 }
            guard i < b.count, (0x30...0x39).contains(b[i]) else { throw fail("bad number") }
            while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 }
        }
        let text = String(decoding: b[s..<i], as: UTF8.self)
        if integral, let v = Int64(text) { return JSONNumber(v) }
        guard let d = Double(text) else { throw fail("bad number") }
        return JSONNumber(d)
    }
}
