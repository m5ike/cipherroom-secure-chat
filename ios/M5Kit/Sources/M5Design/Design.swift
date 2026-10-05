// A design as the app uses it (android/…/design/Design.java): the screens'
// element trees, the theme, the animations, the texts, the menus, the action
// libraries, the assets — from the active bundle, or the built-in default
// (default-design.json, generated from the server's DEFAULT_DESIGN).

import Foundation

public struct DesignLoadError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public final class Design: Sendable {
    /// "built-in" or the bundle's id.
    public let source: String
    /// The design's rev (built-in) or the bundle's version.
    public let version: String
    public let document: DesignDocument
    /// The assets' bytes by name (an image element's "asset:<name>").
    public let assets: [String: Data]
    /// 6.13: where a text this design lacks comes from — the built-in design (bundles only).
    public let fallback: Design?

    /// The screens a bundle must have (Design.fromFiles).
    public static let requiredScreens = ["splash", "lock", "rooms", "room", "message.in", "message.out", "message.sys"]

    public init(source: String, version: String, document: DesignDocument, assets: [String: Data] = [:], fallback: Design? = nil) {
        self.source = source
        self.version = version
        self.document = document
        self.assets = assets
        self.fallback = fallback
    }

    /// A whole design as default-design.json has it (source "built-in", version = its rev or "default").
    public static func fromJSON(_ data: Data) throws -> Design {
        let doc = try DesignDocument.parse(data)
        var assets: [String: Data] = [:]
        for (name, a) in doc.assets { if let b = a.bytes { assets[name] = b } }
        return Design(source: "built-in", version: doc.rev ?? "default", document: doc, assets: assets)
    }

    public static func fromDocument(_ doc: DesignDocument, source: String = "built-in") -> Design {
        var assets: [String: Data] = [:]
        for (name, a) in doc.assets { if let b = a.bytes { assets[name] = b } }
        return Design(source: source, version: doc.rev ?? "default", document: doc, assets: assets)
    }

    /// From a bundle's files; throws when anything essential is missing or malformed.
    public static func fromFiles(bundleId: String, version: String, files: [String: Data]) throws -> Design {
        func object(_ path: String) throws -> DesignValue {
            guard let b = files[path] else { throw DesignLoadError("the bundle has no \(path)") }
            let v: DesignValue
            do { v = try DesignValue.parse(b) } catch { throw DesignLoadError("\(path) is not JSON") }
            guard v.objectValue != nil else { throw DesignLoadError("\(path) is not a JSON object") }
            return v
        }
        var o: [String: DesignValue] = [
            "format": 1, "rev": .string(version),
            "app": try object("app.json"), "theme": try object("theme.json"), "animations": try object("animations.json"),
        ]
        var screens: [String: DesignValue] = [:], menus: [String: DesignValue] = [:], strings: [String: DesignValue] = [:], libs: [String: DesignValue] = [:]
        var assets: [String: Data] = [:]
        for (p, data) in files {
            func json(_ prefix: String) throws -> (String, DesignValue) {
                guard p.hasSuffix(".json"), p.count > prefix.count + 5 else { throw DesignLoadError("\(p) is not a JSON file") }
                let name = String(p.dropFirst(prefix.count).dropLast(5))
                do { return (name, try DesignValue.parse(data)) } catch { throw DesignLoadError("\(p) is not JSON") }
            }
            if p.hasPrefix("screens/") {
                let (n, v) = try json("screens/"); guard v.objectValue != nil else { throw DesignLoadError("\(p) is not a JSON object") }; screens[n] = v
            } else if p.hasPrefix("menus/") {
                let (n, v) = try json("menus/"); guard v.arrayValue != nil else { throw DesignLoadError("\(p) is not a JSON array") }; menus[n] = v
            } else if p.hasPrefix("strings/") {
                let (n, v) = try json("strings/"); guard v.objectValue != nil else { throw DesignLoadError("\(p) is not a JSON object") }; strings[n] = v
            } else if p.hasPrefix("lib/") {
                let (n, v) = try json("lib/"); guard v.objectValue != nil else { throw DesignLoadError("\(p) is not a JSON object") }; libs[n] = v
            } else if p.hasPrefix("assets/") {
                assets[String(p.dropFirst(7))] = data
            }
        }
        for required in requiredScreens where screens[required] == nil { throw DesignLoadError("the bundle has no \(required) screen") }
        if o["theme"]?["light"].objectValue == nil { throw DesignLoadError("the bundle has no theme") }
        o["screens"] = .object(screens)
        o["menus"] = .object(menus)
        o["strings"] = .object(strings)
        o["libraries"] = .object(libs)
        return Design(source: bundleId, version: version, document: DesignDocument(value: .object(o)), assets: assets)
    }

    /// The same design with the built-in one behind its texts (never its own fallback).
    public func withFallback(_ builtIn: Design) -> Design {
        if builtIn === self && fallback == nil { return self }
        return Design(source: source, version: version, document: document, assets: assets, fallback: builtIn === self ? nil : builtIn)
    }

    // MARK: parts

    public func screen(_ id: String) -> DesignNode? { document.screens[id] }

    /// A menu's items (nil when the design has no such menu).
    public func menu(_ id: String) -> [DesignMenuItem]? { document.menus[id] ?? nil }

    public func library(_ name: String) -> DesignLibrary? { document.libraries[name] }

    public var appName: String { document.appName ?? "M5cet" }

    public var theme: DesignTheme? { document.theme }

    /// The theme's corner radius (dp), 14 without a theme.
    public var radius: Int { document.theme?.radius ?? 14 }

    public var font: String { document.theme?.font ?? "sans" }

    /// An animation of the design (an empty one when it has none).
    public func anim(_ name: String) -> AnimSpec { document.animations?[name] ?? AnimSpec() }

    // MARK: texts

    /// A text in a language along the language's chain, this design's table first, then the
    /// built-in design's, in each language; the key itself when nobody has it.
    public func t(_ key: String, lang: String?, languages: DesignLanguage = BuiltInLanguages()) -> String {
        text(key, lang: lang, languages: languages) ?? key
    }

    /// The same, or nil when no table along the chain has the key.
    public func text(_ key: String, lang: String?, languages: DesignLanguage = BuiltInLanguages()) -> String? {
        for l in languages.chain(lang) { if let v = either(key, l) { return v } }
        return nil
    }

    /// A text shown with a count: in each language of the chain the form of n's plural
    /// category ("key#few"), then "key#other", then the plain key — "{n}" replaced by the
    /// number as the asked language writes it.
    public func tn(_ key: String, _ n: Int64, lang: String?, languages: DesignLanguage = BuiltInLanguages()) -> String {
        var v: String?
        for l in languages.chain(lang) {
            let cat = languages.pluralCategory(l, n)
            v = either(key + "#" + cat, l)
            if v == nil && cat != "other" { v = either(key + "#other", l) }
            if v == nil { v = either(key, l) }
            if v != nil { break }
        }
        guard let v else { return key }
        return v.replacingOccurrences(of: "{n}", with: languages.count(lang, n))
    }

    private func either(_ key: String, _ lang: String) -> String? { own(key, lang) ?? fallback?.own(key, lang) }

    private func own(_ key: String, _ lang: String) -> String? { document.strings[lang]?[key] }

    // MARK: colours

    /// A colour: "@token" (the user's look first, then the theme's tone), "#rrggbb", "#aarrggbb"
    /// or a colour name; `fallback` for anything else.
    public func color(_ value: String?, dark: Bool, fallback: DesignColor, appearance: Appearance? = nil) -> DesignColor {
        guard let value, !value.isEmpty else { return fallback }
        if value.hasPrefix("@") {
            let token = String(value.dropFirst())
            if let own = appearance?.override(token, dark: dark) { return own }
            guard let hex = document.theme?.tone(dark: dark)?[token] else { return fallback }
            return DesignColor.parse(hex) ?? fallback
        }
        return DesignColor.parse(value) ?? fallback
    }
}
