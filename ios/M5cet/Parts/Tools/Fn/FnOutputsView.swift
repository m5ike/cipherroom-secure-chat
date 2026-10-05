// A function's outputs in a message, drawn natively — a port of
// android/…/fn/FnView.java (FnOutputs.tsx): text, Markdown, code, tables,
// JSON, images, files, notices, sound and video, buttons (side by side), forms
// — and formatted HTML (6.6) in a locked-down WKWebView (FnHtmlView). Browser
// JavaScript and app panels are the web app's; here they are a note.
//
// Each item stands on its own: one that fails to draw becomes a short note and
// is reported once (FnOutputsHost.report → the server's error entry point may
// answer). What a message does once — its notices, autoplay, a once-button or
// form used — is remembered by the message's key, so a list that draws its rows
// again does not repeat it; notices and autoplay happen only while the message
// is fresh (30 s).
//
// The chat's bubble (msgBody) embeds `FnMessageContent(message:)` (FnCallView.swift),
// which uses this for a model's answer.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

/// What the outputs need from the app (FnView.Host).
@MainActor
protocol FnOutputsHost: AnyObject {
    /// A click or a form for the model (Commands.event with meta and ev), knowing the message it came from;
    /// done(true) when the model answered.
    func event(key: String, meta: JSONObject, ev: JSONObject, done: @escaping (Bool) -> Void)
    /// A notice of a fresh message. level: info, success, warning, error.
    func flash(_ text: String, level: String)
    /// Save (open false) or open a file the function returned (or an image tapped).
    func file(name: String, mime: String, data: Data, open: Bool)
    /// A link tapped in Markdown or HTML (the app asks first).
    func openLink(_ url: String)
    /// An output that could not be shown: {type: "error", error: {type, message}, output, fromError}.
    func report(meta: JSONObject, ev: JSONObject)
}

/// What happened once, per message (the newest 2000) — FnView.ONCE.
@MainActor
enum FnOnce {
    private static var keys: [String] = []
    private static var set: Set<String> = []

    static func happened(_ k: String) -> Bool { set.contains(k) }

    /// Marks k; true the first time.
    @discardableResult
    static func firstTime(_ k: String) -> Bool {
        if set.contains(k) {
            keys.removeAll { $0 == k }
            keys.append(k)
            return false
        }
        set.insert(k)
        keys.append(k)
        if keys.count > 2000 { set.remove(keys.removeFirst()) }
        return true
    }

    static func forget() { keys.removeAll(); set.removeAll() }
}

/// A message's outputs as drawn: consecutive buttons share a row (FnView.show).
enum FnOutputsLayout {
    enum Part: Equatable {
        case item(Int, JSONObject)
        case buttons([(Int, JSONObject)])

        static func == (a: Part, b: Part) -> Bool {
            switch (a, b) {
            case let (.item(i, x), .item(j, y)): return i == j && x == y
            case let (.buttons(x), .buttons(y)): return x.map(\.0) == y.map(\.0) && x.map(\.1) == y.map(\.1)
            default: return false
            }
        }
    }

    static func parts(_ outputs: [JSON]) -> [Part] {
        var out = [Part]()
        for (i, v) in outputs.enumerated() {
            guard let o = v.objectValue else { continue }
            if o.optString("type") == "button" {
                if case .buttons(var row)? = out.last {
                    row.append((i, o))
                    out[out.count - 1] = .buttons(row)
                } else {
                    out.append(.buttons([(i, o)]))
                }
                continue
            }
            out.append(.item(i, o))
        }
        return out
    }

    /// A message is fresh for this long (its notices and autoplay).
    static let freshMs: Int64 = 30_000

    /// An image's file name from its alt text (FnView.fileName).
    static func fileName(_ alt: String, _ fallback: String) -> String {
        let kept = alt.unicodeScalars.filter { u in
            u.properties.isAlphabetic || u.properties.numericType != nil || " ._-".unicodeScalars.contains(u)
        }
        let n = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, let dot = fallback.lastIndex(of: ".") else { return n.isEmpty ? fallback : n }
        return n + fallback[dot...]
    }

    /// "image/jpeg" → "image.jpg".
    static func imageName(_ mime: String) -> String { "image." + String(mime.dropFirst(6)).replacingOccurrences(of: "jpeg", with: "jpg") }

    static func decode(_ b64: String) -> Data? { Data(base64Encoded: b64) }
}

struct FnOutputsView: View {
    /// The message's id.
    let key: String
    let outputs: [JSON]
    /// Its flags.fn — which model and session a click or a form reaches (nil: none).
    let meta: JSONObject?
    /// When it was made (ms).
    let createdAt: Int64
    /// The text colour (the bubble's); nil: @onSurface.
    var ink: Color?
    let host: any FnOutputsHost
    let look: ToolsLook

    var body: some View {
        let fresh = createdAt > 0 && Millis.now - createdAt < FnOutputsLayout.freshMs
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(FnOutputsLayout.parts(outputs).enumerated()), id: \.offset) { _, part in
                switch part {
                case .buttons(let row):
                    FnFlowLayout(spacing: 6) {
                        ForEach(row, id: \.0) { i, o in
                            FnButtonView(key: key, index: i, o: o, meta: meta, host: host, look: look)
                                .layoutValue(key: FnFlowBlockKey.self, value: (" " + o.optString("css") + " ").contains(" block "))
                        }
                    }
                case .item(let i, let o):
                    FnOutputItemView(key: key, index: i, o: o, meta: meta, fresh: fresh, ink: ink ?? look.color("@onSurface"), host: host, look: look)
                }
            }
        }
    }
}

/// Reports an output that could not be shown (once per message and output) — FnView.failed.
@MainActor
func fnReport(_ host: any FnOutputsHost, key: String, meta: JSONObject?, index: Int, type: String, message: String) {
    guard let meta, !meta.optString("chain").isEmpty, FnOnce.firstTime(key + "#\(index):report") else { return }
    let ev = JSONObject([("type", "error"),
                         ("error", .object(JSONObject([("type", .string(type.isEmpty ? "RenderError" : type)), ("message", .string(String(message.prefix(1500))))]))),
                         ("output", .int(index)), ("fromError", .bool(meta["origin"] == .string("error")))])
    host.report(meta: meta, ev: ev)
}

/// One output (FnView.item).
private struct FnOutputItemView: View {
    let key: String
    let index: Int
    let o: JSONObject
    let meta: JSONObject?
    let fresh: Bool
    let ink: Color
    let host: any FnOutputsHost
    let look: ToolsLook

    var body: some View {
        switch o.optString("type") {
        case "text":
            plain(o.optString("text"))
        case "markdown":
            FnMarkdownView(text: o.optString("text"), look: look, ink: ink, onLink: host.openLink)
        case "code":
            FnCodeBox(text: o.optString("text"), ink: ink, look: look)
        case "json":
            titled(o.string("title") ?? "") { FnCodeBox(text: Js.stringify(o["value"], indent: 2), ink: ink, look: look) }
        case "table":
            titled(o.string("title") ?? "") { FnTableView(o: o, ink: ink, look: look) }
        case "image":
            FnImageOutput(key: key, index: index, o: o, meta: meta, ink: ink, host: host, look: look)
        case "file":
            fileRow
        case "flash":
            flash
        case "audio", "video":
            // Autoplay: only a fresh message, only once (FnMediaView marks it when it starts).
            FnMediaView(o: o, autoplayOnce: o["autoplay"] == .bool(true) && fresh ? key + "#\(index):play" : nil, look: look) { why in
                fnReport(host, key: key, meta: meta, index: index, type: "MediaError", message: why)
            }
        case "form":
            let reachable = Commands.answers(meta, "form")
            let used = key + "#\(index):used"
            FnFormView(spec: o, reachable: reachable, sent: o["once"] == .bool(true) && FnOnce.happened(used), look: look, openLink: host.openLink) { values, done in
                host.event(key: key, meta: meta ?? JSONObject(), ev: Commands.form(o.optString("name"), values)) { ok in
                    if ok && o["once"] == .bool(true) { FnOnce.firstTime(used) }
                    done(ok)
                }
            }
            .help(reachable ? "" : look.words("fnui.noEvent", "what", look.words("fnui.what.form")))
        case "html":
            // Outputs come here as they were sent (a peer's too): Outputs.check's limits here, the sanitizing in FnHtmlView.
            if case .string(let html)? = o["html"], html.utf16.count <= FnHtml.max {
                titled(o.string("title").map { String($0.prefix(300)) } ?? "") {
                    FnHtmlView(html: html, look: look, openLink: host.openLink) { why in
                        fnReport(host, key: key, meta: meta, index: index, type: "HtmlError", message: why)
                    }
                }
            }
        case "js":
            // Hidden browser code is an effect of the web app; nothing to show.
            if o["hidden"] != .bool(true) { note(look.words("fnui.webOnly"), "@muted") }
        case "window":
            note(look.words("fnui.webOnly"), "@muted")
        default:
            EmptyView()
        }
    }

    private func plain(_ s: String) -> some View {
        Text(verbatim: s).toolsFont(15).foregroundStyle(ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }

    private func note(_ s: String, _ token: String) -> some View {
        Text(verbatim: s).toolsFont(13, italic: true).foregroundStyle(look.color(token)).fixedSize(horizontal: false, vertical: true)
    }

    /// A JSON value, a table or an HTML page with its title above.
    @ViewBuilder
    private func titled<B: View>(_ title: String, @ViewBuilder _ body: () -> B) -> some View {
        if title.isEmpty {
            body()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: title).toolsFont(15, weight: .bold).foregroundStyle(ink).fixedSize(horizontal: false, vertical: true)
                body()
            }
        }
    }

    /// 📎 name, then Download and Open.
    private var fileRow: some View {
        let name = o.optString("name"), mime = o.optString("mime")
        return HStack(spacing: 6) {
            Text(verbatim: "📎 " + name).toolsFont(15).foregroundStyle(ink).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach([false, true], id: \.self) { open in
                Button {
                    if let d = FnOutputsLayout.decode(o.optString("data")) { host.file(name: name, mime: mime, data: d, open: open) }
                } label: {
                    Text(verbatim: look.words(open ? "fnui.open" : "fnui.download")).toolsFont(14).foregroundStyle(look.color("@primary"))
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(look.color("@border"), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 10).padding(.trailing, 6).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(look.color("@border"), lineWidth: 1))
    }

    /// A notice in the message; the app shows it too while the message is fresh (once).
    private var flash: some View {
        let level = o.optString("level", "info")
        let token = level == "success" ? "@success" : level == "warning" ? "@warning" : level == "error" ? "@danger" : "@primary"
        let c = look.color(token)
        return Text(verbatim: o.optString("text"))
            .toolsFont(15)
            .foregroundStyle(ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(c.opacity(0x22 / 255)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(c, lineWidth: 1))
            .onAppear {
                if fresh && FnOnce.firstTime(key + "#\(index):flash") { host.flash(o.optString("text"), level: level) }
            }
    }
}

/// Monospace text that scrolls sideways.
struct FnCodeBox: View {
    let text: String
    let ink: Color
    let look: ToolsLook

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(verbatim: text).toolsFont(13, design: .monospaced).foregroundStyle(ink).fixedSize().textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
    }
}

/// A table: the head on the panel colour, cells as text, sideways scrolling.
struct FnTableView: View {
    let o: JSONObject
    let ink: Color
    let look: ToolsLook

    var body: some View {
        let cols = o.array("columns") ?? []
        let rows: [[JSON]] = (o.array("rows") ?? []).map { r in r.arrayValue ?? [r] }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(cols.enumerated()), id: \.offset) { _, c in cell(Js.str(c), head: true) }
                }
                .background(look.color("@surfaceVariant"))
                ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                    GridRow {
                        ForEach(Array(r.enumerated()), id: \.offset) { _, c in cell(Outputs.cellText(c), head: false) }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(look.color("@border"), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func cell(_ s: String, head: Bool) -> some View {
        Text(verbatim: s).toolsFont(14, weight: head ? .bold : .regular).foregroundStyle(ink).fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 6)
    }
}

/// An image (a function may return a huge one: drawn at most the screen's size), tapped: opened.
private struct FnImageOutput: View {
    let key: String
    let index: Int
    let o: JSONObject
    let meta: JSONObject?
    let ink: Color
    let host: any FnOutputsHost
    let look: ToolsLook
    @State private var image: UIImage?
    @State private var broken = false

    var body: some View {
        let mime = o.optString("mime")
        let alt = o.string("alt") ?? ""
        if mime == "image/svg+xml" {
            // No SVG renderer here: a placeholder that saves the file.
            Button {
                if let d = FnOutputsLayout.decode(o.optString("data")) { host.file(name: FnOutputsLayout.fileName(alt, "image.svg"), mime: mime, data: d, open: false) }
            } label: {
                Text(verbatim: "SVG" + (alt.isEmpty ? "" : " · " + alt) + " — " + look.words("fnui.download")).toolsFont(14).foregroundStyle(ink)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(look.color("@surfaceVariant")))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(look.color("@border"), lineWidth: 1))
            }
            .buttonStyle(.plain)
        } else {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 360, alignment: .leading)
                        .accessibilityLabel(Text(verbatim: alt))
                        .onTapGesture {
                            if let d = FnOutputsLayout.decode(o.optString("data")) {
                                host.file(name: FnOutputsLayout.fileName(alt, FnOutputsLayout.imageName(mime)), mime: mime, data: d, open: true)
                            }
                        }
                } else if !broken {
                    Color.clear.frame(height: 40)
                }
            }
            .task(id: key + "#\(index)") {
                let b64 = o.optString("data")
                let side: CGFloat = 2048
                let made = await Task.detached(priority: .userInitiated) { () -> UIImage? in
                    guard let data = Data(base64Encoded: b64) else { return nil }
                    return FnImages.downsample(data, maxPixels: side)
                }.value
                if let made { image = made } else {
                    broken = true
                    fnReport(host, key: key, meta: meta, index: index, type: "ImageError", message: "the image could not be shown (\(mime))")
                }
            }
        }
    }
}

enum FnImages {
    /// A picture no larger than maxPixels a side (ImageIO thumbnails — the full bitmap is never decoded).
    static func downsample(_ data: Data, maxPixels: CGFloat) -> UIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels] as CFDictionary
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts) else { return nil }
        return UIImage(cgImage: cg)
    }
}

// MARK: - buttons

/// A function's button: a tap calls its button entry point; confirm asks first, once locks it after a success.
private struct FnButtonView: View {
    let key: String
    let index: Int
    let o: JSONObject
    let meta: JSONObject?
    let host: any FnOutputsHost
    let look: ToolsLook
    /// idle, confirm, busy, done.
    @State private var state = "idle"
    @State private var confirmTask: Task<Void, Never>?

    private var used: String { key + "#" + o.optString("name") + ":" + o.optString("title") + ":used" }
    private var reachable: Bool { Commands.answers(meta, "button") }
    private var css: String { " " + o.optString("css") + " " }
    private var once: Bool { o["once"] == .bool(true) }

    var body: some View {
        let s = once && FnOnce.happened(used) && state == "idle" ? "done" : state
        let enabled = reachable && o["disabled"] != .bool(true) && s != "busy" && s != "done"
        let style = FnButtonStyle.of(css: css, style: o.object("style"), look: look)
        let small = css.contains(" small "), large = css.contains(" large ")
        let icon = o.string("icon").map { $0 + " " } ?? ""
        let title = s == "confirm" ? (o.optString("confirm").isEmpty ? look.words("fnui.confirm") : o.optString("confirm")) : o.optString("title")
        Button { click() } label: {
            Text(verbatim: icon + title + (s == "busy" ? " …" : ""))
                .toolsFont(small ? 12 : large ? 16 : 14, weight: .bold)
                .underline(css.contains(" link "))
                .multilineTextAlignment(.center)
                .foregroundStyle(style.ink)
                .padding(.horizontal, small ? 9 : large ? 18 : 14)
                .padding(.vertical, small ? 4 : large ? 10 : 7)
                .frame(maxWidth: css.contains(" block ") ? .infinity : nil)
                .background(RoundedRectangle(cornerRadius: css.contains(" round ") ? 999 : 10).fill(style.fill))
                .overlay(RoundedRectangle(cornerRadius: css.contains(" round ") ? 999 : 10)
                    .stroke(s == "confirm" ? look.color("@warning") : style.stroke, lineWidth: s == "confirm" ? 2 : 1))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
        .help(reachable ? "" : look.words("fnui.noEvent", "what", look.words("fnui.what.button")))
    }

    private func click() {
        let s = once && FnOnce.happened(used) ? "done" : state
        guard reachable, s != "busy", s != "done", o["disabled"] != .bool(true) else { return }
        let confirm = o.string("confirm") ?? ""
        if !confirm.isEmpty && s != "confirm" {
            state = "confirm"
            // The web resets it when the button loses focus; here after a moment.
            confirmTask?.cancel()
            confirmTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled && state == "confirm" { state = "idle" }
            }
            return
        }
        confirmTask?.cancel()
        state = "busy"
        let used = self.used, once = self.once
        host.event(key: key, meta: meta ?? JSONObject(), ev: Commands.button(o.optString("name"), o["data"])) { ok in
            if ok && once { FnOnce.firstTime(used) }
            state = ok && once ? "done" : "idle"
        }
    }
}

/// The web's fn-btn classes in the theme's colours; a style's own colours win (FnView.Button.style).
struct FnButtonStyle: Equatable {
    let fill: Color
    let stroke: Color
    let ink: Color

    /// .fn-btn--info: hsl(199 80% 42%).
    static let info = CssColor.parse("hsl(199, 80%, 42%)") ?? 0xFF15_8AC0

    @MainActor
    static func of(css: String, style: JSONObject?, look: ToolsLook) -> FnButtonStyle {
        var fill = look.design("@surfaceVariant"), stroke = look.design("@border"), ink = look.design("@onSurface")
        if css.contains(" primary ") { fill = look.design("@primary"); stroke = fill; ink = look.design("@onPrimary") }
        else if css.contains(" success ") { fill = look.design("@success"); stroke = fill; ink = .white }
        else if css.contains(" danger ") { fill = look.design("@danger"); stroke = fill; ink = .white }
        else if css.contains(" warning ") { fill = look.design("@warning"); stroke = fill; ink = DesignColor(argb: 0xFF1A_1200) }
        else if css.contains(" info ") { fill = DesignColor(argb: info); stroke = fill; ink = .white }
        else if css.contains(" ghost ") { fill = .transparent; stroke = .transparent }
        else if css.contains(" outline ") { fill = .transparent; stroke = look.design("@primary"); ink = stroke }
        else if css.contains(" link ") { fill = .transparent; stroke = .transparent; ink = look.design("@primary") }
        if let st = style {
            if let c = CssColor.parse(st.string("color")) { ink = DesignColor(argb: c) }
            if let b = CssColor.parse(st.string("background")) { fill = DesignColor(argb: b) }
            if let r = CssColor.parse(st.string("border")) { stroke = DesignColor(argb: r) }
        }
        return FnButtonStyle(fill: fill.color, stroke: stroke.color, ink: ink.color)
    }
}

// MARK: - flow layout (android fn/FlowRow)

/// A child that takes a whole line (a "block" button).
struct FnFlowBlockKey: LayoutValueKey {
    static let defaultValue = false
}

/// Children side by side, wrapping to the next line when they do not fit; a block child takes a line.
struct FnFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let max = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let full = v[FnFlowBlockKey.self] && max.isFinite
            let s = full ? v.sizeThatFits(ProposedViewSize(width: max, height: nil)) : v.sizeThatFits(ProposedViewSize(width: max.isFinite ? max : nil, height: nil))
            let w = full ? max : Swift.min(s.width, max)
            if x > 0 && x + w > max { y += line + spacing; x = 0; line = 0 }
            x += w + spacing
            widest = Swift.max(widest, x - spacing)
            line = Swift.max(line, s.height)
        }
        return CGSize(width: max.isFinite ? Swift.max(widest, 0) : widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let max = bounds.width
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for v in subviews {
            let full = v[FnFlowBlockKey.self]
            let s = full ? v.sizeThatFits(ProposedViewSize(width: max, height: nil)) : v.sizeThatFits(ProposedViewSize(width: max, height: nil))
            let w = full ? max : Swift.min(s.width, max)
            if x > 0 && x + w > max { y += line + spacing; x = 0; line = 0 }
            v.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), proposal: ProposedViewSize(width: w, height: s.height))
            x += w + spacing
            line = Swift.max(line, s.height)
        }
    }
}
