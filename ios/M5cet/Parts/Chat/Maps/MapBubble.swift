// ui/parts/MapBubble (6.2): the map of a position — in the bubble of a position
// message, and in the place sheet. The operator's size, centred on the point with
// the pin and "<sender>'s current position", the coordinates under it when the
// policy says so. A tap in the bubble opens the place sheet (6.7); the sheet's
// map opens the full map.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

@MainActor
enum MapBubble {
    /// Messages whose map did not come lately (id → when): the text and the pin for a minute.
    private static var failed: [String: Int64] = [:]

    static func failedLately(_ m: ChatMessage) -> Bool {
        guard let at = failed[m.id] else { return false }
        return EpochMs.now - at < 60_000
    }

    static func markFailed(_ m: ChatMessage) { failed[m.id] = EpochMs.now }

    /// The policy when this message gets a map now, else nil (the pin as before).
    static func policy(for m: ChatMessage) -> ChatMapPolicy? {
        if BubbleKinds.position(m) == nil || failedLately(m) { return nil }
        return ChatMapPolicies.usable()
    }

    /// "lat, lon ± acc m" (Locale.ROOT).
    static func coords(_ lat: Double, _ lon: Double, _ acc: Int64) -> String {
        String(format: "%.5f, %.5f", locale: Locale(identifier: "en_US_POSIX"), lat, lon) + (acc > 0 ? " ± \(acc) m" : "")
    }
}

/// The map view: a placeholder pin until the picture is drawn; no tile → `onFail` (the bubble falls back to the text).
struct MapBubbleView: View {
    let message: ChatMessage
    let policy: ChatMapPolicy
    let fg: Color
    let primary: DesignColor
    let maxWidth: CGFloat
    let t: (String) -> String
    let onTap: () -> Void
    var onFail: (() -> Void)?
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        let pos = BubbleKinds.position(message) ?? JSONObject()
        let lat = pos.chatDouble("lat"), lon = pos.chatDouble("lon"), acc = pos.optInt64("acc")
        let w = min(CGFloat(policy.width), maxWidth)
        let h = (w * CGFloat(policy.height) / CGFloat(policy.width)).rounded()
        let caption = mapCaption
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onTap) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12).fill(fg.opacity(0.08))
                    if let image {
                        Image(uiImage: image).resizable().interpolation(.high)
                    } else {
                        DesignIcon(name: "map-pin", size: 26, color: fg.opacity(0.45))
                    }
                }
                .frame(width: w, height: h)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            .accessibilityLabel(Text(verbatim: caption.isEmpty ? t("msg.map") : caption))
            if policy.showCoords {
                Text(verbatim: MapBubble.coords(lat, lon, acc))
                    .font(.system(size: 12))
                    .foregroundStyle(fg.opacity(0.75))
                    .padding(.top, 3)
                    .textSelection(.enabled)
            }
        }
        .task(id: message.id + policy.signature) {
            let bg = policy.accent != 0 ? policy.accent : primary.argb
            let spec = ChatMapPreview.Spec(lat: lat, lon: lon, acc: acc, caption: caption, captionBg: bg)
            let scale = ChatMapPreview.scale(policy, displayScale)
            if let hit = ChatMapPreview.cached(policy, spec, scale) { image = hit; return }
            if let drawn = await ChatMapPreview.render(policy, spec, scale) { image = drawn; return }
            MapBubble.markFailed(message)
            onFail?()
        }
    }

    private var mapCaption: String {
        !policy.label ? "" : message.mine ? t("map.captionMine") : t("map.caption").replacingOccurrences(of: "{name}", with: message.senderName)
    }
}
