// The people of the room in a panel (android/…/ui/parts/UserPanel.java) that floats
// (drag it by its header; dropped near an edge it docks there) or docks to the
// left, right or bottom edge. Docked, it can be pinned or set to hide itself: it
// slides into its edge and leaves the design's "users.handle" tab there; a tap
// slides it back out, and it tucks away again after a few seconds without a touch
// or on a touch outside. The trees ("users", "users.item", "users.handle") and the
// timing (animations.users) come from the design. 6.2: each person as the web's
// recipients widget shows them, a checkbox for who gets the next message, "Select
// all" / "Clear selection"; a tap opens a person's detail (People).
//
// The slot fills the room's message area (a stack: Android's FrameLayout child is
// MATCH_PARENT); only the panel and its handle take touches — the messages under
// the rest of it stay usable. On an iPad (regular width) it is the same panel at
// the same width, docked to the edge of the room's readable column, as Android
// draws it on an unfolded Fold.

import M5Core
import M5Design
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

struct UserPanelView: View {
    let ctx: SlotContext
    var people = PeopleModel.shared
    var state = UserPanelState.shared

    @State private var panelSize: CGSize = .zero
    @State private var drag: CGSize = .zero
    @State private var clock: Int64 = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// UserPanel: 264 dp wide (docked left / right, floating).
    static let width: CGFloat = 264

    var body: some View {
        let host = ctx.host
        let _ = (host.revision, people.revision, clock)
        Group {
            if state.open {
                GeometryReader { geo in
                    panelLayer(geo.size, host: host)
                }
                .task(id: state.open) { await tick() }
            } else {
                Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            }
        }
        #if DEBUG
        // Open or not (-M5UsersOpen NO): the dialogs of -M5People.
        .task { PeopleDebug.runOnce(host) }
        #endif
    }

    // MARK: the scope

    /// The panel's scope (UserPanel.scope): each person as the web's recipients widget shows them and the
    /// selection's summary for the last row.
    static func scope(people: PeopleModel, state: UserPanelState, host: DesignHost) -> [String: DesignValue] {
        let users = people.users(people.core().rooms.active, form: host.form, settings: host.settings, t: host.peopleText)
        let selectable = users.filter { $0.bool("selectable") == true }.count
        let selected = users.filter { $0.bool("selected") == true }.count
        return ["users": .array(users.map(\.designValue)), "count": .number(Double(users.count)), "selectable": .number(Double(selectable)),
                "selectedCount": .number(Double(selected)), "allSelected": .bool(selectable > 0 && selected == selectable),
                "dock": .string(state.dock), "autoHide": .bool(state.autoHide), "edge": .string(state.dock), "open": .bool(state.revealed)]
    }

    // MARK: layout

    @ViewBuilder
    private func panelLayer(_ size: CGSize, host: DesignHost) -> some View {
        let scope = Scope(Self.scope(people: people, state: state, host: host))
        let dock = state.dock, hide = state.hides, revealed = state.revealed
        let w = dock == "bottom" ? max(0, size.width - 12) : min(Self.width, max(0, size.width - 12))
        let pw = panelSize.width > 0 ? panelSize.width : w
        let ph = panelSize.height > 0 ? panelSize.height : 240
        let maxH = (dock == "bottom" ? size.height * 0.45 : size.height * 0.8)
        let origin = origin(size, dock: dock, pw: pw, ph: ph)
        let away = Self.away(dock: dock, tucked: hide && !revealed, pw: pw, ph: ph)
        let spec = host.design.anim("users")
        let animation: Animation? = reduceMotion || host.reducedMotion ? nil : Easing(name: spec.easing ?? "decelerate").animation((spec.ms ?? 240) / 1000)
        ZStack(alignment: .topLeading) {
            DesignTemplateView(screen: "users", scope: scope)
                .environment(\.peopleListCap, max(80, min(360, maxH - 120)))
                .frame(width: w)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxHeight: maxH, alignment: .top)
                .clipped()
                .onGeometryChange(for: CGSize.self) { $0.size } action: { panelSize = $0 }
                .contentShape(Rectangle())
                .simultaneousGesture(floatDrag(size, pw: pw, ph: ph), including: dock == "none" ? .all : .subviews)
                .offset(x: origin.x + away.width + (dock == "none" ? drag.width : 0), y: origin.y + away.height + (dock == "none" ? drag.height : 0))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("userPanel")
            if hide {
                handle(scope, size: size, dock: dock)
                    .opacity(revealed ? 0 : 1)
                    .allowsHitTesting(!revealed)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .overlay {
            // A touch outside the revealed panel tucks it away (Android dispatchTouchEvent); the touch goes on.
            if hide && revealed {
                PeopleTouchObserver { p in
                    let frame = CGRect(x: origin.x, y: origin.y, width: pw, height: ph)
                    if frame.contains(p) { state.touchedInside() } else { state.tuck() }
                }
                .allowsHitTesting(false)
            }
        }
        .animation(animation, value: revealed)
        .animation(animation, value: dock)
    }

    /// How far the auto-hiding panel moves into its edge (nothing while it is out).
    static func away(dock: String, tucked: Bool, pw: CGFloat, ph: CGFloat) -> CGSize {
        guard tucked else { return .zero }
        switch dock {
        case "left": return CGSize(width: -(pw + 12), height: 0)
        case "bottom": return CGSize(width: 0, height: ph + 12)
        default: return CGSize(width: pw + 12, height: 0)
        }
    }

    private func origin(_ size: CGSize, dock: String, pw: CGFloat, ph: CGFloat) -> CGPoint {
        switch dock {
        case "left": return CGPoint(x: 6, y: 8)
        case "bottom": return CGPoint(x: 6, y: max(0, size.height - ph - 6))
        case "none":
            let x = state.x < 0 ? max(0, size.width - Self.width - 12) : CGFloat(state.x)
            let y = state.y < 0 ? 12 : CGFloat(state.y)
            return CGPoint(x: min(max(0, x), max(0, size.width - pw)), y: min(max(0, y), max(0, size.height - ph)))
        default: return CGPoint(x: max(0, size.width - pw - 6), y: 8)
        }
    }

    /// The tab the auto-hiding panel leaves at its edge: a tap brings the panel out.
    private func handle(_ scope: Scope, size: CGSize, dock: String) -> some View {
        let alignment: Alignment = dock == "left" ? .leading : dock == "bottom" ? .bottom : .trailing
        return DesignTemplateView(screen: "users.handle", scope: scope)
            .fixedSize()
            .contentShape(Rectangle())
            .onTapGesture { state.reveal() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: ctx.t("users.title")))
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { state.reveal() }
            .accessibilityIdentifier("userPanel.handle")
            .frame(width: size.width, height: size.height, alignment: alignment)
    }

    /// The floating panel moves by its header (the top 48 pt); dropped near an edge it docks there (as on the web).
    private func floatDrag(_ size: CGSize, pw: CGFloat, ph: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .local)
            .onChanged { v in
                guard state.dock == "none", v.startLocation.y < 48 else { return }
                drag = v.translation
            }
            .onEnded { v in
                guard state.dock == "none", v.startLocation.y < 48 else { drag = .zero; return }
                let o = origin(size, dock: "none", pw: pw, ph: ph)
                let left = min(max(0, o.x + v.translation.width), max(0, size.width - pw))
                let top = min(max(0, o.y + v.translation.height), max(0, size.height - ph))
                drag = .zero
                let snap: CGFloat = 48
                if left < snap { state.dock("left"); ctx.host.refresh(); return }
                if left + pw > size.width - snap { state.dock("right"); ctx.host.refresh(); return }
                if top + ph > size.height - snap { state.dock("bottom"); ctx.host.refresh(); return }
                state.place(x: Double(left), y: Double(top))
            }
    }

    // MARK: signal and presence (6.2, 6.7)

    /// While the panel is shown, the peers' connection statistics are read every few seconds (the signal bars);
    /// the status dots change colour as minutes pass — also with nobody's connection to read.
    private func tick() async {
        var ticks = 0
        try? await Task.sleep(for: .seconds(1))
        while !Task.isCancelled && state.open {
            let shown = state.revealed || !state.autoHide
            if shown { people.core().rooms.active?.refreshStats() }
            ticks += 1
            if shown && ticks % 10 == 0 { clock = EpochMs.now }
            try? await Task.sleep(for: .seconds(3))
        }
    }
}

/// The list of people inside the panel (UserPanel.List): one "users.item" tree per person, at most 360 pt high.
struct UserListView: View {
    let users: [DesignValue]
    @Environment(\.peopleListCap) private var cap
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView(.vertical) {
            VStack(spacing: 0) {
                ForEach(Array(users.enumerated()), id: \.offset) { _, u in
                    DesignTemplateView(screen: "users.item", scope: Scope(["user": u]))
                        .id(Expr.toText(u["id"]))
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(idealHeight: min(contentHeight, cap))
        .frame(maxHeight: cap)
        .accessibilityIdentifier("userList")
    }
}

private struct PeopleListCapKey: EnvironmentKey { static let defaultValue: CGFloat = 360 }

extension EnvironmentValues {
    /// The user list's largest height (360 pt, less in a short panel).
    var peopleListCap: CGFloat {
        get { self[PeopleListCapKey.self] }
        set { self[PeopleListCapKey.self] = newValue }
    }
}

/// Sees every touch in the window and lets it go on (a recognizer on the window that never recognizes and
/// never cancels a touch): the user panel learns about a touch outside it without taking it from the messages.
/// The point is in this view's space (lay it over the panel's area; it takes no touches itself).
struct PeopleTouchObserver: UIViewRepresentable {
    let onTouch: @MainActor (CGPoint) -> Void

    func makeUIView(context: Context) -> ObserverView {
        let v = ObserverView()
        v.backgroundColor = .clear
        v.isUserInteractionEnabled = false
        v.spy.onTouch = onTouch
        return v
    }

    func updateUIView(_ uiView: ObserverView, context: Context) { uiView.spy.onTouch = onTouch }

    static func dismantleUIView(_ uiView: ObserverView, coordinator: ()) { uiView.spy.view?.removeGestureRecognizer(uiView.spy) }

    final class ObserverView: UIView {
        let spy = TouchSpy()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            spy.view?.removeGestureRecognizer(spy)
            spy.anchor = self
            window?.addGestureRecognizer(spy)
        }
    }

    final class TouchSpy: UIGestureRecognizer, UIGestureRecognizerDelegate {
        var onTouch: (@MainActor (CGPoint) -> Void)?
        weak var anchor: UIView?

        init() {
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
            delegate = self
        }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            if let t = touches.first, let anchor { onTouch?(t.location(in: anchor)) }
            state = .failed
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
