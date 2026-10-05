// The elements that only show something: text / badge / chip, button labels, icon
// buttons, avatars, pictures, progress (Renderer.Bound.bindContent, AvatarView,
// RatioImageView, Images).

import M5Design
import SwiftUI
import UIKit

// MARK: text, badge, chip

/// A TextView of the design: its style (size × Dynamic Type, weight, family, italic), max lines with an
/// ellipsis, alignment, 1.1 line spacing, colour, a start icon, and web addresses / e-mails as links.
struct DesignTextView: View {
    let content: TextContent
    let style: TextStyle?
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let st = TextLook(style)
        let size = CGFloat(st.size) * scale
        HStack(alignment: .center, spacing: CGFloat(content.icon?.gap ?? 0)) {
            if let icon = content.icon { DesignIcon(name: icon.name, size: icon.size, color: icon.color.color) }
            text
                .font(st.font(scale))
                .foregroundStyle(st.color.color)
                .lineLimit(st.lines)
                .truncationMode(.tail)
                .multilineTextAlignment(st.align.textAlignment)
                .lineSpacing(size * CGFloat(st.lineSpacing - 1) * 1.2)
                .frame(maxWidth: st.maxWidth.map { CGFloat($0) }, alignment: Alignment(horizontal: st.align.horizontal, vertical: .center))
        }
    }

    private var text: Text {
        if content.links { return Text(DesignLinks.attributed(content.text)) }
        return Text(verbatim: content.text)
    }
}

/// A textual element's style, with Android's TextView defaults when the node has none.
struct TextLook {
    var size = 15.5, weight = FontWeightKind.regular, italic = false, family = FontFamily.sans
    var lines: Int?, align = TextAlign.start, lineSpacing = 1.1, maxWidth: Double?
    var color = DesignColor.black, hintColor: DesignColor?

    init(_ s: TextStyle?) {
        guard let s else { return }
        size = s.size; weight = s.weight; italic = s.italic; family = s.family; lines = s.lines; align = s.align
        lineSpacing = s.lineSpacing; maxWidth = s.maxWidth; color = s.color; hintColor = s.hintColor
    }

    func font(_ scale: CGFloat) -> Font { DesignFonts.font(size: CGFloat(size) * scale, weight: weight, italic: italic, family: family) }
}

/// Linkify.WEB_URLS | EMAIL_ADDRESSES.
enum DesignLinks {
    static func attributed(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return out }
        let ns = text as NSString
        for m in detector.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            guard let url = m.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? ""),
                  let r = Range(m.range, in: text), let ar = Range(r, in: out) else { continue }
            out[ar].link = url
            out[ar].underlineStyle = .single
        }
        return out
    }
}

// MARK: button

/// A button's label: the icon beside the text, centred together (ui/look/Buttons.hug).
struct DesignButtonLabel: View {
    let content: ButtonContent
    let style: TextStyle?
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let st = TextLook(style)
        HStack(spacing: content.icon == nil || content.text.isEmpty ? 0 : CGFloat(content.icon?.gap ?? 8)) {
            if let icon = content.icon { DesignIcon(name: icon.name, size: icon.size, color: icon.color.color) }
            if !content.text.isEmpty {
                Text(verbatim: content.text)
                    .font(st.font(scale))
                    .foregroundStyle(st.color.color)
                    .lineLimit(st.lines)
                    .multilineTextAlignment(.center)
            }
        }
    }
}

// MARK: icon button

/// A 44 × 44 icon button: its icon in the look's colour, a badge number at the top end (the shape is the chrome's).
struct DesignIconButtonView: View {
    let content: IconButtonContent
    @Environment(\.designTextScale) private var scale

    var body: some View {
        DesignIcon(name: content.icon, size: content.iconSize, color: content.iconColor.color)
            .frame(width: 44, height: 44)
            .overlay(alignment: .topTrailing) {
                if let badge = content.badge {
                    Text(verbatim: badge)
                        .font(.system(size: 10 * min(scale, 1.4), weight: .medium))
                        .foregroundStyle(content.badgeText.color)
                        .lineLimit(1)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16, maxHeight: 16)
                        .background(RoundedRectangle(cornerRadius: 8).fill(content.badgeFill.color))
                        .fixedSize()
                        .padding(.top, 4)
                        .padding(.trailing, 4)
                        .accessibilityHidden(true)
                }
            }
    }
}

// MARK: avatar

/// Renderer.AvatarView: a circle of the name's colour with its initials, always size × size.
struct DesignAvatar: View {
    let content: AvatarContent

    var body: some View {
        let s = CGFloat(content.size)
        Circle()
            .fill(content.color.color)
            .overlay {
                Text(verbatim: content.initials)
                    .font(.system(size: s * 0.4, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .frame(width: s, height: s)
            .accessibilityHidden(true)
    }
}

// MARK: progress

struct DesignProgress: View {
    let value: Double?
    @Environment(\.designRenderContext) private var context

    var body: some View {
        let tint = context?.swiftColor("@primary", .blue) ?? .accentColor
        if let value {
            ProgressView(value: min(1, max(0, value)))
                .progressViewStyle(.linear)
                .tint(tint)
                .frame(idealWidth: 160, idealHeight: 16)
        } else {
            ProgressView()
                .progressViewStyle(.circular)
                .controlSize(.large)
                .tint(tint)
        }
    }
}

// MARK: image

/// Renderer.RatioImageView + Images: the design's asset, inline data or a fixed https picture; cover / contain /
/// center; a ratio sets the height from the width; adjustViewBounds keeps the picture's own shape otherwise.
struct DesignImageView: View {
    let content: ImageContent
    @State private var remote: UIImage?

    var body: some View {
        let image = DesignImages.local(content.source) ?? remote
        DesignImageLayout(natural: image?.size ?? .zero, ratio: CGFloat(content.ratio)) {
            Group {
                if let image {
                    switch content.fit {
                    case .cover: Image(uiImage: image).resizable().scaledToFill()
                    case .contain: Image(uiImage: image).resizable().scaledToFit()
                    case .center: Image(uiImage: image)
                    }
                } else {
                    Color.clear
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .clipped()
        }
        .accessibilityHidden(true)
        .task(id: content.source) {
            guard case .remote(let url) = content.source else { return }
            remote = await DesignImages.remote(url)
        }
    }
}

/// The picture's size rules: natural size for WRAP, the other side from the picture's shape (adjustViewBounds),
/// or the design's ratio (width / height).
struct DesignImageLayout: Layout {
    var natural: CGSize
    var ratio: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil }, h = proposal.height.flatMap { $0.isFinite ? $0 : nil }
        if let w, let h { return CGSize(width: w, height: h) }
        if ratio > 0 {
            let width = w ?? natural.width
            return CGSize(width: width, height: width / ratio)
        }
        let aspect = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0
        if let w { return CGSize(width: w, height: w * aspect) }
        if let h { return CGSize(width: aspect > 0 ? h / aspect : 0, height: h) }
        return natural
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for s in subviews { s.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size)) }
    }
}

/// Renderer.Images: decoded once and kept (16 MB), big pictures scaled down to 1600 px.
@MainActor
enum DesignImages {
    private static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.totalCostLimit = 16 << 20
        return c
    }()

    static func key(_ s: ImageSource) -> String? {
        switch s {
        case .none: return nil
        case .asset(let name, _): return "asset:" + name
        case .data(let mime, let data): return "data:\(mime):\(data.count):\(data.hashValue)"
        case .remote(let url): return url.absoluteString
        }
    }

    static func local(_ s: ImageSource) -> UIImage? {
        guard let k = key(s) else { return nil }
        if let hit = cache.object(forKey: k as NSString) { return hit }
        let data: Data
        switch s {
        case .asset(_, let d?): data = d
        case .data(_, let d): data = d
        default: return nil
        }
        guard let img = decode(data) else { return nil }
        cache.setObject(img, forKey: k as NSString, cost: cost(img))
        return img
    }

    /// A fixed https picture of the design (DesignUrls let it through), fetched without cookies or a disk cache.
    static func remote(_ url: URL) async -> UIImage? {
        let k = url.absoluteString as NSString
        if let hit = cache.object(forKey: k) { return hit }
        guard url.scheme == "https" else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.httpShouldHandleCookies = false
        guard let (data, response) = try? await session.data(for: req), data.count <= 16 << 20,
              (response as? HTTPURLResponse)?.statusCode == 200, let img = decode(data) else { return nil }
        cache.setObject(img, forKey: k, cost: cost(img))
        return img
    }

    private static let session = URLSession(configuration: .ephemeral)

    private static func decode(_ data: Data) -> UIImage? {
        guard let img = UIImage(data: data, scale: 1) else { return nil }
        let maxSide = max(img.size.width, img.size.height)
        guard maxSide > 1600 else { return img }
        let k = 1600 / maxSide
        return img.preparingThumbnail(of: CGSize(width: img.size.width * k, height: img.size.height * k)) ?? img
    }

    private static func cost(_ img: UIImage) -> Int { Int(img.size.width * img.size.height * img.scale * img.scale * 4) }
}
