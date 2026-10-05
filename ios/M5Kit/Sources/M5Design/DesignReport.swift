// What this version of the app makes of a design: elements and actions it
// does not know (kept in the document, drawn as nothing / logged as unknown —
// a newer server's design still loads), expressions and templates that do not
// parse, and the server sanitizer's LIMITS exceeded. The app logs the report;
// it never refuses a signed design for it (Android does not either).

import Foundation

public struct DesignReport: Sendable, Equatable {
    public var unknownElements: Set<String> = []
    public var unknownActions: Set<String> = []
    public var unknownEvents: Set<String> = []
    /// "where: why" for every expression or template that does not parse.
    public var expressionErrors: [String] = []
    /// LIMITS exceeded and structural problems (a bundle missing a required screen, a nested lib.run…).
    public var problems: [String] = []
    /// Elements counted over every screen.
    public var nodeCount = 0

    public var isClean: Bool { unknownElements.isEmpty && unknownActions.isEmpty && unknownEvents.isEmpty && expressionErrors.isEmpty && problems.isEmpty }

    public init() {}

    /// Checks a whole design.
    public static func check(_ doc: DesignDocument) -> DesignReport {
        var r = DesignReport()
        for required in Design.requiredScreens where doc.screens[required] == nil { r.problems.append("no \(required) screen") }
        for (id, tree) in doc.screens.sorted(by: { $0.key < $1.key }) { r.screen(id, tree) }
        for (id, items) in doc.menus.sorted(by: { $0.key < $1.key }) {
            guard let items else { r.problems.append("menus.\(id): not a list"); continue }
            if items.count > ElementCatalog.Limits.menuItems { r.problems.append("menus.\(id): more than \(ElementCatalog.Limits.menuItems) items") }
            for (i, it) in items.enumerated() {
                let at = "menus.\(id)[\(i)]"
                r.action(it.action, at: at)
                r.template(it.label, at: at + " label")
                if let a = it.arg { r.value(a, at: at + " arg") }
                if let c = it.condition { r.expr(c, at: at + " if") }
                if !it.icon.isEmpty && Icons.symbols[it.icon] == nil { r.problems.append("\(at): unknown icon \"\(it.icon)\"") }
            }
        }
        if doc.libraries.count > ElementCatalog.Limits.libraries { r.problems.append("more than \(ElementCatalog.Limits.libraries) libraries") }
        for (name, lib) in doc.libraries.sorted(by: { $0.key < $1.key }) {
            let steps = lib.steps ?? []
            if steps.count > ElementCatalog.Limits.steps { r.problems.append("libraries.\(name): more than \(ElementCatalog.Limits.steps) steps") }
            for (i, st) in steps.enumerated() {
                let at = "libraries.\(name)[\(i)]"
                guard let a = st.action else { r.problems.append("\(at): no action"); continue }
                if a == "lib.run" { r.problems.append("\(at): a library cannot run another library") }
                r.action(a, at: at)
                if let arg = st.arg { r.value(arg, at: at + " arg") }
                if let c = st.condition { r.expr(c, at: at + " if") }
            }
        }
        for (lang, table) in doc.strings where table.count > ElementCatalog.Limits.strings {
            r.problems.append("strings.\(lang): more than \(ElementCatalog.Limits.strings) texts")
        }
        var total = 0
        for (name, a) in doc.assets {
            let size = a.data.utf8.count * 3 / 4
            if size > ElementCatalog.Limits.asset { r.problems.append("assets.\(name): larger than \(ElementCatalog.Limits.asset / 1024) kB") }
            total += size
        }
        if total > ElementCatalog.Limits.assets { r.problems.append("assets: more than \(ElementCatalog.Limits.assets / 1024 / 1024) MB together") }
        return r
    }

    mutating func screen(_ id: String, _ tree: DesignNode) {
        var count = 0
        tree.walk { n, depth in
            count += 1
            let at = "\(id)/\(n.id)"
            if depth > ElementCatalog.Limits.depth { problems.append("\(at): nested deeper than \(ElementCatalog.Limits.depth)") }
            if !n.element.isKnown { unknownElements.insert(n.el) }
            if let t = n.text {
                if JavaSemantics.length(t) > ElementCatalog.Limits.text { problems.append("\(at): text longer than \(ElementCatalog.Limits.text)") }
                value(t, at: at + " text")
            }
            for (k, v) in n.props ?? [:] {
                guard case .string(let s) = v else { continue }
                if k == "options" && s.hasPrefix("=") { expr(String(s.dropFirst()), at: at + " options"); continue }
                value(s, at: "\(at) \(k)")
            }
            for (k, v) in n.style ?? [:] {
                if case .string(let s) = v, s.hasPrefix("=") { expr(String(s.dropFirst()), at: "\(at) style.\(k)") }
            }
            if let c = n.condition { expr(c, at: at + " if") }
            if let e = n.each { expr(e, at: at + " each") }
            for (ev, h) in n.on ?? [:] {
                if !ElementCatalog.events.contains(ev) { unknownEvents.insert(ev) }
                action(h.action, at: "\(at) on.\(ev)")
                if let a = h.arg { value(a, at: "\(at) on.\(ev) arg") }
            }
        }
        nodeCount += count
        if count > ElementCatalog.Limits.nodes { problems.append("\(id): more than \(ElementCatalog.Limits.nodes) elements") }
    }

    mutating func action(_ a: String, at: String) {
        if !ActionCatalog.isKnown(a) { unknownActions.insert(a) }
    }

    mutating func expr(_ src: String, at: String) {
        if let e = Expr.check(src) { expressionErrors.append("\(at): \(e)") }
    }

    mutating func template(_ src: String, at: String) {
        if let e = Expr.checkTemplate(src) { expressionErrors.append("\(at): \(e)") }
    }

    /// A prop / argument value: "=expression" or a template.
    mutating func value(_ src: String, at: String) {
        if src.hasPrefix("=") { expr(String(src.dropFirst()), at: at) } else { template(src, at: at) }
    }
}
