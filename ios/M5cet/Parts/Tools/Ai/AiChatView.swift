// The AI assistant's conversation (6.1, slot "aiChat") — a port of
// android/…/ui/parts/AiChat.java: a scrolling thread of turns and an input
// row. The server-side model streams its answer; each piece lands here as it
// comes. AI is not end-to-end encrypted and the screen says so. The design's
// ai.send / ai.stop / ai.clear reach the same model (AiChatModel).

import M5Core
import M5Design
import Observation
import SwiftUI

/// The input and the actions of the AI chat (ai.send, ai.stop, ai.clear) — one per app.
@MainActor
@Observable
final class AiChatModel {
    var input = ""
    @ObservationIgnored var assistant: () -> AiAssistant
    @ObservationIgnored var bearer: () async -> String
    @ObservationIgnored private weak var loadedFor: AiAssistant?

    init(assistant: @escaping () -> AiAssistant, bearer: @escaping () async -> String) {
        self.assistant = assistant
        self.bearer = bearer
    }

    /// Asks what this user may use (once per assistant — a new server makes a new one).
    func loadIfNeeded() {
        let a = assistant()
        guard loadedFor !== a else { return }
        loadedFor = a
        Task { @MainActor in _ = await a.loadStatus(bearer: await bearer()) }
    }

    /// The status allows a question now (ready, or no-limit).
    static func usable(_ s: AiAssistant.Status?) -> Bool { s?.state == "ready" || s?.state == "no-limit" }

    /// ai.send / the send button.
    func send() {
        let a = assistant()
        guard Self.usable(a.status) else { return }
        let q = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty || a.busy { return }
        if a.model.isEmpty, let d = a.status?.defaultRef, !d.isEmpty { a.model = d }
        Task { @MainActor in
            let b = await bearer()
            if a.send(bearer: b, question: q) { input = "" }
        }
    }

    func stop() { assistant().stop() }

    func clear() { assistant().clear() }

    /// $ai of the "ai" screen.
    var scope: DesignValue {
        let a = assistant()
        return ["state": .string(a.status?.state ?? "loading"), "busy": .bool(a.busy), "model": .string(a.model)]
    }

    /// The banner: what the state means (off, sign in, no model), else that AI is not end-to-end encrypted.
    static func banner(_ s: AiAssistant.Status?, _ t: (String) -> String) -> String {
        switch s?.state {
        case "off": return t("ai.off")
        case "sign-in": return t("ai.signIn")
        case "no-model": return t("ai.noModel")
        default: return t("ai.notE2ee")
        }
    }

    /// A turn's text as drawn: the error, "Thinking…" while nothing came, else the text.
    static func text(_ turn: AiAssistant.Turn, _ t: (String) -> String) -> String {
        if turn.failed { return turn.errorMessage.isEmpty ? t("ai.error") : turn.errorMessage }
        if turn.text.isEmpty && turn.pending { return t("ai.thinking") }
        return turn.text
    }

    /// The line under an answer: stopped, and the model.
    static func meta(_ turn: AiAssistant.Turn, _ t: (String) -> String) -> String? {
        guard !turn.user, turn.stopped || !turn.model.isEmpty else { return nil }
        return (turn.stopped ? t("ai.stopped") + " · " : "") + turn.model
    }
}

struct AiChatView: View {
    let host: DesignHost
    let model: AiChatModel
    /// Links in an answer (the app asks first).
    let openLink: (String) -> Void
    @FocusState private var focused: Bool

    var body: some View {
        let look = ToolsLook(host: host)
        let ai = model.assistant()
        let status = ai.status
        let usable = AiChatModel.usable(status)
        VStack(spacing: 0) {
            Text(verbatim: AiChatModel.banner(status, look.t))
                .toolsFont(12)
                .foregroundStyle(look.color("@muted"))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)
                .accessibilityIdentifier("aiChat.banner")
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: 4) {
                        if status != nil {
                            ForEach(ai.turns) { turn in bubble(turn, look).id(turn.id) }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: ai.revision) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
                .onAppear { proxy.scrollTo("end", anchor: .bottom) }
            }
            HStack(spacing: 6) {
                TextField("", text: Binding(get: { model.input }, set: { model.input = $0 }),
                          prompt: Text(verbatim: look.t("ai.placeholder")).foregroundStyle(look.color("@muted")), axis: .vertical)
                    .lineLimit(1...5)
                    .toolsFont(16)
                    .foregroundStyle(look.color("@onSurface"))
                    .focused($focused)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 20).fill(look.color("@surfaceVariant")))
                    .disabled(!usable)
                    .accessibilityIdentifier("aiChat.input")
                Button { if ai.busy { model.stop() } else { model.send() } } label: {
                    DesignIcon(name: ai.busy ? "pause" : "send-horizontal", size: 24,
                               color: look.color(!model.input.isEmpty || ai.busy ? "@primary" : "@muted"))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .disabled(!(usable || ai.busy))
                .accessibilityLabel(Text(verbatim: look.t(ai.busy ? "ai.stop" : "ai.send")))
                .accessibilityIdentifier("aiChat.send")
            }
            .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 12)
        }
        .onAppear { model.loadIfNeeded() }
    }

    private func bubble(_ turn: AiAssistant.Turn, _ look: ToolsLook) -> some View {
        let bg = look.color(turn.user ? "@bubbleOut" : "@bubbleIn")
        let fg = look.color(turn.user ? "@onBubbleOut" : "@onBubbleIn")
        let text = AiChatModel.text(turn, look.t)
        return HStack {
            if turn.user { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 4) {
                if turn.user {
                    Text(verbatim: text).toolsFont(15).foregroundStyle(fg).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                } else {
                    FnMarkdownView(text: text, look: look, ink: fg, onLink: openLink).textSelection(.enabled)
                }
                if let meta = AiChatModel.meta(turn, look.t) {
                    Text(verbatim: meta).toolsFont(11).foregroundStyle(look.color("@muted"))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(bg))
            if !turn.user { Spacer(minLength: 48) }
        }
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }
}
