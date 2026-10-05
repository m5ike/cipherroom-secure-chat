// A screen's element tree resolved for one state — the port of
// android/…/ui/Renderer.java's model: create() (structure, static style,
// layout params, events) and bind() (`if`, `each`, texts, colours and props
// given as expressions, each element's content). The SwiftUI layer draws the
// RenderNodes; ActionRunner runs their events.
//
// Throws an ExprError when an expression or a template of the design does not
// parse (Android: the screen fails, Bundles.onRenderFailure rolls a trial
// bundle back and the built-in design's screen is shown — `resolveOrFallback`).

import Foundation

/// What a screen is resolved against.
public struct RenderContext: Sendable {
    public var design: Design
    /// The tone (Appearance.isDark).
    public var dark: Bool
    public var translator: Translator
    /// The user's look: settings (appearance.*, look.*, and every other $settings value) and the templates.
    public var appearance: Appearance
    public var look: Look
    /// $form — the values inputs and choices are bound to.
    public var form: [String: DesignValue]
    /// Enter animations run (a screen shown, not a refresh of it).
    public var animateEnter: Bool

    public init(design: Design, dark: Bool, translator: Translator, settings: SettingsModel = SettingsModel(), templates: [LookTemplate] = [],
                form: [String: DesignValue] = [:], reducedMotion: Bool = false, animateEnter: Bool = false) {
        self.design = design
        self.dark = dark
        self.translator = translator
        appearance = Appearance(settings: settings, templates: templates)
        look = Look(settings: settings, appearance: appearance, reducedMotion: reducedMotion)
        self.form = form
        self.animateEnter = animateEnter
    }

    public var settings: SettingsModel { appearance.settings }

    /// A colour of the design in this tone with the user's look (Renderer.color).
    public func color(_ v: String?, _ fallback: DesignColor) -> DesignColor {
        design.color(v, dark: dark, fallback: fallback, appearance: appearance)
    }
}

public struct ScreenResolver: Sendable {
    public var context: RenderContext

    public init(_ context: RenderContext) { self.context = context }

    private var tr: Translator { context.translator }
    private var density: Double { context.appearance.density }

    // MARK: - entry points

    /// The screen of this id in the design (nil when the design has no such screen, or its root is hidden).
    public func resolve(screen id: String, scope: Scope) throws -> RenderNode? {
        guard let tree = context.design.screen(id) else { return nil }
        return try resolve(tree, scope: scope)
    }

    /// A tree (a screen, a sheet, a list item's template) in a scope; nil when its root is hidden.
    public func resolve(_ root: DesignNode, scope: Scope) throws -> RenderNode? {
        try node(root, parent: nil, index: 0, scope: scope, inheritedFg: nil, path: root.id.isEmpty ? "root" : root.id)
    }

    /// MainActivity.showScreen: the screen, or — when it fails — the built-in design's one and the failure.
    public func resolveOrFallback(screen id: String, scope: Scope, builtIn: Design) -> (node: RenderNode?, failure: Error?) {
        do {
            return (try resolve(screen: id, scope: scope), nil)
        } catch {
            var fallback = self
            fallback.context.design = builtIn
            return ((try? fallback.resolve(screen: id, scope: scope)) ?? nil, error)
        }
    }

    /// A menu of the design for showing (MainActivity.showMenu): items whose `if` holds, labels rendered.
    public func menu(_ id: String, scope: Scope) throws -> [ResolvedMenuItem] {
        guard let items = context.design.menu(id) else { return [] }
        var out: [ResolvedMenuItem] = []
        for it in items {
            if let cond = it.condition, !cond.isEmpty, !Expr.truthy(try Expr.eval(cond, scope, tr)) { continue }
            out.append(ResolvedMenuItem(id: it.id, icon: it.icon, label: try Expr.render(it.label, scope, tr), action: it.action, raw: it.arg,
                                        scope: scope, dangerous: DesignAction.dangerous(it.action)))
        }
        return out
    }

    /// A swipe side's actions (SwipeRow.actions): at most four, a broken item skipped.
    public func swipeActions(_ menuId: String, scope: Scope) -> [SwipeAction] {
        guard !menuId.isEmpty, let items = context.design.menu(menuId) else { return [] }
        var out: [SwipeAction] = []
        for it in items {
            if out.count >= SwipeMath.maxPerSide { break }
            if it.action.isEmpty { continue }
            do {
                if let cond = it.condition, !cond.isEmpty, !Expr.truthy(try Expr.eval(cond, scope, tr)) { continue }
                out.append(SwipeAction(icon: it.icon.isEmpty ? "circle" : it.icon, label: try Expr.render(it.label, scope, tr), action: it.action,
                                       raw: it.arg, value: try it.arg.map { try Expr.value($0, scope, tr) }, scope: scope))
            } catch {
                continue
            }
        }
        return out
    }

    /// A choice's options: "a:Label|b:{_'key'}" or "=expr" (a list of values or of {value, label}).
    public func options(_ node: DesignNode, scope: Scope) throws -> [DesignOption] {
        guard let raw = node.propString("options"), !raw.isEmpty else { return [] }
        if raw.hasPrefix("=") {
            guard case .array(let a) = try Expr.eval(String(raw.dropFirst()), scope, tr) else { return [] }
            return a.prefix(100).map { o in
                if case .object(let obj) = o {
                    let value = obj["value"]?.optString("") ?? ""
                    return DesignOption(value: value, label: obj["label"].flatMap { $0.isNull ? nil : $0.optString(nil) } ?? value)
                }
                return DesignOption(value: Expr.toText(o), label: Expr.toText(o))
            }
        }
        // String.split("\\|"): trailing empty parts dropped.
        var parts = raw.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        while parts.count > 1, parts.last == "" { parts.removeLast() }
        return try parts.map { part in
            let u = Array(part.utf16)
            let colon = JavaSemantics.indexOf(u, 0x3A)
            let value = colon < 0 ? JavaSemantics.trim(part) : JavaSemantics.trim(JavaSemantics.string(u[0..<colon]))
            let label = colon < 0 ? value : try Expr.render(JavaSemantics.trim(JavaSemantics.string(u[(colon + 1)...])), scope, tr)
            return DesignOption(value: value, label: label)
        }
    }

    /// The value an input-like element shows: its setting, else its form value.
    public func boundValue(_ node: DesignNode) -> DesignValue {
        if let key = node.propString("setting") { return context.settings.get(key) }
        guard let bind = node.propString("bind") else { return .null }
        return context.form[bind] ?? .null
    }

    // MARK: - structure

    enum BoxKind: Equatable { case linear(horizontal: Bool), frame, flow }

    struct ParentInfo {
        let el: String
        let style: [String: DesignValue]
        let box: BoxKind
    }

    func boxKind(_ n: DesignNode) -> BoxKind? {
        switch n.el {
        case "row": return n.propString("wrap") == "true" ? .flow : .linear(horizontal: true)
        case "column", "sheet", "card", "swipe": return .linear(horizontal: false)
        case "stack": return .frame
        case "scroll": return .linear(horizontal: n.propString("horizontal") == "true")
        default: return nil
        }
    }

    private func node(_ n: DesignNode, parent: ParentInfo?, index: Int, scope: Scope, inheritedFg: DesignColor?, path: String) throws -> RenderNode? {
        let style = n.style ?? [:]
        if let each = n.each {
            return try repeatGroup(n, each: each, style: style, parent: parent, index: index, scope: scope, inheritedFg: inheritedFg, path: path)
        }
        if let cond = n.condition, !cond.isEmpty, !Expr.truthy(try Expr.eval(cond, scope, tr)) { return nil }
        return try element(n, style: style, layout: parent.map { params(n, style, parent: $0, index: index) } ?? LayoutParams(width: .fill, height: .fill),
                           scope: scope, inheritedFg: inheritedFg, path: path)
    }

    /// A repeated node: a group of its copies, one per item (at most 200) in the item's scope.
    private func repeatGroup(_ n: DesignNode, each: String, style: [String: DesignValue], parent: ParentInfo?, index: Int, scope: Scope, inheritedFg: DesignColor?, path: String) throws -> RenderNode {
        let list = try Expr.eval(each, scope, tr)
        let items = Array((list.arrayValue ?? []).prefix(200))
        let alias = n.alias ?? "item"
        var template = n
        template.each = nil
        let kind: ContainerSpec.Kind
        var gap = 0.0
        if parent?.box == .flow {
            kind = .flow
            gap = (parent?.style["gap"]?.optDouble(0) ?? 0) * density
        } else {
            kind = parent?.el == "row" ? .horizontal : .vertical
        }
        var copies: [RenderNode] = []
        for (i, item) in items.enumerated() {
            let sc = scope.child(alias, value: item, index: i, count: items.count)
            if let c = try node(template, parent: parent, index: i, scope: sc, inheritedFg: inheritedFg, path: path + "#\(i)") { copies.append(c) }
        }
        return RenderNode(id: path, nodeId: n.id, element: n.element, isRepeat: true,
                          layout: parent.map { params(n, style, parent: $0, index: index) } ?? LayoutParams(width: .fill, height: .fill),
                          container: ContainerSpec(kind: kind, flowGap: gap), box: BoxStyle(), textStyle: nil,
                          foreground: inheritedFg ?? context.color("@onSurface", .black), content: .container, events: [:], binding: nil,
                          accessibilityLabel: nil, enter: nil, children: copies, scope: scope)
    }

    // MARK: - layout (Bound.params, box4, size)

    func size(_ v: DesignValue?, _ dflt: Dimension) -> Dimension {
        switch v {
        case .number(let d)?: return .points(Double(Float(d)))
        case .string(let s)?:
            if s == "match" { return .fill }
            if s == "wrap" { return .wrap }
            return JavaSemantics.parseDouble(s).map { .points(Double(Float($0))) } ?? dflt
        default: return dflt
        }
    }

    func box4(_ v: DesignValue?) -> DesignInsets {
        let k = density
        switch v {
        case nil, .null?: return .zero
        case .number(let d)?: return DesignInsets(all: d * k)
        case .string(let s)?:
            let parts = JavaSemantics.trim(s).split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" || $0 == "\u{0B}" || $0 == "\u{0C}" }).map(String.init)
            var f: [Double] = []
            for p in (parts.isEmpty ? [""] : parts) {
                guard let d = JavaSemantics.parseDouble(p) else { return .zero }
                f.append(Double(Float(d)) * k)
            }
            switch f.count {
            case 1: return DesignInsets(all: f[0])
            case 2: return DesignInsets(top: f[0], right: f[1], bottom: f[0], left: f[1])
            case 3: return DesignInsets(top: f[0], right: f[1], bottom: f[2], left: f[1])
            default: return DesignInsets(top: f[0], right: f[1], bottom: f[2], left: f[3])
            }
        case .bool?, .array?, .object?:
            return .zero
        }
    }

    private func cross(_ a: String) -> CrossAlign? {
        switch a {
        case "center": return .center
        case "end": return .end
        case "start": return .start
        default: return nil
        }
    }

    func params(_ n: DesignNode, _ style: [String: DesignValue], parent: ParentInfo, index: Int) -> LayoutParams {
        let inRow = parent.el == "row"
        var linear = false
        if case .linear = parent.box { linear = true }
        let parentAlign = parent.style["align"].flatMap { $0.isNull ? nil : $0.optString(nil) } ?? (inRow ? "center" : "stretch")
        var dW: Dimension = !inRow && linear && parentAlign == "stretch" ? .fill : .wrap
        var dH: Dimension = inRow && linear && parentAlign == "stretch" ? .fill : .wrap
        if parent.box == .frame { dW = .fill; dH = .fill }
        if n.el == "divider" {
            if inRow { dW = .points(1); dH = .fill } else { dW = .fill; dH = .points(1) }
        }
        if n.el == "spacer" {
            guard let sz = n.prop("size") else { return LayoutParams(width: .points(0), height: .points(0), weight: 1) }
            dW = size(sz, .points(0)); dH = dW
        }
        let w = size(style["width"], dW), h = size(style["height"], dH)
        let weight = Double(Float(style["weight"]?.optDouble(0) ?? 0))
        var lp = LayoutParams()
        let selfAlign = style["self"]?.optString("") ?? ""
        if linear {
            lp.width = weight > 0 && inRow ? .points(0) : w
            lp.height = weight > 0 && !inRow ? .points(0) : h
            lp.weight = weight
            if selfAlign != "stretch", let g = cross(selfAlign.isEmpty ? parentAlign : selfAlign) { lp.crossAlign = g }
            if selfAlign == "stretch" { if inRow { lp.height = .fill } else { lp.width = .fill } }
        } else {
            lp.width = w
            lp.height = h
            if !selfAlign.isEmpty {
                switch selfAlign {
                case "center": lp.frameAlign = .center
                case "end": lp.frameAlign = .bottomEnd
                case "start": lp.frameAlign = .topStart
                default: lp.frameAlign = .fill
                }
            }
        }
        let m = box4(style["margin"])
        let gap = index > 0 && linear ? (parent.style["gap"]?.optDouble(0) ?? 0) * density : 0
        lp.margin = DesignInsets(top: m.top + (inRow ? 0 : gap), right: m.right, bottom: m.bottom, left: m.left + (inRow ? gap : 0))
        return lp
    }

    // MARK: - an element

    private func styleValue(_ style: [String: DesignValue], _ key: String, _ sc: Scope) throws -> String? {
        guard let v = style[key], !v.isNull else { return nil }
        if case .string(let s) = v, s.hasPrefix("=") { return Expr.toText(try Expr.eval(String(s.dropFirst()), sc, tr)) }
        return v.optString(nil) ?? Expr.toText(v)
    }

    private func propValue(_ n: DesignNode, _ key: String, _ sc: Scope) throws -> DesignValue? {
        guard let props = n.props, let v = props[key] else { return nil }
        if case .string(let s) = v { return try Expr.value(s, sc, tr) }
        return v
    }

    private func parseF(_ v: DesignValue?, _ d: Double) -> Double {
        guard let v, !v.isNull else { return d }
        if case .number(let x) = v { return Double(Float(x)) }
        return JavaSemantics.parseDouble(v.optString(nil) ?? Expr.toText(v)).map { Double(Float($0)) } ?? d
    }

    private func numProp(_ n: DesignNode, _ key: String, _ d: Double) -> Double {
        guard let v = n.prop(key) else { return d }
        if case .number(let x) = v { return x }
        if v.isNull { return d }
        return JavaSemantics.parseDouble(v.optString(nil) ?? Expr.toText(v)) ?? d
    }

    private func element(_ n: DesignNode, style: [String: DesignValue], layout: LayoutParams, scope sc: Scope, inheritedFg: DesignColor?, path: String) throws -> RenderNode {
        let el = n.el
        let kind = n.element
        let look = context.look
        let on = n.on ?? [:]
        let clickable = on["click"] != nil

        // ---- static style (Bound.staticStyle)
        var box = BoxStyle()
        var p = box4(style["padding"])
        if el == "button" {
            if style["padding"] == nil { p = DesignInsets(top: 11, right: 20, bottom: 11, left: 20) }
            box.minHeight = 44
        }
        if (el == "badge" || el == "chip") && style["padding"] == nil {
            p = el == "chip" ? DesignInsets(top: 6, right: 12, bottom: 6, left: 12) : DesignInsets(top: 2, right: 7, bottom: 2, left: 7)
        }
        if el == "select" { box.minHeight = 44 }
        box.padding = p
        if let e = style["elevation"] { box.elevation = Double(Float(e.optDouble(0))) }

        var container: ContainerSpec?
        if let bk = boxKind(n) {
            let j = style["justify"]?.optString("start") ?? "start"
            let justify: ContainerSpec.Justify = j == "center" ? .center : j == "end" ? .end : .start
            switch bk {
            case .flow:
                container = ContainerSpec(kind: .flow, justify: justify, flowGap: (style["gap"]?.optDouble(0) ?? 0) * density)
            case .frame:
                container = ContainerSpec(kind: .overlay)
            case .linear(let horizontal):
                // Only a row / column / card / sheet sets its gravity (the scroll's content and the swipe's do not).
                let gravity = ["row", "column", "card", "sheet"].contains(el) ? justify : .start
                container = ContainerSpec(kind: horizontal ? .horizontal : .vertical, justify: gravity,
                                          scroll: el == "scroll" ? (horizontal ? .horizontal : .vertical) : nil)
            }
        }

        // ---- dynamic style (Bound.dynamicStyle)
        var fg = inheritedFg ?? context.color("@onSurface", .black)
        let fgv = try styleValue(style, "fg", sc)
        if let fgv { fg = context.color(fgv, fg) }
        let bg = try styleValue(style, "bg", sc)
        var radius: Double
        if let r = style["radius"] { radius = Double(Float(r.optDouble(.nan))); if radius.isNaN { radius = 0 } }
        else if el == "card" { radius = Double(context.appearance.radius(context.design) + 4) }
        else if el == "button" { radius = look.radius("button") }
        else if el == "chip" { radius = look.radius("chip") }
        else if el == "badge" { radius = 999 }
        else { radius = 0 }
        var borderW = 0.0
        var borderC = DesignColor.transparent
        if let border = try styleValue(style, "border", sc) {
            let parts = JavaSemantics.trim(border).split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
            if let w = parts.first.flatMap({ JavaSemantics.parseDouble($0) }) { borderW = Double(Float(w)) }
            borderC = context.color(parts.count > 1 ? parts[1] : "@border", .gray)
        }
        var fill = DesignColor.transparent
        var paint = false
        if let bg { fill = context.color(bg, .transparent); paint = true }
        if el == "card" && bg == nil {
            fill = context.color("@surface", .white); paint = true
            if style["elevation"] == nil { box.elevation = 1 }
        }
        if el == "button" {
            var variant = Expr.toText(try propValue(n, "variant", sc))
            if variant.isEmpty { variant = "primary" }
            if variant == "primary" { variant = "look:" + look.buttons }
            if bg == nil {
                let primary = context.color("@primary", .blue)
                switch variant {
                case "primary", "look:filled":
                    fill = primary; if fgv == nil { fg = context.color("@onPrimary", .white) }
                case "look:outlined":
                    fill = .transparent; if fgv == nil { fg = primary }
                    if borderW == 0 { borderW = 1.5; borderC = primary.withAlpha(0.7) }
                case "danger":
                    fill = context.color("@danger", .red); if fgv == nil { fg = .white }
                case "tonal", "look:tonal":
                    fill = primary.withAlpha(0.14); if fgv == nil { fg = primary }
                case "secondary":
                    fill = .transparent
                    if borderW == 0 { borderW = 1; borderC = context.color("@border", .gray) }
                default:
                    fill = .transparent; if fgv == nil { fg = primary }
                }
            }
            paint = true
        }
        if el == "badge" {
            let c = Expr.toText(try propValue(n, "color", sc))
            if bg == nil { fill = context.color(c.isEmpty ? "@primary" : c, .red); paint = true }
            if fgv == nil { fg = fill.badgeContrast }
        }
        if el == "chip" {
            let sel = Expr.truthy(try propValue(n, "selected", sc))
            if bg == nil { fill = sel ? context.color("@primary", .blue).withAlpha(0.16) : .transparent; paint = true }
            if borderW == 0 { borderW = 1; borderC = sel ? context.color("@primary", .blue) : context.color("@border", .gray) }
            if fgv == nil && sel { fg = context.color("@primary", .blue) }
        }
        if el == "divider" { fill = context.color(bg ?? "@border", .lightGray); paint = true }
        let rawBg = style["bg"]?.stringValue
        if n.id == "bubble" || rawBg == "@bubbleIn" || rawBg == "@bubbleOut" {
            switch context.appearance.bubbles {
            case "square": radius = 4
            case "minimal":
                fill = .transparent
                fg = context.color("@onSurface", fg)
                box.elevation = 0
                if borderW == 0 { borderW = 1; borderC = context.color("@border", .gray) }
            default: break
            }
        }
        let painted = paint || borderW > 0 || (radius > 0 && bg != nil)
        if painted {
            box.fill = fill
            box.radius = radius
            box.border = borderW > 0 ? BorderSpec(width: borderW, color: borderC) : nil
            if el == "button" || (el == "chip" && clickable) { box.press = pressable(fg.withAlpha(0.18)) }
            else { box.press = clickable ? .ripple(fg.withAlpha(0.18)) : .none }
        } else if clickable && el != "button" && el != "iconButton" && el != "chip" {
            box.press = .system
        }
        if let op = try styleValue(style, "opacity", sc), let o = JavaSemantics.parseDouble(op) { box.opacity = Double(Float(o)) }

        // ---- text style (Bound.textAppearance), for the elements Android draws as TextViews
        var textStyle: TextStyle?
        if kind.isTextual {
            textStyle = self.textStyle(n, style: style, color: el == "input" ? context.color("@onSurface", .black) : fg)
            if el == "input" { textStyle?.hintColor = context.color("@muted", .gray) }
        }

        // ---- events (Bound.wireEvents)
        var events: [String: RenderEvent] = [:]
        let tick = el == "button" || el == "iconButton" || el == "chip"
        if let h = on["click"] { events["click"] = RenderEvent(action: h.action, raw: h.arg, scope: sc, haptic: tick ? .tick : .none) }
        if let h = on["longClick"] { events["longClick"] = RenderEvent(action: h.action, raw: h.arg, scope: sc, haptic: .long) }
        if let h = on["submit"], el == "input" { events["submit"] = RenderEvent(action: h.action, raw: h.arg, scope: sc, haptic: .none) }
        var binding: ValueBinding?
        let setting = n.propString("setting"), bind = n.propString("bind")
        if ["switch", "checkbox", "select", "slider", "segmented"].contains(el), setting != nil || bind != nil {
            binding = ValueBinding(setting: setting, bind: bind, change: on["change"], scope: sc)
        }

        // ---- content (Bound.bindContent)
        var content: RenderContent = container == nil ? .unknown(el) : .container
        var a11y: String?
        switch kind {
        case .text, .badge, .chip, .button:
            let text = try Expr.render(n.text ?? "", sc, tr)
            let links = Expr.toText(try propValue(n, "links", sc)) == "true"
            let iconName = Expr.toText(try propValue(n, "icon", sc))
            let icon = iconName.isEmpty ? nil : IconRef(name: iconName, size: el == "badge" ? 12 : 18, color: fg, gap: el == "badge" ? 3 : 8)
            if el == "button" {
                let disabled = Expr.truthy(try propValue(n, "disabled", sc))
                box.opacity = disabled ? 0.5 : 1
                content = .button(ButtonContent(text: text, icon: icon, disabled: disabled))
            } else {
                content = .text(TextContent(text: text, links: links, icon: icon))
            }
        case .icon:
            let name = Expr.toText(try propValue(n, "icon", sc))
            let sz = parseF(try propValue(n, "size", sc), 20)
            let color = Expr.toText(try propValue(n, "color", sc))
            content = .icon(IconContent(name: name.isEmpty ? "circle" : name, size: sz, color: color.isEmpty ? fg : context.color(color, fg)))
        case .iconButton:
            let name = Expr.toText(try propValue(n, "icon", sc))
            let variant = Expr.toText(try propValue(n, "variant", sc))
            let lk = variant == "primary" ? look.buttons : ""
            let primary = context.color("@primary", .blue)
            let color = lk == "filled" ? context.color("@onPrimary", .white) : lk.isEmpty ? fg : primary
            let rad = look.radius("icon")
            var shapeFill: DesignColor?
            var shapeBorder: BorderSpec?
            switch lk {
            case "filled": shapeFill = primary
            case "tonal": shapeFill = primary.withAlpha(0.14)
            case "outlined": shapeFill = .transparent; shapeBorder = BorderSpec(width: 1.5, color: primary.withAlpha(0.7))
            default: break
            }
            let hasShape = shapeFill != nil
            let label = try Expr.render(n.propString("label") ?? "", sc, tr)
            let badgeValue = try propValue(n, "badge", sc)
            let count: Double
            if case .number(let d)? = badgeValue { count = d } else { count = parseF(badgeValue, 0) }
            content = .iconButton(IconButtonContent(icon: name.isEmpty ? "circle" : name, iconSize: 22, iconColor: color, fill: shapeFill, border: shapeBorder,
                                                    radius: rad, press: pressable((hasShape ? color : fg).withAlpha(hasShape ? 0.2 : 0.16)), label: label,
                                                    badge: count > 0 ? (count > 99 ? "99+" : Expr.toText(.number(count))) : nil,
                                                    badgeFill: context.color("@primary", .red), badgeText: .white))
            a11y = label
        case .avatar:
            let name = Expr.toText(try propValue(n, "name", sc))
            let sz = try propValue(n, "size", sc)
            let size: Double
            if case .number(let d)? = sz { size = Double(Float(d)) } else { size = parseF(sz, 36) }
            content = .avatar(AvatarContent(name: name, initials: Self.initials(name), color: Self.nameColor(name), size: size))
        case .image:
            let rawSrc = n.prop("src")?.stringValue
            let src = DesignUrls.image(raw: rawSrc, bound: Expr.toText(try propValue(n, "src", sc)))
            let ratioV = try propValue(n, "ratio", sc)
            let ratio: Double
            if case .number(let d)? = ratioV { ratio = Double(Float(d)) } else { ratio = parseF(ratioV, 0) }
            let fit = Expr.toText(try propValue(n, "fit", sc))
            content = .image(ImageContent(source: imageSource(src), fit: fit == "contain" ? .contain : fit == "center" ? .center : .cover, ratio: ratio))
        case .divider:
            content = .divider
        case .spacer:
            content = .spacer
        case .progress:
            if n.propString("value") == nil {
                content = .progress(nil)
            } else {
                let v = try propValue(n, "value", sc)
                let progress = v == nil || v == .null ? 0 : Double(max(0, min(1000, JavaSemantics.round(Expr.num(v) * 1000))))
                content = .progress(progress / 1000)
            }
        case .input:
            let type = n.propString("type") ?? "text"
            let value = bind.flatMap { context.form[$0] }.map { $0.isNull ? "" : ($0.optString(nil) ?? Expr.toText($0)) } ?? ""
            if style["padding"] == nil { box.padding = DesignInsets(top: 10, right: 14, bottom: 10, left: 14) }
            // Android sets the field's own background over any style bg.
            box.fill = context.color("@surfaceVariant", .lightGray)
            box.radius = min(look.radius("field"), 22)
            box.border = nil
            content = .input(InputContent(bind: bind, hint: try Expr.render(n.propString("hint") ?? "", sc, tr), kind: InputKind(rawValue: type) ?? .text,
                                          value: value, background: context.color("@surfaceVariant", .lightGray), radius: min(look.radius("field"), 22),
                                          submits: on["submit"] != nil))
        case .toggleSwitch, .checkbox:
            let text = try Expr.render(n.text ?? "", sc, tr)
            let checked = n.propString("checked") != nil ? Expr.truthy(try propValue(n, "checked", sc)) : Expr.truthy(boundValue(n))
            content = .toggle(ToggleContent(style: el == "switch" ? .toggle : .checkbox, text: text, checked: checked, tint: context.color("@primary", .blue),
                                            commitsOnTap: (setting != nil || bind != nil) && on["click"] == nil))
        case .select:
            let current = Expr.toText(boundValue(n))
            let opts = try options(n, scope: sc)
            var label = current
            for o in opts where o.value == current { label = o.label; break }
            if label.isEmpty { label = try Expr.render(n.propString("hint") ?? "", sc, tr) }
            if style["bg"] == nil { box.fill = context.color("@surfaceVariant", .lightGray); box.radius = 12; box.press = .ripple(fg.withAlpha(0.12)) }
            if style["padding"] == nil { box.padding = DesignInsets(top: 8, right: 12, bottom: 8, left: 14) }
            content = .select(SelectContent(options: opts, current: current, label: label, chevron: IconRef(name: "chevron-down", size: 18, color: fg, gap: 8), radius: 12))
        case .slider:
            let mn = numProp(n, "min", 0), mx = numProp(n, "max", 1), step = numProp(n, "step", 0)
            let v = Expr.num(boundValue(n))
            let progress = mx > mn ? Double(JavaSemantics.roundInt((max(mn, min(mx, v)) - mn) / (mx - mn) * 1000)) : 0
            content = .slider(SliderContent(min: mn, max: mx, step: step, value: v, fraction: progress / 1000, tint: context.color("@primary", .blue)))
        case .segmented:
            let opts = try options(n, scope: sc)
            let current = Expr.toText(boundValue(n))
            let accent = context.color("@primary", .blue)
            let outer = min(look.radius("button"), 22), inner = max(0, outer - 3)
            let tonal = look.buttons != "filled"
            if style["bg"] == nil { box.fill = context.color("@surfaceVariant", .lightGray); box.radius = outer }
            if style["padding"] == nil { box.padding = DesignInsets(all: 3) }
            let family = look.family(context.design)
            content = .segmented(SegmentedContent(options: opts, selectedIndex: opts.firstIndex { $0.value == current },
                                                  selectedFill: tonal ? context.color("@surface", .white) : accent,
                                                  selectedText: tonal ? accent : context.color("@onPrimary", .white), text: fg,
                                                  selectedWeight: family == .sans ? .medium : .bold, selectedElevation: tonal ? 1 : 0,
                                                  textSize: Double(Float(13.5)) * context.appearance.fontScale, outerRadius: outer, innerRadius: inner))
        case .slot:
            content = .slot(n.propString("name") ?? "")
        case .swipe:
            func prop(_ key: String) throws -> String {
                guard let v = n.prop(key) else { return "" }
                if case .string(let s) = v { return JavaSemantics.trim(Expr.toText(try Expr.value(s, sc, tr))) }
                return JavaSemantics.trim(Expr.toText(v))
            }
            let rc = try prop("rightColor"), lc = try prop("leftColor")
            content = .swipe(SwipeContent(right: swipeActions(try prop("right"), scope: sc), left: swipeActions(try prop("left"), scope: sc),
                                          rightColor: context.color(rc.isEmpty ? "@danger" : rc, .red), leftColor: context.color(lc.isEmpty ? "@primary" : lc, .blue),
                                          surface: context.color("@surface", .white), tonal: context.color("@surfaceVariant", .lightGray),
                                          onSurface: context.color("@onSurface", .black)))
        case .sheet:
            let present = try propValue(n, "present", sc)
            let dismiss = try propValue(n, "dismissOnAction", sc)
            content = .sheet(SheetContent(dock: Expr.toText(present) == "dock", dismissOnAction: Expr.truthy(dismiss)))
        case .column, .row, .stack, .scroll, .card:
            content = .container
        case .unknown:
            content = .unknown(el)
        }

        // ---- enter animation (Renderer.animate)
        var enter: EnterAnimation?
        if context.animateEnter, let spec = n.anim?.enter, !look.still, spec.type != "none" {
            let k = look.travel
            let type = spec.type
            enter = EnterAnimation(type: type, duration: look.ms(Double(JavaSemantics.longValue(spec.ms))), delay: look.ms(Double(JavaSemantics.longValue(spec.delay))),
                                   distance: 24 * k, fromScale: type == "pop" ? max(0.2, 1 - 0.5 * k) : 1 - 0.1 * k,
                                   easing: look.easing(spec.easing ?? (type == "pop" ? "overshoot" : "decelerate")))
        }

        // ---- children (Bound.create's box + bind with the computed foreground)
        var children: [RenderNode] = []
        if let bk = boxKind(n), let kids = n.children {
            let info = ParentInfo(el: el, style: style, box: bk)
            let justify = style["justify"]?.optString("") ?? ""
            let spread = justify == "between" || justify == "around"
            var seen: [String: Int] = [:]
            var flexes = 0
            func flex() -> RenderNode {
                flexes += 1
                return RenderNode(id: path + "/~flex\(flexes)", nodeId: "", element: .spacer, isRepeat: false,
                                  layout: LayoutParams(width: .points(0), height: .points(0), weight: 1), container: nil, box: BoxStyle(), textStyle: nil,
                                  foreground: fg, content: .flex, events: [:], binding: nil, accessibilityLabel: nil, enter: nil, children: [], scope: sc)
            }
            if spread && justify == "around" { children.append(flex()) }
            for (i, k) in kids.enumerated() {
                var cid = k.id.isEmpty ? "\(k.el)-\(i)" : k.id
                if let c = seen[cid] { seen[cid] = c + 1; cid += "~\(c + 1)" } else { seen[cid] = 0 }
                if spread && i > 0 { children.append(flex()) }
                if let child = try node(k, parent: info, index: i, scope: sc, inheritedFg: fg, path: path + "/" + cid) { children.append(child) }
            }
            if spread && justify == "around" { children.append(flex()) }
        }

        return RenderNode(id: path, nodeId: n.id, element: kind, isRepeat: false, layout: layout, container: container, box: box, textStyle: textStyle,
                          foreground: fg, content: content, events: events, binding: binding, accessibilityLabel: a11y, enter: enter, children: children, scope: sc)
    }

    private func pressable(_ ripple: DesignColor) -> PressFeedback {
        switch context.look.press {
        case "scale": return .scale
        case "none": return .none
        default: return .ripple(ripple)
        }
    }

    private func textStyle(_ n: DesignNode, style: [String: DesignValue], color: DesignColor) -> TextStyle {
        let el = n.el
        let variant = n.propString("variant") ?? (el == "badge" ? "badge" : (el == "button" || el == "chip") ? "label" : "body")
        var size: Double
        var bold = false
        switch variant {
        case "display": size = 30; bold = true
        case "headline": size = 23; bold = true
        case "title": size = 19; bold = true
        case "label": size = 14; bold = true
        case "caption": size = 12
        case "badge": size = 11; bold = true
        case "mono": size = 13
        default: size = Double(Float(15.5))
        }
        if let s = style["size"] { size = Double(Float(s.optDouble(size))) }
        size *= context.appearance.fontScale
        if let b = style["bold"] { bold = b.optBool(false) }
        let font = style["font"]?.optString("") ?? ""
        let italic = style["italic"]?.optBool(false) ?? false
        var family: FontFamily
        var weight: FontWeightKind = bold ? .bold : .regular
        var isItalic = italic
        if variant == "mono" {
            family = .mono; isItalic = false
        } else if !font.isEmpty {
            family = FontFamily(choice: font)
        } else if bold && style["bold"] == nil && variant == "label" && (el == "button" || el == "chip") {
            family = context.look.family(context.design)
            if family == .sans { weight = .medium }
            isItalic = false
        } else {
            family = context.look.family(context.design)
        }
        let lines = Int(JavaSemantics.intValue(style["lines"]?.optDouble(0) ?? 0))
        let alignProp = n.propString("align")
        let align: TextAlign = alignProp == "center" ? .center : alignProp == "end" ? .end : (el == "button" ? .center : .start)
        var maxWidth: Double?
        if let mw = style["maxWidth"] { maxWidth = Double(Float(mw.optDouble(.nan))); if maxWidth!.isNaN { maxWidth = 0 } }
        return TextStyle(size: size, weight: weight, italic: isItalic, family: family, lines: lines > 0 ? lines : nil, align: align,
                         lineSpacing: Double(Float(1.1)), maxWidth: maxWidth, color: color, hintColor: nil)
    }

    private func imageSource(_ src: String) -> ImageSource {
        if src.isEmpty { return .none }
        if src.hasPrefix("asset:") {
            let name = String(src.dropFirst(6))
            return .asset(name: name, data: context.design.assets[name])
        }
        if src.hasPrefix("data:image/") {
            guard let comma = src.firstIndex(of: ","), comma > src.startIndex else { return .none }
            let head = src[src.index(src.startIndex, offsetBy: 5)..<comma]
            let mime = String(head.split(separator: ";").first ?? "")
            guard let data = Data(base64Encoded: String(src[src.index(after: comma)...]), options: .ignoreUnknownCharacters) else { return .none }
            return .data(mime: mime, data: data)
        }
        if src.hasPrefix("https://"), let url = URL(string: src) { return .remote(url) }
        return .none
    }

    // MARK: - avatars (Ui.initials / Ui.nameColor)

    /// Up to two initials of a name ("?" for none): the first letters of the first two parts,
    /// split on runs of spaces, ".", "_" and "-" (Java's split("[\\s._-]+")).
    public static func initials(_ name: String?) -> String {
        let n = JavaSemantics.trim(name ?? "")
        if n.isEmpty { return "?" }
        func sep(_ x: UInt16) -> Bool { x == 0x20 || (x >= 0x09 && x <= 0x0D) || x == 0x2E || x == 0x5F || x == 0x2D }
        let u = Array(n.utf16)
        var parts: [[UInt16]] = [[]]
        var i = 0
        while i < u.count {
            if sep(u[i]) {
                while i < u.count && sep(u[i]) { i += 1 }
                parts.append([])
            } else {
                parts[parts.count - 1].append(u[i]); i += 1
            }
        }
        while parts.count > 1, parts.last?.isEmpty == true { parts.removeLast() }
        let a = parts[0].first.map { JavaSemantics.string([$0]) } ?? ""
        let b = parts.count > 1 ? (parts[1].first.map { JavaSemantics.string([$0]) } ?? "") : ""
        return (a + b).uppercased()
    }

    /// A stable colour for a name (avatars): Java's String.hashCode over a palette of ten.
    public static func nameColor(_ name: String?) -> DesignColor {
        let palette: [UInt32] = [0xFFE1_1D48, 0xFF25_63EB, 0xFF05_9669, 0xFFD9_7706, 0xFF7C_3AED, 0xFF08_91B2, 0xFFDB_2777, 0xFF65_A30D, 0xFFEA_580C, 0xFF4F_46E5]
        var h: Int32 = 0
        for u in (name ?? "").utf16 { h = h &* 31 &+ Int32(u) }
        let m = Int(h % Int32(palette.count))
        return DesignColor(argb: palette[abs(m)])
    }
}
