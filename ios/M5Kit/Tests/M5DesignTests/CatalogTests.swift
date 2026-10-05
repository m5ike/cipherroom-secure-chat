import Foundation
import Testing
@testable import M5Design

/// The Swift catalogue says what the server's catalogue says (fixtures/catalog.json, dumped from
/// server/android/design.ts by fixtures/dump-catalog.ts), and ELEMENTS.md is generated from it.
@Suite struct CatalogTests {
    static let catalog = try! Fixtures.json(Fixtures.here + "catalog.json")

    @Test func elementsAndTheirProps() {
        let server = Self.catalog["elements"].arrayValue!
        #expect(server.map { $0["el"].stringValue! }.sorted() == ElementCatalog.entries.map(\.el).sorted())
        for e in server {
            let el = e["el"].stringValue!
            guard let mine = ElementCatalog.entry(el) else { Issue.record("no \(el)"); continue }
            #expect(ElementKind(name: el).isKnown && ElementKind(name: el).name == el)
            #expect(mine.container == e["container"].boolValue && mine.text == e["text"].boolValue && mine.group == e["group"].stringValue, "\(el)")
            let props = e["props"].arrayValue!
            #expect(props.map { $0["name"].stringValue! } == mine.props.map(\.name), "\(el)")
            for (p, q) in zip(props, mine.props) {
                #expect(p["kind"].stringValue == q.kind.rawValue, "\(el).\(q.name)")
                #expect(p["options"].arrayValue?.map { $0.stringValue! } == q.options, "\(el).\(q.name)")
            }
        }
        #expect(ElementKind(name: "hologram") == .unknown("hologram") && !ElementKind(name: "hologram").isKnown)
    }

    @Test func styleTokensEventsSlotsLimits() {
        #expect(Self.catalog["style"].arrayValue!.map { $0["name"].stringValue! } == ElementCatalog.styleProps.map(\.name))
        #expect(Self.catalog["colors"].arrayValue!.map { $0.stringValue! } == ElementCatalog.colorTokens)
        #expect(Self.catalog["anims"].arrayValue!.map { $0.stringValue! } == ElementCatalog.animTypes)
        #expect(Self.catalog["easings"].arrayValue!.map { $0.stringValue! } == ElementCatalog.easings)
        #expect(Self.catalog["easings"].arrayValue!.allSatisfy { Easing(rawValue: $0.stringValue!) != nil })
        #expect(Self.catalog["events"].arrayValue!.map { $0.stringValue! } == ElementCatalog.events)
        #expect(Self.catalog["slots"].arrayValue!.map { $0["name"].stringValue! } == ElementCatalog.slots.map(\.name))
        for s in Self.catalog["slots"].arrayValue! {
            #expect(ElementCatalog.slots.first { $0.name == s["name"].stringValue }?.screens == s["screens"].arrayValue!.map { $0.stringValue! })
        }
        let l = Self.catalog["limits"]
        #expect(l["nodes"] == .number(Double(ElementCatalog.Limits.nodes)) && l["depth"] == .number(Double(ElementCatalog.Limits.depth)))
        #expect(l["text"] == .number(Double(ElementCatalog.Limits.text)) && l["strings"] == .number(Double(ElementCatalog.Limits.strings)))
        #expect(l["libraries"] == .number(Double(ElementCatalog.Limits.libraries)) && l["steps"] == .number(Double(ElementCatalog.Limits.steps)))
        #expect(l["menuItems"] == .number(Double(ElementCatalog.Limits.menuItems)) && l["asset"] == .number(Double(ElementCatalog.Limits.asset)))
        #expect(l["assets"] == .number(Double(ElementCatalog.Limits.assets)))
        #expect(Self.catalog["langs"].arrayValue!.map { $0.stringValue! }.sorted() == DesignLocales.codes.sorted())
    }

    @Test func actionsAndWhatTheyNeed() {
        let server = Self.catalog["actions"].arrayValue!
        #expect(server.map { $0["action"].stringValue! } == ActionCatalog.names)
        for a in server { #expect(ActionCatalog.entry(a["action"].stringValue!)?.arg == a["arg"].stringValue, "\(a["action"])") }
        for need in Self.catalog["needs"].arrayValue! {
            let code = Int(need["code"].numberValue!)
            for a in need["actions"].arrayValue! { #expect(ActionCatalog.entry(a.stringValue!)?.since == code, "\(a)") }
            for e in need["elements"].arrayValue! { #expect(ElementCatalog.entry(e.stringValue!)?.since == code, "\(e)") }
        }
    }

    @Test func screensAndTheirVariables() {
        let server = Self.catalog["screens"].arrayValue!
        #expect(server.map { $0["id"].stringValue! } == ScreenScope.screens.map(\.id))
        for (s, mine) in zip(server, ScreenScope.screens) {
            #expect(s["vars"].arrayValue!.map { String($0.stringValue!.dropFirst()) } == mine.vars && s["group"].stringValue == mine.group, "\(mine.id)")
            #expect(Fixtures.builtIn.screen(mine.id) != nil, "\(mine.id)")
        }
        var settings = SettingsModel()
        settings.set("voice.rate", 2)
        let app = ScreenScope.app(design: Fixtures.builtIn, version: "6.14.0", code: 61400)
        let lock = ScreenScope.scope(screen: "lock", app: app, form: ["typed": "secret"], settings: settings, own: ["lock": .obj(["mode": "pin"])])
        #expect(lock["form"] == .obj([:]) && lock["lock"]["mode"] == "pin" && lock["settings"]["voice"]["rate"] == 2 && lock["app"]["code"] == 61400)
        let rooms = ScreenScope.scope(screen: "rooms", app: app, form: ["typed": "x"], settings: settings)
        #expect(rooms["form"]["typed"] == "x")
        #expect(ScreenScope.room(key: nil)["status"] == "offline" && ScreenScope.room(key: "k", name: "team", active: true)["active"] == true)
    }

    @Test func iconsAreTheConsolesCatalogue() throws {
        #expect(Self.catalog["icons"].arrayValue!.map { $0.stringValue! } == Icons.names)
        let set = try IconSet(json: Fixtures.data(Fixtures.assets + "icons.json"))
        #expect(set.icons.keys.sorted() == Icons.names)
    }

    @Test func elementsMdIsGeneratedFromTheCatalogue() throws {
        let url = Fixtures.url("ios/M5Kit/Sources/M5Design/ELEMENTS.md")
        let generated = ElementCatalog.markdown()
        if ProcessInfo.processInfo.environment["M5_WRITE_ELEMENTS_MD"] == "1" {
            try Data(generated.utf8).write(to: url)
        }
        let committed = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        #expect(committed == generated, "ELEMENTS.md is out of step: run the tests with M5_WRITE_ELEMENTS_MD=1")
        for e in ElementCatalog.entries { #expect(generated.contains("## `\(e.el)`")) }
    }
}

/// Icons.java / SvgPath.java: the Lucide geometry.
@Suite struct IconTests {
    static let set = try! IconSet(json: Fixtures.data(Fixtures.assets + "icons.json"))

    static func finite(_ e: PathElement) -> Bool {
        func ok(_ p: IconPoint) -> Bool { p.x.isFinite && p.y.isFinite && abs(p.x) < 100 && abs(p.y) < 100 }
        switch e {
        case .move(let p), .line(let p): return ok(p)
        case .quad(let c, let p): return ok(c) && ok(p)
        case .cubic(let a, let b, let p): return ok(a) && ok(b) && ok(p)
        case .close: return true
        case .ellipse(let r), .roundedRect(let r, _, _): return r.width >= 0 && r.height >= 0 && r.x.isFinite
        }
    }

    @Test func everyIconParses() {
        #expect(Self.set.icons.count == 277)
        for (name, shapes) in Self.set.icons {
            #expect(!shapes.isEmpty, "\(name)")
            for s in shapes { #expect(!s.elements.isEmpty && s.elements.allSatisfy(Self.finite), "\(name)") }
        }
        #expect(Self.set.shapes("no-such-icon") == Self.set.shapes("circle"))
        #expect(Self.set.shapes("circle") == [IconShape(elements: [.ellipse(IconRect(x: 2, y: 2, width: 20, height: 20))], fill: false)])
        #expect(Self.set.shapes("check-check") == [
            IconShape(elements: [.move(IconPoint(18, 6)), .line(IconPoint(7, 17)), .line(IconPoint(2, 12))], fill: false),
            IconShape(elements: [.move(IconPoint(22, 10)), .line(IconPoint(14.5, 17.5)), .line(IconPoint(13, 16))], fill: false),
        ])
    }

    @Test func sfSymbolsMapBestEffort() {
        #expect(Icons.sfSymbol("settings") == "gearshape")
        #expect(Icons.sfSymbol("check-check") == nil)   // drawn from the Lucide geometry
        #expect(Icons.sfSymbol("no-such") == nil)
        let mapped = Icons.names.filter { Icons.sfSymbol($0) != nil }.count
        #expect(mapped > 240)
    }

    @Test func pathCommands() {
        #expect(SvgPath.parse("M1 2 3 4h5v-6H0V1z") == [.move(IconPoint(1, 2)), .line(IconPoint(3, 4)), .line(IconPoint(8, 4)), .line(IconPoint(8, -2)),
                                                       .line(IconPoint(0, -2)), .line(IconPoint(0, 1)), .close])
        #expect(SvgPath.parse("m1 1 2 2") == [.move(IconPoint(1, 1)), .line(IconPoint(3, 3))])
        #expect(SvgPath.parse("M0 0C1 1 2 2 3 3S5 5 6 6") == [.move(IconPoint(0, 0)), .cubic(control1: IconPoint(1, 1), control2: IconPoint(2, 2), to: IconPoint(3, 3)),
                                                               .cubic(control1: IconPoint(4, 4), control2: IconPoint(5, 5), to: IconPoint(6, 6))])
        #expect(SvgPath.parse("M0 0Q1 1 2 0T4 0") == [.move(IconPoint(0, 0)), .quad(control: IconPoint(1, 1), to: IconPoint(2, 0)), .quad(control: IconPoint(3, -1), to: IconPoint(4, 0))])
        #expect(SvgPath.parse("M0 0S1 1 2 2") == [.move(IconPoint(0, 0)), .cubic(control1: IconPoint(0, 0), control2: IconPoint(1, 1), to: IconPoint(2, 2))])
        // numbers run into each other: "1e1" "-2.5" ".5", and a missing one reads 0
        #expect(SvgPath.parse("M1e1-2.5.5") == [.move(IconPoint(10, -2.5)), .line(IconPoint(0.5, 0))])
        #expect(SvgPath.parse("M0 0 L 1 1 # 2 2").count == 2)   // a stray character ends the path
        #expect(SvgPath.parse("M0 0 X 1 1") == [.move(IconPoint(0, 0))])
    }

    @Test func arcsBecomeQuarterCubics() {
        // a half circle of radius 5 from (0,0) to (10,0): two quarter pieces ending on the far point
        let p = SvgPath.parse("M0 0A5 5 0 0 1 10 0")
        #expect(p.count == 3)
        if case .cubic(_, _, let end) = p[2] { #expect(abs(end.x - 10) < 1e-9 && abs(end.y) < 1e-9) } else { Issue.record("not a cubic") }
        if case .cubic(_, _, let mid) = p[1] { #expect(abs(mid.x - 5) < 1e-9 && abs(abs(mid.y) - 5) < 1e-9) } else { Issue.record("not a cubic") }
        // flags without separators, relative end point
        let q = SvgPath.parse("M2 2a1 1 0 01 2 0")
        if case .cubic(_, _, let end)? = q.last { #expect(abs(end.x - 4) < 1e-9 && abs(end.y - 2) < 1e-9) } else { Issue.record("no arc") }
        // zero radius: a line; same point: nothing
        #expect(SvgPath.parse("M0 0A0 5 0 0 1 3 4") == [.move(IconPoint(0, 0)), .line(IconPoint(3, 4))])
        #expect(SvgPath.parse("M1 1A5 5 0 0 1 1 1") == [.move(IconPoint(1, 1))])
        // a radius too small grows to reach the end
        let big = SvgPath.parse("M0 0A1 1 0 0 1 10 0")
        if case .cubic(_, _, let end)? = big.last { #expect(abs(end.x - 10) < 1e-9) } else { Issue.record("no arc") }
    }
}
