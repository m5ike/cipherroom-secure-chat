// The design files the app bundle carries (the "Copy design assets" build phase copies
// them from android/app/src/main/assets/m5/): the built-in design, the Lucide icons and
// the look's templates — read once (Android: Design.builtIn, Icons.load, Appearance).

import Foundation
import M5Design
import os

@MainActor
enum DesignAssets {
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "design")

    static func url(_ name: String) -> URL? { Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "m5") }

    /// default-design.json (source "built-in"). A missing or broken file leaves an empty design (no screens).
    static let builtIn: Design = {
        do {
            guard let u = url("default-design") else { throw DesignLoadError("no m5/default-design.json in the bundle") }
            return try Design.fromJSON(Data(contentsOf: u))
        } catch {
            log.fault("the built-in design does not load: \(String(describing: error), privacy: .public)")
            return Design.fromDocument(DesignDocument(value: .object([:])))
        }
    }()

    static let icons: IconSet = {
        guard let u = url("icons"), let data = try? Data(contentsOf: u), let set = try? IconSet(json: data) else {
            log.error("m5/icons.json does not load")
            return IconSet(icons: [:])
        }
        return set
    }()

    static let templates: [LookTemplate] = {
        guard let u = url("themes"), let data = try? Data(contentsOf: u), let list = try? LookTemplate.list(data) else {
            log.error("m5/themes.json does not load")
            return []
        }
        return list
    }()
}
