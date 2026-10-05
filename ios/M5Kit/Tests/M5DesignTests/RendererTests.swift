import Foundation
import Testing
@testable import M5Design

/// The render tree: every screen of the built-in design resolves with the console's sample state,
/// and the Renderer's rules (create + bind) come out as values.
@MainActor
@Suite struct RendererTests {
    static let catalog = try! Fixtures.json(Fixtures.here + "catalog.json")

    static func context(settings: SettingsModel = SettingsModel(), dark: Bool = false, form: [String: DesignValue] = [:], animate: Bool = false, lang: String = "cs") -> RenderContext {
        RenderContext(design: Fixtures.builtIn, dark: dark, translator: Translator(design: Fixtures.builtIn, lang: lang), settings: settings,
                      templates: Fixtures.templates, form: form, animateEnter: animate)
    }

    /// MainActivity.scopeFor's common variables around a sample.
    static func scope(_ sample: DesignValue, settings: SettingsModel = SettingsModel()) -> Scope {
        var vars = sample.objectValue ?? [:]
        if vars["app"] == nil { vars["app"] = .obj(["name": "M5cet", "version": "6.14.0", "code": 61400, "bundle": "default"]) }
        if vars["form"] == nil { vars["form"] = .obj([:]) }
        if vars["settings"] == nil { vars["settings"] = settings.scope() }
        if vars["define"] == nil { vars["define"] = .obj([:]) }
        if vars["account"] == nil { vars["account"] = .obj(["signedIn": false]) }
        return Scope(vars)
    }

    static func color(_ token: String, dark: Bool = false) -> DesignColor { Fixtures.builtIn.color(token, dark: dark, fallback: .magenta) }

    @Test func everyScreenResolvesWithItsSample() throws {
        let screens = Self.catalog["screens"].arrayValue!
        #expect(screens.count >= 44)
        var nodes = 0
        for s in screens {
            let id = s["id"].stringValue!
            guard Fixtures.builtIn.screen(id) != nil else { Issue.record("no screen \(id)"); continue }
            for dark in [false, true] {
                let node = try ScreenResolver(Self.context(dark: dark, animate: true)).resolve(screen: id, scope: Self.scope(s["sample"]))
                if let node {
                    nodes += node.all().count
                    let ids = node.all().map(\.id)
                    #expect(Set(ids).count == ids.count, "\(id): ids repeat")
                }
            }
        }
        #expect(nodes > 1000)
    }

    @Test func aRoomRowAsTheRoomListDrawsIt() throws {
        let room: DesignValue = .obj(["key": "family", "name": "family", "users": 3, "unread": 7, "active": false, "connected": true, "selected": true])
        let ctx = Self.context(animate: true)
        let node = try #require(try ScreenResolver(ctx).resolve(screen: "rooms.item", scope: Self.scope(.obj(["room": room]))))
        #expect(node.element == .swipe)
        guard case .swipe(let swipe) = node.content else { Issue.record("not a swipe"); return }
        #expect(swipe.right.map(\.action) == ["room.delete"])
        #expect(swipe.left.map(\.action) == ["room.clone", "room.edit"])
        #expect(swipe.right[0].value == "family" && swipe.right[0].label == Fixtures.builtIn.t("swipe.delete", lang: "cs"))
        #expect(swipe.rightColor == Self.color("@danger") && swipe.leftColor == Self.color("@primary"))

        let row = try #require(node.find("item"))
        #expect(row.box.fill == Self.color("@surface"))
        #expect(row.box.padding == DesignInsets(top: 12, right: 16, bottom: 12, left: 16))
        #expect(row.container?.kind == .horizontal)
        #expect(row.events["click"]?.action == "room.switch")
        #expect(row.box.press == .ripple(Self.color("@onSurface").withAlpha(0.18)))
        #expect(row.layout.width == .fill) // a column (the swipe's content) stretches its children

        let sel = try #require(row.find("sel"))
        guard case .toggle(let t) = sel.content else { Issue.record("not a toggle"); return }
        #expect(t.checked && t.style == .checkbox && !t.commitsOnTap)
        #expect(sel.layout.crossAlign == .center)       // a row centres its children by default
        #expect(sel.layout.margin.left == 0)

        let avatar = try #require(row.find("avatar"))
        #expect(avatar.content == .avatar(AvatarContent(name: "family", initials: "F", color: ScreenResolver.nameColor("family"), size: 40)))
        #expect(avatar.layout.margin.left == 12)        // the row's gap

        let info = try #require(row.find("info"))
        #expect(info.layout.weight == 1 && info.layout.width == .points(0))
        let state = try #require(info.find("state"))
        #expect(state.content == .text(TextContent(text: "Připojeno", links: false, icon: nil)))
        #expect(state.foreground == Self.color("@success"))
        #expect(state.textStyle?.size == 12)
        #expect(state.layout.margin.top == 2)
        let name = try #require(info.find("name"))
        #expect(name.textStyle?.weight == .bold && name.textStyle?.lines == 1)

        let unread = try #require(row.find("unread"))
        #expect(unread.content == .text(TextContent(text: "7", links: false, icon: IconRef(name: "message-circle", size: 12, color: unread.foreground, gap: 3))))
        #expect(unread.box.fill == Self.color("@primary") && unread.box.radius == 999)
        #expect(unread.enter?.type == "pop" && unread.enter?.duration == 240 && unread.enter?.easing == .overshoot)
        #expect(row.find("users") != nil)

        // the event fires through the runner with its own scope
        let h = MockHost()
        #expect(ActionRunner(host: h).fire(row.events["click"]!) == .performed(.roomSwitch("family")))

        // a saved room: no users badge, no unread badge, muted state
        let saved: DesignValue = .obj(["key": "x", "name": "Project X", "users": 0, "unread": 0, "active": true, "connected": false, "selected": false])
        let node2 = try #require(try ScreenResolver(Self.context()).resolve(screen: "rooms.item", scope: Self.scope(.obj(["room": saved]))))
        #expect(node2.find("users") == nil && node2.find("unread") == nil)
        #expect(node2.find("item")?.box.fill == Self.color("@surfaceVariant"))
        #expect(node2.find("avatar").map { if case .avatar(let a) = $0.content { return a.initials } else { return "" } } == "PX")
        #expect(node2.find("unread")?.enter == nil)
    }

    @Test func theLookShapesTheTree() throws {
        func tree(_ n: DesignNode, _ s: SettingsModel = SettingsModel(), dark: Bool = false) throws -> RenderNode {
            try #require(try ScreenResolver(Self.context(settings: s, dark: dark)).resolve(n, scope: .empty))
        }
        let col = DesignNode(id: "c", el: "column", style: ["gap": 10, "padding": "8 16"], children: [
            DesignNode(id: "b1", el: "button", text: "Go", props: ["icon": "plus"]),
            DesignNode(id: "b2", el: "button", text: "Tonal", props: ["variant": "tonal"]),
            DesignNode(id: "b3", el: "button", text: "Off", props: ["variant": "secondary", "disabled": "=true"]),
            DesignNode(id: "ch", el: "chip", text: "Pick", props: ["selected": "=1"], on: ["click": EventHandler(action: "back")]),
            DesignNode(id: "ib", el: "iconButton", props: ["icon": "menu", "label": "{_'menu.more'}", "variant": "primary", "badge": 120]),
            DesignNode(id: "card", el: "card", children: [DesignNode(id: "t", el: "text", text: "x")]),
            DesignNode(id: "bubble", el: "column", style: ["bg": "@bubbleIn", "radius": 16]),
            DesignNode(id: "gone", el: "text", text: "x", condition: "false"),
            DesignNode(id: "alien", el: "hologram", children: [DesignNode(id: "k", el: "text")]),
        ])
        let a = try tree(col)
        #expect(a.box.padding == DesignInsets(top: 8, right: 16, bottom: 8, left: 16))
        let b1 = try #require(a.find("b1"))
        #expect(b1.box.fill == Self.color("@primary") && b1.foreground == Self.color("@onPrimary"))
        #expect(b1.box.radius == 999 && b1.box.minHeight == 44 && b1.box.press == .ripple(Self.color("@onPrimary").withAlpha(0.18)))
        #expect(b1.box.padding == DesignInsets(top: 11, right: 20, bottom: 11, left: 20))
        #expect(b1.textStyle?.weight == .medium && b1.textStyle?.size == 14 && b1.textStyle?.align == .center)
        #expect(b1.events.isEmpty)
        #expect(b1.layout.margin.top == 0)
        let b2 = try #require(a.find("b2"))
        #expect(b2.box.fill == Self.color("@primary").withAlpha(0.14) && b2.foreground == Self.color("@primary"))
        #expect(b2.textStyle?.weight == .regular && b2.textStyle?.size == 15.5) // a button with a variant prop: body text, as Android
        #expect(b2.layout.margin.top == 10)
        let b3 = try #require(a.find("b3"))
        #expect(b3.box.border == BorderSpec(width: 1, color: Self.color("@border")) && b3.box.opacity == 0.5)
        guard case .button(let bc) = b3.content else { Issue.record("not a button"); return }
        #expect(bc.disabled)
        let ch = try #require(a.find("ch"))
        #expect(ch.box.fill == Self.color("@primary").withAlpha(0.16) && ch.foreground == Self.color("@primary"))
        #expect(ch.box.border?.color == Self.color("@primary") && ch.events["click"]?.haptic == .tick)
        let ib = try #require(a.find("ib"))
        guard case .iconButton(let ic) = ib.content else { Issue.record("not an icon button"); return }
        #expect(ic.badge == "99+" && ic.fill == Self.color("@primary") && ic.iconColor == Self.color("@onPrimary") && ic.radius == 999)
        #expect(ib.accessibilityLabel == Fixtures.builtIn.t("menu.more", lang: "cs"))
        let card = try #require(a.find("card"))
        #expect(card.box.fill == Self.color("@surface") && card.box.elevation == 1 && card.box.radius == Double(Fixtures.builtIn.radius + 4))
        #expect(a.find("gone") == nil)
        let alien = try #require(a.find("alien"))
        #expect(alien.content == .unknown("hologram") && alien.children.isEmpty)

        // the user's look: tonal buttons, square shapes, compact, square bubbles, a scale press, bigger text
        var s = SettingsModel()
        s.set("look.buttons", "outlined"); s.set("look.shape", "square"); s.set("appearance.density", "compact")
        s.set("appearance.bubbles", "square"); s.set("look.press", "scale"); s.set("appearance.fontScale", 1.5)
        let b = try tree(col, s)
        #expect(b.box.padding.top == 8 * Double(Float(0.8)))
        #expect(b.find("b2")!.layout.margin.top == 10 * Double(Float(0.8)))
        let o1 = b.find("b1")!
        #expect(o1.box.fill == .transparent && o1.foreground == Self.color("@primary") && o1.box.border?.width == 1.5 && o1.box.radius == 4 && o1.box.press == .scale)
        #expect(o1.textStyle?.size == 14 * 1.5)
        #expect(b.find("bubble")!.box.radius == 4)
        s.set("appearance.bubbles", "minimal")
        let m = try tree(col, s)
        #expect(m.find("bubble")!.box.fill == .transparent && m.find("bubble")!.box.border?.width == 1)

        // a template's colours and a variant
        var t = SettingsModel()
        t.set("appearance.preset", "nord"); t.set("look.variant", "sage")
        let n = try tree(col, t, dark: true)
        #expect(n.find("b1")!.box.fill == Palette.color("nord", "sage", dark: true))
        #expect(n.find("card")!.box.fill == DesignColor.parse(Fixtures.templates.first { $0.id == "nord" }!.tokens(dark: true)["surface"]!))
    }

    @Test func layoutRules() throws {
        let row = DesignNode(id: "r", el: "row", style: ["gap": 8, "justify": "between"], children: [
            DesignNode(id: "a", el: "text", text: "a"),
            DesignNode(id: "d", el: "divider"),
            DesignNode(id: "sp", el: "spacer"),
            DesignNode(id: "sz", el: "spacer", props: ["size": 12]),
            DesignNode(id: "w", el: "text", text: "w", style: ["width": "match", "height": 30, "self": "end", "margin": "1 2 3"]),
        ])
        let r = try #require(try ScreenResolver(Self.context()).resolve(row, scope: .empty))
        #expect(r.children.map { $0.content == .flex } == [false, true, false, true, false, true, false, true, false])
        let d = r.find("d")!
        #expect(d.layout.width == .points(1) && d.layout.height == .fill && d.box.fill == Self.color("@border"))
        #expect(d.layout.margin.left == 8)
        #expect(r.find("sp")!.layout == LayoutParams(width: .points(0), height: .points(0), weight: 1))
        #expect(r.find("sz")!.layout.width == .points(12))
        let w = r.find("w")!
        #expect(w.layout.width == .fill && w.layout.height == .points(30) && w.layout.crossAlign == .end)
        #expect(w.layout.margin == DesignInsets(top: 1, right: 2, bottom: 3, left: 2 + 8))

        let stack = DesignNode(id: "s", el: "stack", children: [DesignNode(id: "a", el: "text"), DesignNode(id: "b", el: "text", style: ["self": "center"])])
        let st = try #require(try ScreenResolver(Self.context()).resolve(stack, scope: .empty))
        #expect(st.container?.kind == .overlay)
        #expect(st.find("a")!.layout.width == .fill && st.find("a")!.layout.frameAlign == .none)
        #expect(st.find("b")!.layout.frameAlign == .center)

        let flow = DesignNode(id: "f", el: "row", props: ["wrap": true], style: ["gap": 6, "justify": "center"], children: [DesignNode(id: "c", el: "chip", text: "x")])
        let fl = try #require(try ScreenResolver(Self.context()).resolve(flow, scope: .empty))
        #expect(fl.container == ContainerSpec(kind: .flow, justify: .center, flowGap: 6))
        #expect(fl.find("c")!.layout.margin.left == 0)

        let scroll = DesignNode(id: "sc", el: "scroll", props: ["horizontal": "true"], style: ["gap": 4], children: [DesignNode(id: "a", el: "text"), DesignNode(id: "b", el: "text")])
        let sc = try #require(try ScreenResolver(Self.context()).resolve(scroll, scope: .empty))
        #expect(sc.container == ContainerSpec(kind: .horizontal, justify: .start, scroll: .horizontal))
        #expect(sc.find("b")!.layout.margin.top == 4) // Android adds a scroll's gap on top, even sideways
    }

    @Test func repeatedNodes() throws {
        let list = DesignNode(id: "l", el: "column", style: ["gap": 5], children: [
            DesignNode(id: "head", el: "text", text: "Head"),
            DesignNode(id: "it", el: "text", text: "{$p.name} {$index}{=$first ? ' first' : ''}{=$last ? ' last' : ''}", condition: "$p.name != 'skip'", each: "$people", alias: "p"),
        ])
        let people: DesignValue = [.obj(["name": "Ann"]), .obj(["name": "skip"]), .obj(["name": "Bob"])]
        let l = try #require(try ScreenResolver(Self.context()).resolve(list, scope: Scope(["people": people])))
        let group = try #require(l.children.last)
        #expect(group.isRepeat && group.container?.kind == .vertical && group.id == "l/it")
        #expect(group.layout.margin.top == 5)
        #expect(group.children.map(\.id) == ["l/it#0", "l/it#2"])
        #expect(group.children.map { if case .text(let t) = $0.content { return t.text } else { return "" } } == ["Ann 0 first", "Bob 2 last"])
        #expect(group.children[1].layout.margin.top == 5)
        #expect(group.children[1].scope["p"]["name"] == "Bob")

        let many = DesignNode(id: "m", el: "row", children: [DesignNode(id: "x", el: "text", text: "{$item}", each: "$n")])
        let big = try #require(try ScreenResolver(Self.context()).resolve(many, scope: Scope(["n": .array((0..<300).map { .number(Double($0)) })])))
        #expect(big.children[0].children.count == 200 && big.children[0].container?.kind == .horizontal)
        let none = try #require(try ScreenResolver(Self.context()).resolve(many, scope: .empty))
        #expect(none.children[0].children.isEmpty)
    }

    @Test func controlsBoundToSettingsAndForm() throws {
        var s = SettingsModel()
        s.set("voice.rate", 1.5)
        let tree = DesignNode(id: "c", el: "column", children: [
            DesignNode(id: "sel", el: "select", props: ["setting": "voice.lang", "options": ":{_'k.none'}|cs:Čeština|de:Deutsch|", "hint": "Pick"]),
            DesignNode(id: "sel2", el: "select", props: ["bind": "who", "options": "=$opts"]),
            DesignNode(id: "sl", el: "slider", props: ["setting": "voice.rate", "min": 0.5, "max": "2.5", "step": 0.25], on: ["change": EventHandler(action: "flash", arg: "{$value}")]),
            DesignNode(id: "seg", el: "segmented", props: ["setting": "appearance.tone", "options": "system:A|light:B|dark:C"]),
            DesignNode(id: "sw", el: "switch", text: "Tick", props: ["setting": "look.haptics"]),
            DesignNode(id: "in", el: "input", props: ["bind": "q", "hint": "Search", "type": "password"], on: ["submit": EventHandler(action: "back")]),
            DesignNode(id: "pr", el: "progress", props: ["value": "=$p"]),
            DesignNode(id: "spin", el: "progress"),
            DesignNode(id: "img", el: "image", props: ["src": "https://cdn.example/a.png", "ratio": 1.5, "fit": "contain"]),
            DesignNode(id: "img2", el: "image", props: ["src": "https://x.example/{$q}"]),
            DesignNode(id: "img3", el: "image", props: ["src": "=$photo"]),
            DesignNode(id: "ic", el: "icon", props: ["icon": "=$i", "size": "16", "color": "@danger"]),
            DesignNode(id: "sh", el: "sheet", props: ["present": "=$dock ? 'dock' : 'sheet'", "dismissOnAction": true]),
        ])
        let scope = Scope(["opts": [.obj(["value": "a", "label": "Alpha"]), "b"], "p": 0.42, "q": "secret", "photo": "data:image/png;base64,iVBORw0KGgo=", "i": "", "dock": true])
        let ctx = Self.context(settings: s, form: ["who": "b", "q": "typed"])
        let c = try #require(try ScreenResolver(ctx).resolve(tree, scope: scope))
        guard case .select(let sel) = c.find("sel")!.content else { Issue.record("select"); return }
        #expect(sel.options == [DesignOption(value: "", label: Fixtures.builtIn.t("k.none", lang: "cs")), DesignOption(value: "cs", label: "Čeština"), DesignOption(value: "de", label: "Deutsch")])
        #expect(sel.current == "" && sel.label == "k.none")
        #expect(c.find("sel")!.box.fill == Self.color("@surfaceVariant") && c.find("sel")!.box.minHeight == 44)
        #expect(c.find("sel")!.binding?.setting == "voice.lang")
        guard case .select(let sel2) = c.find("sel2")!.content else { Issue.record("select2"); return }
        #expect(sel2.options == [DesignOption(value: "a", label: "Alpha"), DesignOption(value: "b", label: "b")] && sel2.label == "b")
        guard case .slider(let sl) = c.find("sl")!.content else { Issue.record("slider"); return }
        #expect(sl.min == 0.5 && sl.max == 2.5 && sl.value == 1.5 && sl.fraction == 0.5)
        #expect(sl.value(atFraction: 0.61) == 1.75)
        #expect(sl.value(atFraction: 1) == 2.5)
        guard case .segmented(let seg) = c.find("seg")!.content else { Issue.record("segmented"); return }
        #expect(seg.selectedIndex == 0 && seg.selectedFill == Self.color("@primary") && seg.outerRadius == 22 && seg.innerRadius == 19)
        guard case .toggle(let sw) = c.find("sw")!.content else { Issue.record("switch"); return }
        #expect(sw.checked && sw.commitsOnTap && sw.style == .toggle && sw.text == "Tick")
        guard case .input(let inp) = c.find("in")!.content else { Issue.record("input"); return }
        #expect(inp.value == "typed" && inp.kind == .password && inp.hint == "Search" && inp.submits && c.find("in")!.events["submit"] != nil)
        #expect(c.find("in")!.box.padding == DesignInsets(top: 10, right: 14, bottom: 10, left: 14) && c.find("in")!.textStyle?.hintColor == Self.color("@muted"))
        #expect(c.find("pr")!.content == .progress(0.42))
        #expect(c.find("spin")!.content == .progress(nil))
        #expect(c.find("img")!.content == .image(ImageContent(source: .remote(URL(string: "https://cdn.example/a.png")!), fit: .contain, ratio: 1.5)))
        #expect(c.find("img2")!.content == .image(ImageContent(source: .none, fit: .cover, ratio: 0)))
        guard case .image(let im3) = c.find("img3")!.content, case .data(let mime, let bytes) = im3.source else { Issue.record("img3"); return }
        #expect(mime == "image/png" && bytes.count == 8)
        #expect(c.find("ic")!.content == .icon(IconContent(name: "circle", size: 16, color: Self.color("@danger"))))
        #expect(c.find("sh")!.content == .sheet(SheetContent(dock: true, dismissOnAction: true)))

        // a change on the slider: through the runner into the setting, then its change event with $value
        let h = MockHost()
        h.settings = s
        ActionRunner(host: h).commit(c.find("sl")!.binding!, value: .number(sl.value(atFraction: 0.61)))
        #expect(h.settings.num("voice.rate") == 1.75)
        #expect(h.performed == [.flash("1.75")])
    }

    @Test func aBrokenExpressionFailsTheScreenAndTheBuiltInOneIsShown() throws {
        var doc = Fixtures.builtIn.document
        doc.screens["about"] = DesignNode(id: "root", el: "text", text: "{$broken")
        let broken = Design.fromDocument(doc)
        let r = ScreenResolver(RenderContext(design: broken, dark: false, translator: .keys))
        #expect(throws: ExprError.self) { try r.resolve(screen: "about", scope: .empty) }
        let (node, failure) = r.resolveOrFallback(screen: "about", scope: Self.scope(.obj([:])), builtIn: Fixtures.builtIn)
        #expect(failure != nil && node != nil && node?.nodeId == Fixtures.builtIn.screen("about")?.id)
    }

    @Test func avatars() {
        #expect(ScreenResolver.initials("Alice Nováková") == "AN")
        #expect(ScreenResolver.initials("bystry-sokol-7k3q") == "BS")
        #expect(ScreenResolver.initials("  ") == "?")
        #expect(ScreenResolver.initials(nil) == "?")
        #expect(ScreenResolver.initials(".net") == "N")    // a leading separator leaves an empty first part
        #expect(ScreenResolver.initials("a..b") == "AB")
        #expect(ScreenResolver.initials("žluť") == "Ž")
        // String.hashCode over the palette
        #expect(ScreenResolver.nameColor("Alice") == DesignColor(argb: 0xFFEA_580C)) // 63350368 % 10 = 8
        #expect(ScreenResolver.nameColor("") == DesignColor(argb: 0xFFE1_1D48))
    }
}
