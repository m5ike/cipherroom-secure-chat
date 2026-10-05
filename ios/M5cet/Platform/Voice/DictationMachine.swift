// Dictation's state machine (6.7) — port 1:1 of
// android/app/src/main/java/cz/m5cet/app/voice/DictationMachine.java (itself
// client/src/lib/dictation.ts with pause / resume for the app speaking). Pure:
// the tests drive it (DictationMachineTests = Android's DictationMachineTest);
// the phone's recogniser is an Engine (Dictation.swift).
//
//   IDLE ─start→ STARTING ─(ready)→ LISTENING
//   LISTENING ─(the recogniser ended by itself: a pause)→ RESTARTING → STARTING …
//   any ─pause (the app speaks)→ PAUSED ─resume→ STARTING
//   any ─stop→ STOPPING ─(last words, end — or finishMs)→ IDLE
//   any ─abort, or a fatal error (no permission, no microphone)→ IDLE
//
// A stop always ends it: the recogniser is asked to stop so the last words still
// come, a pending restart is cancelled, and a recogniser that does not end within
// finishMs is cancelled and dropped — the microphone is free. Events of a session
// that is over (a late result, an error after our own cancel) are ignored, so
// nothing ever restarts a stopped dictation. Single-threaded: the main actor.
//
// One deliberate difference: an error that ends the dictation ("unsupported", a
// fatal code, "ended") is reported BEFORE the machine goes idle. Android reports
// it after finish(), when Dictation has already dropped its listener on IDLE —
// so the composer's onEnded never sees it and "not-allowed", "audio-capture",
// "language-not-supported" were never flashed. The tests are Android's.

import Foundation

/// What a recogniser session reports (Android DictationMachine.Events).
@MainActor
protocol DictationEvents: AnyObject {
    func ready()
    func partial(_ text: String?)
    func fin(_ text: String?)
    func error(_ code: String?)
    /// The session is over (after its result or error).
    func end()
}

/// One recogniser session.
@MainActor
protocol DictationSession: AnyObject {
    /// Stop listening; the last words come, then end.
    func stop()
    /// Drop it now (no more events matter); free the microphone.
    func abort()
}

/// The recogniser (Dictation.swift: Speech framework, on the device only).
@MainActor
protocol DictationEngine: AnyObject {
    /// A new session; throws when it cannot start.
    func start(lang: String, events: any DictationEvents) throws -> any DictationSession
}

/// Timers (the main queue in the app, by hand in the tests).
@MainActor
protocol DictationScheduler: AnyObject {
    func post(_ ms: Int64, _ block: @escaping @MainActor () -> Void) -> AnyHashable
    func cancel(_ token: AnyHashable)
}

/// What the machine tells its owner.
@MainActor
protocol DictationMachineListener: AnyObject {
    func onText(_ text: String, fin: Bool)
    func onState(_ state: DictationMachine.State)
    func onError(_ code: String)
}

@MainActor
final class DictationMachine {
    enum State: String, Sendable {
        case idle = "IDLE", starting = "STARTING", listening = "LISTENING", restarting = "RESTARTING", paused = "PAUSED", stopping = "STOPPING"
    }

    /// Errors after which listening again is pointless.
    static let fatal: Set<String> = ["not-allowed", "audio-capture", "language-not-supported", "unsupported", "no-microphone"]

    private let engine: any DictationEngine
    private let scheduler: any DictationScheduler
    private weak var listener: (any DictationMachineListener)?
    private var lang: String
    private(set) var state: State = .idle
    private var session: (any DictationSession)?
    private var gen = 0
    private var restartTimer: AnyHashable?
    private var finishTimer: AnyHashable?
    private var idleRestarts = 0
    private var lastError = ""
    var finishMs: Int64 = 1500
    var restartMs: Int64 = 250
    var busyRestartMs: Int64 = 700
    var maxIdleRestarts = 8

    /// The listener is held weakly (the owner keeps it).
    init(engine: any DictationEngine, scheduler: any DictationScheduler, lang: String, listener: any DictationMachineListener) {
        self.engine = engine
        self.scheduler = scheduler
        self.lang = lang
        self.listener = listener
    }

    var active: Bool { state != .idle }
    /// Hearing now (the recogniser is ready).
    var listening: Bool { state == .listening }
    func setLang(_ lang: String) { self.lang = lang }

    @discardableResult
    func start() -> Bool {
        if state != .idle { return false }
        idleRestarts = 0
        return open()
    }

    /// Stop and finish the text.
    func stop() {
        if state == .idle || state == .stopping { return }
        clearRestart()
        guard let s = session else { finish(); return } // restarting / paused: nothing listens
        set(.stopping)
        let g = gen
        s.stop()
        finishTimer = scheduler.post(finishMs) { [weak self] in
            guard let self else { return }
            self.finishTimer = nil
            if g == self.gen && self.state == .stopping { self.abortSession(); self.finish() }
        }
    }

    /// Stop at once; unfinished words are dropped.
    func abort() {
        if state == .idle { return }
        abortSession()
        finish()
    }

    func toggle() {
        if state == .idle { start() } else { stop() }
    }

    /// The app is about to speak: stop hearing (resume() goes on).
    func pause() {
        if state == .idle || state == .stopping || state == .paused { return }
        clearRestart()
        abortSession()
        set(.paused)
    }

    func resume() {
        if state != .paused { return }
        open()
    }

    private func set(_ next: State) {
        if state == next { return }
        state = next
        listener?.onState(next)
    }

    /// The events of one session (generation `g`): ignored once the session is over.
    private final class Events: DictationEvents {
        weak var machine: DictationMachine?
        let g: Int
        init(machine: DictationMachine, g: Int) { self.machine = machine; self.g = g }
        private var mine: DictationMachine? { machine.flatMap { $0.gen == g ? $0 : nil } }
        func ready() { if let m = mine, m.state == .starting { m.set(.listening) } }
        func partial(_ text: String?) { if let m = mine, let text, !text.isEmpty { m.idleRestarts = 0; m.listener?.onText(text, fin: false) } }
        func fin(_ text: String?) { if let m = mine, let text, !text.isEmpty { m.idleRestarts = 0; m.listener?.onText(text, fin: true) } }
        func error(_ code: String?) { mine?.onError(code) }
        func end() { mine?.onEnd() }
    }

    @discardableResult
    private func open() -> Bool {
        gen += 1
        let g = gen
        set(.starting)
        do {
            session = try engine.start(lang: lang, events: Events(machine: self, g: g))
            return true
        } catch {
            session = nil
            listener?.onError("unsupported")
            finish()
            return false
        }
    }

    private func onError(_ code: String?) {
        let code = code ?? ""
        lastError = code
        if Self.fatal.contains(code) && state != .stopping {
            abortSession()
            listener?.onError(code)
            finish()
            return
        }
        if code != "no-speech" && code != "aborted" && code != "busy" && code != "client" { listener?.onError(code) }
    }

    private func onEnd() {
        session = nil
        if state == .stopping || state == .idle || state == .paused {
            if state != .paused { finish() }
            return
        }
        // It ended by itself (a pause, the network): dictation goes on.
        idleRestarts += 1
        if idleRestarts > maxIdleRestarts { listener?.onError("ended"); finish(); return }
        set(.restarting)
        let wait = lastError == "busy" || lastError == "client" || lastError == "network" ? busyRestartMs : restartMs
        lastError = ""
        restartTimer = scheduler.post(wait) { [weak self] in
            guard let self else { return }
            self.restartTimer = nil
            if self.state == .restarting { self.open() }
        }
    }

    private func abortSession() {
        let s = session
        session = nil
        gen += 1
        s?.abort()
    }

    private func clearRestart() {
        if let t = restartTimer { scheduler.cancel(t); restartTimer = nil }
    }

    private func finish() {
        clearRestart()
        if let t = finishTimer { scheduler.cancel(t); finishTimer = nil }
        session = nil
        gen += 1
        set(.idle)
    }
}

/// The main queue's timers (the app's scheduler).
@MainActor
final class MainQueueScheduler: DictationScheduler {
    private var next = 0
    private var live = Set<Int>()

    func post(_ ms: Int64, _ block: @escaping @MainActor () -> Void) -> AnyHashable {
        next += 1
        let id = next
        live.insert(id)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, ms)))) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.live.remove(id) != nil else { return }
                block()
            }
        }
        return id
    }

    func cancel(_ token: AnyHashable) {
        if let id = token.base as? Int { live.remove(id) }
    }
}
