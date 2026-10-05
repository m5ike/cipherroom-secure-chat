// The screen on show and the back stack — MainActivity.showScreen's stack rule and
// onBackPressed, exactly: lock, enrolment and splash never go on the stack, a
// screen opened from the splash or the lock starts a new one, Back from the room
// with nothing behind goes to the rooms, and a screen that comes back off the
// stack takes the duplicates around it away. iOS Back is the edge swipe (and the
// design's own back buttons); Android's "leave the app" is nothing here.

import Observation

@MainActor
@Observable
final class ScreenRouter {
    /// The screen on show ("" before the first one).
    private(set) var screen = ""
    /// The back stack, the newest last (MainActivity's ArrayDeque: push = append, pop = removeLast).
    private(set) var stack: [String] = []
    /// A new screen was shown (each one gets fresh views and its enter animations).
    private(set) var generation = 0
    /// Whether the last change is animated (the design's "screen" transition).
    private(set) var animated = false
    /// The first resolve of a new screen runs the enter animations (Renderer.AnimationGate).
    @ObservationIgnored var enterPending = false

    enum BackOutcome: Equatable {
        /// Another screen is on show now.
        case shown(String)
        /// Android would leave the app (lock, enrolment, splash, an empty stack): nothing on iOS.
        case leave
    }

    /// MainActivity.showScreen (the design has the screen — the host checks).
    func show(_ id: String, transition: Bool) {
        if !screen.isEmpty && screen != id && id != "lock" && id != "enroll" && screen != "splash" && screen != "lock" { stack.append(screen) }
        let from = screen
        // Android animates when a screen was on show already (its view is there) and another one comes.
        animated = transition && generation > 0 && from != id
        screen = id
        generation += 1
        enterPending = true
    }

    /// The same screen drawn anew (MainActivity's "design" state, goRoom on the room screen).
    func reshow() {
        guard !screen.isEmpty else { return }
        generation += 1
        enterPending = true
        animated = false
    }

    func clearStack() { stack.removeAll() }

    /// MainActivity.onBackPressed (after the overlay had its chance).
    @discardableResult
    func back() -> BackOutcome {
        if screen == "lock" || screen == "enroll" || screen == "splash" { return .leave }
        guard let prev = stack.popLast() else {
            if screen == "room" {
                show("rooms", transition: true)
                stack.removeAll()
                return .shown("rooms")
            }
            return .leave
        }
        let now = screen
        screen = ""
        show(prev, transition: true)
        if stack.last == now { stack.removeLast() }
        if stack.last == prev { stack.removeLast() }
        return .shown(prev)
    }
}
