// MsgBody.attachment (6.2): the preview (when the type has one and the file is
// here), then the footer — the type, name and size with save, share and forward
// (or the transfer's progress). Pictures are decoded once into memory
// (ChatState.images, 1280 px); a placeholder of a picture's size keeps the list from
// jumping twice.

import M5Core
import M5Design
import M5Proto
import SwiftUI

struct AttachmentView: View {
    let message: ChatMessage
    let fg: Color
    let accent: Color
    let ctx: SlotContext

    var body: some View {
        let m = message
        let ready = ChatVaultMedia.ready(m)
        let type = MediaPreviews.type(m)
        VStack(alignment: .leading, spacing: 0) {
            if ready {
                switch type {
                case .image: PicturePreview(message: m, host: ctx.host)
                case .audio: ChatAudioBar(id: m.id, source: .message(m), fg: fg, accent: accent, t: ctx.t).padding(.top, 4)
                case .video: ChatVideoBox(message: m, maxWidth: MsgBodyView.maxW, t: ctx.t).padding(.top, 4)
                case .pdf: PdfPreview(message: m, fg: fg, t: ctx.t, host: ctx.host)
                case .text: TextHeadPreview(message: m, fg: fg, host: ctx.host)
                case .other: EmptyView()
                }
            }
            footer(m, type: type, ready: ready)
        }
    }

    /// Under the content: the type, name and size, then save, share and forward (or the transfer's progress).
    private func footer(_ m: ChatMessage, type: MediaPreviews.Kind, ready: Bool) -> some View {
        var sub = Expr.sizeText(Double(m.fileSize))
        if m.fileProgress == -2 { sub = "⚠ " + ctx.t("file.failed") }
        else if m.fileProgress >= 0 { sub = "\(Int((m.fileProgress * 100).rounded())) % · " + Expr.sizeText(Double(m.fileSize)) }
        else if m.filePath != nil && !m.mine && m.fileVerified { sub += " · ✓" }
        let what = HStack(spacing: 0) {
            DesignIcon(name: MediaPreviews.icon(type), size: 20, color: accent).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: m.fileName ?? "").font(.system(size: 13)).foregroundStyle(fg).lineLimit(1).truncationMode(.middle)
                Text(verbatim: sub).font(.system(size: 11.5)).foregroundStyle(fg.opacity(0.75))
            }
            .padding(.leading, 8).padding(.trailing, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                if ready {
                    Button { ChatActions.openFile(m, host: ctx.host) } label: { what.contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .accessibilityLabel(Text(verbatim: ctx.t("file.open") + " " + (m.fileName ?? "")))
                    action("download", ctx.t("file.save")) { ChatActions.saveFile(m, host: ctx.host) }
                    action("share-2", ctx.t("file.share")) { ChatActions.shareFile(m, host: ctx.host) }
                    action("forward", ctx.t("msg.forward")) { ChatActions.forward(m, host: ctx.host) }
                } else {
                    what
                }
            }
            if m.fileProgress >= 0 {
                ProgressView(value: min(1, max(0, (m.fileProgress * 1000).rounded() / 1000)))
                    .tint(accent)
                    .padding(.top, 2)
            }
        }
        .padding(.top, 6)
    }

    private func action(_ icon: String, _ label: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            DesignIcon(name: icon, size: 18, color: fg).frame(width: 34, height: 34).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(Text(verbatim: label))
        .help(Text(verbatim: label))
    }
}

/// A picture of the message: at most 300 tall and the bubble wide; a tap shows it full screen.
struct PicturePreview: View {
    let message: ChatMessage
    let host: DesignHost
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image = image ?? ChatState.shared.image(message.id) {
                let s = fit(image.size)
                Button { ChatActions.viewImage(message, host: host) } label: {
                    Image(uiImage: image).resizable().interpolation(.high).frame(width: s.width, height: s.height)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: message.fileName ?? ""))
                .accessibilityAddTraits(.isImage)
            } else {
                // A placeholder of a picture's size while it is decoded, so the list does not jump twice.
                RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.18)).frame(width: 200, height: 150)
            }
        }
        .padding(.top, 4)
        .task(id: message.id) {
            if ChatState.shared.image(message.id) != nil { return }
            if let img = await ChatVaultMedia.image(message, maxPx: 1280) {
                ChatState.shared.putImage(img, message.id)
                image = img
            }
        }
    }

    /// FIT_START with adjustViewBounds: at most 276 wide and 300 tall, the picture's aspect kept.
    private func fit(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 200, height: 150) }
        let s = min(1, min(MsgBodyView.maxW / size.width, 300 / size.height))
        // A small picture is drawn at its size in points (the decoded pixels are at most 1280).
        let w = size.width * s, h = size.height * s
        return CGSize(width: max(1, w.rounded()), height: max(1, h.rounded()))
    }
}

/// The first page (a white sheet, the page count in its corner); a tap opens it.
struct PdfPreview: View {
    let message: ChatMessage
    let fg: Color
    let t: (String) -> String
    let host: DesignHost
    @State private var page: UIImage?
    @State private var pages = 0
    @State private var failed = false

    var body: some View {
        let w = min(MsgBodyView.maxW, 220)
        if !failed {
            Button { ChatActions.openFile(message, host: host) } label: {
                ZStack(alignment: .bottomTrailing) {
                    Color.white
                    if let page { Image(uiImage: page).resizable().scaledToFit().frame(width: w, alignment: .top) }
                    if page != nil, pages > 0 {
                        Text(verbatim: "PDF · \(pages) " + t("file.pages"))
                            .font(.system(size: 11)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.67)))
                            .padding(6)
                    }
                }
                .frame(width: w, height: page.map { min(260, w * $0.size.height / max(1, $0.size.width)) } ?? 120)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(fg.opacity(0.2), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: message.fileName ?? ""))
            .padding(.top, 4)
            .task(id: message.id) { await load(w) }
        }
    }

    private func load(_ w: CGFloat) async {
        let key = message.id + "#pdf"
        if let img = ChatState.shared.image(key), let n = ChatState.shared.meta(key) as? Int { page = img; pages = n; return }
        guard let data = try? ChatVaultMedia.data(message) else { failed = true; return }
        let target = min(1080, w * 2)
        let got = await Task.detached(priority: .utility) { MediaPreviews.pdfFirstPage(data, maxWidth: target) }.value
        guard let got else { failed = true; return }
        ChatState.shared.putImage(got.image, key)
        ChatState.shared.putMeta(got.pages, key)
        page = got.image
        pages = got.pages
    }
}

/// The first lines of a text file (a tap opens it).
struct TextHeadPreview: View {
    let message: ChatMessage
    let fg: Color
    let host: DesignHost
    @State private var head: String?
    @State private var failed = false

    var body: some View {
        if !failed {
            let name = (message.fileName ?? "").lowercased()
            let mono = !name.hasSuffix(".md") && !name.hasSuffix(".markdown") && !name.hasSuffix(".txt")
            Button { ChatActions.openFile(message, host: host) } label: {
                Text(verbatim: head ?? "…")
                    .font(.system(size: 12.5, design: mono ? .monospaced : .default))
                    .foregroundStyle(fg)
                    .lineLimit(8)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(fg.opacity(0.07)))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
            .task(id: message.id) {
                let key = message.id + "#text"
                if let cached = ChatState.shared.meta(key) as? String { head = cached; return }
                guard let data = try? ChatVaultMedia.data(message), let h = MediaPreviews.textHead(data, lines: 8), !h.isEmpty else { failed = true; return }
                ChatState.shared.putMeta(h, key)
                head = h
            }
        }
    }
}
