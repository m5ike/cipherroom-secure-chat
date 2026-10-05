// What a chat bubble draws for the functions — the fn parts of
// android/…/ui/parts/MsgBody.java (fnCall, statusChip, problemHead,
// fitAnswer) and Parts.fnOutputs: a command's own bubble (its query, then the
// loading with what the model says it is doing and how far, then a status chip:
// answered below, sent to the room, an error, cancelled) and a model's answer
// (its outputs, a wrong call's card with its title in the danger colour).
//
// For the chat part (msgBody): `if FnMessageContent.handles(m) { FnMessageContent(message: m, ink: fg, accent: a) }`.
// It needs the window's DesignHost in the environment (the renderer puts it there).

import M5Core
import M5Design
import M5Proto
import SwiftUI

struct FnMessageContent: View {
    let message: ChatMessage
    /// The bubble's text colour.
    var ink: Color?
    /// Links and an "ok" chip (the bubble's accent).
    var accent: Color?

    @Environment(DesignHost.self) private var host

    /// The message is a command's call or carries a model's outputs (else the bubble draws its text).
    static func handles(_ m: ChatMessage) -> Bool { isCall(m) || !(m.fnDraw?.array("outputs") ?? []).isEmpty }

    /// A command's own bubble: its query, loading or status.
    static func isCall(_ m: ChatMessage) -> Bool {
        guard let fd = m.fnDraw else { return false }
        return fd.has("query") || fd["pending"] == .bool(true) || fd.object("status") != nil
    }

    /// 6.11: a model's answer needs the row's width for a table, code, JSON, a form, a page, a picture, a video (fitAnswer).
    static func wide(_ m: ChatMessage) -> Bool {
        (m.fnDraw?.array("outputs") ?? []).contains { o in
            ["table", "code", "json", "form", "html", "image", "video"].contains(o.objectValue?.optString("type") ?? "")
        }
    }

    /// A bubble that still loads after this long (a restart in between) is over.
    static let staleMs: Int64 = 300_000

    var body: some View {
        let look = ToolsLook(host: host)
        let fg = ink ?? look.color("@onSurface")
        let fd = message.fnDraw ?? JSONObject()
        let model = FnModelFace.of(message) != nil
        VStack(alignment: .leading, spacing: 0) {
            if Self.isCall(message) {
                FnCallView(message: message, fd: fd, ink: fg, accent: accent ?? look.color("@primary"), look: look)
            } else {
                if model && fd["problem"] == .bool(true) { problemHead(fd, look) }
                if let engine = ToolParts.engine {
                    FnOutputsView(key: message.id, outputs: fd.array("outputs") ?? [], meta: fd, createdAt: message.createdAt, ink: fg,
                                  host: engine.outputsHost(host), look: look)
                }
            }
        }
        // fitAnswer: at least a comfortable width; what needs room (a page, a table, a form…) up to Android's 560 dp
        // (a little more for iPad's readable width) — never the whole width of a wide window.
        .frame(minWidth: model && !Self.isCall(message) ? (Self.wide(message) ? 280 : 220) : nil,
               maxWidth: model && Self.wide(message) ? 640 : nil, alignment: .leading)
    }

    /// 6.11: a wrong call's answer starts with what it is about, in the danger colour.
    private func problemHead(_ fd: JSONObject, _ look: ToolsLook) -> some View {
        HStack(spacing: 8) {
            DesignIcon(name: "circle-alert", size: 18, color: look.color("@danger"))
            Text(verbatim: fd.optString("title")).toolsFont(14.5, weight: .bold).foregroundStyle(look.color("@danger"))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.top, 2).padding(.bottom, 6)
    }
}

/// The call's own bubble: the query, then the loading indicator (with what the model says it is doing, and how
/// far) / the status. The run's clock (30 s) settles it; a bubble from before a restart that still loads is over
/// after 5 minutes.
struct FnCallView: View {
    let message: ChatMessage
    let fd: JSONObject
    let ink: Color
    let accent: Color
    let look: ToolsLook

    /// The progress as RoomSession writes it ({p, text}) — or the preview core's flat progress / progressText.
    static func progress(_ fd: JSONObject) -> (p: Double, text: String) {
        if let o = fd.object("progress") { return (o.double("p") ?? -1, Js.trim(o.optString("text"))) }
        if let p = fd.double("progress") { return (p, Js.trim(fd.optString("progressText"))) }
        return (-1, "")
    }

    var body: some View {
        let query = fd.optString("query")
        let pending = fd["pending"] == .bool(true) && Millis.now - message.createdAt < FnMessageContent.staleMs
        // One column as wide as the wider of the query and the loading; the loading centred in it (as Android's).
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            if !query.isEmpty {
                GridRow {
                    Text(verbatim: query).toolsFont(15.5).foregroundStyle(ink).fixedSize(horizontal: false, vertical: true)
                }
            }
            if pending {
                let pr = Self.progress(fd)
                GridRow {
                    VStack(spacing: 3) {
                        FnDots(color: ink)
                        if pr.p > 0 && pr.p <= 1 {
                            ProgressView(value: pr.p)
                                .progressViewStyle(.linear)
                                .tint(ink)
                                .frame(width: 160)
                                .accessibilityValue(Text(verbatim: "\(Int((pr.p * 100).rounded())) %"))
                        }
                        Text(verbatim: !pr.text.isEmpty ? pr.text : look.t("functions.running").replacingOccurrences(of: "{name}", with: fd.optString("name")))
                            .toolsFont(12)
                            .foregroundStyle(ink.opacity(0.7))
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    .padding(.top, 6).padding(.bottom, 2)
                    .gridCellAnchor(.center)
                    .modifier(FnPulse())
                }
            } else if let status = fd.object("status") {
                GridRow { statusChip(status).padding(.top, 4).padding(.bottom, 1) }
            }
        }
    }

    /// 6.11: the command's end — an icon and a word: answered below, sent to the room, an error (the timeout, a wrong call…), cancelled.
    private func statusChip(_ status: JSONObject) -> some View {
        let kind = status.optString("kind", "info"), code = status.optString("code")
        let col = kind == "error" ? look.color("@danger") : kind == "ok" ? accent : ink.opacity(0.75)
        let icon = kind == "error" ? (code == "timeout" ? "clock" : "circle-alert") : kind == "ok" ? (code == "sent" ? "users" : "circle-check")
            : code == "cancelled" ? "circle-x" : "info"
        var label = status.optString("label")
        if label.isEmpty && !code.isEmpty { label = look.t("fnm." + code) }
        return HStack(spacing: 6) {
            DesignIcon(name: icon, size: 16, color: col)
            Text(verbatim: label).toolsFont(13).foregroundStyle(col)
        }
        .padding(.leading, 8).padding(.trailing, 10).padding(.vertical, 4)
        .background(Capsule().fill(col.opacity(0.12)))
        .accessibilityElement(children: .combine)
    }
}

/// Three dots that bounce in turn — a self-contained loading indicator (MsgBody.DotsView).
struct FnDots: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        TimelineView(.animation(paused: still)) { ctx in
            let phase = still ? 0 : ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 2 * .pi
            Canvas { g, size in
                let r: CGFloat = 3, gap: CGFloat = 8, cy = size.height / 2, amp: CGFloat = 3.2, mid = size.width / 2
                for i in 0..<3 {
                    let off = max(0, sin(phase - Double(i) * 0.6))
                    let rect = CGRect(x: mid + CGFloat(i - 1) * gap - r, y: cy - CGFloat(off) * amp - r, width: 2 * r, height: 2 * r)
                    g.fill(Path(ellipseIn: rect), with: .color(color.opacity(0.45 + 0.55 * off)))
                }
            }
        }
        .frame(width: 28, height: 14)
        .accessibilityHidden(true)
    }
}

/// The running call pulses (alpha 1 ↔ 0.82) — unless Reduce Motion.
private struct FnPulse: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var low = false

    func body(content: Content) -> some View {
        content
            .opacity(low ? 0.82 : 1)
            .onAppear {
                guard !still else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { low = true }
            }
    }
}
