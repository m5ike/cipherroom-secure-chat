// Where the fn / profile tests read the repository's shared vectors (the
// Android test resources). Every repository read goes through FnRepo.root.

import Foundation
import M5Core

enum FnRepo {
    /// The repository: five levels above this file (ios/M5Kit/Tests/M5ProtoTests/FnRepo.swift).
    static let root = ProtoRepo.root

    /// A JSON object file of the repository (a path relative to its root).
    static func json(_ relative: String) throws -> JSONObject {
        let data = try Data(contentsOf: root.appendingPathComponent(relative))
        guard let o = try JSON.parse(Array(data)).objectValue else { throw CocoaError(.fileReadCorruptFile) }
        return o
    }

    /// One of android/app/src/test/resources/cz/m5cet/app/fn/*.json.
    static func fnVectors(_ name: String) throws -> JSONObject {
        try json("android/app/src/test/resources/cz/m5cet/app/fn/" + name)
    }
}
