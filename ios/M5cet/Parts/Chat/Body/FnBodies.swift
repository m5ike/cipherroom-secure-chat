// MsgBody's command parts (6.5 / 6.11): a command's own bubble — the query, then
// the loading indicator (with what the model says it is doing, and how far) /
// the status chip; and a command's outputs (Parts.fnOutputs → fn/FnView).
//
// The outputs' renderer (buttons, forms, tables, media, FnHtml in a locked
// WKWebView) is the tools agent's Parts/Fn: it plugs in here as
// `ChatFnOutputs.renderer`. Until it does, the outputs are shown as their Markdown
// text (Outputs.toMarkdown — what the web sends as the message's text).

import M5Core
import M5Design
import M5Proto
import SwiftUI

/// The tools agent's FnView: a command's outputs in a bubble.
@MainActor
protocol ChatFnOutputsRenderer: AnyObject {
    /// The outputs of `message` (meta = its fnDraw: outputs, keyword, model…) drawn in the bubble's colour.
    func view(message: ChatMessage, outputs: [JSON], meta: JSONObject, fg: Color, ctx: SlotContext) -> AnyView
}

@MainActor
enum ChatFnOutputs {
    /// Set by Parts/Fn (tools agent); nil = the Markdown fallback.
    static var renderer: (any ChatFnOutputsRenderer)?

    static func view(_ m: ChatMessage, _ meta: JSONObject, fg: Color, ctx: SlotContext) -> AnyView {
        let outputs = meta.array("outputs") ?? []
        if outputs.isEmpty {
            return AnyView(Text(verbatim: m.visibleText).font(.system(size: 15)).foregroundStyle(fg).fixedSize(horizontal: false, vertical: true))
        }
        if let renderer { return renderer.view(message: m, outputs: outputs, meta: meta, fg: fg, ctx: ctx) }
        let md = Outputs.toMarkdown(outputs)
        let text = (try? AttributedString(markdown: md, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(md)
        return AnyView(Text(text).font(.system(size: 15)).foregroundStyle(fg).tint(ctx.color("@primary", .blue)).fixedSize(horizontal: false, vertical: true))
    }
}

/// The call's own bubble: the query, then loading / status. A bubble from before a restart that still loads is over after 5 minutes.
struct FnCallView: View {
    let message: ChatMessage
    let fd: JSONObject
    let fg: Color
    let accent: Color
    let ctx: SlotContext
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let query = fd.optString("query")
        let pending = fd.bool("pending") == true && Millis.now - message.createdAt < 300_000
        VStack(alignment: .leading, spacing: 0) {
            if !query.isEmpty {
                MessageTextView(text: query, fg: fg, accent: accent, size: 15.5 * ctx.context.appearance.fontScale * Double(scale), host: ctx.host)
            }
            if pending {
                VStack(spacing: 0) {
                    LoadingDots(color: fg)
                    let progress = fd.object("progress")
                    let p = progress?.double("p") ?? -1
                    if p > 0 && p <= 1 {
                        ProgressView(value: (p * 1000).rounded() / 1000)
                            .tint(fg)
                            .frame(width: 160)
                            .padding(.top, 4)
                            .accessibilityLabel(Text(verbatim: "\(Int((p * 100).rounded())) %"))
                    }
                    let said = (progress?.optString("text") ?? "").trimmingCharacters(in: .whitespaces)
                    Text(verbatim: !said.isEmpty ? said : ctx.t("functions.running").replacingOccurrences(of: "{name}", with: fd.optString("name")))
                        .font(.system(size: 12 * scale))
                        .foregroundStyle(fg.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.top, 3)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 6).padding(.bottom, 2)
                .modifier(Pulse())
            } else if let status = fd.object("status") {
                StatusChip(status: status, fg: fg, accent: accent, danger: ctx.color("@danger", DesignColor(argb: 0xFFCC_3333)), t: ctx.t)
            } else {
                ChatFnOutputs.view(message, fd, fg: fg, ctx: ctx) // settled with the caller-only result (a bubble from before 6.11)
            }
        }
    }
}

/// 6.11: the command's end — an icon and a word: answered below, sent to the room, an error, cancelled.
struct StatusChip: View {
    let status: JSONObject
    let fg: Color
    let accent: Color
    let danger: Color
    let t: (String) -> String
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let kind = status.optString("kind", "info")
        let code = status.optString("code")
        let col = kind == "error" ? danger : kind == "ok" ? accent : fg.opacity(0.75)
        let icon = kind == "error" ? (code == "timeout" ? "clock" : "circle-alert") : kind == "ok" ? (code == "sent" ? "users" : "circle-check")
            : code == "cancelled" ? "circle-x" : "info"
        var label = status.optString("label")
        if label.isEmpty && !code.isEmpty { label = t("fnm." + code) }
        return HStack(spacing: 6) {
            DesignIcon(name: icon, size: 16, color: col).accessibilityHidden(true)
            Text(verbatim: label).font(.system(size: 13 * scale)).foregroundStyle(col)
        }
        .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 4)
        .background(Capsule().fill(col.opacity(0.12)))
        .padding(.top, 4).padding(.bottom, 1)
        .accessibilityElement(children: .combine)
    }
}

/// Three dots that bounce in turn — a self-contained loading indicator (still when motion is off).
struct LoadingDots: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        TimelineView(.animation(paused: reduce)) { ctx in
            let phase = reduce ? 0 : ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 2 * .pi
            Canvas { g, size in
                let r: CGFloat = 3, gap: CGFloat = 8, amp: CGFloat = 3.2
                for i in 0..<3 {
                    let off = max(0, sin(phase - Double(i) * 0.6))
                    let x = size.width / 2 + CGFloat(i - 1) * gap, y = size.height / 2 - CGFloat(off) * amp
                    g.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .color(color.opacity(0.45 + 0.55 * off)))
                }
            }
        }
        .frame(width: 28, height: 14)
        .accessibilityHidden(true)
    }
}

/// The bubble pulses while a call runs (here: its content).
private struct Pulse: ViewModifier {
    @State private var dim = false
    @Environment(\.accessibilityReduceMotion) private var reduce

    func body(content: Content) -> some View {
        content
            .opacity(dim ? 0.82 : 1)
            .onAppear {
                guard !reduce else { return }
                withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}
