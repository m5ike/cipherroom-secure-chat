// ui/bubble/BubbleSwipe (6.10): a message bubble dragged sideways. Dragged toward
// the reading direction's END — to the RIGHT in Czech, English or German, to the
// left in a right-to-left layout — it REPLIES; toward the START it FORWARDS. The
// bubble follows the finger (freely, then a rubber band), the icon of what it will
// do grows in under the edge it uncovers, the phone ticks once where letting go
// starts to count (triggerDp) and once more if the finger comes back; let go past
// it the action runs, short of it nothing happens; either way the bubble springs back.
//
// Who gets the gesture: a drag that STARTS ON A BUBBLE and is clearly sideways
// (dominance times more than down, past the touch slop) is the bubble's; a more
// vertical one is the list's scrolling, for good; a quick sideways FLING that starts
// anywhere else moves to the previous / next connected room (roomFling).
//
// Pure: fed the touch's numbers (points; the density turns the dp constants into
// points — 1 on iOS), it answers, so the thresholds are unit-tested.

import CoreGraphics

struct BubbleSwipe {
    enum Act { case none, reply, forward }

    /// What the touch became: still deciding, the bubble's drag, the list's scroll, or nothing for the bubble.
    enum Phase { case wait, drag, scroll, none }

    /// A drag is the bubble's once it is this many times more sideways than vertical.
    static let dominance: CGFloat = 1.5
    /// Let go this far (dp) from where the drag began: the action runs. The tick comes here.
    static let triggerDp: CGFloat = 64
    /// The bubble follows the finger freely this far (dp), then as a rubber band …
    static let freeDp: CGFloat = 84
    static let resist: CGFloat = 0.3
    /// … never further than this (dp).
    static let maxDp: CGFloat = 120
    /// A fling off the bubbles at least this fast (dp/s), twice as sideways as vertical, changes the room.
    static let roomFlingDp: CGFloat = 700

    private let slop, trigger, free, max: CGFloat
    private let reply, forward, rtl: Bool
    private(set) var phase: Phase
    private var x0, y0: CGFloat
    /// How far the bubble is moved toward the END of the reading direction (negative = toward the start).
    private var along: CGFloat = 0
    private var past = false
    private(set) var crossed = false

    /// A finger went down at (x, y). `onBubble`: on a bubble that may be swiped; `canReply` / `canForward`: what the
    /// message allows (a direction without its action stays put); `rtl`: the layout reads right to left.
    init(density: CGFloat, slop: CGFloat, onBubble: Bool, canReply: Bool, canForward: Bool, rtl: Bool, x: CGFloat, y: CGFloat) {
        self.slop = Swift.max(1, slop)
        trigger = Self.triggerDp * density
        free = Self.freeDp * density
        max = Self.maxDp * density
        reply = canReply
        forward = canForward
        self.rtl = rtl
        x0 = x
        y0 = y
        phase = onBubble && (canReply || canForward) ? .wait : .none
    }

    /// The bubble's own drag (it moves, the list does not scroll, the room stays).
    var dragging: Bool { phase == .drag }

    /// The finger is at (x, y) now: is the gesture the bubble's?
    @discardableResult
    mutating func move(_ x: CGFloat, _ y: CGFloat) -> Bool {
        crossed = false
        if phase == .none || phase == .scroll { return false }
        var dx = x - x0
        let dy = y - y0
        if phase == .wait {
            let ax = abs(dx), ay = abs(dy)
            if ax > slop && ax >= Self.dominance * ay {
                let toward = Self.act(dx, rtl: rtl)
                if !allows(toward) { phase = .none; return false }
                phase = .drag
                x0 += dx > 0 ? slop : -slop // no jump by the slop
                dx = x - x0
            } else if ay > slop {
                phase = .scroll
                return false
            } else {
                return false
            }
        }
        let e = rtl ? -dx : dx
        var next = Self.follow(e, free: free, max: max, resist: Self.resist)
        if next > 0 && !reply || next < 0 && !forward { next = 0 } // back past the start: only toward an allowed side
        along = next
        let nowPast = abs(along) >= trigger
        crossed = nowPast != past
        past = nowPast
        return true
    }

    /// Where the bubble is now, physically (positive = to the right).
    var offset: CGFloat { rtl ? -along : along }

    /// Letting go here runs the action.
    var armed: Bool { phase == .drag && past }

    /// What the drag shows now (its icon), none before it moved.
    var showing: Act { along > 0 ? .reply : along < 0 ? .forward : .none }

    /// How much of the way to the trigger (0–1): the icon grows in with it.
    var progress: CGFloat { trigger <= 0 ? 0 : Swift.min(1, abs(along) / trigger) }

    /// The finger lifted: what runs (none short of the trigger, or when it was not the bubble's). The gesture is over.
    mutating func release() -> Act {
        let out = armed ? showing : .none
        cancel()
        return out
    }

    /// The gesture was taken away: nothing runs.
    mutating func cancel() {
        phase = .none
        along = 0
        past = false
        crossed = false
    }

    private func allows(_ a: Act) -> Bool { a == .reply ? reply : a == .forward && forward }

    // MARK: rules

    /// A physical sideways movement (positive = to the right) → the action it means in this layout.
    static func act(_ dx: CGFloat, rtl: Bool) -> Act {
        let e = rtl ? -dx : dx
        return e > 0 ? .reply : e < 0 ? .forward : .none
    }

    /// Where the bubble is for a finger `d` from the start: 1:1 up to `free`, then `resist` of the rest, at most `max`.
    static func follow(_ d: CGFloat, free: CGFloat, max: CGFloat, resist: CGFloat) -> CGFloat {
        let a = abs(d)
        let v = a <= free ? a : Swift.min(max, free + (a - free) * resist)
        return (d > 0 ? 1 : d < 0 ? -1 : 0) * Swift.min(v, max)
    }

    /// The 6.1 room change: a fling (velocity /s) that did not start on a bubble, at least `min` sideways and twice as sideways as vertical.
    static func roomFling(startedOnBubble: Bool, vx: CGFloat, vy: CGFloat, min: CGFloat) -> Bool {
        !startedOnBubble && abs(vx) >= min && abs(vx) >= 2 * abs(vy)
    }

    /// Which way the room changes for that fling: +1 the next room (a fling to the left), −1 the previous one.
    static func roomStep(_ vx: CGFloat) -> Int { vx < 0 ? 1 : -1 }
}

/// ui/bubble/HoldGesture (6.7): the hold area beside a hold-to-read bubble — a press that stays put for a moment
/// reveals the message until the finger lifts; a finger that moves first (a scroll, a swipe) or lifts first reveals
/// nothing. Pure (the web's hold area waits as long: HOLD_SIDE_MS).
struct BubbleHoldGesture {
    /// How long the finger stays before the message shows (ms).
    static let delayMs: Int64 = 180

    enum Step { case none, arm, reveal, hide, cancel }

    private let delayMs: Int64
    private let slop: CGFloat
    private var down = false
    private(set) var revealed = false
    private var x0: CGFloat = 0, y0: CGFloat = 0
    private var t0: Int64 = 0

    init(delayMs: Int64 = BubbleHoldGesture.delayMs, slop: CGFloat) {
        self.delayMs = delayMs
        self.slop = slop
    }

    /// Finger down: arm — check again after the delay (due).
    mutating func down(_ x: CGFloat, _ y: CGFloat, _ t: Int64) -> Step {
        down = true
        revealed = false
        x0 = x; y0 = y; t0 = t
        return .arm
    }

    /// Before the reveal, a move beyond the slop gives the gesture to the list (cancel); after it, the finger may wander.
    mutating func move(_ x: CGFloat, _ y: CGFloat) -> Step {
        if !down || revealed { return .none }
        let dx = x - x0, dy = y - y0
        if dx * dx + dy * dy > slop * slop { down = false; return .cancel }
        return .none
    }

    /// The delay's check: reveal once the finger stayed long enough.
    mutating func due(_ t: Int64) -> Step {
        if !down || revealed || t - t0 < delayMs { return .none }
        revealed = true
        return .reveal
    }

    /// Finger up (or the gesture taken away): hide what was revealed, else cancel the wait.
    mutating func up() -> Step {
        let was = revealed, armedNow = down
        down = false
        revealed = false
        return was ? .hide : armedNow ? .cancel : .none
    }

    var armed: Bool { down && !revealed }
}
