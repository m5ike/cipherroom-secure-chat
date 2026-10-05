// The window's root: the design's screen on show (MainActivity's screenBox) with the
// design's screen transition, and the overlay above it — flash messages, a sheet or
// the Tools dock, menus (popovers at their elements), the confirmations ActionGuard
// asks for. Edge to edge (SystemBars): the background under the bars, the content
// inside the safe area and above the keyboard. iOS Back is the left-edge swipe.
// iPad / regular width: Android draws the same single screen on a large display, so
// the screen sits centred at a readable width.

import M5Design
import SwiftUI
import UIKit

struct DesignShell: View {
    @State private var host: DesignHost
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var widthClass
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The widest a screen is drawn (regular width).
    static let readableWidth: CGFloat = 900

    init(host: DesignHost) { _host = State(initialValue: host) }

    var body: some View {
        let ctx = host.renderContext()
        ZStack {
            ctx.swiftColor("@background", .white).ignoresSafeArea()
            ScreenStage()
            FlashLayer()
        }
        .overlayPreferenceValue(DockAnchorKey.self) { anchor in
            GeometryReader { proxy in
                SheetLayer(size: proxy.size, composerTop: anchor.map { proxy[$0].minY })
            }
        }
        .coordinateSpace(.named(DesignShell.space))
        .gesture(EdgeSwipeBack { host.back() })
        .accessibilityAction(.escape) { host.back() }
        .simultaneousGesture(SpatialTapGesture(coordinateSpace: .named(DesignShell.space)).onEnded { v in
            // The dock closes on a tap outside it, and the tap still reaches what it hit.
            if host.sheet != nil, let frame = host.dockFrame, !frame.contains(v.location) { host.dockClosedByTap() }
        })
        .alert(Text(verbatim: host.urlConfirmation?.title ?? ""), isPresented: Binding(get: { host.urlConfirmation != nil }, set: { if !$0 { host.urlConfirmation = nil } }),
               presenting: host.urlConfirmation) { req in
            Button(req.confirm) { host.confirmURL() }
            Button(req.cancel, role: .cancel) { host.urlConfirmation = nil }
        } message: { req in
            Text(verbatim: req.url)
        }
        .alert(Text(verbatim: host.shareConfirmation?.title ?? ""), isPresented: Binding(get: { host.shareConfirmation != nil }, set: { if !$0 { host.shareConfirmation = nil } }),
               presenting: host.shareConfirmation) { req in
            Button(req.confirm) { host.confirmShareRequest() }
            Button(req.cancel, role: .cancel) { host.shareConfirmation = nil }
        } message: { req in
            Text(verbatim: req.shown)
        }
        .environment(host)
        .environment(\.designRenderContext, ctx)
        .environment(\.designTextScale, DesignTextScale.factor(typeSize))
        .tint(ctx.swiftColor("@primary", .blue))
        .preferredColorScheme(host.explicitDark.map { $0 ? .dark : .light })
        .onAppear { sync() }
        .onChange(of: scheme) { _, _ in sync() }
        .onChange(of: reduceMotion) { _, _ in sync() }
        .onChange(of: widthClass) { _, _ in sync() }
    }

    nonisolated static let space = "m5.shell"

    private func sync() {
        if host.explicitDark == nil { host.systemDark = scheme == .dark }
        host.reducedMotion = reduceMotion
        let regular = widthClass == .regular
        if host.regularWidth != regular { host.regularWidth = regular }
    }
}

// MARK: - the screen

/// The screen on show; a new one comes with the design's transition (animations.screen), the old one fades.
private struct ScreenStage: View {
    @Environment(DesignHost.self) private var host
    @Environment(\.horizontalSizeClass) private var widthClass

    var body: some View {
        let router = host.router
        ZStack {
            if !router.screen.isEmpty {
                ScreenView(screen: router.screen)
                    .id(router.generation)
                    .transition(transition)
            }
        }
        .frame(maxWidth: widthClass == .regular ? DesignShell.readableWidth : .infinity, maxHeight: .infinity)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: Bool.self) { $0.size.width > $0.size.height } action: { wide in
            // MainActivity.lockResized: the lock tree may lay out anew.
            if host.wide != wide { host.wide = wide }
        }
        .overlay(alignment: .topLeading) {
            if router.screen == "splash" {
                // The version for UI tests (AppShellTests): not shown, but reachable.
                Color.clear
                    .frame(width: 1, height: 1)
                    .accessibilityElement()
                    .accessibilityLabel(Text(verbatim: "\(AppInfo.version) (\(AppInfo.build))"))
                    .accessibilityIdentifier("app.version")
            }
        }
    }

    /// The new screen enters as the design says (slide-left by default, Renderer.animate), the old one fades away.
    private var transition: AnyTransition {
        let spec = host.design.anim("screen")
        let look = Look(settings: host.settings, reducedMotion: host.reducedMotion)
        let d = 24 * CGFloat(look.travel)
        let insertion: AnyTransition
        switch spec.type ?? "fade" {
        case "none": return .identity
        case "slide-up": insertion = .opacity.combined(with: .offset(y: d))
        case "slide-down": insertion = .opacity.combined(with: .offset(y: -d))
        case "slide-left": insertion = .opacity.combined(with: .offset(x: d))
        case "slide-right": insertion = .opacity.combined(with: .offset(x: -d))
        case "scale": insertion = .opacity.combined(with: .scale(scale: 1 - 0.1 * CGFloat(look.travel)))
        case "pop": insertion = .opacity.combined(with: .scale(scale: max(0.2, 1 - 0.5 * CGFloat(look.travel))))
        default: insertion = .opacity
        }
        return .asymmetric(insertion: insertion, removal: .opacity)
    }
}

/// One screen of the design, resolved against the window's state on every change (cheap; ids are stable).
struct ScreenView: View {
    let screen: String
    @Environment(DesignHost.self) private var host
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let _ = host.revision
        // The first resolve of a screen runs its enter animations (not when the system asks for less motion).
        let animate = host.router.enterPending && !reduceMotion
        let ctx = host.renderContext(animateEnter: animate)
        Group {
            if let node = host.resolve(screen, scope: host.scope(for: screen), context: ctx) {
                let fill = node.box.fill.flatMap { $0.alpha > 0 ? $0 : nil }
                NodeView(node: node)
                    .environment(\.designRenderContext, ctx)
                    // iOS: a screen's own background reaches under the bars (the call screen's dark one left light
                    // strips at the top and bottom), and where the system's bar text would not read on it, the
                    // status bar steps aside.
                    .background { if let fill { fill.color.ignoresSafeArea() } }
                    .statusBarHidden(fill.map { Self.barTextUnreadable(on: $0, dark: host.isDark) } ?? false)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { host.router.enterPending = false }
    }

    /// The status bar's text follows the tone (dark text when light); on a background that wants the other
    /// text colour (a dark call screen in the light tone) it would not read.
    static func barTextUnreadable(on fill: DesignColor, dark: Bool) -> Bool {
        let wantsLightText = Palette.onColor(fill) == .white
        return wantsLightText != dark
    }
}

/// A design template drawn on its own (a list row, a message): what the parts use for "rooms.item",
/// "message.in", "users.item"… — resolved in the scope they give, with the window's look.
struct DesignTemplateView: View {
    let screen: String
    let scope: Scope
    var animateEnter = false
    @Environment(DesignHost.self) private var host

    var body: some View {
        let _ = host.revision
        let ctx = host.renderContext(animateEnter: animateEnter)
        if let node = host.resolve(screen, scope: scope, context: ctx) {
            NodeView(node: node)
                .environment(\.designRenderContext, ctx)
        }
    }
}

// MARK: - flash messages

/// Parts.flash: the design's "flash" screen at the top (its own scope: only $flash), the design's enter
/// animation, gone after its stay or a tap.
private struct FlashLayer: View {
    @Environment(DesignHost.self) private var host
    @Environment(\.horizontalSizeClass) private var widthClass

    var body: some View {
        let spec = host.design.anim("flash")
        let look = Look(settings: host.settings, reducedMotion: host.reducedMotion)
        let d = 24 * CGFloat(look.travel)
        let insertion: AnyTransition = switch spec.type ?? "fade" {
        case "slide-down": .opacity.combined(with: .offset(y: -d))
        case "slide-up": .opacity.combined(with: .offset(y: d))
        case "none": .identity
        default: .opacity
        }
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                ForEach(host.flashes) { item in
                    FlashView(item: item)
                        .transition(.asymmetric(insertion: insertion, removal: .opacity.combined(with: .offset(y: -16))))
                }
            }
            .frame(maxWidth: widthClass == .regular ? DesignShell.readableWidth : .infinity)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct FlashView: View {
    let item: FlashItem
    @Environment(DesignHost.self) private var host

    var body: some View {
        let ctx = host.renderContext()
        let scope = Scope(["flash": ["title": .string(item.title), "text": .string(item.text), "level": .string(item.level.rawValue)]])
        if let node = host.resolve("flash", scope: scope, context: ctx) {
            NodeView(node: node)
                .environment(\.designRenderContext, ctx)
                .fixedSize(horizontal: false, vertical: true)
                .contentShape(Rectangle())
                .onTapGesture { host.dismissFlash(item.id) }
                .accessibilityAddTraits(.isStaticText)
                .accessibilityIdentifier("flash")
        }
    }
}

// MARK: - edge swipe = Back

/// The left-edge pan (UIScreenEdgePanGestureRecognizer): Android's system Back.
struct EdgeSwipeBack: UIGestureRecognizerRepresentable {
    let onBack: @MainActor () -> Void

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let g = UIScreenEdgePanGestureRecognizer()
        g.edges = .left
        return g
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        guard recognizer.state == .ended else { return }
        let t = recognizer.translation(in: recognizer.view)
        let v = recognizer.velocity(in: recognizer.view)
        if t.x > 60 || v.x > 500 { onBack() }
    }
}
