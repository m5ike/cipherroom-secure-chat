// The composer's text field (Composer.input): multi-line, up to 6 lines, then it
// scrolls. "Enter sends" (Settings › Messages, messages.enterSends): the Return key
// sends — on a hardware keyboard Shift-Return still makes a new line; without the
// setting Return is a new line. A picture pasted into it (⌘V, the edit menu) is
// sent as a picture. The caret's position (UTF-16) goes to the suggester.

import SwiftUI
import UIKit

struct ComposerField: UIViewRepresentable {
    @Binding var text: String
    let hint: String
    let font: UIFont
    let color: UIColor
    let hintColor: UIColor
    let tint: UIColor
    let enterSends: Bool
    /// Bumped when the field should take the focus (and the keyboard).
    let focusRequests: Int
    /// Bumped with a position (UTF-16) when the caret should go there (a picked suggestion).
    var caretToken = 0
    var caretAt = 0
    let onSend: @MainActor () -> Void
    let onCaret: @MainActor (Int) -> Void
    let onPasteImage: @MainActor (Data) -> Void
    @Binding var height: CGFloat

    static let maxLines = 6

    func makeUIView(context: Context) -> FieldView {
        let v = FieldView()
        v.delegate = context.coordinator
        v.backgroundColor = .clear
        v.textContainerInset = UIEdgeInsets(top: 10, left: 12, bottom: 10, right: 0)
        v.textContainer.lineFragmentPadding = 4
        v.isScrollEnabled = false
        v.autocapitalizationType = .sentences
        v.adjustsFontForContentSizeCategory = false
        v.accessibilityIdentifier = "composer.field"
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.onPasteImage = { data in Task { @MainActor in onPasteImage(data) } }
        v.onShiftReturn = { [weak v] in
            v?.allowNewline = true
            v?.insertText("\n")
            v?.allowNewline = false
        }
        context.coordinator.parent = self
        return v
    }

    func updateUIView(_ v: FieldView, context: Context) {
        context.coordinator.parent = self
        if v.text != text { v.text = text; v.selectedRange = NSRange(location: (text as NSString).length, length: 0) }
        v.font = font
        v.textColor = color
        v.tintColor = tint
        v.placeholder.text = hint
        v.placeholder.font = font
        v.placeholder.textColor = hintColor
        v.placeholder.isHidden = !text.isEmpty
        v.accessibilityLabel = hint
        v.returnKeyType = enterSends ? .send : .default
        v.hardwareShiftReturn = enterSends
        if context.coordinator.caretSeen != caretToken {
            context.coordinator.caretSeen = caretToken
            let n = (v.text as NSString).length
            v.selectedRange = NSRange(location: max(0, min(caretAt, n)), length: 0)
        }
        if context.coordinator.focusSeen != focusRequests {
            let first = context.coordinator.focusSeen < 0
            context.coordinator.focusSeen = focusRequests
            if !first { DispatchQueue.main.async { v.becomeFirstResponder() } }
        }
        DispatchQueue.main.async { context.coordinator.measure(v) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerField
        var focusSeen = -1
        var caretSeen = 0

        init(_ p: ComposerField) { parent = p }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            // Return with "Enter sends" (the soft keyboard's Send, a hardware Return): the message goes, no new line.
            if parent.enterSends && text == "\n" && (textView as? FieldView)?.allowNewline != true {
                parent.onSend()
                return false
            }
            return true
        }

        func textViewDidChange(_ v: UITextView) {
            parent.text = v.text
            (v as? FieldView)?.placeholder.isHidden = !v.text.isEmpty
            measure(v)
            parent.onCaret(v.selectedRange.location)
        }

        func textViewDidChangeSelection(_ v: UITextView) { parent.onCaret(v.selectedRange.location) }

        /// One to six lines, then it scrolls.
        func measure(_ v: UITextView) {
            let width = v.bounds.width > 0 ? v.bounds.width : 200
            let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            let line = (v.font ?? .systemFont(ofSize: 16)).lineHeight
            let maxH = line * CGFloat(ComposerField.maxLines) + v.textContainerInset.top + v.textContainerInset.bottom
            let h = min(maxH, max(44, ceil(fit)))
            v.isScrollEnabled = fit > maxH
            if abs(parent.height - h) > 0.5 { parent.height = h }
        }
    }

    /// UITextView with a placeholder, a picture paste and Shift-Return on a hardware keyboard.
    final class FieldView: UITextView {
        let placeholder = UILabel()
        var onPasteImage: ((Data) -> Void)?
        var onShiftReturn: (() -> Void)?
        var hardwareShiftReturn = false
        /// Shift-Return is inserting its new line (not a send).
        var allowNewline = false

        override init(frame: CGRect, textContainer: NSTextContainer?) {
            super.init(frame: frame, textContainer: textContainer)
            placeholder.numberOfLines = 1
            placeholder.isAccessibilityElement = false
            addSubview(placeholder)
        }

        required init?(coder: NSCoder) { fatalError("not from a storyboard") }

        override func layoutSubviews() {
            super.layoutSubviews()
            placeholder.frame = CGRect(x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top,
                                       width: bounds.width - textContainerInset.left - textContainerInset.right - 2 * textContainer.lineFragmentPadding,
                                       height: placeholder.font.lineHeight)
        }

        override var keyCommands: [UIKeyCommand]? {
            guard hardwareShiftReturn else { return super.keyCommands }
            let c = UIKeyCommand(input: "\r", modifierFlags: .shift, action: #selector(shiftReturn))
            c.wantsPriorityOverSystemBehavior = true
            return (super.keyCommands ?? []) + [c]
        }

        @objc private func shiftReturn() { onShiftReturn?() }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)) && UIPasteboard.general.hasImages { return true }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            let pb = UIPasteboard.general
            if pb.hasImages && !pb.hasStrings, let img = pb.image {
                if let data = pb.data(forPasteboardType: "public.jpeg") ?? pb.data(forPasteboardType: "public.png") ?? img.pngData() { onPasteImage?(data) }
                return
            }
            super.paste(sender)
        }
    }
}
