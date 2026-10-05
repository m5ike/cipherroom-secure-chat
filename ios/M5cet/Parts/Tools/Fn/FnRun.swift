// A command's run as the chat sees it — a port of android/…/fn/Run.java
// (client/src/lib/functions.ts): where it comes from, what its stream says
// (start, progress, outputs, live questions, then done or error), and the
// message its outputs become (showFnResult() in App.tsx).

import Foundation
import M5Core
import M5Proto

enum FnRun {
    /// Where a run comes from: the room's blind id (nil: none), this device's client id, the language, the time zone.
    struct Origin: Sendable, Equatable {
        var room: String?
        var client: String?
        var lang: String?
        var tz: String?

        func into(_ body: inout JSONObject) {
            body["room"] = room.map { $0.isEmpty ? JSON.null : .string($0) } ?? .null
            body["client"] = client.map { $0.isEmpty ? JSON.null : .string($0) } ?? .null
            body["lang"] = .string(lang ?? "en")
            if let tz, !tz.isEmpty { body["tz"] = .string(tz) }
        }
    }

    /// A running command's question: kind "prompt" (text, choices, placeholder), "form" (title, text, fields,
    /// submit) or "nfc" (spec.command: an NFC operation for this device's reader — answered with an NfcResult).
    struct Interaction: Sendable, Equatable {
        /// A form field: name, label, type, required, placeholder, values (a choice).
        struct Field: Sendable, Equatable {
            let name: String
            let label: String
            let type: String
            let required: Bool
            let placeholder: String
            let values: [String]

            init(_ f: JSONObject) {
                name = f.optString("name")
                label = FnRun.string(f, "label")
                type = FnRun.string(f, "type")
                required = f["required"] == .bool(true)
                placeholder = FnRun.string(f, "placeholder")
                values = Command.strings(f.array("values"))
            }
        }

        let runId: String
        let id: String
        let kind: String
        let spec: JSONObject

        init(_ d: JSONObject) {
            runId = FnRun.string(d, "runId")
            id = FnRun.string(d, "id")
            let k = d.string("kind")
            kind = k == "form" ? "form" : k == "nfc" ? "nfc" : "prompt"
            spec = d.object("spec") ?? JSONObject()
        }

        var title: String { FnRun.string(spec, "title") }
        var text: String { FnRun.string(spec, "text") }
        var placeholder: String { FnRun.string(spec, "placeholder") }
        var submit: String { FnRun.string(spec, "submit") }
        var choices: [String] { Command.strings(spec.array("choices")) }

        var fields: [Field] {
            (spec.array("fields") ?? []).compactMap { $0.objectValue }.filter { !$0.optString("name").isEmpty }.map(Field.init)
        }
    }

    /// A finished run (doneBody() in server/functions/routes.ts).
    struct Done: Sendable, Equatable {
        let runId: String
        let status: String
        let outputs: [JSON]
        /// The failure, when the run failed and nothing answered it: {type, message}; else nil.
        let error: JSONObject?
        /// The function failed and its error entry point answered (the outputs are that answer).
        let handled: Bool
        let failed: JSONObject?
        /// "room" or "caller"; nil when the server did not say.
        let visibility: String?
        /// The processing session a reply, a click or a form continues, and the call in it.
        let chain: String?
        let call: Int?
        let model: String?
        let keyword: String
        let name: String
        let events: [String]?
        let raw: JSONObject

        init(_ d: JSONObject) {
            raw = d
            runId = FnRun.string(d, "runId")
            status = FnRun.string(d, "status")
            outputs = d.array("outputs") ?? []
            error = d.object("error")
            handled = d["handled"] == .bool(true)
            failed = d.object("failed")
            let v = d.string("visibility")
            visibility = v == "room" || v == "caller" ? v : nil
            chain = d.string("chain")
            call = FnRun.intValue(d["call"])
            model = d.string("model")
            keyword = FnRun.string(d, "keyword")
            name = FnRun.string(d, "name")
            events = d.array("events").map { Command.strings($0) }
        }

        /// It failed and nothing answered: show error.message instead of outputs.
        var failedUnanswered: Bool { error != nil && !handled }

        /// The message these outputs become: the flags.fn metadata (with the model's icon — the server's when
        /// it sends one, else the command's), the outputs, and the Markdown as the text.
        func message(keyword fallbackKeyword: String, name fallbackName: String, visibility fallbackVisibility: String, icon: String? = nil) -> Message {
            let kw = keyword.isEmpty ? fallbackKeyword : keyword
            var meta = JSONObject([("keyword", .string(kw)), ("name", .string(name.isEmpty ? fallbackName : name))])
            if let ic = ModelIdentity.safeIcon(raw["icon"]) ?? ModelIdentity.safeIcon(icon.map { .string($0) }) { meta["icon"] = .string(ic) }
            if let model, !model.isEmpty { meta["model"] = .string(model) }
            if let chain, !chain.isEmpty { meta["chain"] = .string(chain) }
            if let call { meta["call"] = .int(call) }
            if let events, !events.isEmpty { meta["events"] = .array(events.map { .string($0) }) }
            if handled { meta["origin"] = "error" }
            let md = Outputs.toMarkdown(outputs)
            let text = !md.isEmpty ? md : !outputs.isEmpty ? "/" + kw : ""
            let room = meta.with("outputs", .array(Outputs.shareable(outputs)))
            let local = meta.with("outputs", .array(outputs))
            return Message(fn: room, local: local, text: text, room: (visibility ?? fallbackVisibility) == "room", name: meta.optString("name"))
        }
    }

    /// A function's answer as a chat message.
    struct Message: Sendable, Equatable {
        /// flags.fn for the room: the outputs that fit into a message (large media become notes).
        let fn: JSONObject
        /// flags.fn as this device keeps it: every output.
        let local: JSONObject
        /// The outputs' Markdown, "/keyword" when they have none, "" when there are no outputs (functions.empty).
        let text: String
        /// Send it to the room (else show it only here).
        let room: Bool
        let name: String
    }

    /// A peer's flags.fn as the app may use it (validateFlags() in client/src/lib/validate.ts): the model and
    /// session only in their shapes, known events, the outputs checked again. nil: not one.
    static func meta(_ raw: JSON?) -> JSONObject? {
        guard case .object(let fn)? = raw else { return nil }
        let keyword = fn.string("keyword").flatMap { $0.utf16.count <= 40 ? $0 : nil } ?? ""
        let name = fn.string("name").flatMap { $0.utf16.count <= 120 ? $0 : nil } ?? ""
        if keyword.isEmpty { return nil }
        var out = JSONObject([("keyword", .string(keyword)), ("name", .string(name.isEmpty ? keyword : name))])
        if let m = fn.string("model"), matches(m, model: true) { out["model"] = .string(m) }
        if let icon = ModelIdentity.safeIcon(fn["icon"]) { out["icon"] = .string(icon) }
        if let c = fn.string("chain"), matches(c, model: false) { out["chain"] = .string(c) }
        if case .number(let n)? = fn["call"] {
            let d = n.double
            if d == d.rounded(), d >= 0, d < 10_000 { out["call"] = .int(Int(d)) }
        }
        if let ev = fn.array("events") {
            var seen = [String]()
            for e in Command.strings(ev) where ["response", "button", "form", "error"].contains(e) && !seen.contains(e) { seen.append(e) }
            if !seen.isEmpty { out["events"] = .array(seen.map { .string($0) }) }
        }
        if case .array? = fn["outputs"] {
            let outputs = Outputs.sanitize(fn["outputs"])
            if !outputs.isEmpty { out["outputs"] = .array(outputs) }
        }
        if fn["origin"] == .string("error") { out["origin"] = "error" }
        return out
    }

    /// [a-z0-9][a-z0-9_-]{0,63} (a model id) or chn_[a-z0-9]{6,40} (a session).
    private static func matches(_ s: String, model: Bool) -> Bool {
        let u = Array(s.utf8)
        func lowerDigit(_ c: UInt8) -> Bool { (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) }
        if model {
            guard let f = u.first, lowerDigit(f), u.count <= 64 else { return false }
            return u.dropFirst().allSatisfy { lowerDigit($0) || $0 == 0x5F || $0 == 0x2D }
        }
        guard s.hasPrefix("chn_") else { return false }
        let rest = u.dropFirst(4)
        return rest.count >= 6 && rest.count <= 40 && rest.allSatisfy(lowerDigit)
    }

    static func string(_ o: JSONObject, _ k: String) -> String { o.string(k) ?? "" }

    /// A JSON number as Java's ((Number) x).intValue().
    static func intValue(_ v: JSON?) -> Int? {
        guard case .number(let n)? = v else { return nil }
        if let i = n.int64 { return Int(Int32(truncatingIfNeeded: i)) }
        let d = n.double
        guard d.isFinite else { return nil }
        return Int(Int32(truncatingIfNeeded: Int64(d.rounded(.towardZero))))
    }
}

/// What a run's stream says (Run.Listener), on the main actor in its order. Exactly one of done and error
/// ends it (a stream that stops without either is an "incomplete" error) — unless the call was cancelled.
@MainActor
struct FnRunHandlers {
    /// Any event but the end (start, progress, an output, a question, a log line) — a sign of life (RunWatch).
    var alive: () -> Void = {}
    var start: (String) -> Void = { _ in }
    /// p as the function reported it, and its text.
    var progress: (Double, String) -> Void = { _, _ in }
    /// One output as the function produced it (the full list comes with done).
    var output: (JSONObject) -> Void = { _ in }
    /// A live question: answer it with FnCommandsClient.answer.
    var interaction: (FnRun.Interaction) -> Void = { _ in }
    var done: (FnRun.Done) -> Void = { _ in }
    var error: (String, String) -> Void = { _, _ in }
}

/// The events of a run's stream told to the handlers (streamFunction() in functions.ts; Run.stream).
@MainActor
final class FnRunStream: FnStreamSink {
    private let h: FnRunHandlers
    private var over = false

    init(_ handlers: FnRunHandlers) { h = handlers }

    func event(_ name: String, _ d: JSONObject) {
        if over { return }
        if name != "done" && name != "error" { h.alive() }
        switch name {
        case "start": h.start(FnRun.string(d, "runId"))
        case "progress":
            let t = d["text"]
            h.progress(Js.toNumber(d["p"]), t == nil || t == .null ? "" : Js.str(t))
        case "output": h.output(d)
        case "interaction": h.interaction(FnRun.Interaction(d))
        case "done":
            over = true
            h.done(FnRun.Done(d))
        case "error":
            over = true
            let code = FnRun.string(d, "code")
            h.error(code.isEmpty ? "error" : code, FnRun.string(d, "message"))
        default: break // log lines are the console's
        }
    }

    func end() {
        if over { return }
        over = true
        h.error("incomplete", Texts.t("fnm.err.incomplete", "The answer stopped before it was complete."))
    }

    func fail(_ f: FnFailure) {
        if over { return }
        over = true
        h.error(f.code.isEmpty ? "error" : f.code, f.message)
    }
}
