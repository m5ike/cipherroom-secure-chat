// Contract 1 (Renderer/README.md): the app's native parts the design places with
// `slot` elements — the port of android/…/ui/parts/Parts.create(name, bound).
// A part registers a factory under its slot name; the renderer calls it with the
// slot node's scope and a way to run actions. An unregistered slot draws a
// neutral empty space (DEBUG: a thin dashed outline with the slot's name).

import M5Design
import SwiftUI
import os

/// What a slot's part gets: the slot element as the renderer resolved it, its scope
/// (the screen's variables — $room, $msg, $update…), the render context (design,
/// tone, texts, the user's look), the window's size class and the window's host.
@MainActor
struct SlotContext {
    /// The slot's part name (`props.name`): "messages", "composer", "lockPad"…
    let name: String
    /// The slot element (id, layout, box, foreground, scope).
    let node: RenderNode
    /// Design, tone (`context.dark`), texts (`context.translator`), look (`context.look`, `context.appearance`).
    let context: RenderContext
    let horizontalSizeClass: UserInterfaceSizeClass?
    /// The window's host: navigation, sheets, menus, flash, $form, settings, the action runner.
    let host: DesignHost

    /// The element's unique, stable id (use it as an anchor for `host.showMenu(_:anchor:)`).
    var id: String { node.id }
    /// The variables the slot sees.
    var scope: Scope { node.scope }
    /// The colour children of the slot inherit (texts, icons).
    var foreground: Color { node.foreground.color }

    /// A design colour ("@primary", "#rrggbb") in the current tone and look.
    func color(_ token: String, _ fallback: DesignColor = .magenta) -> Color { context.color(token, fallback).color }
    /// A text of the design in the app's language.
    func t(_ key: String) -> String { context.translator.t(key) }

    /// An action of the app's own code (Renderer.Host.action(action, arg, …)): it goes through
    /// ActionGuard like any other; a value without a raw text counts as computed.
    @discardableResult
    func run(_ action: String, _ value: DesignValue? = nil) -> ActionOutcome {
        host.runner.runFromApp(action, value: value, scope: scope, source: ActionSource(id))
    }

    /// A resolved event of the design (a template's click inside the part).
    @discardableResult
    func fire(_ event: RenderEvent) -> ActionOutcome { host.runner.fire(event, source: ActionSource(id)) }
}

/// slot name → the part that draws it. One registry per app (DesignServices), shared by its windows.
@MainActor
final class SlotRegistry {
    typealias Factory = @MainActor (SlotContext) -> AnyView

    /// The slot names of the design format (server/android/design.ts SLOTS, Parts.create).
    static let names = ["splashLogo", "logo", "lockPad", "enrollForm", "joinForm", "roomList", "roomTabs", "messages", "composer",
                        "userPanel", "userList", "callControls", "callVideo", "settingsList", "msgBody", "msgHold", "voicePad",
                        "nfcPanel", "nfcWork", "nfcBuilder", "aiChat", "updateProgress"]

    private var factories: [String: Factory] = [:]
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "slots")

    init(builtIns: Bool = true) {
        if builtIns { RendererParts.register(into: self) }
    }

    /// Registers (or replaces) the part of a slot.
    func register(_ name: String, _ factory: @escaping Factory) { factories[name] = factory }

    func unregister(_ name: String) { factories[name] = nil }

    func has(_ name: String) -> Bool { factories[name] != nil }

    var registered: [String] { factories.keys.sorted() }

    /// The part for a slot element, or the neutral placeholder.
    func view(_ context: SlotContext) -> AnyView {
        if let f = factories[context.name] { return f(context) }
        return AnyView(SlotPlaceholder(name: context.name))
    }
}

/// An unregistered slot: nothing in Release; a thin dashed outline with the name in DEBUG.
struct SlotPlaceholder: View {
    let name: String

    var body: some View {
        #if DEBUG
        ZStack {
            Rectangle()
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .foregroundStyle(Color.gray.opacity(0.7))
            Text(verbatim: name)
                .font(.caption2.monospaced())
                .foregroundStyle(Color.gray)
                .fixedSize()
        }
        .frame(idealWidth: 0, idealHeight: 0)
        .accessibilityHidden(true)
        #else
        Color.clear.frame(idealWidth: 0, idealHeight: 0).accessibilityHidden(true)
        #endif
    }
}
