// The core's parts in the design's slots (android ui/parts: LockPad, Forms.Enroll,
// Forms.Join, RoomList, RoomTabs, CallParts.Controls / Video): the lock's pad
// (the design draws the lock screen around it — header, step, errors from
// $lock), the enrolment and join forms, the saved rooms (each the design's
// "rooms.item" template), the connected rooms' tabs, and the call's controls
// and video from Platform/Calls' Parts.

import M5Core
import M5Design
import M5Net
import SwiftUI

@MainActor
enum CoreSlots {
    static func register(into registry: SlotRegistry, core: AppCore, state: AppScreenState, actions: CoreActions) {
        registry.register("lockPad") { ctx in AnyView(LockPadPart(ctx: ctx, state: state, core: core)) }
        registry.register("enrollForm") { ctx in AnyView(EnrollFormPart(ctx: ctx, core: core, state: state)) }
        registry.register("joinForm") { ctx in AnyView(JoinFormPart(ctx: ctx, core: core, state: state, actions: actions)) }
        registry.register("roomList") { ctx in AnyView(RoomListPart(ctx: ctx, rooms: core.rooms)) }
        registry.register("roomTabs") { ctx in AnyView(RoomTabsPart(ctx: ctx, rooms: core.rooms, actions: actions)) }
        registry.register("callControls") { ctx in AnyView(CallControlsPart(ctx: ctx, rooms: core.rooms)) }
        registry.register("callVideo") { ctx in AnyView(CallVideoPart(ctx: ctx, rooms: core.rooms)) }
    }
}

// MARK: - the forms' look (Forms.field / Forms.button)

private struct FormField: View {
    let ctx: SlotContext
    let hint: String
    @Binding var text: String
    var secure = false
    var url = false
    var caps = false

    var body: some View {
        Group {
            if secure {
                SecureField("", text: $text, prompt: Text(hint).foregroundStyle(ctx.color("@muted")))
            } else {
                TextField("", text: $text, prompt: Text(hint).foregroundStyle(ctx.color("@muted")))
                    .keyboardType(url ? .URL : .default)
                    .textInputAutocapitalization(url ? .never : caps ? .characters : .words)
            }
        }
        .autocorrectionDisabled()
        .font(.system(size: 16))
        .foregroundStyle(ctx.color("@onSurface"))
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 14).fill(ctx.color("@surfaceVariant")))
        .accessibilityLabel(hint)
    }
}

private struct FormButton: View {
    let ctx: SlotContext
    let title: String
    var icon: String?
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if busy { ProgressView().tint(ctx.color("@onPrimary")) } else if let icon { DesignIcon(name: icon, size: 20, color: ctx.color("@onPrimary")) }
                Text(title).font(.system(size: 16, weight: .semibold))
            }
            .foregroundStyle(ctx.color("@onPrimary"))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Capsule().fill(ctx.color("@primary")))
            .opacity(busy ? 0.6 : 1)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

// MARK: - enrolment (Forms.Enroll)

private struct EnrollFormPart: View {
    let ctx: SlotContext
    let core: AppCore
    let state: AppScreenState
    @State private var server = ""
    @State private var code = ""
    @State private var name = UIDevice.current.name
    @State private var busy = false
    @State private var applied: Double = -1
    @FocusState private var codeFocused: Bool

    private var form: [String: DesignValue] { ctx.host.form }
    private var pinKid: String { (form["kid"]?.stringValue ?? "").trimmingCharacters(in: .whitespaces) }

    var body: some View {
        VStack(spacing: 10) {
            FormField(ctx: ctx, hint: ctx.t("enroll.server"), text: $server, url: true)
                .accessibilityIdentifier("enroll.server")
            if !pinKid.isEmpty { pinLine }
            FormField(ctx: ctx, hint: ctx.t("enroll.code"), text: $code, caps: true)
                .focused($codeFocused)
                .accessibilityIdentifier("enroll.code")
            FormField(ctx: ctx, hint: ctx.t("enroll.name"), text: $name)
                .accessibilityIdentifier("enroll.name")
            FormButton(ctx: ctx, title: ctx.t("enroll.submit"), busy: busy) { submit() }
                .padding(.top, 8)
                .accessibilityIdentifier("enroll.submit")
        }
        .onAppear { prefill(force: true) }
        .onChange(of: ctx.host.revision) { prefill(force: false) }
    }

    /// "Server key from the QR code: …", and a warning once the address is another server.
    private var pinLine: some View {
        let linkServer = form["enrollLinkServer"]?.stringValue ?? ""
        let same = linkServer.isEmpty || EnrollLink.sameHost(server, linkServer)
        let c = same ? ctx.color("@muted") : ctx.color("@danger")
        return HStack(alignment: .top, spacing: 8) {
            DesignIcon(name: same ? "shield-check" : "shield-alert", size: 18, color: same ? ctx.color("@success") : c)
            Text(ctx.t("enroll.qrKid") + ": " + pinKid + (same ? "" : "\n" + ctx.t("enroll.qrMismatch").replacingOccurrences(of: "{server}", with: linkServer)))
                .font(.system(size: 13)).foregroundStyle(c)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    /// A newer link (its prefill number) replaces the server and the code; otherwise what was typed stays.
    private func prefill(force: Bool) {
        let seq = form["enrollPrefill"]?.numberValue ?? 0
        if force && applied < 0 {
            server = form["server"]?.stringValue ?? CoreConfig.defaultServer
            code = form["code"]?.stringValue ?? ""
            applied = seq
            if seq > 0 && code.isEmpty { codeFocused = true }
            return
        }
        guard seq > applied else { return }
        applied = seq
        server = form["server"]?.stringValue ?? server
        code = form["code"]?.stringValue ?? ""
        if code.isEmpty { codeFocused = true }
    }

    private func submit() {
        guard !busy else { return }
        busy = true
        let base = EnrollLink.server(server) ?? server
        Task { @MainActor in
            defer { busy = false }
            do {
                try await core.device.enroll(server: base, code: code.trimmingCharacters(in: .whitespaces), name: name.trimmingCharacters(in: .whitespaces), pinKid: pinKid)
                state.enrollError = ""
                ctx.host.form["enrollError"] = nil
                await core.start()
                ctx.host.route()
            } catch {
                state.enrollError = ctx.t("enroll.failed") + ": " + Self.message(error)
                ctx.host.refresh()
            }
        }
    }

    static func message(_ e: any Error) -> String {
        if let h = e as? HTTPError, !h.message.isEmpty { return h.message }
        return (e as CustomStringConvertible).description
    }
}

// MARK: - join (Forms.Join; the edit sheet with roomEdit)

private struct JoinFormPart: View {
    let ctx: SlotContext
    let core: AppCore
    let state: AppScreenState
    let actions: CoreActions
    @State private var name = ""
    @State private var room = ""
    @State private var pass = ""
    @State private var editKey: String?
    @State private var started = false

    var body: some View {
        VStack(spacing: 10) {
            FormField(ctx: ctx, hint: ctx.t("join.name"), text: $name).accessibilityIdentifier("join.name")
            FormField(ctx: ctx, hint: ctx.t("join.room"), text: $room).accessibilityIdentifier("join.room")
            FormField(ctx: ctx, hint: ctx.t("join.passphrase"), text: $pass, secure: true)
                .onSubmit { go() }
                .accessibilityIdentifier("join.passphrase")
            FormButton(ctx: ctx, title: editKey == nil ? ctx.t("join.submit") : ctx.t("room.edit.save"), icon: editKey == nil ? "log-in" : "save") { go() }
                .padding(.top, 8)
                .accessibilityIdentifier("join.submit")
        }
        .onAppear {
            guard !started else { return }
            started = true
            // A saved room's Edit fills the form with it (taken once).
            if let k = ctx.host.form["roomEdit"]?.stringValue, let s = core.rooms.saved(k) {
                ctx.host.form["roomEdit"] = nil
                editKey = k
                name = s.userName
                room = s.label
                pass = s.passphrase
            } else {
                name = core.profiles.flatMap { _ in nil } ?? core.userName
            }
        }
    }

    private func go() {
        if let k = editKey { actions.saveEdit(key: k, room: room, passphrase: pass, name: name, ctx.host) }
        else { actions.finishJoin(room: room, passphrase: pass, name: name, ctx.host) }
    }
}

// MARK: - the saved rooms (RoomList)

private struct RoomListPart: View {
    let ctx: SlotContext
    let rooms: RoomsController

    var body: some View {
        let items = rooms.items
        ZStack {
            if items.isEmpty {
                Text(ctx.t("rooms.empty"))
                    .font(.system(size: 15)).foregroundStyle(ctx.color("@muted"))
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("rooms.empty")
            } else {
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            DesignTemplateView(screen: "rooms.item", scope: Scope(["room": item.scope]))
                                .id(item.key)
                        }
                    }
                }
                .accessibilityIdentifier("rooms.list")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - the connected rooms' tabs (RoomTabs)

private struct RoomTabsPart: View {
    let ctx: SlotContext
    let rooms: RoomsController
    let actions: CoreActions

    var body: some View {
        let _ = rooms.revision
        let open = rooms.connectedSessions
        let primary = ctx.color("@primary")
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(open, id: \.key) { r in
                    let on = r.key == rooms.activeKey
                    let badge = r.unread > 0 ? "  " + (r.unread > 99 ? "99+" : String(r.unread)) : ""
                    Button { actions.goRoom(r.key, ctx.host) } label: {
                        Text(r.label + badge)
                            .font(.system(size: 13, weight: on || r.unread > 0 ? .semibold : .regular))
                            .foregroundStyle(on ? primary : ctx.color("@onSurface"))
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Capsule().fill(on ? primary.opacity(0.14) : Color.clear))
                            .overlay(Capsule().strokeBorder(on ? primary : ctx.color("@border"), lineWidth: 1))
                            .opacity(r.connected ? 1 : 0.55)
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(LongPressGesture().onEnded { _ in rooms.leave(r.key) })
                    .accessibilityIdentifier("room.tab." + r.key)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .frame(idealHeight: 44)
    }
}

// MARK: - calls (CallParts.Controls / Video)

private struct CallControlsPart: View {
    let ctx: SlotContext
    let rooms: RoomsController

    var body: some View {
        if let key = rooms.activeController?.key, let rtc = CallSystem.shared.room(key) {
            CallControls(room: rtc, regular: ctx.horizontalSizeClass == .regular)
                .frame(idealHeight: 88)
        } else {
            Color.clear.frame(idealHeight: 0)
        }
    }
}

private struct CallVideoPart: View {
    let ctx: SlotContext
    let rooms: RoomsController

    var body: some View {
        if let key = rooms.activeController?.key, let rtc = CallSystem.shared.room(key) {
            CallParticipantsGrid(room: rtc, regular: ctx.horizontalSizeClass == .regular)
        } else {
            Color.clear
        }
    }
}
