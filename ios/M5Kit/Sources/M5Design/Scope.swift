// What an expression sees: the variables of a screen ($app, $form, $settings,
// $msg, $room, $log…) and the design's texts (_('key'), {_'key'}).
// Android: Expr.Scope / Expr.Translate, MainActivity.scopeFor, Renderer.child.

import Foundation

/// The variables of one evaluation. A value type: a screen's scope, a repeated
/// item's scope (`each` adds the item, `index`, `first`, `last`), a change
/// event's scope (`value`) are copies with names added.
public struct Scope: Sendable, Hashable {
    public private(set) var variables: [String: DesignValue]

    public init(_ variables: [String: DesignValue] = [:]) { self.variables = variables }

    /// The variable's value; `.null` when the scope does not have it.
    public func get(_ name: String) -> DesignValue { variables[name] ?? .null }

    public subscript(name: String) -> DesignValue {
        get { get(name) }
        set { variables[name] = newValue }
    }

    /// The same scope with one more (or a replaced) variable.
    public func with(_ name: String, _ value: DesignValue) -> Scope {
        var s = self
        s.variables[name] = value
        return s
    }

    /// A repeated item's scope (Renderer.child): the item under its name, then
    /// `index`, `first`, `last`; the item's name wins over the three.
    public func child(_ name: String, value: DesignValue, index: Int, count: Int) -> Scope {
        var s = self
        s.variables["index"] = .number(Double(index))
        s.variables["first"] = .bool(index == 0)
        s.variables["last"] = .bool(index == count - 1)
        s.variables[name] = value
        return s
    }

    public static let empty = Scope()
}

/// The design's texts for expressions and templates, and the language the date
/// filters write in (Android: Expr.Translate with t(key) and lang()).
public struct Translator: Sendable {
    /// The app's language (`nil`: the date filters write the fixed "5. 10. 2026 14:05" form).
    public var lang: String?
    /// The time zone of the date filters (`nil`: the device's).
    public var timeZone: TimeZone?
    private let lookup: @Sendable (String) -> String

    public init(lang: String? = nil, timeZone: TimeZone? = nil, _ lookup: @escaping @Sendable (String) -> String) {
        self.lang = lang
        self.timeZone = timeZone
        self.lookup = lookup
    }

    /// The design's texts in a language (MainActivity.tr: app.t(key), app.lang()).
    public init(design: Design, lang: String, timeZone: TimeZone? = nil) {
        self.init(lang: lang, timeZone: timeZone) { design.t($0, lang: lang) }
    }

    public func t(_ key: String) -> String { lookup(key) }

    /// The key itself (no texts).
    public static let keys = Translator { $0 }
}
