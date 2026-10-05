// 6.11: one command run's clock and its single ending — a port of
// android/…/fn/RunWatch.java. A run that shows no sign of life (no event of
// its stream; the server's pings are not events) for
// ModelIdentity.fnRunTimeoutMs fails, an open question (a form, an NFC tap)
// pauses the clock, an answer starts it afresh, progress and every other event
// move it on. However a run ends — done, an error (incomplete stream, network,
// HTTP), the timeout, a newer run that replaced it — it is settled exactly
// once: settle says true only the first time, so the command's bubble never
// loads for ever and never settles twice. Pure; main actor (the stream's
// events and the timer both come there).

import M5Proto

struct FnRunWatch: Sendable {
    /// How a run ended.
    enum End: Sendable, Equatable, CaseIterable { case done, error, timeout, cancelled }

    private let timeoutMs: Int64
    private var deadline: Int64
    private var open = 0
    private(set) var ended: End?

    init(timeoutMs: Int64 = ModelIdentity.fnRunTimeoutMs, now: Int64) {
        self.timeoutMs = timeoutMs
        deadline = now + timeoutMs
    }

    /// A sign of life (start, progress, an output, a log line): the clock starts again.
    mutating func alive(_ now: Int64) {
        if ended == nil { deadline = now + timeoutMs }
    }

    /// A question opened: the clock waits for the person.
    mutating func asked() {
        if ended == nil { open += 1 }
    }

    /// A question was answered (or dismissed): when none is left open, the clock starts afresh.
    mutating func answered(_ now: Int64) {
        if ended != nil || open == 0 { return }
        open -= 1
        if open == 0 { deadline = now + timeoutMs }
    }

    var paused: Bool { ended == nil && open > 0 }

    /// Time left before the run times out (ms): 0 when it has; Int64.max while a question is open or once it ended.
    func remaining(_ now: Int64) -> Int64 {
        if ended != nil || open > 0 { return .max }
        return Swift.max(0, deadline - now)
    }

    /// Running, no question open, and the time is up.
    func expired(_ now: Int64) -> Bool { ended == nil && open == 0 && now >= deadline }

    /// Ends the run — true only for the first ending; every later one (a late answer after a timeout…) is ignored.
    mutating func settle(_ how: End) -> Bool {
        if ended != nil { return false }
        ended = how
        return true
    }

    var over: Bool { ended != nil }
}
