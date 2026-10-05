// JSON records of the security code, read as leniently as Android's org.json
// (optInt, optString, optLong…) and written compactly. The formats that cross to
// Android or the server (lock inbox items, the signed policy, the wipe report)
// keep Android's field names.

import Foundation

typealias SecRecord = [String: Any]

enum SecJSON {
    static func parse(_ data: Data) -> SecRecord? {
        (try? JSONSerialization.jsonObject(with: data)) as? SecRecord
    }

    static func parse(_ text: String) -> SecRecord? { parse(Bytes.utf8(text)) }

    static func data(_ o: SecRecord) -> Data {
        (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
    }

    static func string(_ o: SecRecord) -> String { Bytes.str(data(o)) ?? "{}" }

    fileprivate static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }
}

/// org.json's opt… readers (prefixed: other parts of the app may extend dictionaries too).
extension Dictionary where Key == String, Value == Any {
    func jInt(_ key: String, _ fallback: Int = 0) -> Int {
        switch self[key] {
        case let n as NSNumber where !SecJSON.isBool(n): n.intValue
        case let s as String: Int(s) ?? fallback
        default: fallback
        }
    }

    func jInt64(_ key: String, _ fallback: Int64 = 0) -> Int64 {
        switch self[key] {
        case let n as NSNumber where !SecJSON.isBool(n): n.int64Value
        case let s as String: Int64(s) ?? fallback
        default: fallback
        }
    }

    func jString(_ key: String, _ fallback: String = "") -> String {
        switch self[key] {
        case let s as String: s
        case let n as NSNumber: n.stringValue
        default: fallback
        }
    }

    func jBool(_ key: String, _ fallback: Bool = false) -> Bool {
        switch self[key] {
        case let n as NSNumber: n.boolValue
        case let s as String: s == "true" ? true : s == "false" ? false : fallback
        default: fallback
        }
    }

    func jObject(_ key: String) -> SecRecord? { self[key] as? SecRecord }

    func jHas(_ key: String) -> Bool {
        guard let v = self[key] else { return false }
        return !(v is NSNull)
    }
}
