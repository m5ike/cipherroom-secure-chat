// The screens' expression and template language — a faithful port of
// android/app/src/main/java/cz/m5cet/app/ui/Expr.java (and server/android/
// expr.ts, same vectors: test/fixtures/android-expr.json).
//
//   expressions  $var.member[0] · _('key') · literals 'text' "text" 1.5 true false null
//                ! - (unary) · * / % · + - · < > <= >= · == != === !== · && || · c ? a : b
//   templates    text with {$var.path|filter:arg}, {_'key'|filter}, {=expression}, {{ for "{"
//   filters      upper lower trim truncate[:n] default[:'x'] count date time datetime size
//
// Values are DesignValues; strings are measured and compared in UTF-16 code
// units like Java's. Parsed once and cached (2000 entries).

import Foundation
import Synchronization

/// Why an expression or a template is not valid (the Java message, word for word).
public struct ExprError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

public enum Expr {
    /// The longest expression (characters, UTF-16).
    public static let max = 400
    /// How deep expressions may nest (parentheses, ternaries, indexes).
    public static let maxDepth = 40

    // MARK: - AST

    indirect enum Node: Sendable {
        case lit(DesignValue)
        case variable(String)
        case get(Node, Node)
        case tr(String)
        case not(Node)
        case negate(Node)
        case logic(Node, Node, or: Bool)
        case cond(Node, Node, Node)
        case binary(BinOp, Node, Node)
    }

    enum BinOp: String, Sendable { case eq = "==", ne = "!=", add = "+", sub = "-", mul = "*", div = "/", mod = "%", lt = "<", gt = ">", le = "<=", ge = ">=" }

    static func evaluate(_ n: Node, _ s: Scope, _ tr: Translator?) -> DesignValue {
        switch n {
        case .lit(let v): return v
        case .variable(let name): return s.get(name)
        case .get(let o, let k): return member(evaluate(o, s, tr), evaluate(k, s, tr))
        case .tr(let key): return .string(tr?.t(key) ?? key)
        case .not(let a): return .bool(!truthy(evaluate(a, s, tr)))
        case .negate(let a): return .number(-num(evaluate(a, s, tr)))
        case .logic(let a, let b, let or):
            let x = evaluate(a, s, tr)
            return or ? (truthy(x) ? x : evaluate(b, s, tr)) : (truthy(x) ? evaluate(b, s, tr) : x)
        case .cond(let c, let a, let b): return truthy(evaluate(c, s, tr)) ? evaluate(a, s, tr) : evaluate(b, s, tr)
        case .binary(let op, let a, let b):
            let x = evaluate(a, s, tr), y = evaluate(b, s, tr)
            switch op {
            case .eq: return .bool(same(x, y))
            case .ne: return .bool(!same(x, y))
            case .add:
                if case .string = x { return .string(toText(x) + toText(y)) }
                if case .string = y { return .string(toText(x) + toText(y)) }
                return .number(num(x) + num(y))
            case .sub: return .number(num(x) - num(y))
            case .mul: return .number(num(x) * num(y))
            case .div: return num(y) == 0 ? .null : .number(num(x) / num(y))
            case .mod: return num(y) == 0 ? .null : .number(num(x).truncatingRemainder(dividingBy: num(y)))
            case .lt, .gt, .le, .ge:
                let c: Int
                if case .string(let p) = x, case .string(let q) = y {
                    c = compareUTF16(p, q)
                } else {
                    let p = num(x), q = num(y)
                    if p.isNaN || q.isNaN { return .bool(false) }
                    c = JavaSemantics.compare(p, q)
                }
                switch op {
                case .lt: return .bool(c < 0)
                case .gt: return .bool(c > 0)
                case .le: return .bool(c <= 0)
                default: return .bool(c >= 0)
                }
            }
        }
    }

    /// String.compareTo: UTF-16 code units, lexicographically.
    static func compareUTF16(_ a: String, _ b: String) -> Int {
        var i = a.utf16.makeIterator(), j = b.utf16.makeIterator()
        while true {
            switch (i.next(), j.next()) {
            case (nil, nil): return 0
            case (nil, _): return -1
            case (_, nil): return 1
            case (let x?, let y?): if x != y { return Int(x) - Int(y) }
            }
        }
    }

    // MARK: - lexer

    struct Tok: Sendable { let k: Character; let v: String; let at: Int }

    private static let quote1: UInt16 = 0x27, quote2: UInt16 = 0x22, backslash: UInt16 = 0x5C, dollar: UInt16 = 0x24, underscore: UInt16 = 0x5F, dot: UInt16 = 0x2E

    static func lex(_ src: String) throws -> [Tok] {
        let u = JavaSemantics.units(src)
        var out: [Tok] = []
        var i = 0
        let n = u.count
        while i < n {
            let c = u[i]
            if c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { i += 1; continue }
            if JavaSemantics.isDigit(c) || (c == dot && i + 1 < n && JavaSemantics.isDigit(u[i + 1])) {
                var j = i
                while j < n && (JavaSemantics.isDigit(u[j]) || u[j] == dot) { j += 1 }
                if j < n && (u[j] == 0x65 || u[j] == 0x45) {
                    j += 1
                    if j < n && (u[j] == 0x2B || u[j] == 0x2D) { j += 1 }
                    while j < n && JavaSemantics.isDigit(u[j]) { j += 1 }
                }
                out.append(Tok(k: "n", v: JavaSemantics.string(u[i..<j]), at: i)); i = j; continue
            }
            if c == quote1 || c == quote2 {
                var sb: [UInt16] = []
                var j = i + 1
                while j < n && u[j] != c {
                    if u[j] == backslash && j + 1 < n { sb.append(u[j + 1]); j += 2; continue }
                    sb.append(u[j]); j += 1
                }
                if j >= n { throw ExprError("unterminated string at \(i)") }
                out.append(Tok(k: "s", v: JavaSemantics.string(sb), at: i)); i = j + 1; continue
            }
            if c == dollar {
                var j = i + 1
                if j >= n || !(JavaSemantics.isLetter(u[j]) || u[j] == underscore) { throw ExprError("bad variable at \(i)") }
                while j < n && (JavaSemantics.isLetterOrDigit(u[j]) || u[j] == underscore) { j += 1 }
                out.append(Tok(k: "v", v: JavaSemantics.string(u[(i + 1)..<j]), at: i)); i = j; continue
            }
            if JavaSemantics.isLetter(c) || c == underscore {
                var j = i
                while j < n && (JavaSemantics.isLetterOrDigit(u[j]) || u[j] == underscore) { j += 1 }
                out.append(Tok(k: "i", v: JavaSemantics.string(u[i..<j]), at: i)); i = j; continue
            }
            let three = n >= i + 3 ? JavaSemantics.string(u[i..<(i + 3)]) : ""
            let two = n >= i + 2 ? JavaSemantics.string(u[i..<(i + 2)]) : ""
            if three == "===" || three == "!==" { out.append(Tok(k: "o", v: three, at: i)); i += 3; continue }
            if ["==", "!=", "<=", ">=", "&&", "||"].contains(two) { out.append(Tok(k: "o", v: two, at: i)); i += 2; continue }
            if c < 0x80, "!+-*/%<>?:().[],".utf16.contains(c) { out.append(Tok(k: "o", v: JavaSemantics.string([c]), at: i)); i += 1; continue }
            throw ExprError("unexpected \"\(JavaSemantics.string([c]))\" at \(i)")
        }
        out.append(Tok(k: "e", v: "", at: n))
        return out
    }

    // MARK: - parser

    struct Parser {
        let t: [Tok]
        var p = 0
        var depth = 0

        init(_ t: [Tok]) { self.t = t }

        func peek() -> Tok { t[p] }
        func isOp(_ v: String) -> Bool { let k = peek(); return k.k == "o" && k.v == v }
        mutating func expect(_ v: String) throws { if !isOp(v) { throw ExprError("expected \"\(v)\" at \(peek().at)") }; p += 1 }

        mutating func expr() throws -> Node {
            depth += 1
            if depth > Expr.maxDepth { throw ExprError("expression nested too deep") }
            let n = try ternary()
            depth -= 1
            return n
        }

        mutating func ternary() throws -> Node {
            let c = try or()
            if isOp("?") {
                p += 1
                let a = try expr()
                try expect(":")
                let b = try expr()
                return .cond(c, a, b)
            }
            return c
        }

        mutating func or() throws -> Node {
            var a = try and()
            while isOp("||") { p += 1; a = .logic(a, try and(), or: true) }
            return a
        }

        mutating func and() throws -> Node {
            var a = try eq()
            while isOp("&&") { p += 1; a = .logic(a, try eq(), or: false) }
            return a
        }

        mutating func eq() throws -> Node {
            var a = try rel()
            while isOp("==") || isOp("!=") || isOp("===") || isOp("!==") {
                let op = String(t[p].v.prefix(2)); p += 1
                a = .binary(op == "==" ? .eq : .ne, a, try rel())
            }
            return a
        }

        mutating func rel() throws -> Node {
            var a = try add()
            while isOp("<") || isOp(">") || isOp("<=") || isOp(">=") {
                let op = BinOp(rawValue: t[p].v)!; p += 1
                a = .binary(op, a, try add())
            }
            return a
        }

        mutating func add() throws -> Node {
            var a = try mul()
            while isOp("+") || isOp("-") {
                let op: BinOp = t[p].v == "+" ? .add : .sub; p += 1
                a = .binary(op, a, try mul())
            }
            return a
        }

        mutating func mul() throws -> Node {
            var a = try unary()
            while isOp("*") || isOp("/") || isOp("%") {
                let op: BinOp = t[p].v == "*" ? .mul : t[p].v == "/" ? .div : .mod; p += 1
                a = .binary(op, a, try unary())
            }
            return a
        }

        mutating func unary() throws -> Node {
            if isOp("!") { p += 1; return .not(try unary()) }
            if isOp("-") { p += 1; return .negate(try unary()) }
            return try postfix()
        }

        mutating func postfix() throws -> Node {
            var n = try primary()
            while true {
                if isOp(".") {
                    p += 1
                    let id = peek()
                    if id.k != "i" { throw ExprError("expected a name after \".\" at \(id.at)") }
                    p += 1
                    n = .get(n, .lit(.string(id.v)))
                } else if isOp("[") {
                    p += 1
                    let key = try expr()
                    try expect("]")
                    n = .get(n, key)
                } else {
                    return n
                }
            }
        }

        mutating func primary() throws -> Node {
            let k = peek()
            switch k.k {
            case "n":
                p += 1
                guard let d = JavaSemantics.parseDouble(k.v) else { throw ExprError("For input string: \"\(k.v)\"") }
                return .lit(.number(d))
            case "s": p += 1; return .lit(.string(k.v))
            case "v": p += 1; return .variable(k.v)
            case "i":
                p += 1
                if k.v == "true" { return .lit(.bool(true)) }
                if k.v == "false" { return .lit(.bool(false)) }
                if k.v == "null" { return .lit(.null) }
                if k.v == "_" && isOp("(") {
                    p += 1
                    let key = peek()
                    if key.k != "s" { throw ExprError("_() needs a quoted key at \(key.at)") }
                    p += 1
                    try expect(")")
                    return .tr(key.v)
                }
                throw ExprError("unknown name \"\(k.v)\" at \(k.at) (variables start with $)")
            default:
                if isOp("(") { p += 1; let n = try expr(); try expect(")"); return n }
                throw ExprError(k.k == "e" ? "unexpected end of the expression" : "unexpected \"\(k.v)\" at \(k.at)")
            }
        }
    }

    // MARK: - cache

    enum Cached: Sendable { case expr(Node), template([Part]) }

    private struct Cache {
        var entries: [String: (value: Cached, tick: UInt64)] = [:]
        var tick: UInt64 = 0
        mutating func get(_ key: String) -> Cached? {
            guard let e = entries[key] else { return nil }
            tick += 1
            entries[key] = (e.value, tick)
            return e.value
        }
        mutating func put(_ key: String, _ value: Cached) {
            tick += 1
            entries[key] = (value, tick)
            if entries.count > 2000, let oldest = entries.min(by: { $0.value.tick < $1.value.tick })?.key { entries[oldest] = nil }
        }
    }

    private static let cache = Mutex(Cache())

    static func parse(_ src: String) throws -> Node {
        if case .expr(let n)? = cache.withLock({ $0.get("e:" + src) }) { return n }
        if JavaSemantics.length(src) > max { throw ExprError("expression longer than \(max) characters") }
        var ps = Parser(try lex(src))
        let n = try ps.expr()
        if ps.peek().k != "e" { throw ExprError("unexpected \"\(ps.peek().v)\" at \(ps.peek().at)") }
        cache.withLock { $0.put("e:" + src, .expr(n)) }
        return n
    }

    // MARK: - public API

    /// The value of an expression (no leading "="). Throws when it does not parse.
    public static func eval(_ src: String, _ scope: Scope, _ tr: Translator? = nil) throws -> DesignValue {
        evaluate(try parse(src), scope, tr)
    }

    /// nil when the expression is valid, else why not.
    public static func check(_ src: String) -> String? {
        do { _ = try parse(src); return nil } catch let e as ExprError { return e.message } catch { return "\(error)" }
    }

    // MARK: - values

    /// Whether a value counts as true: not null, false, 0, NaN or "" (arrays and objects always).
    public static func truthy(_ v: DesignValue?) -> Bool {
        switch v ?? .null {
        case .null: return false
        case .bool(let b): return b
        case .number(let d): return d != 0 && !d.isNaN
        case .string(let s): return !s.isEmpty
        case .array, .object: return true
        }
    }

    /// A value as a number: null 0, booleans 1 / 0, text parsed (Double.parseDouble; "" → 0), else NaN.
    public static func num(_ v: DesignValue?) -> Double {
        switch v ?? .null {
        case .null: return 0
        case .number(let d): return d
        case .bool(let b): return b ? 1 : 0
        case .string(let s):
            let t = JavaSemantics.trim(s)
            if t.isEmpty { return 0 }
            return JavaSemantics.parseDouble(t) ?? .nan
        case .array, .object: return .nan
        }
    }

    /// `==`: numbers by value, texts and booleans equal, null only to null.
    /// (Java compares arrays and objects by identity; here they are values and compare by content.)
    static func same(_ a: DesignValue, _ b: DesignValue) -> Bool {
        switch (a, b) {
        case (.null, .null): return true
        case (.null, _), (_, .null): return false
        case (.number(let x), .number(let y)): return x == y
        case (.string(let x), .string(let y)): return x.utf16.elementsEqual(y.utf16)
        case (.bool(let x), .bool(let y)): return x == y
        case (.array, .array), (.object, .object): return a == b
        default: return false
        }
    }

    /// `obj.key` / `obj[key]`: an index of an array or a text, `length`, a member of an object.
    static func member(_ obj: DesignValue, _ key: DesignValue) -> DesignValue {
        if case .null = obj { return .null }
        var numericIndex: Int32?
        var numeric = false
        switch key {
        case .number(let d):
            numeric = true
            let i = JavaSemantics.intValue(d)
            if d != Double(i) { return .null }
            numericIndex = i
        case .string(let s):
            if !s.isEmpty && s.utf16.allSatisfy({ JavaSemantics.isDigit($0) }) {
                numeric = true
                guard let i = JavaSemantics.parseInt(s) else { return .null }
                numericIndex = i
            }
        default: break
        }
        if numeric, let i32 = numericIndex {
            let i = Int(i32)
            switch obj {
            case .array(let a): return i >= 0 && i < a.count ? a[i] : .null
            case .string(let s):
                let u = Array(s.utf16)
                return i >= 0 && i < u.count ? .string(JavaSemantics.string([u[i]])) : .null
            default: break
            }
        }
        guard case .string(let k) = key else { return .null }
        if k == "length" {
            switch obj {
            case .array(let a): return .number(Double(a.count))
            case .string(let s): return .number(Double(s.utf16.count))
            default: break
            }
        }
        if case .object(let o) = obj { return o[k] ?? .null }
        return .null
    }

    /// How a value reads in text: whole numbers without ".0", nothing for null, lists joined by ", ".
    public static func toText(_ v: DesignValue?) -> String {
        switch v ?? .null {
        case .null: return ""
        case .number(let d):
            if d.isNaN || d.isInfinite { return "" }
            if d == d.rounded() && abs(d) < 1e15 { return String(Int64(d)) }
            return JavaSemantics.plainDecimal(Double(JavaSemantics.round(d * 1e6)) / 1e6)
        case .bool(let b): return b ? "true" : "false"
        case .string(let s): return s
        case .array(let a): return a.map { toText($0) }.joined(separator: ", ")
        case .object: return ""
        }
    }

    // MARK: - templates

    struct Part: Sendable {
        let lit: String?
        let expr: Node?
        let filters: [(name: String, arg: String?)]
    }

    static let filterNames: Set<String> = ["upper", "lower", "trim", "truncate", "default", "count", "date", "time", "datetime", "size"]

    private static func isSpace(_ c: UInt16) -> Bool { c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D }
    private static func isAsciiDigit(_ c: UInt16) -> Bool { c >= 0x30 && c <= 0x39 }
    private static func isAsciiLetter(_ c: UInt16) -> Bool { (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) }

    /// `^\s*([a-z]+)(?::\s*(?:'([^']*)'|"([^"]*)"|(-?\d+)))?\s*$`
    static func matchFilter(_ u: [UInt16]) -> (name: String, arg: String?)? {
        var i = 0
        let n = u.count
        while i < n && isSpace(u[i]) { i += 1 }
        let start = i
        while i < n && u[i] >= 0x61 && u[i] <= 0x7A { i += 1 }
        if i == start { return nil }
        let name = JavaSemantics.string(u[start..<i])
        var arg: String?
        if i < n && u[i] == 0x3A {
            i += 1
            while i < n && isSpace(u[i]) { i += 1 }
            if i < n && (u[i] == quote1 || u[i] == quote2) {
                let close = JavaSemantics.indexOf(u, u[i], from: i + 1)
                if close < 0 { return nil }
                arg = JavaSemantics.string(u[(i + 1)..<close])
                i = close + 1
            } else {
                let s = i
                if i < n && u[i] == 0x2D { i += 1 }
                let digits = i
                while i < n && isAsciiDigit(u[i]) { i += 1 }
                if i == digits { return nil }
                arg = JavaSemantics.string(u[s..<i])
            }
        }
        while i < n && isSpace(u[i]) { i += 1 }
        return i == n ? (name, arg) : nil
    }

    static func split(_ u: [UInt16], on sep: UInt16) -> [[UInt16]] {
        var out: [[UInt16]] = [[]]
        for c in u { if c == sep { out.append([]) } else { out[out.count - 1].append(c) } }
        return out
    }

    static func parseFilters(_ chain: [UInt16]) throws -> [(name: String, arg: String?)] {
        var out: [(name: String, arg: String?)] = []
        let raw = split(chain, on: 0x7C)
        for i in raw.indices.dropFirst() {
            guard let m = matchFilter(raw[i]), filterNames.contains(m.name) else {
                throw ExprError("unknown filter \"\(JavaSemantics.trim(JavaSemantics.string(raw[i])))\"")
            }
            out.append(m)
        }
        return out
    }

    /// `^\$[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\.\d+)*$`
    static func isHead(_ u: [UInt16]) -> Bool {
        let n = u.count
        guard n >= 2, u[0] == dollar, isAsciiLetter(u[1]) || u[1] == underscore else { return false }
        var i = 2
        while i < n && (isAsciiLetter(u[i]) || isAsciiDigit(u[i]) || u[i] == underscore) { i += 1 }
        while i < n {
            guard u[i] == dot, i + 1 < n else { return false }
            i += 1
            if isAsciiLetter(u[i]) || u[i] == underscore {
                i += 1
                while i < n && (isAsciiLetter(u[i]) || isAsciiDigit(u[i]) || u[i] == underscore) { i += 1 }
            } else if isAsciiDigit(u[i]) {
                while i < n && isAsciiDigit(u[i]) { i += 1 }
            } else {
                return false
            }
        }
        return true
    }

    /// `head.replaceAll("\\.(\\d+)", "[$1]")`
    static func indexPath(_ u: [UInt16]) -> String {
        var out: [UInt16] = []
        var i = 0
        while i < u.count {
            if u[i] == dot && i + 1 < u.count && isAsciiDigit(u[i + 1]) {
                var j = i + 1
                while j < u.count && isAsciiDigit(u[j]) { j += 1 }
                out.append(0x5B); out.append(contentsOf: u[(i + 1)..<j]); out.append(0x5D)
                i = j
            } else {
                out.append(u[i]); i += 1
            }
        }
        return JavaSemantics.string(out)
    }

    static func parseTemplate(_ src: String) throws -> [Part] {
        if case .template(let p)? = cache.withLock({ $0.get("t:" + src) }) { return p }
        var parts: [Part] = []
        var lit: [UInt16] = []
        let u = JavaSemantics.units(src)
        var i = 0
        while i < u.count {
            let c = u[i]
            if c == 0x7B && i + 1 < u.count && u[i + 1] == 0x7B { lit.append(0x7B); i += 2; continue }
            if c != 0x7B { lit.append(c); i += 1; continue }
            let end = JavaSemantics.indexOf(u, 0x7D, from: i)
            if end < 0 { throw ExprError("unclosed \"{\" at \(i)") }
            let body = JavaSemantics.units(JavaSemantics.trim(JavaSemantics.string(u[(i + 1)..<end])))
            if !lit.isEmpty { parts.append(Part(lit: JavaSemantics.string(lit), expr: nil, filters: [])); lit.removeAll() }
            if body.count >= 2 && body[0] == underscore && (body[1] == quote1 || body[1] == quote2) {
                let q = body[1]
                let close = JavaSemantics.indexOf(body, q, from: 2)
                if close < 0 { throw ExprError("unclosed translation at \(i)") }
                parts.append(Part(lit: nil, expr: .tr(JavaSemantics.string(body[2..<close])), filters: try parseFilters(Array(body[(close + 1)...]))))
            } else if body.first == 0x3D {
                parts.append(Part(lit: nil, expr: try parse(JavaSemantics.string(body[1...])), filters: []))
            } else if body.first == dollar {
                let bar = JavaSemantics.indexOf(body, 0x7C)
                let head = JavaSemantics.units(JavaSemantics.trim(JavaSemantics.string(bar < 0 ? body[...] : body[..<bar])))
                if !isHead(head) { throw ExprError("bad placeholder \"{\(JavaSemantics.string(body))}\"") }
                parts.append(Part(lit: nil, expr: try parse(indexPath(head)), filters: bar < 0 ? [] : try parseFilters(Array(body[bar...]))))
            } else {
                throw ExprError("bad placeholder \"{\(JavaSemantics.string(body))}\" (use {$var}, {_'key'} or {=expression})")
            }
            i = end + 1
        }
        if !lit.isEmpty { parts.append(Part(lit: JavaSemantics.string(lit), expr: nil, filters: [])) }
        cache.withLock { $0.put("t:" + src, .template(parts)) }
        return parts
    }

    /// A template's text. Throws when it does not parse.
    public static func render(_ src: String?, _ scope: Scope, _ tr: Translator? = nil) throws -> String {
        guard let src else { return "" }
        if !src.contains("{") { return src }
        var out = ""
        for p in try parseTemplate(src) {
            if let lit = p.lit { out += lit; continue }
            guard let e = p.expr else { continue }
            var v = evaluate(e, scope, tr)
            for f in p.filters { v = try filter(v, f.name, f.arg, tr) }
            out += toText(v)
        }
        return out
    }

    /// nil when the template is valid, else why not.
    public static func checkTemplate(_ src: String) -> String? {
        do { _ = try parseTemplate(src); return nil } catch let e as ExprError { return e.message } catch { return "\(error)" }
    }

    /// 6.10 (G-20): whether a prop or an action's argument reads data — an "=expression"
    /// or a template whose placeholder names a variable. Literals and translations are the
    /// design's own text. What cannot be parsed counts as reading data (fail closed).
    public static func readsData(_ src: String?) -> Bool {
        guard let src else { return false }
        do {
            if src.hasPrefix("=") { return reads(try parse(String(src.dropFirst()))) }
            if !src.contains("{") { return false }
            for p in try parseTemplate(src) { if let e = p.expr, reads(e) { return true } }
            return false
        } catch {
            return true
        }
    }

    static func reads(_ n: Node) -> Bool {
        switch n {
        case .lit, .tr: return false
        case .get(let o, let k): return reads(o) || reads(k)
        case .not(let a), .negate(let a): return reads(a)
        case .logic(let a, let b, _): return reads(a) || reads(b)
        case .cond(let c, let a, let b): return reads(c) || reads(a) || reads(b)
        case .binary(_, let a, let b): return reads(a) || reads(b)
        case .variable: return true
        }
    }

    /// A prop or style value: "=expression" → its value, anything else → the rendered template.
    public static func value(_ src: String?, _ scope: Scope, _ tr: Translator? = nil) throws -> DesignValue {
        guard let src else { return .null }
        if src.hasPrefix("=") { return try eval(String(src.dropFirst()), scope, tr) }
        return .string(try render(src, scope, tr))
    }

    // MARK: - filters

    private static func pad2(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    static func filter(_ v: DesignValue, _ name: String, _ arg: String?, _ tr: Translator?) throws -> DesignValue {
        let lang = tr?.lang
        if let lang, name == "date" || name == "time" || name == "datetime" {
            guard case .number(let d) = v else { return .string("") }
            let at = JavaSemantics.longValue(d)
            let tz = tr?.timeZone
            switch name {
            case "date": return .string(DesignFormats.date(lang, at, timeZone: tz))
            case "time": return .string(DesignFormats.time(lang, at, timeZone: tz))
            default: return .string(DesignFormats.date(lang, at, timeZone: tz) + " " + DesignFormats.time(lang, at, timeZone: tz))
            }
        }
        switch name {
        case "upper": return .string(toText(v).uppercased())
        case "lower": return .string(toText(v).lowercased())
        case "trim": return .string(JavaSemantics.trim(toText(v)))
        case "truncate":
            var limit = 40
            if let arg {
                guard let p = JavaSemantics.parseInt(arg) else { throw ExprError("For input string: \"\(arg)\"") }
                limit = Int(p)
            }
            let n = Swift.max(1, limit)
            let s = toText(v)
            let u = Array(s.utf16)
            return .string(u.count > n ? JavaSemantics.string(u[0..<(n - 1)]) + "…" : s)
        case "default": return truthy(v) ? v : .string(arg ?? "")
        case "count":
            switch v {
            case .array(let a): return .number(Double(a.count))
            case .string(let s): return .number(Double(s.utf16.count))
            default: return .number(0)
            }
        case "date", "time", "datetime":
            guard case .number(let d) = v else { return .string("") }
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = tr?.timeZone ?? .current
            let date = Date(timeIntervalSince1970: Double(JavaSemantics.longValue(d)) / 1000)
            let c = cal.dateComponents([.day, .month, .year, .hour, .minute], from: date)
            let ds = "\(c.day ?? 0). \(c.month ?? 0). \(c.year ?? 0)"
            let ts = pad2(c.hour ?? 0) + ":" + pad2(c.minute ?? 0)
            return .string(name == "date" ? ds : name == "time" ? ts : ds + " " + ts)
        case "size":
            let n = num(v)
            if n < 1024 { return .string(toText(.number(n)) + " B") }
            if n < 1024 * 1024 { return .string(toText(.number(Double(JavaSemantics.round(n / 102.4)) / 10.0)) + " kB") }
            if n < 1024.0 * 1024 * 1024 { return .string(toText(.number(Double(JavaSemantics.round(n / 104857.6)) / 10.0)) + " MB") }
            return .string(toText(.number(Double(JavaSemantics.round(n / 107374182.4)) / 10.0)) + " GB")
        default: return v
        }
    }

    /// The `size` filter on a byte count ("12.3 kB"; Ui.size).
    public static func sizeText(_ bytes: Double) -> String {
        (try? filter(.number(bytes), "size", nil, nil)).map { toText($0) } ?? ""
    }
}
