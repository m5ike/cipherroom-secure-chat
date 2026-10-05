// ui/parts/MsgBody (6.1, slot "msgBody" in message.in / .out): what the design's
// elements cannot draw — a sealed message and its code, a held ("tap") message, a
// vanishing one and its time, the text with links, mentions and tags, a command's
// outputs, and the attachment. 6.2: a position message is a map (MapBubble; the text
// and the pin when the operator switched maps off or the server cannot be reached);
// an attachment shows a preview — a picture, a voice or audio player, a video played
// in place, the first page of a PDF, the first lines of a text — and under it a
// footer: its type, name and size with save, share and forward. Revealing a held
// message and opening a sealed one are steps of the message's timeline.

import M5Core
import M5Crypto
import M5Design
import M5Proto
import SwiftUI

/// The bubble's content, as wide as the bubble lets it be.
struct MsgBodyView: View {
    let ctx: SlotContext
    @Environment(\.designTextScale) private var textScale
    @State private var mapFailed = false
    @GestureState private var chipPress = false
    @State private var chipFrame: CGRect = .zero

    /// The widest a map or a preview gets: the bubble's content (300 pt less its padding).
    static let maxW: CGFloat = 276
    nonisolated static let space = "m5.msgBody"

    var body: some View {
        if let m = ChatMessageScope.message(ctx.scope) {
            content(m)
                .fixedSize(horizontal: false, vertical: true)
                .coordinateSpace(.named(Self.space))
                // The chip's hold is tracked here, not on the chip: the chip goes while the message shows.
                .simultaneousGesture(DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.space)).updating($chipPress) { v, s, _ in
                    if chipFrame.contains(v.startLocation) { s = true }
                }, including: m.tap ? .all : .subviews)
                .background(GeometryReader { g in
                    Color.clear.preference(key: BubbleFramesKey.self, value: BubbleFrames(body: g.frame(in: .named(BubbleRowView.space))))
                })
                .onChange(of: chipPress) { _, pressed in holdFromChip(m, pressed) }
        }
    }

    // MARK: colours

    private func colors(_ m: ChatMessage) -> (fg: Color, accent: Color) {
        let plain = ctx.context.appearance.bubbles == "minimal"
        // 6.11: a model's answer is drawn as an incoming message even when this device sent it to the room.
        let out = m.mine && BubbleModelFace.of(m) == nil
        let fg = ctx.color(plain ? "@onSurface" : out ? "@onBubbleOut" : "@onBubbleIn", .black)
        return (fg, out ? fg : ctx.color("@primary", .blue))
    }

    // MARK: MsgBody.build

    @ViewBuilder
    private func content(_ m: ChatMessage) -> some View {
        let (fg, accent) = colors(m)
        let state = ChatState.shared
        let holding = state.isHeld(m.id)
        let now = Millis.now
        VStack(alignment: .leading, spacing: 0) {
            if m.vanished {
                BodyNote(text: ctx.t("msg.vanished"), fg: fg, italic: true)
            } else {
                if m.hiddenUntil != 0 && BubbleHides.hidden(m, now) {
                    BodyNote(text: hiddenNote(m), fg: fg, italic: true) // shown only with "show hidden"
                }
                let sealedShut = m.sealed != nil && m.sealPlain == nil
                if sealedShut { SealedBox(message: m, fg: fg, accent: accent, t: ctx.t) }
                if m.sealed != nil && m.mine, let code = m.sealCode { BodyNote(text: ctx.t("msg.yourCode") + ": " + code, fg: fg, italic: false) }
                if m.tap && !holding {
                    holdChip(m, fg: fg, accent: accent)
                }
                if !sealedShut && !(m.tap && !holding) {
                    shown(m, fg: fg, accent: accent)
                }
                if m.tap && holding { BodyNote(text: "👁 " + ctx.t("msg.holding"), fg: fg, italic: false) }
                if m.vanishSeconds > 0 { BodyNote(text: "⏳ \(state.vanishLeft(m)) s", fg: fg, italic: false) }
            }
        }
        .frame(minWidth: isTextAnswer(m) ? 220 : nil, alignment: .leading)
        .padding(.vertical, BubbleModelFace.of(m) != nil && !FnMessageContent.isCall(m) ? 2 : 0)
    }

    /// What is shown when nothing hides it: a command's call or outputs (the Tools part's FnMessageContent — the
    /// call bubble, its status, a wrong call's head, the outputs incl. HTML), a map, the text; then the attachment.
    @ViewBuilder
    private func shown(_ m: ChatMessage, fg: Color, accent: Color) -> some View {
        let map = mapFailed ? nil : MapBubble.policy(for: m)
        let positionMap = map != nil && BubbleKinds.isPositionMessage(m)
        let _ = ChatState.shared.mapGeneration
        if FnMessageContent.handles(m) {
            FnMessageContent(message: m, ink: fg, accent: accent)
        } else if positionMap, let map {
            MapBubbleView(message: m, policy: map, fg: fg, primary: ctx.context.color("@primary", .blue), maxWidth: Self.maxW, t: ctx.t,
                          onTap: { ChatActions.mapPreview(m, host: ctx.host) }, onFail: { mapFailed = true })
        } else if !m.visibleText.isEmpty {
            MessageTextView(text: m.visibleText, fg: fg, accent: accent, size: 15.5 * ctx.context.appearance.fontScale * Double(textScale), host: ctx.host)
        }
        if m.fileName != nil { AttachmentView(message: m, fg: fg, accent: accent, ctx: ctx) }
    }

    private func hiddenNote(_ m: ChatMessage) -> String {
        if m.hiddenUntil == ChatMessage.untilSignIn { return ctx.t("msg.hiddenSignin") }
        return ctx.t("msg.hiddenUntil") + " " + DesignFormats.time(ctx.host.services.lang, m.hiddenUntil)
    }

    // MARK: hold to read (the chip)

    /// A "tap" message: visible only while held (pointer down), like the web's Hold to reveal.
    private func holdChip(_ m: ChatMessage, fg: Color, accent: Color) -> some View {
        BodyChip(text: "👁 " + ctx.t("msg.holdToReveal"), fg: fg, accent: accent)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.space)) } action: { chipFrame = $0 }
            .accessibilityAction(named: Text(verbatim: ctx.t("msg.holdToReveal"))) { holdFromChip(m, true) }
    }

    /// Held from the chip (or the hold area beside the bubble): the first time is its "revealed" step; letting go hides it.
    private func holdFromChip(_ m: ChatMessage, _ on: Bool) {
        ChatBodyHold.hold(m, on)
    }

    // MARK: 6.11 a model's answer fits what it shows

    /// A model's answer drawn as text (FnMessageContent sizes the ones it draws): fitAnswer's comfortable width.
    private func isTextAnswer(_ m: ChatMessage) -> Bool { BubbleModelFace.of(m) != nil && !FnMessageContent.handles(m) }
}

/// Holding a "tap" message (the chip, the hold area): its revealed step the first time, the set of held ones.
@MainActor
enum ChatBodyHold {
    static func hold(_ m: ChatMessage, _ on: Bool) {
        guard m.tap, !m.vanished, m.kind != "sys", m.sealed == nil || m.sealPlain != nil || !on else {
            if !on { ChatState.shared.hold(m.id, false) }
            return
        }
        if on == ChatState.shared.isHeld(m.id) { return }
        ChatState.shared.hold(m.id, on)
        if on, !m.has("revealed"), let room = CoreModels.shared.rooms.room(m.roomKey) ?? CoreModels.shared.rooms.active {
            room.touch(m.id) { $0.mark("revealed") } // the first time it was shown
        }
    }
}

// MARK: - small pieces

/// MsgBody.note: a line in the bubble's colour, a little lighter.
struct BodyNote: View {
    let text: String
    let fg: Color
    let italic: Bool
    @Environment(\.designTextScale) private var scale

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 12.5 * scale).italic(italic))
            .foregroundStyle(fg.opacity(0.75))
            .padding(.vertical, 2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// MsgBody.chip: bold, on a faint pill of the accent with its outline.
struct BodyChip: View {
    let text: String
    let fg: Color
    let accent: Color
    @Environment(\.designTextScale) private var scale

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 13.5 * scale, weight: .bold))
            .foregroundStyle(fg)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Capsule().fill(accent.opacity(0.16)))
            .overlay(Capsule().strokeBorder(accent.opacity(0.5), lineWidth: 1))
            .contentShape(Capsule())
    }
}

/// A sealed message: a code field and Open (PBKDF2 off the main thread).
struct SealedBox: View {
    let message: ChatMessage
    let fg: Color
    let accent: Color
    let t: (String) -> String
    @State private var code = ""
    @State private var opening = false
    @State private var wrong = false
    @Environment(\.designTextScale) private var scale

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BodyNote(text: "🔒 " + t("msg.sealed"), fg: fg, italic: false)
            HStack(spacing: 8) {
                TextField(text: $code, prompt: Text(verbatim: "XXXX-XXXX-XXXX").foregroundStyle(fg.opacity(0.5))) { EmptyView() }
                    .font(.system(size: 14 * scale))
                    .foregroundStyle(fg)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 10).fill(fg.opacity(0.1)))
                    .onSubmit(open)
                Button(action: open) { BodyChip(text: opening ? "…" : t("msg.open"), fg: fg, accent: accent) }
                    .buttonStyle(.plain)
                    .disabled(opening)
            }
            if wrong { BodyNote(text: t("msg.wrongCode"), fg: fg, italic: false) }
        }
    }

    private func open() {
        let c = code
        guard !c.trimmingCharacters(in: .whitespaces).isEmpty, !opening, let meta = message.sealed else { return }
        opening = true
        let text = message.text, id = message.id, key = message.roomKey
        Task {
            let plain = await Task.detached(priority: .userInitiated) { Sealed.open(text, meta: meta, code: c) }.value
            opening = false
            guard let plain else { wrong = true; return }
            wrong = false
            let room = CoreModels.shared.rooms.room(key) ?? CoreModels.shared.rooms.active
            room?.touch(id) { m in
                m.sealPlain = plain
                m.mark("opened")
            }
        }
    }
}

/// The frames of a row's own pieces (the body, the hold area) in the row's space — what the row's sideways drag
/// needs to tell the bubble from what is beside it.
struct BubbleFrames: Equatable {
    var body: CGRect?
    var hold: CGRect?
}

struct BubbleFramesKey: PreferenceKey {
    static let defaultValue = BubbleFrames()
    static func reduce(value: inout BubbleFrames, nextValue: () -> BubbleFrames) {
        let n = nextValue()
        if let b = n.body { value.body = b }
        if let h = n.hold { value.hold = h }
    }
}
