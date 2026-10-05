// The repository's vector files (docs/ios-architecture.md § 6), read relative
// to this file: test/vectors/p4.json, test/vectors/nfc-tag-v2.json,
// test/fixtures/android-interop.json and the Android test resources.

import Foundation
import M5Core
@testable import M5Crypto
import Testing

enum Repo {
    /// The repository root (ios/M5Kit/Tests/M5CryptoTests/<file> → four levels up).
    static let root: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    static func json(_ relative: String) throws -> JSON {
        try JSON.parse(Array(try Data(contentsOf: root.appendingPathComponent(relative))))
    }

    static let p4: JSON = try! json("test/vectors/p4.json")
}

extension JSON {
    /// A required string field (tests).
    func s(_ key: String) -> String { self[key]?.stringValue ?? { Issue.record("missing string \(key)"); return "" }() }
    func i(_ key: String) -> Int64 { self[key]?.int64Value ?? { Issue.record("missing integer \(key)"); return 0 }() }
    func o(_ key: String) -> JSON { self[key] ?? { Issue.record("missing \(key)"); return .null }() }
    func a(_ key: String) -> [JSON] { self[key]?.arrayValue ?? { Issue.record("missing array \(key)"); return [] }() }
    var obj: JSONObject { objectValue ?? JSONObject() }
}

/// A copy of an object without `field`.
func without(_ o: JSON, _ field: String) -> JSON { .object((o.objectValue ?? JSONObject()).without(field)) }

func text(_ b: Bytes) -> String { String(decoding: b, as: UTF8.self) }

func bytes(_ n: Int, _ f: (Int) -> Int) -> Bytes { (0..<n).map { UInt8(truncatingIfNeeded: f($0)) } }

func b64(_ s: String) -> Bytes { B64.decode(s)! }

/// Expects `body` to throw a P4Error with `code`.
func expectP4(_ code: String, _ comment: Comment? = nil, sourceLocation: SourceLocation = #_sourceLocation, _ body: () throws -> Void) {
    do {
        try body()
        Issue.record(Comment(rawValue: "expected P4Error \(code) \(comment.map { "\($0)" } ?? "")"), sourceLocation: sourceLocation)
    } catch let e as P4Error {
        #expect(e.code == code, comment, sourceLocation: sourceLocation)
    } catch {
        Issue.record("expected P4Error \(code), got \(error)", sourceLocation: sourceLocation)
    }
}
