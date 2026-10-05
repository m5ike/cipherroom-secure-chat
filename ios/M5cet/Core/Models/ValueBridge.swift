// The two JSON value types of the app side by side: M5Core's `JSON` / `JSONObject`
// (the protocol, the vault, the network — org.json's semantics) and M5Design's
// `DesignValue` (what the design's expressions read). The models hand the parts
// both: the typed message (`ChatMessage`) and the scope a template sees.

import Foundation
import M5Core
import M5Design

extension DesignValue {
    /// M5Core JSON → the design's value (numbers as doubles, as Expr reads them).
    init(json: JSON) {
        switch json {
        case .null: self = .null
        case .bool(let b): self = .bool(b)
        case .number(let n): self = .number(n.double)
        case .string(let s): self = .string(s)
        case .array(let a): self = .array(a.map { DesignValue(json: $0) })
        case .object(let o): self = .object(o.designObject)
        }
    }

    init(_ object: JSONObject) { self = .object(object.designObject) }

    /// The design's value → M5Core JSON (a whole number stays an integer, as org.json would write it).
    var json: JSON {
        switch self {
        case .null: return .null
        case .bool(let b): return .bool(b)
        case .number(let d):
            if d.isFinite, d == d.rounded(), abs(d) < 9.0e15 { return .int(Int64(d)) }
            return .double(d)
        case .string(let s): return .string(s)
        case .array(let a): return .array(a.map(\.json))
        case .object(let o):
            var out = JSONObject()
            for k in o.keys.sorted() { out[k] = o[k]!.json }
            return .object(out)
        }
    }
}

extension JSONObject {
    /// As the design sees it.
    var designObject: [String: DesignValue] {
        var out = [String: DesignValue]()
        for (k, v) in self { out[k] = DesignValue(json: v) }
        return out
    }

    var designValue: DesignValue { .object(designObject) }
}

extension Dictionary where Key == String, Value == DesignValue {
    /// $form as M5Proto's helpers read it (SendPlan.of, SendPlan.apply).
    var jsonForm: [String: JSON] { mapValues(\.json) }
}

extension Dictionary where Key == String, Value == JSON {
    var designForm: [String: DesignValue] { mapValues { DesignValue(json: $0) } }
}

/// Milliseconds since 1970 — the protocol's clock (System.currentTimeMillis).
enum Millis {
    static var now: Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}
