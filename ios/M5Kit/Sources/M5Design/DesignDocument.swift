// The design document — what server/android/design.ts writes (AndroidDesign)
// and the app reads: assets/m5/default-design.json as a whole, or a bundle's
// files (app.json, theme.json, animations.json, screens/*.json, menus/*.json,
// strings/*.json, lib/*.json, assets/*).
//
// Every type reads leniently, as org.json's opt* do on Android, and keeps the
// keys it does not know in `extra`, so a newer server's design decodes and
// encodes back unchanged (forward compatibility). Codable goes through
// DesignValue: `init(value:)` reads, `value` writes.

import Foundation

/// A type of the design document built from / written to a DesignValue.
public protocol DesignValueConvertible: Codable, Sendable {
    init(value: DesignValue)
    var value: DesignValue { get }
}

extension DesignValueConvertible {
    public init(from decoder: Decoder) throws { self.init(value: try DesignValue(from: decoder)) }
    public func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// Lenient readers (org.json opt* semantics).
enum Opt {
    static func string(_ v: DesignValue?) -> String? { v?.optString(nil) }
    static func object(_ v: DesignValue?) -> [String: DesignValue]? { v?.objectValue }
    static func array(_ v: DesignValue?) -> [DesignValue]? { v?.arrayValue }
    static func stringMap(_ v: DesignValue?) -> [String: String]? {
        guard let o = v?.objectValue else { return nil }
        var out: [String: String] = [:]
        for (k, x) in o { if let s = x.optString(nil) { out[k] = s } }
        return out
    }
    static func extra(_ o: [String: DesignValue], known: Set<String>) -> [String: DesignValue] {
        o.filter { !known.contains($0.key) }
    }
    static func put(_ o: inout [String: DesignValue], _ key: String, _ v: String?) { if let v { o[key] = .string(v) } }
}

// MARK: - node

/// One element of a screen's tree (server/android/design.ts ANode).
public struct DesignNode: DesignValueConvertible, Hashable {
    public var id: String
    /// The element's name as the design wrote it ("column", "text", "swipe"…; an unknown one is kept).
    public var el: String
    public var name: String?
    /// A text template (text, badge, chip, button, switch, checkbox).
    public var text: String?
    /// The element's props: a string is a literal, a template or "=expression"; numbers and booleans as they are.
    public var props: [String: DesignValue]?
    /// Style props (padding, bg, fg, …); a string starting with "=" is an expression.
    public var style: [String: DesignValue]?
    public var anim: NodeAnimation?
    /// `if`: shown only when the expression is truthy.
    public var condition: String?
    /// `each`: an expression giving a list; the node repeats for every item (at most 200).
    public var each: String?
    /// `as`: the item's variable name (default "item").
    public var alias: String?
    /// `on`: event → handler (click, longClick, submit, change).
    public var on: [String: EventHandler]?
    public var children: [DesignNode]?
    /// Keys this version does not know, kept as they are.
    public var extra: [String: DesignValue]

    static let known: Set<String> = ["id", "el", "name", "text", "props", "style", "anim", "if", "each", "as", "on", "children"]

    public init(id: String, el: String, name: String? = nil, text: String? = nil, props: [String: DesignValue]? = nil, style: [String: DesignValue]? = nil,
                anim: NodeAnimation? = nil, condition: String? = nil, each: String? = nil, alias: String? = nil, on: [String: EventHandler]? = nil,
                children: [DesignNode]? = nil, extra: [String: DesignValue] = [:]) {
        self.id = id; self.el = el; self.name = name; self.text = text; self.props = props; self.style = style; self.anim = anim
        self.condition = condition; self.each = each; self.alias = alias; self.on = on; self.children = children; self.extra = extra
    }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        id = Opt.string(o["id"]) ?? ""
        el = Opt.string(o["el"]) ?? ""
        name = Opt.string(o["name"])
        text = Opt.string(o["text"])
        props = Opt.object(o["props"])
        style = Opt.object(o["style"])
        anim = o["anim"]?.objectValue.map { NodeAnimation(value: .object($0)) }
        condition = Opt.string(o["if"])
        each = Opt.string(o["each"])
        alias = Opt.string(o["as"])
        if let on = Opt.object(o["on"]) {
            var handlers: [String: EventHandler] = [:]
            for (k, v) in on where v.objectValue != nil { handlers[k] = EventHandler(value: v) }
            self.on = handlers
        } else {
            on = nil
        }
        // Like Renderer (optJSONObject per child): what is not an object is no child.
        children = Opt.array(o["children"]).map { $0.compactMap { $0.objectValue != nil ? DesignNode(value: $0) : nil } }
        extra = Opt.extra(o, known: Self.known)
    }

    public var value: DesignValue {
        var o = extra
        o["id"] = .string(id)
        o["el"] = .string(el)
        Opt.put(&o, "name", name)
        Opt.put(&o, "text", text)
        if let props { o["props"] = .object(props) }
        if let style { o["style"] = .object(style) }
        if let anim { o["anim"] = anim.value }
        Opt.put(&o, "if", condition)
        Opt.put(&o, "each", each)
        Opt.put(&o, "as", alias)
        if let on { o["on"] = .object(on.mapValues { $0.value }) }
        if let children { o["children"] = .array(children.map { $0.value }) }
        return .object(o)
    }

    /// The element kind (`.unknown` for a name this version does not draw).
    public var element: ElementKind { ElementKind(name: el) }

    /// A prop as Renderer's s(key) reads it: optString (numbers and booleans as text), nil when absent.
    public func propString(_ key: String) -> String? { props?[key].flatMap { $0.isNull ? nil : $0.optString(nil) } }

    /// The raw prop value.
    public func prop(_ key: String) -> DesignValue? { props?[key] }

    /// All nodes of this tree, depth first (this one first).
    public func walk(_ visit: (DesignNode, Int) throws -> Void, depth: Int = 0) rethrows {
        try visit(self, depth)
        for c in children ?? [] { try c.walk(visit, depth: depth + 1) }
    }
}

/// `anim` of a node: its enter animation.
public struct NodeAnimation: DesignValueConvertible, Hashable {
    public var enter: EnterSpec?
    public var extra: [String: DesignValue]

    public init(enter: EnterSpec?, extra: [String: DesignValue] = [:]) { self.enter = enter; self.extra = extra }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        enter = o["enter"]?.objectValue.map { EnterSpec(value: .object($0)) }
        extra = Opt.extra(o, known: ["enter"])
    }

    public var value: DesignValue {
        var o = extra
        if let enter { o["enter"] = enter.value }
        return .object(o)
    }
}

/// An enter animation as the design states it (type, ms, delay, easing).
public struct EnterSpec: DesignValueConvertible, Hashable {
    public var values: [String: DesignValue]
    public init(value: DesignValue) { values = value.objectValue ?? [:] }
    public init(type: String, ms: Double? = nil, delay: Double? = nil, easing: String? = nil) {
        values = ["type": .string(type)]
        if let ms { values["ms"] = .number(ms) }
        if let delay { values["delay"] = .number(delay) }
        if let easing { values["easing"] = .string(easing) }
    }
    public var value: DesignValue { .object(values) }
    /// optString("type", "fade")
    public var type: String { values["type"]?.optString(nil) ?? "fade" }
    /// optLong("ms", 220)
    public var ms: Double { values["ms"].map { $0.optDouble(220) } ?? 220 }
    public var delay: Double { values["delay"].map { $0.optDouble(0) } ?? 0 }
    public var easing: String? { values["easing"]?.optString(nil) }
}

/// A handler of an event: an action and its argument as the design wrote it.
public struct EventHandler: DesignValueConvertible, Hashable {
    public var action: String
    /// The argument as written: a literal, a template, or "=expression"; nil: none.
    public var arg: String?
    public var extra: [String: DesignValue]

    public init(action: String, arg: String? = nil, extra: [String: DesignValue] = [:]) { self.action = action; self.arg = arg; self.extra = extra }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        action = Opt.string(o["action"]) ?? ""
        arg = o["arg"].flatMap { $0.isNull ? nil : $0.optString(nil) }
        extra = Opt.extra(o, known: ["action", "arg"])
    }

    public var value: DesignValue {
        var o = extra
        o["action"] = .string(action)
        Opt.put(&o, "arg", arg)
        return .object(o)
    }
}

// MARK: - menus, libraries, assets

/// An item of a design menu (main, room, dock, a swipe row's sides…).
public struct DesignMenuItem: DesignValueConvertible, Hashable {
    public var id: String
    public var icon: String
    public var label: String
    public var action: String
    public var arg: String?
    public var condition: String?
    public var extra: [String: DesignValue]

    public init(id: String, icon: String, label: String, action: String, arg: String? = nil, condition: String? = nil, extra: [String: DesignValue] = [:]) {
        self.id = id; self.icon = icon; self.label = label; self.action = action; self.arg = arg; self.condition = condition; self.extra = extra
    }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        id = Opt.string(o["id"]) ?? ""
        icon = Opt.string(o["icon"]) ?? ""
        label = Opt.string(o["label"]) ?? ""
        action = Opt.string(o["action"]) ?? ""
        arg = o["arg"].flatMap { $0.isNull ? nil : $0.optString(nil) }
        condition = Opt.string(o["if"])
        extra = Opt.extra(o, known: ["id", "icon", "label", "action", "arg", "if"])
    }

    public var value: DesignValue {
        var o = extra
        o["id"] = .string(id)
        o["icon"] = .string(icon)
        o["label"] = .string(label)
        o["action"] = .string(action)
        Opt.put(&o, "arg", arg)
        Opt.put(&o, "if", condition)
        return .object(o)
    }
}

/// A library of action steps (`lib.run name`); it cannot run another library.
public struct DesignLibrary: DesignValueConvertible, Hashable {
    public var description: String
    public var steps: [LibraryStep]?
    public var extra: [String: DesignValue]

    public init(description: String, steps: [LibraryStep]?, extra: [String: DesignValue] = [:]) { self.description = description; self.steps = steps; self.extra = extra }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        description = Opt.string(o["description"]) ?? ""
        // optJSONObject(i) per step: what is not an object is skipped (kept as nil).
        steps = Opt.array(o["steps"]).map { $0.map { LibraryStep(value: $0) } }
        extra = Opt.extra(o, known: ["description", "steps"])
    }

    public var value: DesignValue {
        var o = extra
        o["description"] = .string(description)
        if let steps { o["steps"] = .array(steps.map { $0.value }) }
        return .object(o)
    }
}

public struct LibraryStep: DesignValueConvertible, Hashable {
    /// `do`: the action (nil: the step is broken — the library stops there).
    public var action: String?
    public var arg: String?
    public var condition: String?
    /// The step was not an object (skipped).
    public var isObject: Bool
    public var extra: [String: DesignValue]

    public init(action: String, arg: String? = nil, condition: String? = nil) {
        self.action = action; self.arg = arg; self.condition = condition; isObject = true; extra = [:]
    }

    public init(value: DesignValue) {
        guard let o = value.objectValue else { action = nil; arg = nil; condition = nil; isObject = false; extra = ["": value]; return }
        isObject = true
        action = o["do"].flatMap { $0.isNull ? nil : $0.optString(nil) }
        arg = o["arg"].flatMap { $0.isNull ? nil : $0.optString(nil) }
        condition = Opt.string(o["if"])
        extra = Opt.extra(o, known: ["do", "arg", "if"])
    }

    public var value: DesignValue {
        if !isObject { return extra[""] ?? .null }
        var o = extra
        Opt.put(&o, "do", action)
        Opt.put(&o, "arg", arg)
        Opt.put(&o, "if", condition)
        return .object(o)
    }
}

/// A small asset of the design (an image or a font), base64 in the document.
public struct DesignAsset: DesignValueConvertible, Hashable {
    public var mime: String
    public var data: String
    public var extra: [String: DesignValue]

    public init(mime: String, data: String) { self.mime = mime; self.data = data; extra = [:] }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        mime = Opt.string(o["mime"]) ?? ""
        data = Opt.string(o["data"]) ?? ""
        extra = Opt.extra(o, known: ["mime", "data"])
    }

    public var value: DesignValue {
        var o = extra
        o["mime"] = .string(mime)
        o["data"] = .string(data)
        return .object(o)
    }

    public var bytes: Data? { Data(base64Encoded: data) }
}

// MARK: - theme, animations

/// The design's theme: colour tokens per tone, the corner radius, the font, the density.
public struct DesignTheme: DesignValueConvertible, Hashable {
    public var light: [String: String]?
    public var dark: [String: String]?
    public var radiusValue: DesignValue?
    public var fontValue: String?
    public var density: String?
    public var extra: [String: DesignValue]

    public init(light: [String: String], dark: [String: String], radius: Int = 14, font: String = "sans", density: String = "normal") {
        self.light = light; self.dark = dark; radiusValue = .number(Double(radius)); fontValue = font; self.density = density; extra = [:]
    }

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        light = Opt.stringMap(o["light"])
        dark = Opt.stringMap(o["dark"])
        radiusValue = o["radius"]
        fontValue = Opt.string(o["font"])
        density = Opt.string(o["density"])
        extra = Opt.extra(o, known: ["light", "dark", "radius", "font", "density"])
    }

    public var value: DesignValue {
        var o = extra
        if let light { o["light"] = .object(light.mapValues { .string($0) }) }
        if let dark { o["dark"] = .object(dark.mapValues { .string($0) }) }
        if let radiusValue { o["radius"] = radiusValue }
        Opt.put(&o, "font", fontValue)
        Opt.put(&o, "density", density)
        return .object(o)
    }

    /// optInt("radius", 14)
    public var radius: Int { radiusValue.map { Int(JavaSemantics.intValue($0.optDouble(14))) } ?? 14 }
    /// optString("font", "sans")
    public var font: String { fontValue ?? "sans" }

    public func tone(dark isDark: Bool) -> [String: String]? { isDark ? dark : light }
}

/// One of the design's animations (screen, dialog, message, list, flash, users, splash).
public struct AnimSpec: DesignValueConvertible, Hashable {
    public var values: [String: DesignValue]
    public init(value: DesignValue) { values = value.objectValue ?? [:] }
    public init(_ values: [String: DesignValue] = [:]) { self.values = values }
    public var value: DesignValue { .object(values) }
    public var type: String? { values["type"]?.optString(nil) }
    public var ms: Double? { values["ms"]?.numberValue }
    public var easing: String? { values["easing"]?.optString(nil) }
    public var delay: Double? { values["delay"]?.numberValue }
    /// flash: how long it stays (ms).
    public var stay: Double? { values["stay"]?.numberValue }
    /// splash: orbit | pulse | reveal | none.
    public var style: String? { values["style"]?.optString(nil) }
    /// splash: the shortest time it shows (ms).
    public var minMs: Double? { values["minMs"]?.numberValue }
}

// MARK: - the document

/// The whole design as default-design.json has it (server: AndroidDesign).
public struct DesignDocument: DesignValueConvertible, Hashable {
    public var format: Int?
    public var appName: String?
    public var appExtra: [String: DesignValue]
    public var theme: DesignTheme?
    public var animations: [String: AnimSpec]?
    public var screens: [String: DesignNode]
    /// A menu that is not an array is kept as nil (Android: optJSONArray).
    public var menus: [String: [DesignMenuItem]?]
    public var strings: [String: [String: String]]
    public var libraries: [String: DesignLibrary]
    public var assets: [String: DesignAsset]
    public var rev: String?
    public var updatedAt: Double?
    public var updatedBy: String?
    public var extra: [String: DesignValue]

    static let known: Set<String> = ["format", "app", "theme", "animations", "screens", "menus", "strings", "libraries", "assets", "rev", "updatedAt", "updatedBy"]

    public init(value: DesignValue) {
        let o = value.objectValue ?? [:]
        format = o["format"]?.numberValue.map { Int(JavaSemantics.intValue($0)) }
        let app = o["app"]?.objectValue
        appName = app.flatMap { Opt.string($0["name"]) }
        appExtra = app.map { Opt.extra($0, known: ["name"]) } ?? [:]
        theme = o["theme"]?.objectValue.map { DesignTheme(value: .object($0)) }
        animations = o["animations"]?.objectValue.map { $0.compactMapValues { $0.objectValue.map { AnimSpec(value: .object($0)) } } }
        screens = (o["screens"]?.objectValue ?? [:]).compactMapValues { $0.objectValue != nil ? DesignNode(value: $0) : nil }
        menus = (o["menus"]?.objectValue ?? [:]).mapValues { v in v.arrayValue.map { $0.map { DesignMenuItem(value: $0) } } }
        strings = (o["strings"]?.objectValue ?? [:]).compactMapValues { Opt.stringMap($0) }
        libraries = (o["libraries"]?.objectValue ?? [:]).compactMapValues { $0.objectValue != nil ? DesignLibrary(value: $0) : nil }
        assets = (o["assets"]?.objectValue ?? [:]).compactMapValues { $0.objectValue != nil ? DesignAsset(value: $0) : nil }
        rev = Opt.string(o["rev"])
        updatedAt = o["updatedAt"]?.numberValue
        updatedBy = Opt.string(o["updatedBy"])
        extra = Opt.extra(o, known: Self.known)
    }

    public var value: DesignValue {
        var o = extra
        if let format { o["format"] = .number(Double(format)) }
        if appName != nil || !appExtra.isEmpty {
            var a = appExtra
            Opt.put(&a, "name", appName)
            o["app"] = .object(a)
        }
        if let theme { o["theme"] = theme.value }
        if let animations { o["animations"] = .object(animations.mapValues { $0.value }) }
        o["screens"] = .object(screens.mapValues { $0.value })
        o["menus"] = .object(menus.mapValues { $0.map { .array($0.map { $0.value }) } ?? .null })
        o["strings"] = .object(strings.mapValues { .object($0.mapValues { .string($0) }) })
        o["libraries"] = .object(libraries.mapValues { $0.value })
        o["assets"] = .object(assets.mapValues { $0.value })
        Opt.put(&o, "rev", rev)
        if let updatedAt { o["updatedAt"] = .number(updatedAt) }
        Opt.put(&o, "updatedBy", updatedBy)
        return .object(o)
    }

    /// Reads default-design.json (or any whole design).
    public static func parse(_ data: Data) throws -> DesignDocument { DesignDocument(value: try DesignValue.parse(data)) }
}
