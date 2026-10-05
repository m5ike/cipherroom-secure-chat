// Parts.forward / forwardSheet / forwardRoom / forwardTo (6.2, 6.10) and
// Parts.pickRecipients (6.1).
//
// Forward (App.tsx:3565): the same text and attachment, "forwarded from", no kinds;
// a sealed one only when opened. In the design's sheet (message.forward,
// $form.forward): what goes, the connected rooms, then everyone there or one person
// (privately) — a file from the vault goes to the whole room (a transfer has no
// private form). One connected room: straight to whom.
//
// message.recipients: who gets the next message (none = everyone), checked in a list.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

@MainActor
enum ChatForward {
    private final class State {
        var message: ChatMessage?
        var room = ""
    }

    private static var states: [ObjectIdentifier: State] = [:]
    private static func state(_ host: DesignHost) -> State {
        if let s = states[ObjectIdentifier(host)] { return s }
        let s = State()
        states[ObjectIdentifier(host)] = s
        return s
    }

    private static var connected: [any RoomModel] { CoreModels.shared.rooms.open.filter(\.connected) }

    /// msg.forward: the sheet (a design without it: the rooms, then the people, as menus at the row).
    static func start(_ m: ChatMessage, host: DesignHost) {
        let rooms = connected
        if rooms.isEmpty { host.flash(title: "", text: host.translator.t("room.offline"), level: .warn); return }
        let s = state(host)
        s.message = m
        s.room = rooms.count == 1 ? rooms[0].key : ""
        if host.design.screen("message.forward") != nil {
            host.form["forward"] = scope(host)
            host.showSheet("message.forward")
            return
        }
        // A bundle from before 6.10: the rooms, then everyone there or one person.
        let entries = rooms.enumerated().map { i, r in
            MenuEntry(id: i, icon: "messages-square", label: r.label) { pickRoom(r.key, host: host, menus: true) }
        }
        host.showMenu(entries, anchor: "msg/" + m.id)
    }

    /// msg.forwardRoom: into this room next (whom); "" back to the rooms.
    static func pickRoom(_ key: String, host: DesignHost, menus: Bool = false) {
        let s = state(host)
        guard let m = s.message else { return }
        let to = key.isEmpty ? nil : CoreModels.shared.rooms.room(key)
        s.room = to?.connected == true ? to!.key : ""
        if menus, let to {
            if to.peers.isEmpty || vaultFile(m) { send(to: nil, host: host); return }
            var entries = [MenuEntry(id: 0, icon: "users", label: host.translator.t("msg.everyone") + " · " + to.label) { send(to: nil, host: host) }]
            for (i, p) in to.peers.enumerated() { entries.append(MenuEntry(id: i + 1, icon: "user", label: p.name) { send(to: p.id, host: host) }) }
            Task { @MainActor in host.showMenu(entries, anchor: "msg/" + m.id) }
            return
        }
        host.form["forward"] = scope(host)
        host.refresh()
    }

    /// msg.forwardTo: send it — to one person of the chosen room privately, or (no id) to everyone there.
    static func send(to peerId: String?, host: DesignHost) {
        let s = state(host)
        let to = s.room.isEmpty ? nil : CoreModels.shared.rooms.room(s.room)
        guard let m = s.message, let to, to.connected else {
            host.closeOverlay()
            host.flash(title: "", text: host.translator.t("room.offline"), level: .warn)
            return
        }
        let id = (peerId ?? "").isEmpty || vaultFile(m) ? nil : peerId
        let name = id.flatMap { to.peerName($0) }
        if id != nil && name == nil { host.form["forward"] = scope(host); host.refresh(); return } // they left meanwhile
        s.message = nil
        s.room = ""
        host.closeOverlay()
        forward(m, to: to, peerId: id, peerName: name)
        host.flash(title: "", text: "✓ " + (name.map { $0 + " · " } ?? "") + to.label, level: .success)
    }

    /// The message again: its text and inline attachment (or the vault file by transfer), "forwarded from", no kinds.
    static func forward(_ m: ChatMessage, to: any RoomModel, peerId: String?, peerName: String?) {
        var o = Outgoing(text: m.visibleText)
        o.forwardedFrom = m.forwardedFrom ?? m.senderName
        if let d = m.fileDataUrl { o.fileName = m.fileName; o.fileMime = m.fileMime; o.dataUrl = d; o.fileSize = m.fileSize; o.fileImage = m.fileImage }
        if let peerId, let peerName { o.recipients.append(peerId); o.recipientNames.append(peerName) }
        if vaultFile(m), let path = m.filePath {
            to.sendFile(vaultId: path, name: m.fileName ?? "file", mime: m.fileMime ?? "application/octet-stream", size: m.fileSize, o)
        } else {
            to.send(o)
        }
    }

    static func vaultFile(_ m: ChatMessage) -> Bool { m.filePath != nil && m.fileDataUrl == nil }

    /// $form.forward: the step, what goes (sender, two lines, its icon), the rooms or the people.
    static func scope(_ host: DesignHost) -> DesignValue {
        let s = state(host)
        guard let m = s.message else { return .object([:]) }
        let t = host.translator
        let rooms = connected
        let to = s.room.isEmpty ? nil : CoreModels.shared.rooms.room(s.room)
        let kind = BubbleReplyQuote.kind(m, nil)
        var text = BubbleReplyQuote.line(m.visibleText)
        if text.isEmpty, let f = m.fileName { text = BubbleReplyQuote.line(f) }
        let active = CoreModels.shared.rooms.activeKey
        let whole = vaultFile(m)
        let people: [DesignValue] = to != nil && !whole ? to!.peers.map { ["id": .string($0.id), "name": .string($0.name)] } : []
        return ["step": .string(to == nil ? "room" : "who"), "canBack": .bool(to != nil && rooms.count > 1),
                "sender": .string(m.mine ? t.t("quote.you") : m.senderName), "text": .string(text), "icon": .string(BubbleReplyQuote.icon(kind)),
                "rooms": .array(rooms.map { ["key": .string($0.key), "name": .string($0.label), "users": .number(Double($0.userCount)), "here": .bool($0.key == active)] }),
                "room": .string(to?.label ?? ""), "people": .array(people), "hasPeople": .bool(!people.isEmpty), "wholeRoom": .bool(whole)]
    }

    // MARK: message.recipients

    /// Who gets the next message (none = everyone): the room's people, checked.
    static func pickRecipients(host: DesignHost) {
        guard let room = CoreModels.shared.rooms.active else { return }
        let composer = CoreModels.shared.composer(for: host)
        let peers = room.peers
        if peers.isEmpty { host.flash(title: "", text: host.translator.t("msg.nobody"), level: .info); return }
        let c = host.renderContext()
        let view = RecipientsSheet(peers: peers, chosen: Set(composer.recipientIds), t: host.translator.t,
                                   fg: c.swiftColor("@onSurface", .black), accent: c.swiftColor("@primary", .blue)) { ids in
            composer.setRecipients(ids)
        }
        let vc = UIHostingController(rootView: view)
        if let sheet = vc.sheetPresentationController { sheet.detents = [.medium(), .large()]; sheet.prefersGrabberVisible = true }
        vc.view.backgroundColor = c.color("@surface", .white).uiColor
        ChatFileActions.present(vc)
    }
}

private struct RecipientsSheet: View {
    let peers: [PeerRef]
    @State var chosen: Set<String>
    let t: (String) -> String
    let fg: Color
    let accent: Color
    let done: ([String]) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: t("msg.recipients")).font(.title3.bold()).foregroundStyle(fg).padding(.bottom, 12)
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    ForEach(peers) { p in
                        Button {
                            if chosen.contains(p.id) { chosen.remove(p.id) } else { chosen.insert(p.id) }
                        } label: {
                            HStack {
                                Text(verbatim: p.name).foregroundStyle(fg)
                                Spacer()
                                Image(systemName: chosen.contains(p.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(accent)
                            }
                            .padding(.vertical, 10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(chosen.contains(p.id) ? .isSelected : [])
                    }
                }
            }
            HStack {
                Button(t("msg.everyone")) { done([]); dismiss() }
                Spacer()
                Button(t("send.done")) { done(peers.map(\.id).filter(chosen.contains)); dismiss() }.buttonStyle(.borderedProminent)
            }
            .tint(accent)
            .padding(.top, 12)
        }
        .padding(20)
    }
}
