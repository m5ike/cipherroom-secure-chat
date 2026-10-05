// The AI assistant — a port of android/…/fn/Assistant.java
// (client/src/lib/ai.ts and components/AiPanel.tsx): the models this user may
// use (GET /api/ai/status), a conversation streamed as it is written (POST
// /api/ai/chat — delta, reasoning, citations, done, error) and stopped at
// will. What is sent goes to the server and the operator's provider: it is not
// end-to-end encrypted like the chat (the screen says so). Main actor and
// @Observable: the AI chat part draws `turns` as they fill in.

import Foundation
import M5Core
import M5Proto
import Observation

@MainActor
@Observable
final class AiAssistant {
    static let levels = ["off", "low", "medium", "high"]
    private static let states = ["off", "no-model", "sign-in", "no-limit", "ready"]

    struct Model: Sendable, Equatable {
        let ref: String
        let label: String
        let provider: String
        let reasoning: Bool
        let vision: Bool

        init(_ m: JSONObject) {
            ref = m.optString("ref")
            label = m.string("label") ?? ref
            provider = m.string("provider") ?? ""
            reasoning = m["reasoning"] == .bool(true)
            vision = m["vision"] == .bool(true)
        }
    }

    /// What this user may use: state off | no-model | sign-in | no-limit | ready.
    struct Status: Sendable, Equatable {
        let enabled: Bool
        let state: String
        let models: [Model]
        let defaultRef: String
        let maxOutputTokens: Int
        let maxInputChars: Int

        func model(_ ref: String) -> Model? { models.first { $0.ref == ref } }
    }

    static let off = Status(enabled: false, state: "off", models: [], defaultRef: "", maxOutputTokens: 2048, maxInputChars: 24000)

    /// One turn of the conversation. An answer fills in while pending.
    struct Turn: Identifiable, Sendable, Equatable {
        let id: Int
        let user: Bool
        var text = ""
        /// The model's label (an answer).
        var model = ""
        var reasoning = ""
        var citations: [JSONObject] = []
        var pending = false
        /// Stopped by the user (the text so far stays).
        var stopped = false
        /// Why it failed: the server's code and message; "" when it did not.
        var errorCode = ""
        var errorMessage = ""
        /// How long it took and the output tokens (after done).
        var ms: Int64 = 0
        var outputTokens: Int64 = 0

        var failed: Bool { !errorCode.isEmpty }
    }

    @ObservationIgnored let api: FnApi
    private(set) var status: Status?
    /// The model to use; kept on the next status only if it is still offered.
    var model = ""
    private(set) var reasoning = "off"
    private(set) var turns: [Turn] = []
    // Observed: the send button follows it (busy ↔ stop).
    private var busyCall: FnCall?
    @ObservationIgnored private var nextId = 0
    /// Bumped on every change of the answer being written (the part scrolls to the end).
    private(set) var revision = 0
    /// Told when an answer finished (tests, the part).
    @ObservationIgnored var onFinished: ((Turn) -> Void)?

    init(api: FnApi) { self.api = api }

    var busy: Bool { busyCall != nil }

    func setReasoning(_ level: String) { reasoning = Self.levels.contains(level) ? level : "off" }

    /// Asks what this user may use; a failure is "off". Picks the model: the chosen one if offered, else the default.
    @discardableResult
    func loadStatus(bearer: String) async -> Status {
        let s: Status
        switch await api.json("/api/ai/status", bearer: bearer) {
        case .success(let j): s = Self.statusFrom(j)
        case .failure: s = Self.off
        }
        status = s
        if s.model(model) == nil { model = !s.defaultRef.isEmpty ? s.defaultRef : s.models.first?.ref ?? "" }
        return s
    }

    static func statusFrom(_ j: JSONObject) -> Status {
        let models = (j.array("models") ?? []).compactMap { $0.objectValue }.filter { $0.string("ref") != nil }.map(Model.init)
        let limits = j.object("limits")
        let state = j.string("state").flatMap { states.contains($0) ? $0 : nil } ?? "off"
        func limit(_ k: String, _ d: Int) -> Int {
            guard case .number(let n)? = limits?[k] else { return d }
            return Int(Int32(truncatingIfNeeded: Int64(n.double.rounded(.towardZero))))
        }
        return Status(enabled: j["enabled"] == .bool(true), state: state, models: models, defaultRef: j.string("default") ?? "",
                      maxOutputTokens: limit("maxOutputTokens", off.maxOutputTokens), maxInputChars: limit("maxInputChars", off.maxInputChars))
    }

    /// Asks: the question and the answer as it is written join the conversation. The model is told each earlier
    /// question with the answer it got (a failed or empty answer leaves both out). False when there is nothing to
    /// send, an answer is still being written, or the AI is not ready.
    @discardableResult
    func send(bearer: String, question: String) -> Bool {
        let text = Js.trim(question)
        guard !text.isEmpty, busyCall == nil, let status, status.state == "ready" else { return false }
        var messages = [JSON]()
        if turns.count > 1 {
            for i in 0..<(turns.count - 1) {
                let x = turns[i], next = turns[i + 1]
                if x.user && !next.user && !next.text.isEmpty && !next.failed {
                    messages.append(["role": "user", "content": .string(x.text)])
                    messages.append(["role": "assistant", "content": .string(next.text)])
                }
            }
        }
        messages.append(["role": "user", "content": .string(text)])
        let current = status.model(model)
        nextId += 1
        turns.append(Turn(id: nextId, user: true, text: text))
        nextId += 1
        var answer = Turn(id: nextId, user: false)
        answer.model = current?.label ?? model
        answer.pending = true
        turns.append(answer)
        let body = JSONObject([("model", .string(model)), ("reasoning", .string(current?.reasoning == true ? reasoning : "off")),
                               ("messages", .array(messages)), ("stream", true)])
        busyCall = api.stream("/api/ai/chat", bearer: bearer, body: body, sink: AiChatStream(self, answerId: answer.id))
        revision &+= 1
        return true
    }

    // MARK: the answer being written (AiChatStream)

    fileprivate func pending(_ id: Int) -> Bool { turns.last { $0.id == id }?.pending ?? false }

    fileprivate func update(_ id: Int, _ change: (inout Turn) -> Void) {
        guard let i = turns.lastIndex(where: { $0.id == id }) else { return }
        change(&turns[i])
        revision &+= 1
    }

    fileprivate func done(_ id: Int, _ d: JSONObject) {
        update(id) { t in
            if let s = d.string("text"), !s.isEmpty { t.text = s }
            if let s = d.string("reasoning"), !s.isEmpty { t.reasoning = s }
            if let c = d.array("citations") { t.citations = c.compactMap(\.objectValue) }
            t.ms = d.optInt64("ms")
            t.outputTokens = d.object("usage")?.optInt64("output") ?? 0
        }
        finish(id)
    }

    fileprivate func fail(_ id: Int, _ code: String, _ message: String) {
        update(id) { t in t.errorCode = code; t.errorMessage = message }
        finish(id)
    }

    private func finish(_ id: Int) {
        update(id) { $0.pending = false }
        busyCall = nil
        if let t = turns.last(where: { $0.id == id }) { onFinished?(t) }
    }

    /// Stops the answer being written; what came so far stays (marked stopped).
    func stop() {
        guard let c = busyCall else { return }
        c.cancel()
        for t in turns where t.pending {
            update(t.id) { $0.stopped = true }
            finish(t.id)
        }
        busyCall = nil
    }

    /// A new conversation (stops an answer being written).
    func clear() {
        busyCall?.cancel()
        busyCall = nil
        turns.removeAll()
        revision &+= 1
    }

    /// The last complete answer (to copy or put into the message), or nil.
    var lastAnswer: Turn? { turns.last { !$0.user && !$0.pending && !$0.text.isEmpty && !$0.failed } }
}

/// The chat stream's events into the answer (Assistant.send's Api.Stream).
@MainActor
private final class AiChatStream: FnStreamSink {
    private weak var ai: AiAssistant?
    private let id: Int

    init(_ ai: AiAssistant, answerId: Int) {
        self.ai = ai
        id = answerId
    }

    func event(_ name: String, _ d: JSONObject) {
        guard let ai, ai.pending(id) else { return }
        switch name {
        case "delta": if let s = d.string("text") { ai.update(id) { $0.text += s } }
        case "reasoning": if let s = d.string("text") { ai.update(id) { $0.reasoning += s } }
        case "citations": if let c = d.array("citations") { ai.update(id) { $0.citations = c.compactMap(\.objectValue) } }
        case "done": ai.done(id, d)
        case "error":
            let code = d["code"] == nil || d["code"] == .null ? "error" : Js.str(d["code"])
            let message = d["message"] == nil || d["message"] == .null ? Texts.t("fnm.err.aiFailed", "The AI call failed.") : Js.str(d["message"])
            ai.fail(id, code, message)
        default: break
        }
    }

    func end() {
        guard let ai, ai.pending(id) else { return }
        ai.fail(id, "incomplete", Texts.t("fnm.err.incomplete", "The answer stopped before it was complete."))
    }

    func fail(_ f: FnFailure) {
        guard let ai, ai.pending(id) else { return }
        ai.fail(id, !f.code.isEmpty ? f.code : f.status > 0 ? "http-\(f.status)" : "network", f.message)
    }
}
