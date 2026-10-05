// A chat command as GET /api/functions/commands describes it — a port of
// android fn/Command.java (commandView() in server/functions/routes.ts;
// Command in client/src/lib/functions.ts). 6.11: the model's icon and its own
// guide (usage), an input's pattern, min and max — absent from an older
// server (nil / "").

import M5Core

/// A chat command (android `fn/Command.java`).
public struct Command: Sendable, Equatable {
    /// One of the model's inputs (its name fills from "name=value" or by position).
    public struct Input: Sendable, Equatable {
        public let name: String
        /// string, text, integer, number, boolean, enum, user, file, secret, hostname…
        public let type: String
        /// "" without one.
        public let label: String
        /// "" without one.
        public let help: String
        public let required: Bool
        /// Its default as the server sent it (nil: none; JSON null is a default).
        public let def: JSON?
        /// An enum's values (empty otherwise).
        public let values: [String]
        /// 6.11: a regular expression the value matches (nil: none).
        public let pattern: String?
        /// 6.11: a number's range (nil: open).
        public let min: Double?
        public let max: Double?

        public init(name: String, type: String, label: String = "", help: String = "", required: Bool = false, def: JSON? = nil,
                    values: [String] = [], pattern: String? = nil, min: Double? = nil, max: Double? = nil) {
            self.name = name
            self.type = type
            self.label = label
            self.help = help
            self.required = required
            self.def = def
            self.values = values
            self.pattern = pattern?.isEmpty == false ? pattern : nil
            self.min = min
            self.max = max
        }

        /// Required and without a default: it has to be given ("<name>" in the usage line).
        public var mustGive: Bool { required && def == nil }
    }

    public let keyword: String
    public let name: String
    public let summary: String
    public let runtime: String
    /// "room": its outputs go to the room; "caller": only to whoever ran it.
    public let visibility: String
    /// One of the caller's groups may use it (not only "everyone").
    public let mine: Bool
    public let inputs: [Input]
    /// What a reply, a click or a form of its messages reaches (response, button, form, error); nil: not said.
    public let events: [String]?
    /// The model's id (nil from an older server).
    public let model: String?
    /// 6.11: the model's icon — a lucide name or one emoji (nil: by its keyword, ModelIdentity).
    public let icon: String?
    /// 6.11: the model's own short guide (examples); "" without one.
    public let usage: String

    public init(keyword: String, name: String = "", summary: String = "", runtime: String = "", visibility: String = "room", mine: Bool = false,
                inputs: [Input] = [], events: [String]? = nil, model: String? = nil, icon: String? = nil, usage: String = "") {
        self.keyword = keyword
        self.name = name
        self.summary = summary
        self.runtime = runtime
        self.visibility = visibility
        self.mine = mine
        self.inputs = inputs
        self.events = events
        self.model = model
        let i = icon?.javaTrimmed ?? ""
        self.icon = i.isEmpty ? nil : i
        self.usage = usage
    }

    /// From the server's JSON; nil when it has no keyword.
    public static func from(_ o: JSONObject) -> Command? {
        let keyword = o.orgString("keyword")
        if keyword.isEmpty { return nil }
        var inputs = [Input]()
        for v in o.array("inputs") ?? [] {
            guard let x = v.objectValue, !x.orgString("name").isEmpty else { continue }
            inputs.append(Input(name: x.orgString("name"), type: text(x, "type"), label: text(x, "label"), help: text(x, "help"), required: x.orgBool("required"),
                                def: x.has("default") ? x["default"] : nil, values: strings(x.array("values")), pattern: text(x, "pattern"),
                                min: number(x, "min"), max: number(x, "max")))
        }
        let ev = o.array("events")
        var visibility = "room"
        if case .string("caller")? = o["visibility"] { visibility = "caller" }
        return Command(keyword: keyword, name: text(o, "name"), summary: text(o, "summary"), runtime: text(o, "runtime"), visibility: visibility,
                       mine: o.orgBool("mine"), inputs: inputs, events: ev.map { strings($0) }, model: o.string("model"),
                       icon: text(o, "icon"), usage: text(o, "usage"))
    }

    /// A finite number the server sent (6.11 min / max), else nil.
    private static func number(_ o: JSONObject, _ k: String) -> Double? {
        guard let d = o.double(k), d.isFinite else { return nil }
        return d
    }

    private static func text(_ o: JSONObject, _ k: String) -> String { o.string(k) ?? "" }

    /// The strings of a JSON array (anything else skipped).
    public static func strings(_ a: [JSON]?) -> [String] { (a ?? []).compactMap(\.stringValue) }
}
