// Ports of android/app/src/test/java/cz/m5cet/app/ui/bubble/BubbleSwipeTest.java (6.10) and
// HoldGestureTest.java (6.7): a bubble dragged sideways — right replies, left forwards
// (mirrored right to left); a clear threshold with a tick; a vertical drag stays the list's; a
// fling off the bubbles still changes the room. The hold area: a short still hold reveals; a
// scroll or a quick tap does not. (ui/look/SwipeTest is M5Kit's: M5DesignTests/LookTests.)

import CoreGraphics
import XCTest
@testable import M5cet

final class BubbleSwipeTests: XCTestCase {
    private let d: CGFloat = 2 // px per dp
    private let slop: CGFloat = 16
    private var trigger: CGFloat { BubbleSwipe.triggerDp * d }

    private func at(_ onBubble: Bool, _ reply: Bool, _ forward: Bool, _ rtl: Bool) -> BubbleSwipe {
        BubbleSwipe(density: d, slop: slop, onBubble: onBubble, canReply: reply, canForward: forward, rtl: rtl, x: 100, y: 100)
    }

    func testRightReplies() {
        var g = at(true, true, true, false)
        XCTAssertEqual(g.phase, .wait)
        XCTAssertFalse(g.move(110, 102)) // inside the slop: still deciding
        XCTAssertEqual(g.phase, .wait)
        XCTAssertTrue(g.move(130, 104)) // clearly sideways: the bubble's
        XCTAssertTrue(g.dragging)
        XCTAssertEqual(g.offset, 30 - slop, accuracy: 1e-3) // no jump by the slop
        XCTAssertEqual(g.showing, .reply)
        XCTAssertFalse(g.armed)
        g.move(100 + slop + trigger, 104)
        XCTAssertTrue(g.crossed) // the tick
        XCTAssertTrue(g.armed)
        XCTAssertEqual(g.progress, 1, accuracy: 1e-6)
        XCTAssertEqual(g.release(), .reply)
        XCTAssertEqual(g.phase, .none)
    }

    func testLeftForwards() {
        var g = at(true, true, true, false)
        XCTAssertTrue(g.move(60, 100))
        XCTAssertEqual(g.showing, .forward)
        XCTAssertLessThan(g.offset, 0)
        g.move(100 - slop - trigger - 10, 100)
        XCTAssertTrue(g.armed)
        XCTAssertEqual(g.release(), .forward)
    }

    func testShortOfTheTriggerNothingRuns() {
        var g = at(true, true, true, false)
        g.move(130, 100)
        g.move(100 + slop + trigger - 1, 100)
        XCTAssertFalse(g.armed)
        XCTAssertEqual(g.release(), .none)
    }

    func testTheTickComesOnceOutAndOnceBack() {
        var g = at(true, true, true, false)
        g.move(140, 100)
        var ticks = 0
        var x: CGFloat = 140
        while x <= 100 + slop + trigger + 40 { g.move(x, 100); if g.crossed { ticks += 1 }; x += 4 }
        XCTAssertEqual(ticks, 1)
        x = 100 + slop + trigger + 40
        while x >= 120 { g.move(x, 100); if g.crossed { ticks += 1 }; x -= 4 }
        XCTAssertEqual(ticks, 2)
        XCTAssertFalse(g.armed) // brought back: letting go does nothing
        XCTAssertEqual(g.release(), .none)
    }

    func testAVerticalDragIsTheListsForGood() {
        var g = at(true, true, true, false)
        XCTAssertFalse(g.move(104, 130))
        XCTAssertEqual(g.phase, .scroll)
        XCTAssertFalse(g.move(200, 135)) // sideways later: still the list's
        XCTAssertEqual(g.offset, 0)
        XCTAssertEqual(g.release(), .none)
    }

    func testADiagonalDragIsNotSidewaysEnough() {
        var g = at(true, true, true, false)
        // 30 px across, 24 down: less than 1.5× as sideways — not decided, then the list's.
        XCTAssertFalse(g.move(130, 124))
        XCTAssertEqual(g.phase, .scroll)
        var h = at(true, true, true, false)
        XCTAssertTrue(h.move(130, 119)) // 30 across, 19 down: ≥ 1.5×
        XCTAssertTrue(h.dragging)
    }

    func testADirectionWithoutItsActionStaysPut() {
        // A sealed message not opened here cannot be forwarded: a drag to the left is not taken.
        var g = at(true, true, false, false)
        XCTAssertFalse(g.move(60, 100))
        XCTAssertEqual(g.phase, .none)
        // Dragged right, then back past the start: it stops at the start.
        var h = at(true, true, false, false)
        h.move(140, 100)
        h.move(20, 100)
        XCTAssertEqual(h.offset, 0)
        XCTAssertEqual(h.release(), .none)
    }

    func testNotOnABubbleTheBubbleNeverMoves() {
        var g = at(false, true, true, false)
        XCTAssertEqual(g.phase, .none)
        XCTAssertFalse(g.move(300, 100))
        XCTAssertEqual(g.release(), .none)
        // Nothing allowed (a notice, a vanished message): the same.
        XCTAssertEqual(at(true, false, false, false).phase, .none)
    }

    func testRightToLeftMirrors() {
        // In a right-to-left layout the reading direction's end is on the left: a drag to the left replies.
        var g = at(true, true, true, true)
        XCTAssertTrue(g.move(60, 100))
        XCTAssertEqual(g.showing, .reply)
        XCTAssertLessThan(g.offset, 0) // the bubble moves where the finger goes
        g.move(100 - slop - trigger, 100)
        XCTAssertEqual(g.release(), .reply)
        var h = at(true, true, true, true)
        h.move(140, 100)
        XCTAssertEqual(h.showing, .forward)
        XCTAssertGreaterThan(h.offset, 0)
        XCTAssertEqual(BubbleSwipe.act(-5, rtl: true), .reply)
        XCTAssertEqual(BubbleSwipe.act(5, rtl: true), .forward)
        XCTAssertEqual(BubbleSwipe.act(5, rtl: false), .reply)
        XCTAssertEqual(BubbleSwipe.act(-5, rtl: false), .forward)
        XCTAssertEqual(BubbleSwipe.act(0, rtl: false), .none)
    }

    func testTheBubbleFollowsThenResists() {
        let free = BubbleSwipe.freeDp * d, max = BubbleSwipe.maxDp * d
        XCTAssertEqual(BubbleSwipe.follow(50, free: free, max: max, resist: BubbleSwipe.resist), 50, accuracy: 1e-4)
        XCTAssertEqual(BubbleSwipe.follow(-free, free: free, max: max, resist: BubbleSwipe.resist), -free, accuracy: 1e-4)
        XCTAssertEqual(BubbleSwipe.follow(free + 100, free: free, max: max, resist: BubbleSwipe.resist), free + 100 * BubbleSwipe.resist, accuracy: 1e-3)
        XCTAssertEqual(BubbleSwipe.follow(10_000, free: free, max: max, resist: BubbleSwipe.resist), max, accuracy: 1e-4)
        XCTAssertEqual(BubbleSwipe.follow(-10_000, free: free, max: max, resist: BubbleSwipe.resist), -max, accuracy: 1e-4)
        // The trigger is reached before the rubber band starts.
        XCTAssertTrue(BubbleSwipe.triggerDp < BubbleSwipe.freeDp && BubbleSwipe.freeDp < BubbleSwipe.maxDp)
    }

    func testACancelRunsNothing() {
        var g = at(true, true, true, false)
        g.move(100 + slop + trigger + 20, 100)
        XCTAssertTrue(g.armed)
        g.cancel()
        XCTAssertEqual(g.release(), .none)
        XCTAssertEqual(g.offset, 0)
    }

    func testAFlingOffTheBubblesChangesTheRoomOnABubbleItDoesNot() {
        let min = BubbleSwipe.roomFlingDp * d
        XCTAssertTrue(BubbleSwipe.roomFling(startedOnBubble: false, vx: -min, vy: 100, min: min))
        XCTAssertTrue(BubbleSwipe.roomFling(startedOnBubble: false, vx: min * 2, vy: -min, min: min))
        XCTAssertFalse(BubbleSwipe.roomFling(startedOnBubble: true, vx: -min * 3, vy: 0, min: min)) // on a bubble: its drag, never the room
        XCTAssertFalse(BubbleSwipe.roomFling(startedOnBubble: false, vx: min - 1, vy: 0, min: min)) // too slow
        XCTAssertFalse(BubbleSwipe.roomFling(startedOnBubble: false, vx: min * 2, vy: min * 1.5, min: min)) // not sideways enough
        XCTAssertEqual(BubbleSwipe.roomStep(-1), 1) // to the left: the next room (6.1)
        XCTAssertEqual(BubbleSwipe.roomStep(1), -1)
    }

    // MARK: HoldGestureTest

    func testAStillHoldRevealsUntilTheFingerLifts() {
        var g = BubbleHoldGesture(delayMs: 180, slop: slop)
        XCTAssertEqual(g.down(100, 40, 1000), .arm)
        XCTAssertEqual(g.move(104, 43), .none) // a finger trembles
        XCTAssertEqual(g.due(1100), .none) // not yet
        XCTAssertTrue(g.armed)
        XCTAssertEqual(g.due(1180), .reveal)
        XCTAssertTrue(g.revealed)
        XCTAssertEqual(g.due(1300), .none) // once
        XCTAssertEqual(g.move(300, 200), .none) // revealed: the finger may wander
        XCTAssertEqual(g.up(), .hide)
        XCTAssertFalse(g.revealed)
    }

    func testAScrollThatStartsHereRevealsNothing() {
        var g = BubbleHoldGesture(delayMs: 180, slop: slop)
        _ = g.down(100, 40, 1000)
        XCTAssertEqual(g.move(100, 70), .cancel)
        XCTAssertEqual(g.due(2000), .none)
        XCTAssertFalse(g.revealed)
        XCTAssertEqual(g.up(), .none)
    }

    func testAQuickTapRevealsNothing() {
        var g = BubbleHoldGesture(delayMs: 180, slop: slop)
        _ = g.down(10, 10, 0)
        XCTAssertEqual(g.up(), .cancel)
        XCTAssertEqual(g.due(500), .none)
        XCTAssertFalse(g.revealed)
    }

    func testTheWebWaitsAsLong() {
        XCTAssertEqual(BubbleHoldGesture.delayMs, 180) // client MessageBubble.tsx HOLD_SIDE_MS
    }
}
