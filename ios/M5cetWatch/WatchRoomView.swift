// One room: its newest messages (the Digital Crown scrolls; the newest at the bottom), the replies on their way,
// and the actions — Reply (dictation, Scribble or the keyboard, or a quick reply), Mark read, Open on iPhone.
// Placeholders, never content, for what the iPhone keeps behind a step or does not send (media, positions).

import SwiftUI

struct WatchRoomView: View {
    @Environment(WatchStore.self) private var store
    let roomId: String
    @State private var replying = false

    var body: some View {
        if let room = store.room(roomId) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if let messages = room.messages {
                            if messages.isEmpty && store.pending(in: roomId).isEmpty {
                                hint(store.t("watch.noMessages"))
                            }
                            ForEach(messages) { m in
                                WatchBubble(message: m)
                            }
                        } else {
                            hint(store.t("watch.notOpen"))
                        }
                        ForEach(store.pending(in: roomId)) { p in
                            WatchPendingBubble(reply: p)
                        }
                        if let notice = store.notice {
                            hint(notice)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: room.messages?.last?.id) { _, _ in
                    withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onChange(of: store.pending(in: roomId).count) { _, _ in
                    withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
            .navigationTitle(Text(verbatim: room.name))
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    if room.reply {
                        Button {
                            replying = true
                        } label: {
                            Label(store.t("notify.reply"), systemImage: "mic.fill")
                        }
                    }
                    if room.unread > 0, room.messages?.isEmpty == false {
                        Button {
                            store.markRead(roomId)
                        } label: {
                            Label(store.t("notify.markRead"), systemImage: "checkmark.message")
                        }
                    }
                    Button {
                        store.openOnPhone(roomId)
                    } label: {
                        Label(store.t("watch.open"), systemImage: "iphone")
                    }
                }
            }
            .sheet(isPresented: $replying) {
                WatchReplyView(roomId: roomId)
            }
            .onDisappear { store.notice = nil }
        } else {
            hint(store.t("watch.notOpen"))
        }
    }

    private func hint(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 4)
    }
}

/// One message: text, or a placeholder with a symbol; who and when; my own with its state.
struct WatchBubble: View {
    @Environment(WatchStore.self) private var store
    let message: WatchMessage

    var body: some View {
        if message.kind == WatchKind.sys {
            Text(verbatim: message.text)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .privacySensitive()
        } else {
            HStack(spacing: 0) {
                if message.mine { Spacer(minLength: 14) }
                VStack(alignment: message.mine ? .trailing : .leading, spacing: 2) {
                    if !message.mine && !message.sender.isEmpty {
                        Text(verbatim: message.sender)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tint)
                            .lineLimit(1)
                            .privacySensitive()
                    }
                    if let symbol = WatchBubble.symbol(message.kind) {
                        Label(store.t(WatchBubble.labelKey(message.kind)), systemImage: symbol)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if !message.text.isEmpty {
                        Text(verbatim: message.text)
                            .font(.body)
                            .privacySensitive()
                    }
                    HStack(spacing: 3) {
                        Text(Date(timeIntervalSince1970: Double(message.at) / 1000), format: .dateTime.hour().minute())
                        if message.mine, let tick = WatchBubble.tick(message.status) {
                            Image(systemName: tick).accessibilityLabel(Text(verbatim: message.status))
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(message.mine ? Color.accentColor.opacity(0.32) : Color.gray.opacity(0.22))
                )
                if !message.mine { Spacer(minLength: 14) }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// The symbol of a kind drawn as a placeholder (nil: the text says it).
    static func symbol(_ kind: String) -> String? {
        switch kind {
        case WatchKind.text, WatchKind.note, WatchKind.sys: nil
        case WatchKind.fn: "terminal"
        case WatchKind.image: "photo"
        case WatchKind.audio: "waveform"
        case WatchKind.video: "film"
        case WatchKind.file: "doc"
        case WatchKind.location: "mappin.and.ellipse"
        case WatchKind.sealed: "lock.fill"
        case WatchKind.tap: "hand.tap"
        case WatchKind.vanish: "timer"
        case WatchKind.hidden: "eye.slash"
        case WatchKind.held: "exclamationmark.shield"
        default: "bubble.left" // neutral and kinds this version does not know
        }
    }

    /// The placeholder's words (WatchWire.english keys).
    static func labelKey(_ kind: String) -> String {
        switch kind {
        case WatchKind.fn: "watch.kind.fn"
        case WatchKind.image: "attach.photo"
        case WatchKind.audio: "attach.voice"
        case WatchKind.video: "watch.kind.video"
        case WatchKind.file: "attach.file"
        case WatchKind.location: "attach.position"
        case WatchKind.sealed: "log.kind.sealed"
        case WatchKind.tap: "log.kind.tap"
        case WatchKind.vanish: "log.kind.vanish"
        case WatchKind.hidden: "log.kind.hidden"
        case WatchKind.held: "watch.kind.held"
        default: "notify.message"
        }
    }

    /// My message's state as a tick.
    static func tick(_ status: String) -> String? {
        switch status {
        case "sending", "queued": "clock"
        case "sent", "stored", "forwarded": "checkmark"
        case "delivered": "checkmark.circle"
        case "read": "checkmark.circle.fill"
        default: nil
        }
    }
}

/// A reply on its way (mine, at the bottom) with its state.
struct WatchPendingBubble: View {
    @Environment(WatchStore.self) private var store
    let reply: PendingReply

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 14)
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: reply.text)
                    .font(.body)
                    .privacySensitive()
                Label(state.text, systemImage: state.symbol)
                    .font(.caption2)
                    .foregroundStyle(state.failed ? .red : .secondary)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 1)
            )
        }
        .accessibilityElement(children: .combine)
    }

    private var state: (text: String, symbol: String, failed: Bool) {
        switch reply.state {
        case .sending: (store.t("watch.reply.sending"), "arrow.up.circle", false)
        case .queued: (store.t("watch.reply.queued"), "clock", false)
        case .sent: (store.t("watch.reply.sent"), "checkmark", false)
        case .failed(let reason): (store.failure(reason), "exclamationmark.circle", true)
        }
    }
}

/// Reply: dictation, Scribble or the keyboard (the system's text input), or a quick reply.
struct WatchReplyView: View {
    @Environment(WatchStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let roomId: String

    var body: some View {
        NavigationStack {
            List {
                TextFieldLink(prompt: Text(verbatim: store.t("watch.write"))) {
                    Label(store.t("watch.write"), systemImage: "mic.fill")
                } onSubmit: { text in
                    store.reply(roomId, text)
                    dismiss()
                }
                Section {
                    ForEach(Array(store.quick.enumerated()), id: \.offset) { _, text in
                        Button {
                            store.reply(roomId, text)
                            dismiss()
                        } label: {
                            Text(verbatim: text)
                        }
                    }
                } header: {
                    Text(verbatim: store.t("watch.quick"))
                }
            }
            .navigationTitle(Text(verbatim: store.t("notify.reply")))
        }
    }
}
