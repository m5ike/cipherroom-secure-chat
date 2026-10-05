// Chat commands — the pure parts of android fn/Commands.java (the client side
// of Functions: client/src/lib/functions.ts and the composer parts of
// App.tsx): which characters start what in the message box (the composer of
// GET /api/client-config), the commands this user may run (their state),
// turning "/keyword args" into the model's inputs, and the events a model's
// message answers. The network side (loading the composer and the commands,
// running, events, answers) belongs to the app's Functions client.

import M5Core

/// Chat commands' pure logic (android `fn/Commands.java` without its network calls).
public enum Commands {
    /// A character that opens suggestions in the message box, and what it offers: functions, mentions or tags.
    public struct Trigger: Sendable, Equatable {
        public let ch: String
        public let action: String
        public init(_ ch: String, _ action: String) { self.ch = ch; self.action = action }
    }

    /// The message box as the operator set it up (ComposerPolicy in client-config.ts).
    public struct Composer: Sendable, Equatable {
        public let triggers: [Trigger]
        /// Tags the operator offers after "#".
        public let tags: [String]

        public init(_ triggers: [Trigger], _ tags: [String]) { self.triggers = triggers; self.tags = tags }

        /// The characters that start a command ("/" unless the operator says otherwise).
        public var commandChars: [String] { triggers.filter { $0.action == "functions" }.map(\.ch) }
    }

    public static let defaultComposer = Composer([Trigger("/", "functions"), Trigger("@", "mentions"), Trigger("#", "tags")], [])

    /// The commands this user may run; enabled is nil until the server answered.
    public struct State: Sendable, Equatable {
        public let enabled: Bool?
        public let commands: [Command]

        public init(_ enabled: Bool?, _ commands: [Command]) { self.enabled = enabled; self.commands = commands }

        public func find(_ keyword: String) -> Command? { commands.first { Js.same($0.keyword, keyword) } }

        /// The state of GET /api/functions/commands' answer: {enabled, commands} (commands only when enabled).
        public static func from(_ o: JSONObject) -> State {
            let enabled = o["enabled"] == .bool(true)
            let list = enabled ? (o.array("commands") ?? []).compactMap { $0.objectValue.flatMap(Command.from) } : []
            return State(enabled, list)
        }
    }

    /// Before the server answered (or for another account).
    public static let unknown = State(nil, [])
    /// Any failure means "off", as on the web.
    public static let off = State(false, [])

    /// How long a command list is good for (App.tsx refreshCommands()).
    public static let freshMs: Int64 = 10_000

    /* ------------------------------------------------------ the composer */

    /// The composer of /api/client-config's answer ({config: {composer}} or {composer}).
    public static func composer(fromClientConfig o: JSONObject) -> Composer {
        let config: JSON? = o.has("config") && !(o["config"]!.isNull) ? o["config"] : .object(o)
        return composerFrom(config?.objectValue?["composer"])
    }

    /// sanitizeComposer() in client-config.ts.
    public static func composerFrom(_ raw: JSON?) -> Composer {
        guard case .object(let r)? = raw else {
            if case .array? = raw { return Composer([], []) }
            return defaultComposer
        }
        var triggers = [Trigger]()
        var seen = Set<[UInt16]>()
        for x in r.array("triggers") ?? [] {
            let e = x.objectValue ?? JSONObject()
            let ch = e.string("char").map { Js.firstCodePoint(Js.trim($0)) } ?? ""
            var action: String?
            if case .string(let a)? = e["action"], a == "functions" || a == "mentions" || a == "tags" { action = a }
            guard !ch.isEmpty, let action, !badTrigger(ch), !seen.contains(Array(ch.utf16)), triggers.count < 10 else { continue }
            seen.insert(Array(ch.utf16))
            triggers.append(Trigger(ch, action))
        }
        var tags = [String]()
        var tagSeen = Set<[UInt16]>()
        for x in r.array("tags") ?? [] {
            guard case .string(var s) = x else { continue }
            if s.utf16.first == 0x23 { s = Js.string(Array(s.utf16.dropFirst())) }
            let t = Js.lowerRoot(Js.trim(s))
            if isTag(t) && tagSeen.insert(Array(t.utf16)).inserted { tags.append(t) }
        }
        return Composer(triggers, Array(tags.prefix(200)))
    }

    /// [\s A-Za-z0-9] — a character that cannot start suggestions.
    private static func badTrigger(_ ch: String) -> Bool {
        let u = Array(ch.utf16)
        guard u.count == 1 else { return false }
        let c = u[0]
        return Js.isWs(c) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)
    }

    /// [\p{L}\p{N}_-]{1,40}.
    private static func isTag(_ t: String) -> Bool {
        let n = t.unicodeScalars.count
        return n >= 1 && n <= 40 && t.unicodeScalars.allSatisfy { Js.isLetter($0) || Js.isNumber($0) || $0 == "_" || $0 == "-" }
    }

    /* ---------------------------------------------------- the command line */

    /// "/word rest" → keyword (lower case) and the argument text.
    public struct Parsed: Sendable, Equatable {
        public let keyword: String
        public let argText: String
    }

    /// [A-Za-z0-9_-].
    static func wordUnit(_ c: UInt16) -> Bool {
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c == 0x5F || c == 0x2D
    }

    /// parseCommandLine(): nil when the text is not a command; chars are the characters that start one.
    public static func parseCommandLine(_ text: String, _ chars: [String]) -> Parsed? {
        let t = Js.trim(text)
        let first = Js.firstCodePoint(t)
        if t.isEmpty || !chars.contains(where: { Js.same($0, first) }) { return nil }
        // ([a-z0-9_-]{1,40})(?:\s+([\s\S]*))? over the rest, case-insensitive.
        let rest = Array(t.utf16.dropFirst(first.utf16.count))
        var k = 0
        while k < rest.count && wordUnit(rest[k]) { k += 1 }
        if k == 0 || k > 40 { return nil }
        if k < rest.count && !Js.isWs(rest[k]) { return nil }
        return Parsed(keyword: Js.string(rest[0..<k]).lowercased(), argText: Js.trim(Js.string(rest[k...])))
    }

    /// Splits an argument line into tokens, honouring "quoted values" (\"([^\"]*)\"|'([^']*)'|(\S+)).
    public static func tokenize(_ argText: String) -> [String] {
        let u = Array(argText.utf16)
        var out = [String]()
        var i = 0
        while i < u.count {
            let c = u[i]
            if Js.isWs(c) { i += 1; continue }
            if c == 0x22 || c == 0x27, let close = u[(i + 1)...].firstIndex(of: c) {
                out.append(Js.string(u[(i + 1)..<close]))
                i = close + 1
                continue
            }
            let s = i
            while i < u.count && !Js.isWs(u[i]) { i += 1 }
            out.append(Js.string(u[s..<i]))
        }
        return out
    }

    /// A value picked in the chat comes as text, so "user", "file" and "secret" are not filled by position.
    static func chatTypeable(_ i: Command.Input) -> Bool { i.type != "user" && i.type != "file" && i.type != "secret" }

    /// buildInputs(): key=value pairs set that input; bare tokens fill the
    /// chat-typeable inputs in order, and a trailing text input takes the rest
    /// ("/check example.org depth=full"). The values are strings; the server types them.
    public static func buildInputs(_ command: Command, _ argText: String) -> JSONObject {
        var inputs = JSONObject()
        let positional = command.inputs.filter(chatTypeable)
        var bare = [String]()
        for tok in tokenize(argText) {
            let u = Array(tok.utf16)
            if let eq = u.firstIndex(of: 0x3D), eq > 0 {
                let name = Js.string(u[0..<eq])
                if command.inputs.contains(where: { Js.same($0.name, name) }) {
                    inputs[name] = .string(Js.string(u[(eq + 1)...]))
                    continue
                }
            }
            bare.append(tok)
        }
        var pi = 0
        for (n, spec) in positional.enumerated() {
            if inputs.has(spec.name) { continue }
            if pi >= bare.count { break }
            // A free-text field at the end takes everything that is left.
            if (spec.type == "text" || spec.type == "string") && n == positional.count - 1 {
                inputs[spec.name] = .string(bare[pi...].joined(separator: " "))
                pi = bare.count
            } else {
                inputs[spec.name] = .string(bare[pi])
                pi += 1
            }
        }
        return inputs
    }

    /* ------------------------------------------------------------- events */

    /// A click on the model's button: its name and data (nil: none).
    public static func button(_ name: String, _ data: JSON?) -> JSONObject {
        JSONObject([("type", "button"), ("name", .string(name))]).with("data", data)
    }

    /// A submitted form: its name and values.
    public static func form(_ name: String, _ values: JSONObject) -> JSONObject {
        JSONObject([("type", "form"), ("name", .string(name)), ("values", .object(values))])
    }

    /// A reply to the model's message: the reply's text and the text of the message it answers.
    public static func response(_ text: String, _ repliedText: String) -> JSONObject {
        JSONObject([("type", "response"), ("text", .string(text)), ("message", .object(JSONObject([("text", .string(repliedText))])))])
    }

    /// Whether a message (its flags.fn) answers this kind of event: it has a session, and says it does (or does not say).
    public static func answers(_ meta: JSONObject?, _ type: String) -> Bool {
        guard let meta, !meta.orgString("chain").isEmpty else { return false }
        guard let events = meta.array("events") else { return true }
        return Command.strings(events).contains(type)
    }
}

extension Js {
    /// Java's String.equals: the same UTF-16 units (Swift's == also equates canonically equivalent text).
    static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
}
