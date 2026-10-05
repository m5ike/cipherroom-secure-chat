// MsgBody.text: the message's text with @mentions and #tags in the accent colour
// and bold (a #tag's tap filters the conversation), and its links — web addresses,
// e-mail addresses, phone numbers (Android's Linkify) — in the accent colour. A
// link from a message is never opened straight away: the whole address is shown
// first (ChatLinks — the renderer's url.open confirmation, the same texts).

import M5Design
import SwiftUI
import UIKit

struct MessageTextView: View {
    let text: String
    let fg: Color
    let accent: Color
    let size: Double
    let host: DesignHost

    var body: some View {
        Text(MessageTextView.attributed(text, accent: accent))
            .font(.system(size: size))
            .foregroundStyle(fg)
            .lineSpacing(size * 0.1)
            .tint(accent)
            .fixedSize(horizontal: false, vertical: true)
            .environment(\.openURL, OpenURLAction { url in open(url) })
    }

    private func open(_ url: URL) -> OpenURLAction.Result {
        if url.scheme == Self.tagScheme {
            let tag = url.absoluteString.dropFirst(Self.tagScheme.count + 1).removingPercentEncoding ?? ""
            ChatActions.filter(String(tag), host: host)
            return .handled
        }
        ChatLinks.confirm(url, host: host)
        return .handled
    }

    static let tagScheme = "m5tag"

    // MARK: spans

    /// (^|[\s(])([@#])([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,39})
    private static let mention = try! NSRegularExpression(pattern: "(^|[\\s(])([@#])([\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]{0,39})")
    private static let links = try! NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue | NSTextCheckingResult.CheckingType.phoneNumber.rawValue)

    /// The text with its spans: mentions and tags bold in the accent (a tag a link of its own), links in the accent.
    static func attributed(_ s: String, accent: Color) -> AttributedString {
        let ns = s as NSString
        let all = NSRange(location: 0, length: ns.length)
        let out = NSMutableAttributedString(string: s)
        for r in mention.matches(in: s, range: all) {
            let span = NSRange(location: r.range(at: 2).location, length: r.range(at: 3).location + r.range(at: 3).length - r.range(at: 2).location)
            out.addAttribute(.foregroundColor, value: UIColor(accent), range: span)
            out.addAttribute(.font, value: UIFont.boldSystemFont(ofSize: UIFont.systemFontSize), range: span)
            if ns.substring(with: r.range(at: 2)) == "#" {
                var tag = ns.substring(with: r.range(at: 3)).lowercased()
                while let last = tag.last, last == "." || last == "-" { tag.removeLast() }
                if let url = URL(string: tagScheme + ":" + (tag.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")) {
                    out.addAttribute(.link, value: url, range: span)
                }
            }
        }
        for r in links.matches(in: s, range: all) {
            var url: URL?
            if r.resultType == .phoneNumber, let p = r.phoneNumber {
                url = URL(string: "tel:" + p.filter { "+0123456789".contains($0) })
            } else if let u = r.url, ["http", "https", "mailto"].contains(u.scheme?.lowercased() ?? "") {
                url = u
            }
            guard let url else { continue }
            out.addAttribute(.link, value: url, range: r.range)
        }
        var a = (try? AttributedString(out, including: \.uiKit)) ?? AttributedString(s)
        // Bold through SwiftUI's own attribute (the UIKit font would fix the size).
        for run in a.runs where run.uiKit.font != nil {
            a[run.range].uiKit.font = nil
            a[run.range].inlinePresentationIntent = .stronglyEmphasized
        }
        for run in a.runs where run.uiKit.foregroundColor != nil {
            a[run.range].uiKit.foregroundColor = nil
            a[run.range].foregroundColor = accent
        }
        return a
    }
}
