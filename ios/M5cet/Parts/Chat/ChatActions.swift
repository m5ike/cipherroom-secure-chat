// What the chat parts do with a message — Android's Parts methods for the list
// (replyTo, copyMessage, forward, quote, filterTag, mapPreview, openMap,
// playSource, openFile, saveFile, shareFile, viewImage) and MessageList.menu /
// a11y. The design's msg.* actions reach the same functions through the router
// (ChatParts.install).

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

@MainActor
enum ChatActions {
    // MARK: what a message allows

    /// Can be answered: a message (not a notice) that is still there.
    static func canReply(_ m: ChatMessage) -> Bool { m.kind != "sys" && !m.vanished }

    /// Can be forwarded: something to send — never a sealed one not opened here (its text is the ciphertext).
    static func canForward(_ m: ChatMessage) -> Bool {
        if !canReply(m) || (m.sealed != nil && m.sealPlain == nil) { return false }
        return !m.visibleText.isEmpty || (m.fileName != nil && (m.fileDataUrl != nil || m.filePath != nil))
    }

    /// The message of the room on screen (Parts.find).
    static func message(_ id: String) -> ChatMessage? { CoreModels.shared.rooms.active?.message(id) }

    // MARK: reply, copy, forward

    /// A reply (the menu, a swipe): the composer quotes the message and gets the keyboard.
    static func reply(_ m: ChatMessage, host: DesignHost) {
        let c = CoreModels.shared.composer(for: host)
        c.setReply(m.id)
        c.focus()
    }

    /// Copy: what the bubble shows (an opened seal's text, not its ciphertext), kept on this device.
    static func copy(_ m: ChatMessage, host: DesignHost) {
        host.copy(m.visibleText)
        host.flash(title: "", text: "✓", level: .success)
    }

    /// Forward: msg.forward — the forward sheet of the design (ChatForward, or the core's when it registers one).
    static func forward(_ m: ChatMessage, host: DesignHost) {
        host.runner.runFromApp("msg.forward", value: .string(m.id))
    }

    // MARK: the long press (MessageList.menu)

    static func menu(_ m: ChatMessage, host: DesignHost, anchor: String) {
        if m.kind == "sys" || m.vanished { return }
        let t = host.translator
        var items = [(String, String, () -> Void)]()
        items.append(("reply", t.t("notify.reply"), { reply(m, host: host) }))
        if !m.visibleText.isEmpty && (m.sealed == nil || m.sealPlain != nil) { items.append(("copy", t.t("msg.copy"), { copy(m, host: host) })) }
        // 6.10: only what can be forwarded (a sealed message not opened here would go out empty).
        if canForward(m) { items.append(("forward", t.t("msg.forward"), { forward(m, host: host) })) }
        // 6.7: the place sheet (map, navigation, a ride).
        if BubbleKinds.position(m) != nil { items.append(("map", t.t("msg.map"), { mapPreview(m, host: host) })) }
        if m.sourceAudio != nil { items.append(("audio-lines", t.t("msg.source"), { playSource(m, host: host) })) }
        if m.fileName != nil && (m.fileDataUrl != nil || m.filePath != nil) {
            items.append(("folder-open", t.t("file.open"), { openFile(m, host: host) }))
            items.append(("download", t.t("file.save"), { saveFile(m, host: host) }))
            items.append(("share-2", t.t("file.share"), { shareFile(m, host: host) }))
        }
        if !m.visibleText.isEmpty && m.sealed == nil { items.append(("volume-2", t.t("msg.speak"), { ChatVoiceHub.say(m.visibleText) })) }
        items.append(("info", t.t("msg.info"), { host.runner.runFromApp("msg.info", value: .string(m.id)) }))
        host.showMenu(items.enumerated().map { i, it in MenuEntry(id: i, icon: it.0, label: it.1) { it.2() } }, anchor: anchor)
    }

    /// What VoiceOver offers on a row: the swipe's actions and the taps' (the original, the sender's profile).
    static func a11y(_ m: ChatMessage, host: DesignHost) -> [BubbleRowAction] {
        let t = host.translator
        var out = [BubbleRowAction]()
        if canReply(m) { out.append(BubbleRowAction(label: t.t("notify.reply")) { reply(m, host: host) }) }
        if canForward(m) { out.append(BubbleRowAction(label: t.t("msg.forward")) { forward(m, host: host) }) }
        if let q = m.replyToId, !q.isEmpty { out.append(BubbleRowAction(label: t.t("quote.go")) { quote(q, host: host) }) }
        if let model = BubbleModelFace.of(m) {
            out.append(BubbleRowAction(label: t.t("fnm.about") + ": " + model.name) { host.runner.runFromApp("msg.sender", value: .string(m.id)) })
        } else if !m.mine && m.kind != "sys" {
            out.append(BubbleRowAction(label: t.t("sender.profile") + ": " + Names.normalize(m.senderName)) { host.runner.runFromApp("msg.sender", value: .string(m.id)) })
        }
        return out
    }

    // MARK: the list (one window's)

    enum Jump { case shown, hidden, missing }

    /// msg.quote: the list goes to the message a reply quotes and flashes it — or says why it cannot.
    static func quote(_ originalId: String, host: DesignHost) {
        switch jump(originalId, host: host) {
        case .shown: break
        case .hidden: host.flash(title: "", text: host.translator.t("quote.hidden"), level: .info)
        case .missing: host.flash(title: "", text: host.translator.t("quote.notLoaded"), level: .info)
        }
    }

    /// Where a quote's original is: on screen now, hidden here, or not in this device's history (MessageList.jumpTo).
    static func jump(_ id: String, host: DesignHost) -> Jump {
        let win = ChatState.shared.window(host)
        let now = Millis.now
        guard !id.isEmpty, let room = CoreModels.shared.rooms.active, let o = room.message(id), !o.deleted, !o.expired(now) else { return .missing }
        if !win.tag.isEmpty && !MessagesPart.matches(o, win.tag) { win.tag = "" }
        let list = MessagesPart.filter(room.messages, tag: win.tag, peek: win.peek, now: now)
        guard list.items.contains(where: { $0.id == id }) else { return list.hidden.contains(id) ? .hidden : .missing }
        win.flashId = id
        win.scrollTarget = id
        return .shown
    }

    /// 6.8 (History, a notification): scrolls to a message of this room, when it is in its list (and flashes it).
    @discardableResult
    static func reveal(_ id: String, host: DesignHost) -> Bool {
        let win = ChatState.shared.window(host)
        if !win.tag.isEmpty { win.tag = "" }
        guard let room = CoreModels.shared.rooms.active,
              MessagesPart.filter(room.messages, tag: "", peek: win.peek, now: Millis.now).items.contains(where: { $0.id == id }) else { return false }
        win.flashId = id
        win.scrollTarget = id
        return true
    }

    /// A #tag's tap: only the messages with it ("" = all again).
    static func filter(_ tag: String, host: DesignHost) {
        let win = ChatState.shared.window(host)
        win.tag = tag
        if let last = CoreModels.shared.rooms.active?.messages.last?.id { win.scrollTarget = last }
    }

    /// msg.showHidden — "Hidden (n)": the hidden messages in their places for now (dimmed), or out of the list again.
    static func toggleHidden(host: DesignHost) {
        let win = ChatState.shared.window(host)
        win.peek = !win.peek && !win.hiddenIds.isEmpty
    }

    // MARK: places

    /// msg.mapPreview / the map's tap / the menu: the place sheet (map, coordinates, Navigate, Ride, Copy).
    static func mapPreview(_ m: ChatMessage, host: DesignHost) { PlaceSheet.show(m, host: host) }

    /// msg.map: the point in Apple Maps — after the confirmation every address of the app gets (the whole of it shown).
    static func openMap(_ m: ChatMessage, host: DesignHost) {
        guard let pos = BubbleKinds.position(m) else { return }
        let url = Where.appleMapsPinWeb(pos.chatDouble("lat"), pos.chatDouble("lon"), m.mine ? "" : m.senderName)
        if let u = URL(string: url) { ChatLinks.confirm(u, host: host) }
    }

    // MARK: media and files

    /// msg.source: the recording a call transcript came from (a player that starts at once).
    static func playSource(_ m: ChatMessage, host: DesignHost) {
        guard let src = m.sourceAudio else { return }
        let c = host.renderContext()
        let view = SourcePlayer(title: host.translator.t("msg.source"), close: host.translator.t("nav.close"), vaultId: src,
                                fg: c.swiftColor("@onSurface", .black), accent: c.swiftColor("@primary", .blue), surface: c.swiftColor("@surface", .white),
                                t: host.translator.t)
        let vc = UIHostingController(rootView: view)
        if let sheet = vc.sheetPresentationController { sheet.detents = [.medium()]; sheet.prefersGrabberVisible = true }
        vc.view.backgroundColor = c.color("@surface", .white).uiColor
        ChatFileActions.present(vc)
    }

    static func openFile(_ m: ChatMessage, host: DesignHost) { ChatFileActions.open(m, host: host) }
    static func saveFile(_ m: ChatMessage, host: DesignHost) { ChatFileActions.save(m, host: host) }
    static func shareFile(_ m: ChatMessage, host: DesignHost) { ChatFileActions.share(m, host: host) }
    static func viewImage(_ m: ChatMessage, host: DesignHost) { ChatFileActions.viewImage(m, host: host) }
}

/// The transcript's recording in a small sheet (Parts.playSource's dialog).
private struct SourcePlayer: View {
    let title: String
    let close: String
    let vaultId: String
    let fg: Color
    let accent: Color
    let surface: Color
    let t: (String) -> String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(verbatim: title).font(.title3.bold()).foregroundStyle(fg)
            ChatAudioBar(id: vaultId + "-src", source: ChatMediaSource { (try ChatVaultMedia.data(vaultId: vaultId), "audio/mp4", "source.m4a") }, fg: fg, accent: accent, t: t, autoplay: true)
            HStack { Spacer(); Button(close) { dismiss() }.tint(accent) }
        }
        .padding(20)
        .background(surface)
    }
}

/// Whether the app's icon set has a Lucide icon (ui/Icons.has: the set is the builders', not all of Lucide).
@MainActor
enum ChatIcons {
    static func has(_ name: String) -> Bool { DesignAssets.icons.has(name) }
}
