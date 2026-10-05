// DesignValue — a JSON value as the design and the screens' expressions see it
// (Android: what org.json gives Expr — String, Number, Boolean, JSONObject,
// JSONArray, null). Numbers are Doubles, as Expr treats every number.

import Foundation

public enum DesignValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([DesignValue])
    case object([String: DesignValue])

    // MARK: accessors

    public var isNull: Bool { if case .null = self { return true } else { return false } }
    public var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    public var numberValue: Double? { if case .number(let d) = self { return d } else { return nil } }
    public var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
    public var arrayValue: [DesignValue]? { if case .array(let a) = self { return a } else { return nil } }
    public var objectValue: [String: DesignValue]? { if case .object(let o) = self { return o } else { return nil } }

    /// A member of an object (`.null` when this is not an object or has no such key).
    public subscript(key: String) -> DesignValue {
        get { objectValue?[key] ?? .null }
        set {
            guard case .object(var o) = self else { return }
            o[key] = newValue
            self = .object(o)
        }
    }

    /// An element of an array (`.null` outside it).
    public subscript(index: Int) -> DesignValue {
        guard case .array(let a) = self, index >= 0, index < a.count else { return .null }
        return a[index]
    }

    /// org.json's optString: a string as it is, a number or a boolean as text, otherwise the default.
    public func optString(_ dflt: String? = nil) -> String? {
        switch self {
        case .string(let s): return s
        case .number, .bool: return Expr.toText(self)
        default: return dflt
        }
    }

    /// org.json's optDouble: a number, or a string that parses as one, otherwise the default.
    public func optDouble(_ dflt: Double) -> Double {
        switch self {
        case .number(let d): return d
        case .string(let s): return JavaSemantics.parseDouble(s) ?? dflt
        default: return dflt
        }
    }

    /// org.json's optBoolean: a boolean, or the strings "true" / "false" (any case), otherwise the default.
    public func optBool(_ dflt: Bool) -> Bool {
        switch self {
        case .bool(let b): return b
        case .string(let s):
            if s.lowercased() == "true" { return true }
            if s.lowercased() == "false" { return false }
            return dflt
        default: return dflt
        }
    }
}

// MARK: - literals (tests, scopes built in code)

extension DesignValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
    ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(nilLiteral: ()) { self = .null }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(stringLiteral value: String) { self = .string(value) }
    public init(arrayLiteral elements: DesignValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, DesignValue)...) {
        var o: [String: DesignValue] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
}

// MARK: - JSON

extension DesignValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let d = try? c.decode(Double.self) { self = .number(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([DesignValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: DesignValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let d):
            // Whole numbers as integers (what the server writes), the rest as they are.
            if d.isFinite, d == d.rounded(), abs(d) < 9.007199254740992e15 { try c.encode(Int64(d)) } else { try c.encode(d) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Parses JSON text (any value, not only an object or an array).
    public static func parse(_ data: Data) throws -> DesignValue {
        let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return DesignValue(any: any)
    }

    public static func parse(_ text: String) throws -> DesignValue { try parse(Data(text.utf8)) }

    /// A value from what JSONSerialization gives (NSNumber booleans told apart from numbers).
    public init(any: Any?) {
        switch any {
        case nil: self = .null
        case is NSNull: self = .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { DesignValue(any: $0) })
        case let o as [String: Any]:
            var out: [String: DesignValue] = [:]
            out.reserveCapacity(o.count)
            for (k, v) in o { out[k] = DesignValue(any: v) }
            self = .object(out)
        default: self = .null
        }
    }

    /// JSON text (sorted keys, so equal values give equal text).
    public func jsonText() -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let d = try? enc.encode(self) else { return "null" }
        return String(decoding: d, as: UTF8.self)
    }
}
