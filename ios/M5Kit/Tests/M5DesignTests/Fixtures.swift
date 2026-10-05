import Foundation
@testable import M5Design

/// Files of the repository the tests read (docs/ios-architecture.md § 6: vectors from the repo itself).
enum Fixtures {
    /// The repository's root (this file is ios/M5Kit/Tests/M5DesignTests/Fixtures.swift).
    static let repo: URL = {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }
        return u
    }()

    static func url(_ relative: String) -> URL { repo.appendingPathComponent(relative) }

    static func data(_ relative: String) throws -> Data { try Data(contentsOf: url(relative)) }

    static func json(_ relative: String) throws -> DesignValue { try DesignValue.parse(data(relative)) }

    static let assets = "android/app/src/main/assets/m5/"
    static let here = "ios/M5Kit/Tests/M5DesignTests/fixtures/"

    /// The built-in design (default-design.json), read once.
    static let builtIn: Design = try! Design.fromJSON(Data(contentsOf: url(assets + "default-design.json")))

    static let templates: [LookTemplate] = (try? LookTemplate.list(Data(contentsOf: url(assets + "themes.json")))) ?? []

    /// 6.14: what the iOS app ships (script/ios-assets.ts → ios/Design/m5/, the build phase "Copy design assets"):
    /// Android's default design with the iOS look and the iOS-only items, the same icons, the iOS look first.
    static let iosAssets = "ios/Design/m5/"
    static let iosBuiltIn: Design = try! Design.fromJSON(Data(contentsOf: url(iosAssets + "default-design.json")))
    static let iosTemplates: [LookTemplate] = (try? LookTemplate.list(Data(contentsOf: url(iosAssets + "themes.json")))) ?? []
}

extension DesignValue {
    /// A JSON object from Swift literals (tests).
    static func obj(_ pairs: KeyValuePairs<String, DesignValue>) -> DesignValue {
        var o: [String: DesignValue] = [:]
        for (k, v) in pairs { o[k] = v }
        return .object(o)
    }
}
