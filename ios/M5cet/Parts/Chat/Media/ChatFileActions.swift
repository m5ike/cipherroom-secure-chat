// What Parts.java does with a message's file (6.1/6.2): open it (Android: another
// app through a content:// URI — here Quick Look in the app), Save as… (the system's
// file picker: the plaintext goes only where the person chose), share it (the share
// sheet), the picture full screen (pinch to zoom, a tap closes it, a long press saves
// it). Each gets a decrypted temporary copy (ChatVaultMedia) that is deleted as soon
// as the sheet or the picker is done with it.

import M5Proto
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
enum ChatFileActions {
    /// msg.open: the file in Quick Look (its own share button inside).
    static func open(_ m: ChatMessage, host: DesignHost) {
        guard m.fileName != nil, let url = copy(m, host: host) else { return }
        let ql = QLPreviewController()
        let source = PreviewSource(url: url)
        ql.dataSource = source
        ql.delegate = source
        source.retainSelf = source
        present(ql)
    }

    /// msg.save: Save as… — the system's document picker exports the copy; then it goes.
    static func save(_ m: ChatMessage, host: DesignHost) {
        guard m.fileName != nil, let url = copy(m, host: host) else { return }
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        let done = ExportDone(url: url) { saved in
            if saved { host.flash(title: "", text: host.translator.t("file.saved"), level: .success) }
        }
        picker.delegate = done
        done.retainSelf = done
        present(picker)
    }

    /// msg.share: the share sheet with the file; the copy goes when the sheet closes.
    static func share(_ m: ChatMessage, host: DesignHost) {
        guard m.fileName != nil, let url = copy(m, host: host) else { return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        vc.completionWithItemsHandler = { _, _, _, _ in ChatVaultMedia.discard(url) }
        present(vc)
    }

    /// The picture full screen (Parts.viewImage): black, pinch to zoom, a tap closes it, a long press saves it.
    static func viewImage(_ m: ChatMessage, host: DesignHost) {
        guard let image = ChatState.shared.image(m.id) else { return }
        let vc = UIHostingController(rootView: ChatImageViewer(image: image, label: m.fileName ?? "", close: { dismissTop() }, save: { save(m, host: host) }))
        vc.modalPresentationStyle = .overFullScreen
        vc.modalTransitionStyle = .crossDissolve
        vc.view.backgroundColor = .clear
        present(vc)
    }

    private static func copy(_ m: ChatMessage, host: DesignHost) -> URL? {
        do { return try ChatVaultMedia.temporaryCopy(m) } catch {
            host.flash(title: "", text: host.translator.t("file.noApp"), level: .warn)
            return nil
        }
    }

    // MARK: presenting

    static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              let window = scene.keyWindow ?? scene.windows.first, var top = window.rootViewController else { return nil }
        while let next = top.presentedViewController { top = next }
        return top
    }

    static func present(_ vc: UIViewController) {
        guard let top = topController() else { return }
        if let pop = vc.popoverPresentationController {
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
        top.present(vc, animated: true)
    }

    private static func dismissTop() { topController()?.dismiss(animated: true) }

    // MARK: delegates that clean up after themselves

    @MainActor
    private final class PreviewSource: NSObject, @preconcurrency QLPreviewControllerDataSource, @preconcurrency QLPreviewControllerDelegate {
        let url: URL
        var retainSelf: PreviewSource?
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
        func previewControllerDidDismiss(_ controller: QLPreviewController) {
            ChatVaultMedia.discard(url)
            retainSelf = nil
        }
    }

    @MainActor
    private final class ExportDone: NSObject, @preconcurrency UIDocumentPickerDelegate {
        let url: URL
        let done: @MainActor (Bool) -> Void
        var retainSelf: ExportDone?
        init(url: URL, done: @escaping @MainActor (Bool) -> Void) { self.url = url; self.done = done }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(true) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(false) }
        private func finish(_ saved: Bool) {
            ChatVaultMedia.discard(url)
            done(saved)
            retainSelf = nil
        }
    }
}

/// The picture full screen: pinch and double-tap to zoom, drag when zoomed, a tap closes, a long press saves.
struct ChatImageViewer: View {
    let image: UIImage
    let label: String
    let close: () -> Void
    let save: () -> Void
    @State private var scale: CGFloat = 1
    @State private var base: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var shown = false

    var body: some View {
        ZStack {
            Color.black.opacity(0.94).ignoresSafeArea()
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(scale)
                .offset(offset)
                .accessibilityLabel(Text(verbatim: label))
                .gesture(MagnifyGesture().onChanged { v in scale = min(6, max(1, base * v.magnification)) }
                    .onEnded { _ in base = scale; if scale <= 1 { withAnimation(.easeOut(duration: 0.2)) { offset = .zero; lastOffset = .zero } } })
                .simultaneousGesture(DragGesture().onChanged { v in
                    guard scale > 1 else { return }
                    offset = CGSize(width: lastOffset.width + v.translation.width, height: lastOffset.height + v.translation.height)
                }.onEnded { _ in lastOffset = offset })
        }
        .opacity(shown ? 1 : 0)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            withAnimation(.easeOut(duration: 0.2)) {
                if scale > 1 { scale = 1; base = 1; offset = .zero; lastOffset = .zero } else { scale = 2.5; base = 2.5 }
            }
        }
        .onTapGesture { close() }
        .onLongPressGesture { save() }
        .onAppear { withAnimation(.easeOut(duration: 0.16)) { shown = true } }
        .accessibilityAction(.escape) { close() }
        .accessibilityAddTraits(.isImage)
    }
}
