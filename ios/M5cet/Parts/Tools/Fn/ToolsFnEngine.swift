// The app's bridge to the functions (6.1) — a port of
// android/…/ui/parts/Fn.java, installed as `CoreModels.shared.fn`: chat
// commands (/…), a command's outputs in a bubble (FnOutputsView), the AI
// assistant and the server's speech. It re-makes its clients when the server
// changes. The composer's triggers and the command list are loaded for the
// account and cached so suggestions and `run` answer without waiting.
//
// 6.11 (client/src/lib/system-messenger.ts): a model's answer is an INCOMING
// message from system-messenger — the model's name and icon — replying to the
// command that asked (a room answer goes out with the model's identity in its
// fn flags, and shows here the same way, "via you"). Every run has a clock
// (FnRunWatch): 30 s without a sign of life ends it — the command's bubble gets
// an error chip, a flash says so — an open question pauses it; each run ends
// exactly once (a newer command cancels the one in flight). A call that cannot
// run as typed (CommandCheck) is not sent: the model's answer is an error card;
// the server's own refusal of the inputs too.

import Foundation
import M5Core
import M5Design
import M5Proto
import UIKit

/// Where the commands' usage is kept (the vault's user tier, record "fn-usage") — the core implements it.
@MainActor
protocol FnUsageStore: AnyObject {
    /// nil while the vault is locked (or when nothing was kept).
    func loadUsage() -> JSONObject?
    func saveUsage(_ o: JSONObject)
}

/// An open question of a run on screen (a sheet); dismiss() takes it away without an answer.
@MainActor
protocol FnAskHandle: AnyObject {
    func dismiss()
}

/// How the engine shows a run's question and a function's files (UIKit sheets in the app, a fake in the tests).
@MainActor
protocol FnPresenting: AnyObject {
    func ask(_ i: FnRun.Interaction, title: String, look: ToolsLook?, answer: @escaping (JSON?) -> Void) -> any FnAskHandle
    /// Save (open false: the system's export to Files) or open (Quick Look) a function's file.
    func file(name: String, mime: String, data: Data, open: Bool, host: DesignHost?)
}

/// An "nfc" question (6.6: the model asks this phone to read a card) — the NFC part answers it with an NfcResult.
@MainActor
protocol FnNfcAsk: AnyObject {
    var runId: String { get }
    /// The run is over: nothing more to answer.
    func runEnded()
    /// A newer question replaces it (cancelled).
    func close()
}

@MainActor
final class ToolsFnEngine: FnEngine {
    /// The core the parts use now (Bootstrap: the real one; DEBUG previews: PreviewCore).
    var core: () -> CoreModels = { CoreModels.shared }
    let transport: any FnTransport
    /// The clock (ms).
    let now: () -> Int64
    /// Off in the tests: they drive the clock with checkClock().
    var timerEnabled = true
    /// This device's client id (Config.deviceId) — the server keys a model's session by it. Core request.
    var deviceId: () -> String = { "" }
    /// The room's blind id on the server (r3.…, never its name) — Core request (RoomModel.serverId).
    var roomId: (any RoomModel) -> String? = { _ in nil }
    var usageStore: (any FnUsageStore)?
    var presenter: any FnPresenting = ToolsSheets()
    /// The NFC part's runner of an "nfc" question (nil: answered "unsupported").
    var nfcAsk: ((_ i: FnRun.Interaction, _ modelName: String, _ host: DesignHost?, _ reply: @escaping (JSON?) -> Void) -> (any FnNfcAsk)?)?

    /// The window that ran a command or drew outputs last (flashes, the form, texts).
    weak var host: DesignHost?

    private var base: String?
    private var client: FnCommandsClient?
    private var assistantObj: AiAssistant?
    /// The account's bearer as last read (the suggester and run answer at once with it).
    private(set) var bearerCache = ""
    private var live: [Live] = []
    private var command: Live?
    private var timer: Task<Void, Never>?
    private var usageObj: Usage?
    private var nfcHandle: (any FnNfcAsk)?

    init(transport: any FnTransport = FnURLSessionTransport(), now: @escaping () -> Int64 = { Millis.now }) {
        self.transport = transport
        self.now = now
    }

    // MARK: clients

    /// The commands client of the current server (made again when it changes).
    func commands() -> FnCommandsClient {
        let b = core().server
        if let client, base == b { return client }
        base = b
        assistantObj = nil
        let c = FnCommandsClient(api: FnApi(base: b, transport: transport), now: now)
        client = c
        return c
    }

    var assistant: AiAssistant {
        let c = commands()
        if let assistantObj { return assistantObj }
        let a = AiAssistant(api: c.api)
        assistantObj = a
        return a
    }

    var speech: FnSpeech { FnSpeech(api: commands().api) }

    /// The account's bearer now ("" signed out); remembered for the synchronous paths.
    func bearer() async -> String {
        let b = await core().account.bearer()
        bearerCache = b
        return b
    }

    private func t(_ key: String) -> String {
        guard let host else { return Texts.t(key, key) }
        return host.translator.t(key)
    }

    private func flash(_ text: String, _ level: FlashLevel) { host?.flash(title: "", text: text, level: level) }

    private func refreshHosts() { host?.refresh() }

    // MARK: FnEngine

    var commandChars: [String] { commands().composer.commandChars }

    /// The character a command starts with here ("/" unless the operator chose another).
    var trigger: String { commandChars.first ?? "/" }

    /// Loads the operator's composer triggers and the account's command list (both cached).
    func load() {
        let c = commands()
        Task { @MainActor in
            let b = await bearer()
            await c.loadComposer(bearer: b)
            refreshHosts()
            await c.refresh(bearer: b)
            refreshHosts()
        }
    }

    /// The lock (F-16): the usage read from the vault, the assistant's conversation, the History's list and the
    /// played media leave the memory (read again after the unlock).
    func forget() {
        usageObj = nil
        assistantObj?.clear()
        FnOnce.forget()
        FnMediaFiles.forget()
        ToolsCallLog.shared.forget()
    }

    func suggest(text: String, caret: Int, names: [String], recent: [String]) -> Suggestions.Result? {
        let c = commands()
        return Suggestions.suggest(text, caret, c.composer, c.state(bearer: bearerCache), names, recent, usage: usage(), now: now())
    }

    /// 6.11: the hint over the message box while a command's arguments are typed (nil: none).
    func hint(text: String, caret: Int) -> ArgHint? {
        ArgHint.of(text, caret, commandChars, commands().state(bearer: bearerCache))
    }

    // MARK: usage (6.11)

    private func usage() -> Usage {
        if let usageObj { return usageObj }
        guard let store = usageStore else { let u = Usage(); usageObj = u; return u }
        guard let o = store.loadUsage() else { return Usage() }
        let u = Usage.from(o)
        usageObj = u
        return u
    }

    private func used(_ keyword: String) {
        let u = usage()
        u.used(keyword, now())
        if u === usageObj { usageStore?.saveUsage(u.toJson()) }
    }

    // MARK: a run

    /// One run in flight: its clock, where its answer goes, what it is.
    @MainActor
    final class Live {
        var watch: FnRunWatch
        let room: (any RoomModel)?
        /// The command's own bubble (nil: a click or a form of a message).
        let bubble: ChatMessage?
        /// The message a click or a form came from (the answer replies to it); nil for a command.
        let origin: ChatMessage?
        let id: ModelIdentity
        /// The command (nil for a click or a form).
        let cmd: Command?
        /// "room" or "caller" when the server does not say.
        let visibility: String
        /// A click's or a form's: the busy state ends with whether the model answered.
        let done: ((Bool) -> Void)?
        var call: FnCall?
        var runId = ""
        /// The question of this run on screen, if any.
        var asking: (any FnAskHandle)?

        init(now: Int64, room: (any RoomModel)?, bubble: ChatMessage?, origin: ChatMessage?, id: ModelIdentity, cmd: Command?, visibility: String,
             done: ((Bool) -> Void)?) {
            watch = FnRunWatch(now: now)
            self.room = room
            self.bubble = bubble
            self.origin = origin
            self.id = id
            self.cmd = cmd
            self.visibility = visibility
            self.done = done
        }
    }

    /// The runs in flight (tests).
    var running: Int { live.count }

    /// A typed command runs on the server instead of being sent; false = not a command, send it as text
    /// (App.tsx: only a known command is intercepted).
    func run(room r: any RoomModel, text: String, host: DesignHost) -> Bool {
        self.host = host
        return run(room: r, text: text)
    }

    @discardableResult
    func run(room r: (any RoomModel)?, text: String) -> Bool {
        let c = commands()
        guard let p = Commands.parseCommandLine(text, commandChars) else { return false }
        let st = c.state(bearer: bearerCache)
        guard let cmd = st.find(p.keyword) else {
            if st.enabled == nil {
                Task { @MainActor in
                    await c.refresh(bearer: await bearer(), force: true)
                    refreshHosts()
                }
            }
            return false
        }
        let inputs = Commands.buildInputs(cmd, p.argText)
        let id = ModelIdentity.of(cmd)
        used(cmd.keyword)
        // 6.5: the call shows at once as the sender's own bubble — pulsing, with a loading indicator under the
        // query; 6.11: then a status, the answer below it.
        let arg = Js.trim(p.argText)
        let query = trigger + cmd.keyword + (arg.isEmpty ? "" : " " + arg)
        let call = r?.startFnCall(keyword: cmd.keyword, name: cmd.name, query: query, icon: id.icon)
        // A newer command replaces the one in flight: that one ends now ("cancelled" on its bubble).
        if let command { end(command, .cancelled) }
        nfcHandle?.close()  // the replaced run's card read is cancelled
        nfcHandle = nil
        // 6.11: a call that cannot run as typed is not sent — the model's answer says what it expects.
        let problems = CommandCheck.check(cmd, inputs)
        if !problems.isEmpty {
            if let call { r?.fnCallStatus(call.id, kind: "error", label: t("fnm.badCall"), code: "bad-input") }
            badCall(r, call, cmd, id, problems, nil)
            return true
        }
        let run = Live(now: now(), room: r, bubble: call, origin: nil, id: id, cmd: cmd, visibility: cmd.visibility, done: nil)
        command = run
        let origin = self.origin()
        start(run) { b, h in c.run(bearer: b, keyword: cmd.keyword, model: cmd.model, inputs: inputs, origin: origin, handlers: h) }
        return true
    }

    /// Where a run comes from: the active room's blind id (6.7: never its plain name), this device, the language, the zone.
    func origin() -> FnRun.Origin {
        let r = core().rooms.active
        let id = r.flatMap(roomId) ?? ""
        let blind = id.hasPrefix("r3.") && id.utf16.count >= 19 && id.dropFirst(3).unicodeScalars.allSatisfy { u in
            (u.value >= 0x30 && u.value <= 0x39) || (u.value >= 0x41 && u.value <= 0x5A) || (u.value >= 0x61 && u.value <= 0x7A) || u == "_" || u == "-"
        }
        return FnRun.Origin(room: blind ? id : nil, client: deviceId(), lang: host?.services.lang ?? "en", tz: TimeZone.current.identifier)
    }

    private func start(_ run: Live, _ go: @escaping (String, FnRunHandlers) -> FnCall) {
        live.append(run)
        arm()
        let handlers = self.handlers(run)
        Task { @MainActor in
            let b = await bearer()
            // Ended meanwhile (a newer command, the clock): it never goes.
            guard !run.watch.over else { return }
            run.call = go(b, handlers)
        }
    }

    /// What a run's stream says, on the main actor in its order.
    private func handlers(_ run: Live) -> FnRunHandlers {
        var h = FnRunHandlers()
        h.alive = { [weak self, weak run] in
            guard let self, let run else { return }
            run.watch.alive(self.now())
            self.arm()
        }
        h.start = { [weak run] id in run?.runId = id }
        h.progress = { [weak run] p, text in
            guard let run, !run.watch.over, let b = run.bubble else { return }
            run.room?.fnCallProgress(b.id, progress: p, text: text)
        }
        h.interaction = { [weak self, weak run] i in
            guard let self, let run, !run.watch.over else { return }
            run.watch.asked()
            self.arm()
            self.ask(run, i)
        }
        h.error = { [weak self, weak run] code, message in
            guard let self, let run else { return }
            self.failed(run, code, message)
        }
        h.done = { [weak self, weak run] d in
            guard let self, let run else { return }
            self.finished(run, d)
        }
        return h
    }

    /// The run's stream ended with an error: incomplete, the network, the server's refusal (HTTP), its error event.
    private func failed(_ run: Live, _ code: String, _ message: String) {
        guard run.watch.settle(.error) else { return }
        closed(run)
        guard let cmd = run.cmd else {
            if code == "expired" { flash(t("fnui.expired"), .warn) } else { flash(t("fnui.eventFailed") + (message.isEmpty ? "" : ": " + message), .error) }
            run.done?(false)
            return
        }
        if code == "bad-input" {
            // The server refused the inputs: shown like a wrong call — what it said, the usage, the parameters.
            if let b = run.bubble { run.room?.fnCallStatus(b.id, kind: "error", label: t("fnm.badCall"), code: "bad-input") }
            badCall(run.room, run.bubble, cmd, run.id, [], message)
            return
        }
        if let b = run.bubble { run.room?.fnCallStatus(b.id, kind: "error", label: message.isEmpty ? t("functions.failed") : message, code: code) }
        flash(t("fnm.failed").replacingOccurrences(of: "{keyword}", with: run.id.keyword), .error)
    }

    private func finished(_ run: Live, _ d: FnRun.Done) {
        guard run.watch.settle(.done) else { return }
        closed(run)
        deliver(run.room, run.bubble, run.origin, run.id, d.visibility ?? run.visibility, d)
        run.done?(!d.failedUnanswered)
    }

    /// A run ended from here: a newer command replaced it, or its time was up (no sign of life for 30 s).
    private func end(_ run: Live, _ how: FnRunWatch.End) {
        guard run.watch.settle(how) else { return }
        run.call?.cancel()
        closed(run)
        if how == .cancelled {
            if let b = run.bubble { run.room?.fnCallStatus(b.id, kind: "info", label: t("fnm.cancelled"), code: "cancelled") }
        } else {
            if let b = run.bubble {
                run.room?.fnCallStatus(b.id, kind: "error", label: t("fnm.timeout").replacingOccurrences(of: "{s}", with: String(ModelIdentity.fnRunTimeoutMs / 1000)), code: "timeout")
            }
            flash(t("fnm.failed").replacingOccurrences(of: "{keyword}", with: run.id.keyword), .error)
        }
        run.done?(false)
    }

    /// A run is over: out of the list, its question and card read go.
    private func closed(_ run: Live) {
        live.removeAll { $0 === run }
        if command === run { command = nil }
        if let a = run.asking { run.asking = nil; a.dismiss() }
        runEnded(run.runId)
        arm()
    }

    /// The clock: the run whose time is up ends; the next check comes when the next one would be.
    func checkClock() {
        let n = now()
        for run in live where run.watch.expired(n) { end(run, .timeout) }
        arm()
    }

    private func arm() {
        timer?.cancel()
        timer = nil
        guard timerEnabled else { return }
        let n = now()
        let next = live.map { $0.watch.remaining(n) }.min() ?? .max
        guard next != .max else { return }
        timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Swift.max(10, next + 10)))
            if Task.isCancelled { return }
            self?.checkClock()
        }
    }

    // MARK: answers

    /// showFnResult(): a room model sends its output end-to-end (6.11: with the model's identity in the fn flags, a
    /// reply to the command here); a caller-only one is an incoming message from system-messenger here. The command's
    /// own bubble ends with a status.
    private func deliver(_ r: (any RoomModel)?, _ call: ChatMessage?, _ origin: ChatMessage?, _ id: ModelIdentity, _ visibility: String, _ d: FnRun.Done) {
        if d.failedUnanswered {
            let msg = d.error?.optString("message") ?? ""
            if let call { r?.fnCallStatus(call.id, kind: "error", label: msg.isEmpty ? t("functions.failed") : msg, code: "failed") }
            flash(t("fnm.failed").replacingOccurrences(of: "{keyword}", with: id.keyword) + (msg.isEmpty ? "" : ": " + msg), .error)
            return
        }
        let m = d.message(keyword: id.keyword, name: id.name, visibility: visibility, icon: id.icon)
        let shown = ModelIdentity.fromJson(m.local) ?? id
        let body = m.text.isEmpty ? t("functions.empty") : m.text
        let anyone = !(r?.peers.isEmpty ?? true)
        let replyTo = call ?? origin
        if m.room, let r, anyone {
            var o = Outgoing(text: body)
            o.forwardedFrom = "/" + shown.keyword
            o.fn = m.fn
            o.fnLocal = m.local
            // A reply to the command here (its own bubble is never sent: the room keeps that quote here), or to the message clicked.
            o.replyTo = replyTo
            if (core().rooms.active as AnyObject?) === (r as AnyObject), let to = recipients() {
                for pid in to { if let n = r.peerName(pid) { o.recipients.append(pid); o.recipientNames.append(n) } }
            }
            r.send(o)
            if let call { r.fnCallStatus(call.id, kind: "ok", label: t("functions.sentToRoom"), code: "sent") }
        } else {
            if m.room { flash(t("functions.localOnly"), .info) }
            if let call { r?.fnCallStatus(call.id, kind: "ok", label: t("fnm.answered"), code: "answered") }
            r?.addModelAnswer(identity: shown.toJson(), text: body, share: m.fn, local: m.local, replyTo: replyTo)
        }
    }

    /// 6.11: the answer to a call that cannot run — an error card from the model: what is wrong, the usage, the
    /// parameters, its guide.
    private func badCall(_ r: (any RoomModel)?, _ call: ChatMessage?, _ cmd: Command, _ id: ModelIdentity, _ problems: [CommandCheck.Problem], _ serverMessage: String?) {
        let title = t("fnm.error.title").replacingOccurrences(of: "{keyword}", with: cmd.keyword)
        guard let r else { flash(title, .error); return }
        let outputs = CommandCheck.card(cmd, trigger, problems, serverMessage) { [weak self] k in self?.t(k) ?? k }
        var fn = id.toJson()
        fn["outputs"] = .array(outputs)
        fn["problem"] = true
        fn["title"] = .string(title)
        let text = title + "\n\n" + Outputs.toMarkdown(outputs)
        r.addModelAnswer(identity: id.toJson(), text: text, share: fn, local: nil, replyTo: call)
    }

    /// The composer's current recipient selection (a private command), or nil for everyone.
    private func recipients() -> [String]? {
        guard case .array(let a)? = host?.form["msgTo"] else { return nil }
        let out = a.map { $0.stringValue ?? Expr.toText($0) }
        return out.isEmpty ? nil : out
    }

    // MARK: a running question

    /// A running model's question (6.11: the run's clock waits for the answer). 6.6: an "nfc" interaction is not a
    /// question — the model asks this phone to read a card: the NFC part runs it and answers with the NfcResult.
    private func ask(_ run: Live, _ i: FnRun.Interaction) {
        let c = commands()
        let reply: (JSON?) -> Void = { [weak self, weak run] value in
            guard let self else { return }
            let b = self.bearerCache
            c.answer(bearer: b, runId: i.runId, interactionId: i.id, value: value)
            run?.watch.answered(self.now())
            self.arm()
        }
        if i.kind == "nfc" {
            nfcHandle?.close()  // an older ask still open: cancelled
            nfcHandle = nil
            if let nfcAsk { nfcHandle = nfcAsk(i, run.id.name, host, reply) } else {
                // No NFC part in this build: the model hears so at once (ModelNfc.result("unsupported", …)).
                reply(.object(JSONObject([("status", "unsupported"), ("message", "NFC is not available to a model in this app.")])))
            }
            return
        }
        var answered = false
        let answer: (JSON?) -> Void = { [weak run] value in
            if answered { return }
            answered = true
            reply(value)
            if let run, let a = run.asking { run.asking = nil; a.dismiss() }
        }
        run.asking = presenter.ask(i, title: i.title.isEmpty ? run.id.name : i.title, look: host.map { ToolsLook(host: $0) }, answer: answer)
    }

    /// The run is over: a sheet still waiting for its card has nothing more to answer.
    private func runEnded(_ runId: String) {
        if let n = nfcHandle, runId.isEmpty || runId == n.runId { n.runEnded(); nfcHandle = nil }
    }

    // MARK: the model's card (6.11)

    /// $form.model (message.model): the model behind an answer — what the command list knows of it, who it came through.
    func modelCard(for m: ChatMessage) -> JSONObject? {
        guard var o = FnModelFace.scope(m, tr: { [weak self] k in self?.t(k) ?? k }, has: FnModelFace.appHas), let id = FnModelFace.of(m) else { return nil }
        let cmd = commands().state(bearer: bearerCache).find(Js.lowerRoot(id.keyword))
        let isLocal = FnModelFace.local(m)
        o["known"] = .bool(cmd != nil)
        o["local"] = .bool(isLocal)
        o["write"] = .string(trigger + id.keyword + " ")
        o["senderId"] = .string(isLocal || m.mine ? "" : m.senderId)
        o["summary"] = .string(cmd?.summary ?? "")
        o["visibility"] = .string(cmd?.visibility ?? "")
        o["usage"] = .string(cmd.map { CommandCheck.usage($0, trigger) } ?? "")
        o["guide"] = .string(cmd?.usage ?? "")
        var inputs = [JSON]()
        for i in cmd?.inputs ?? [] {
            inputs.append(.object(JSONObject([("name", .string(i.name)), ("label", .string(i.label.isEmpty || i.label == i.name ? "" : i.label)),
                                               ("required", .bool(i.mustGive)), ("expect", .string(CommandCheck.expectation(i) { [weak self] k in self?.t(k) ?? k })),
                                               ("help", .string(i.help))])))
        }
        o["inputs"] = .array(inputs)
        o["hasInputs"] = .bool(!inputs.isEmpty)
        return o
    }

    // MARK: outputs (bubble)

    /// What FnOutputsView of a window calls back.
    func outputsHost(_ host: DesignHost) -> any FnOutputsHost {
        self.host = self.host ?? host
        return FnOutputsBridge(engine: self, host: host)
    }

    /// A click or a form of a message's outputs: the model's entry point, streamed like a run.
    func event(key: String, meta: JSONObject, ev: JSONObject, host: DesignHost?, done: @escaping (Bool) -> Void) {
        if let host { self.host = host }
        let r = core().rooms.active
        let from = r?.message(key)
        let id = ModelIdentity.fromJson(meta) ?? ModelIdentity.of(meta.optString("keyword", "?"), meta.optString("name"), nil)
        let run = Live(now: now(), room: r, bubble: nil, origin: from, id: id, cmd: nil, visibility: "caller", done: done)
        let c = commands()
        let origin = self.origin()
        start(run) { b, h in c.event(bearer: b, meta: meta, ev: ev, origin: origin, handlers: h) }
    }

    /// An output this app could not show: logged with its run; the model's error entry point may answer.
    func report(meta: JSONObject, ev: JSONObject) {
        let r = core().rooms.active
        let c = commands()
        let origin = self.origin()
        Task { @MainActor in
            guard let d = await c.report(bearer: await bearer(), meta: meta, ev: ev, origin: origin) else { return }
            let id = ModelIdentity.fromJson(meta) ?? ModelIdentity.of(meta.optString("keyword", "?"), meta.optString("name"), nil)
            deliver(r, nil, nil, id, d.visibility ?? "caller", d)
        }
    }

    /// A link tapped in an output: the whole address is shown first; one that cannot be read in full is refused
    /// (DesignUrls — never a web view of the app's own).
    func openLink(_ url: String, host: DesignHost?) {
        guard let host = host ?? self.host else { return }
        ToolsLinks.confirmOpen(url, host: host)
    }
}

/// FnOutputsView's host for one window.
@MainActor
final class FnOutputsBridge: FnOutputsHost {
    private weak var engine: ToolsFnEngine?
    private weak var host: DesignHost?

    init(engine: ToolsFnEngine, host: DesignHost) {
        self.engine = engine
        self.host = host
    }

    func event(key: String, meta: JSONObject, ev: JSONObject, done: @escaping (Bool) -> Void) {
        guard let engine else { done(false); return }
        engine.event(key: key, meta: meta, ev: ev, host: host, done: done)
    }

    func flash(_ text: String, level: String) {
        let l: FlashLevel = level == "success" ? .success : level == "warning" ? .warn : level == "error" ? .error : .info
        host?.flash(title: "", text: text, level: l)
    }

    func file(name: String, mime: String, data: Data, open: Bool) { engine?.presenter.file(name: name, mime: mime, data: data, open: open, host: host) }

    func openLink(_ url: String) { engine?.openLink(url, host: host) }

    func report(meta: JSONObject, ev: JSONObject) { engine?.report(meta: meta, ev: ev) }
}
