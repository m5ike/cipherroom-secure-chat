// An ordered JSON value — what the NFC contract (client/src/lib/nfc/command.ts:
// NfcCommand, NfcResult, EmvData, MrtdData, the APDU templates) is written in.
// Android carries it as org.json; this is the Swift side, with JavaScript's
// semantics where it matters: objects keep their key order, numbers are doubles
// printed as JSON.stringify prints them, strings escape as JSON.stringify does.

import Foundation
import M5Core

public enum NfcJSON: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([NfcJSON])
    case object(NfcJSONObject)

    /* ------------------------------------------------------------ access */

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var doubleValue: Double? { if case .number(let d) = self { return d }; return nil }
    public var intValue: Int? {
        if case .number(let d) = self, d.isFinite, d >= Double(Int.min), d < Double(Int.max) { return Int(d) }
        return nil
    }
    public var arrayValue: [NfcJSON]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: NfcJSONObject? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
    public var isNumber: Bool { if case .number = self { return true }; return false }
    public var isString: Bool { if case .string = self { return true }; return false }

    public subscript(key: String) -> NfcJSON? { objectValue?[key] }
    public subscript(index: Int) -> NfcJSON? {
        guard case .array(let a) = self, index >= 0, index < a.count else { return nil }
        return a[index]
    }

    /* ------------------------------------------------------------ JS semantics */

    /// `String(v)` as JavaScript writes it (numbers as JSON.stringify prints them).
    public var jsString: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let d): return NfcJSON.numberText(d)
        case .string(let s): return s
        case .array(let a): return a.map { $0.isNull ? "" : $0.jsString }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// JavaScript truthiness.
    public var truthy: Bool {
        switch self {
        case .null: return false
        case .bool(let b): return b
        case .number(let d): return d != 0 && !d.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /* ------------------------------------------------------------ text */

    /// JSON.stringify(value) — compact.
    public var compact: String { var out = ""; write(to: &out, indent: nil, level: 0); return out }

    /// JSON.stringify(value, null, indent).
    public func pretty(indent: Int = 2) -> String { var out = ""; write(to: &out, indent: indent, level: 0); return out }

    func write(to out: inout String, indent: Int?, level: Int) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let d): out += d.isFinite ? NfcJSON.numberText(d) : "null"
        case .string(let s): out += NfcJSON.quote(s)
        case .array(let a):
            if a.isEmpty { out += "[]"; return }
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                if let n = indent { out += "\n" + String(repeating: " ", count: n * (level + 1)) }
                v.write(to: &out, indent: indent, level: level + 1)
            }
            if let n = indent { out += "\n" + String(repeating: " ", count: n * level) }
            out += "]"
        case .object(let o):
            if o.isEmpty { out += "{}"; return }
            out += "{"
            for (i, e) in o.entries.enumerated() {
                if i > 0 { out += "," }
                if let n = indent { out += "\n" + String(repeating: " ", count: n * (level + 1)) }
                out += NfcJSON.quote(e.key)
                out += indent == nil ? ":" : ": "
                e.value.write(to: &out, indent: indent, level: level + 1)
            }
            if let n = indent { out += "\n" + String(repeating: " ", count: n * level) }
            out += "}"
        }
    }

    /// A number as JavaScript prints it: integers without a fraction, others in their shortest form.
    public static func numberText(_ d: Double) -> String {
        if d.isNaN || d.isInfinite { return d.isNaN ? "NaN" : (d > 0 ? "Infinity" : "-Infinity") }
        if d == d.rounded(), abs(d) < 1e21 {
            if abs(d) < 9.2e18 { return String(Int64(d)) }
            return String(format: "%.0f", d)
        }
        var s = "\(d)"
        // Swift writes "1e-05"; JavaScript "0.00001" (down to 1e-7) and "1e-7" after.
        if let e = s.range(of: "e-0") { s.replaceSubrange(e, with: "e-") }
        if s.contains("e"), !s.contains("e-"), !s.contains("e+") { s = s.replacingOccurrences(of: "e", with: "e+") }
        return s
    }

    /// A JSON string literal as JSON.stringify writes it (no escaped "/", non-ASCII as it is).
    public static func quote(_ s: String) -> String {
        var out = "\""
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
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }

    /* ------------------------------------------------------------ parse */

    public struct ParseError: Error, Sendable, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }

    /// Parses JSON text (key order kept, numbers as doubles).
    public static func parse(_ text: String) throws -> NfcJSON {
        var p = Parser(bytes: Array(text.utf8))
        p.skipSpace()
        let v = try p.value(depth: 0)
        p.skipSpace()
        guard p.i == p.bytes.count else { throw ParseError(message: "trailing characters at \(p.i)") }
        return v
    }

    public static func parse(_ data: Data) throws -> NfcJSON { try parse(String(decoding: data, as: UTF8.self)) }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0

        mutating func skipSpace() { while i < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[i]) { i += 1 } }

        func fail(_ m: String) -> ParseError { ParseError(message: "\(m) at \(i)") }

        mutating func value(depth: Int) throws -> NfcJSON {
            guard depth < 512 else { throw fail("nested too deep") }
            guard i < bytes.count else { throw fail("unexpected end") }
            switch bytes[i] {
            case UInt8(ascii: "{"):
                i += 1
                var o = NfcJSONObject()
                skipSpace()
                if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                while true {
                    skipSpace()
                    guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw fail("expected a key") }
                    let k = try string()
                    skipSpace()
                    guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw fail("expected ':'") }
                    i += 1
                    skipSpace()
                    o[k] = try value(depth: depth + 1)
                    skipSpace()
                    guard i < bytes.count else { throw fail("unexpected end") }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                    throw fail("expected ',' or '}'")
                }
            case UInt8(ascii: "["):
                i += 1
                var a = [NfcJSON]()
                skipSpace()
                if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                while true {
                    skipSpace()
                    a.append(try value(depth: depth + 1))
                    skipSpace()
                    guard i < bytes.count else { throw fail("unexpected end") }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                    throw fail("expected ',' or ']'")
                }
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): try word("true"); return .bool(true)
            case UInt8(ascii: "f"): try word("false"); return .bool(false)
            case UInt8(ascii: "n"): try word("null"); return .null
            default: return .number(try number())
            }
        }

        mutating func word(_ w: String) throws {
            let u = Array(w.utf8)
            guard i + u.count <= bytes.count, Array(bytes[i..<i + u.count]) == u else { throw fail("unexpected token") }
            i += u.count
        }

        mutating func number() throws -> Double {
            let start = i
            if i < bytes.count, bytes[i] == UInt8(ascii: "-") { i += 1 }
            var digits = 0
            while i < bytes.count, bytes[i] >= 0x30, bytes[i] <= 0x39 { i += 1; digits += 1 }
            guard digits > 0 else { throw fail("bad number") }
            if i < bytes.count, bytes[i] == UInt8(ascii: ".") {
                i += 1
                var f = 0
                while i < bytes.count, bytes[i] >= 0x30, bytes[i] <= 0x39 { i += 1; f += 1 }
                guard f > 0 else { throw fail("bad number") }
            }
            if i < bytes.count, bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E") {
                i += 1
                if i < bytes.count, bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-") { i += 1 }
                var e = 0
                while i < bytes.count, bytes[i] >= 0x30, bytes[i] <= 0x39 { i += 1; e += 1 }
                guard e > 0 else { throw fail("bad number") }
            }
            guard let d = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else { throw fail("bad number") }
            return d
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= bytes.count else { throw fail("bad escape") }
            var v: UInt32 = 0
            for k in 0..<4 {
                guard let n = Hex.nibble(bytes[i + k]) else { throw fail("bad escape") }
                v = v << 4 | UInt32(n)
            }
            i += 4
            return v
        }

        mutating func string() throws -> String {
            i += 1 // the opening quote
            var out = [UInt8]()
            while true {
                guard i < bytes.count else { throw fail("unterminated string") }
                let c = bytes[i]
                if c == UInt8(ascii: "\"") { i += 1; break }
                if c == UInt8(ascii: "\\") {
                    i += 1
                    guard i < bytes.count else { throw fail("bad escape") }
                    let e = bytes[i]
                    i += 1
                    switch e {
                    case UInt8(ascii: "\""): out.append(0x22)
                    case UInt8(ascii: "\\"): out.append(0x5c)
                    case UInt8(ascii: "/"): out.append(0x2f)
                    case UInt8(ascii: "b"): out.append(0x08)
                    case UInt8(ascii: "f"): out.append(0x0c)
                    case UInt8(ascii: "n"): out.append(0x0a)
                    case UInt8(ascii: "r"): out.append(0x0d)
                    case UInt8(ascii: "t"): out.append(0x09)
                    case UInt8(ascii: "u"):
                        var v = try hex4()
                        if v >= 0xd800, v < 0xdc00, i + 6 <= bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                            let save = i
                            i += 2
                            let lo = try hex4()
                            if lo >= 0xdc00, lo < 0xe000 { v = 0x10000 + ((v - 0xd800) << 10) + (lo - 0xdc00) } else { i = save }
                        }
                        let scalar = Unicode.Scalar(v) ?? "\u{FFFD}"
                        out.append(contentsOf: Array(String(Character(scalar)).utf8))
                    default: throw fail("bad escape")
                    }
                    continue
                }
                out.append(c)
                i += 1
            }
            return String(decoding: out, as: UTF8.self)
        }
    }
}

/// A JSON object that keeps its keys in insertion order (as JavaScript does).
public struct NfcJSONObject: Sendable, Hashable, Sequence {
    public struct Entry: Sendable, Hashable { public let key: String; public var value: NfcJSON }
    public private(set) var entries: [Entry] = []

    public init() {}
    public init(_ pairs: [(String, NfcJSON)]) { for (k, v) in pairs { self[k] = v } }

    public var count: Int { entries.count }
    public var isEmpty: Bool { entries.isEmpty }
    public var keys: [String] { entries.map(\.key) }
    public func makeIterator() -> IndexingIterator<[Entry]> { entries.makeIterator() }

    public subscript(key: String) -> NfcJSON? {
        get { entries.first { $0.key == key }?.value }
        set {
            if let i = entries.firstIndex(where: { $0.key == key }) {
                if let v = newValue { entries[i].value = v } else { entries.remove(at: i) }
            } else if let v = newValue {
                entries.append(Entry(key: key, value: v))
            }
        }
    }

    public func has(_ key: String) -> Bool { entries.contains { $0.key == key } }
    public mutating func remove(_ key: String) { self[key] = nil }

    /// Sets a value and returns self (chaining, like org.json `put`).
    @discardableResult
    public mutating func put(_ key: String, _ value: NfcJSON) -> NfcJSONObject { self[key] = value; return self }

    /// A copy with a value set.
    public func with(_ key: String, _ value: NfcJSON) -> NfcJSONObject { var c = self; c[key] = value; return c }

    /* ---- org.json-like optional getters ---- */

    /// The value as text: a string as it is, a number or boolean as JavaScript prints it; `fallback` when absent or null.
    public func optString(_ key: String, _ fallback: String = "") -> String {
        guard let v = self[key] else { return fallback }
        switch v {
        case .null: return fallback
        case .string(let s): return s
        case .number, .bool: return v.jsString
        case .array, .object: return v.compact
        }
    }

    /// A string value only (nil for anything else).
    public func string(_ key: String) -> String? { self[key]?.stringValue }

    public func optInt(_ key: String, _ fallback: Int = 0) -> Int {
        guard let v = self[key] else { return fallback }
        if let i = v.intValue { return i }
        if let s = v.stringValue, let d = Double(s), d.isFinite, d >= Double(Int.min), d < Double(Int.max) { return Int(d) }
        return fallback
    }

    /// A whole number of any size the platform's Int may not hold (milliseconds since 1970 on Apple Watch).
    public func optInt64(_ key: String, _ fallback: Int64 = 0) -> Int64 {
        guard let d = self[key]?.doubleValue ?? self[key]?.stringValue.flatMap(Double.init), d.isFinite, abs(d) < 9.2e18 else { return fallback }
        return Int64(d)
    }

    public func optDouble(_ key: String, _ fallback: Double = 0) -> Double {
        guard let v = self[key] else { return fallback }
        if let d = v.doubleValue { return d }
        if let s = v.stringValue, let d = Double(s) { return d }
        return fallback
    }

    public func optBool(_ key: String, _ fallback: Bool = false) -> Bool {
        guard let v = self[key] else { return fallback }
        if let b = v.boolValue { return b }
        if let s = v.stringValue { if s.lowercased() == "true" { return true }; if s.lowercased() == "false" { return false } }
        return fallback
    }

    public func optObject(_ key: String) -> NfcJSONObject? { self[key]?.objectValue }
    public func optArray(_ key: String) -> [NfcJSON]? { self[key]?.arrayValue }

    /// The strings of an array value (each element as JavaScript prints it).
    public func strings(_ key: String) -> [String] { (optArray(key) ?? []).map(\.jsString) }

    /// The objects of an array value.
    public func objects(_ key: String) -> [NfcJSONObject] { (optArray(key) ?? []).compactMap(\.objectValue) }

    /// The length of an array value (0 when absent).
    public func arrayCount(_ key: String) -> Int { optArray(key)?.count ?? 0 }

    public var json: NfcJSON { .object(self) }
    public var compact: String { NfcJSON.object(self).compact }
}

/* ------------------------------------------------------------ literals */

extension NfcJSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: NfcJSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, NfcJSON)...) { self = .object(NfcJSONObject(elements)) }
    public init(nilLiteral: ()) { self = .null }
}

extension NfcJSONObject: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, NfcJSON)...) { self.init(elements) }
}

extension NfcJSON {
    public init(_ s: String) { self = .string(s) }
    public init(_ i: Int) { self = .number(Double(i)) }
    public init(_ b: Bool) { self = .bool(b) }
    public init(_ strings: [String]) { self = .array(strings.map { .string($0) }) }
    public init(_ o: NfcJSONObject) { self = .object(o) }
}
