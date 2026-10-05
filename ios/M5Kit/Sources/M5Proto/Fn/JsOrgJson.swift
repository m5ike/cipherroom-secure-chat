// org.json's lenient reads, as the Android ports call them (optString,
// optBoolean, optLong, optInt of the reference org.json the JVM tests use):
// a number or a boolean read as text, "true" / "false" strings read as
// booleans, numbers truncated toward zero, numeric strings read as numbers.

import M5Core

extension JSONObject {
    /// org.json optString(k, fallback): a string as it is, a number or a boolean as text, null / absent → fallback.
    func orgString(_ key: String, _ fallback: String = "") -> String { Js.orgText(self[key], fallback) }

    /// org.json optBoolean(k): true / false, or the strings "true" / "false" (any case).
    func orgBool(_ key: String, _ fallback: Bool = false) -> Bool { Js.orgBoolValue(self[key]) ?? fallback }

    /// org.json optLong(k, fallback): a number truncated, or a string that is one.
    func orgLong(_ key: String, _ fallback: Int64 = 0) -> Int64 { Js.orgLongValue(self[key]) ?? fallback }

    /// org.json optInt(k, fallback): the same, as Java's int.
    func orgInt(_ key: String, _ fallback: Int = 0) -> Int { Js.orgLongValue(self[key]).map { Int(Int32(truncatingIfNeeded: $0)) } ?? fallback }
}

extension Js {
    /// org.json's text of a value (optString): nil and JSON null give `fallback`.
    static func orgText(_ v: JSON?, _ fallback: String = "") -> String {
        guard let v else { return fallback }
        switch v {
        case .null: return fallback
        case .string(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n.description
        case .array, .object: return v.stringify()
        }
    }

    /// org.json's boolean of a value.
    static func orgBoolValue(_ v: JSON?) -> Bool? {
        switch v {
        case .bool(let b)?: return b
        case .string(let s)?:
            let l = asciiLower(s)
            return l == "true" ? true : l == "false" ? false : nil
        default: return nil
        }
    }

    /// org.json's long of a value: a number truncated toward zero (saturated), or a string that is one.
    static func orgLongValue(_ v: JSON?) -> Int64? {
        func long(_ d: Double) -> Int64 {
            if d.isNaN { return 0 }
            if d >= 9.223372036854775807e18 { return Int64.max }
            if d <= -9.223372036854775808e18 { return Int64.min }
            return Int64(d.rounded(.towardZero))
        }
        switch v {
        case .number(let n)?: return n.int ?? long(n.double)
        case .string(let s)?:
            let t = s.javaTrimmed
            if let i = Int64(t) { return i }
            guard isDecimal(Array(t.utf8)), let d = Double(t) else { return nil }
            return long(d)
        default: return nil
        }
    }
}
