// Chat commands' network side — the half of android/…/fn/Commands.java that
// M5Proto's `Commands` leaves to the app: which characters start what in the
// message box (GET /api/client-config), the commands this user may run (GET
// /api/functions/commands, asked at most every 10 s per account), running one
// and the model's other entry points (a click, a form, a reply) as streams,
// reports of outputs the app could not show, and answers to a run's live
// questions. One instance per server; main actor.

import Foundation
import M5Core
import M5Proto

@MainActor
final class FnCommandsClient {
    let api: FnApi
    /// The clock (ms) — the command list's freshness.
    private let now: () -> Int64

    private(set) var composer: Commands.Composer = Commands.defaultComposer
    // The list, whose account it is for and when it was asked for.
    private var state: Commands.State = Commands.unknown
    private var stateBearer = ""
    private var stateAt: Int64 = 0

    init(api: FnApi, now: @escaping () -> Int64 = { Millis.now }) {
        self.api = api
        self.now = now
    }

    var base: String { api.base }

    // MARK: the composer

    /// Asks the server how the message box works; a failure keeps what was known (the defaults at first).
    @discardableResult
    func loadComposer(bearer: String) async -> Commands.Composer {
        if case .success(let o) = await api.json("/api/client-config", bearer: bearer) {
            composer = Commands.composer(fromClientConfig: o)
        }
        return composer
    }

    // MARK: the commands

    /// The commands last heard of for this account (unknown before the server answered, or for another account).
    func state(bearer: String) -> Commands.State { bearer == stateBearer ? state : Commands.unknown }

    /// Asks the server for the commands — unless the list for this account is younger than 10 s and force is
    /// false. Any failure means "off", as on the web.
    @discardableResult
    func refresh(bearer: String, force: Bool = false) async -> Commands.State {
        if !force && bearer == stateBearer && now() - stateAt < Commands.freshMs { return state }
        stateAt = now()
        if bearer != stateBearer { stateBearer = bearer; state = Commands.unknown }
        let got: Commands.State
        switch await api.json("/api/functions/commands", bearer: bearer) {
        case .success(let o): got = Commands.State.from(o)
        case .failure: got = Commands.off
        }
        if bearer == stateBearer { state = got }
        return got
    }

    // MARK: running

    /// Runs a command with a live stream (POST /api/functions/run): progress, questions, then the outputs.
    /// keyword or model (the model's id, which the server prefers) names it.
    func run(bearer: String, keyword: String?, model: String?, inputs: JSONObject?, origin: FnRun.Origin, handlers: FnRunHandlers) -> FnCall {
        var body = JSONObject()
        if let model { body["model"] = .string(model) }
        if let keyword { body["keyword"] = .string(keyword) }
        body["inputs"] = .object(inputs ?? JSONObject())
        origin.into(&body)
        body["stream"] = true
        return api.stream("/api/functions/run", bearer: bearer, body: body, sink: FnRunStream(handlers))
    }

    /// A click, a form or a reply for a model's message (POST /api/functions/event): its entry point runs in the
    /// message's processing session, streamed like a run. meta is the message's flags.fn; ev one of
    /// Commands.button / form / response. A session that is over answers the error "expired".
    func event(bearer: String, meta: JSONObject, ev: JSONObject, origin: FnRun.Origin, handlers: FnRunHandlers) -> FnCall {
        var body = Self.eventBody(meta, ev, origin)
        body["stream"] = true
        return api.stream("/api/functions/event", bearer: bearer, body: body, sink: FnRunStream(handlers))
    }

    /// A report from this app — an output it could not show ({type: "error", error: {type, message}, output,
    /// fromError}) or a log line — logged with the run; the model's error entry point may answer (its outputs).
    func report(bearer: String, meta: JSONObject, ev: JSONObject, origin: FnRun.Origin) async -> FnRun.Done? {
        guard case .success(let o) = await api.json("/api/functions/event", bearer: bearer, body: Self.eventBody(meta, ev, origin)) else { return nil }
        return (o.array("outputs") ?? []).isEmpty ? nil : FnRun.Done(o)
    }

    /// { model, keyword, chain, call, room, client, lang, tz, ...ev } as sendFnEventStream() sends it.
    nonisolated static func eventBody(_ meta: JSONObject, _ ev: JSONObject, _ origin: FnRun.Origin) -> JSONObject {
        var body = JSONObject()
        if let m = meta.string("model") { body["model"] = .string(m) }
        body["keyword"] = .string(meta.optString("keyword"))
        body["chain"] = .string(meta.optString("chain"))
        if let call = FnRun.intValue(meta["call"]) { body["call"] = .int(call) }
        origin.into(&body)
        for (k, v) in ev { body[k] = v }
        return body
    }

    /// Sends the caller's answer to a running command's question (value: the text, the choice, the form's
    /// values; nil cancels). Failures are ignored — the run times out on its own, as on the web.
    func answer(bearer: String, runId: String, interactionId: String, value: JSON?) {
        let body = JSONObject([("interactionId", .string(interactionId)), ("value", value ?? .null)])
        let path = "/api/functions/runs/" + Self.encode(runId) + "/events"
        let api = self.api
        Task { _ = await api.json(path, bearer: bearer, body: body) }
    }

    /// URLEncoder.encode(s, "UTF-8") with "+" as "%20".
    nonisolated static func encode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.*")
        var out = ""
        for b in s.utf8 {
            let c = Character(Unicode.Scalar(b))
            if b < 0x80, let u = Unicode.Scalar(UInt32(b)), allowed.contains(u), c.isASCII { out.append(c) }
            else { out += String(format: "%%%02X", b) }
        }
        return out
    }
}
