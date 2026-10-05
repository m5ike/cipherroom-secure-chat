// ui/look/SendButton (6.2), for the composer: the arrow on the button's shape (the
// look's icon radius), a small badge at its corner saying who gets the message — a
// group for the whole room, one person when it goes only to the chosen — and three
// dots at the other corner hinting that holding it offers more ("send.options").
// The colours come from the caller (the design's tokens); 48 × 48.

import M5Design
import SwiftUI

struct DesignSendButton: View {
    /// The arrow's Lucide name ("send-horizontal").
    let icon: String
    let fill: Color
    let foreground: Color
    /// "users" (everyone) or "user" (only the chosen); nil: no badge.
    let people: String?
    let badgeFill: Color
    let badgeForeground: Color
    /// What it sits on (the composer's surface): the ring around the badge.
    let ring: Color
    /// The long-press dots.
    let cue: Bool
    /// Look.radius("icon").
    let radius: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: min(radius, 22), style: .circular)
                .fill(fill)
                .padding(2)
            DesignIcon(name: icon, size: 21, color: foreground)
                .offset(x: 1)
            if let people {
                ZStack {
                    Circle().fill(ring).frame(width: 19, height: 19)
                    Circle().fill(badgeFill).frame(width: 16, height: 16)
                    DesignIcon(name: people, size: 10, color: badgeForeground)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .offset(x: -0.5, y: -0.5)
            }
            if cue {
                HStack(spacing: 1) {
                    ForEach(0..<3, id: \.self) { _ in Circle().fill(foreground.opacity(0.8)).frame(width: 2.6, height: 2.6) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(.top, 9.2)
                .padding(.trailing, 9.6)
            }
        }
        .frame(width: 48, height: 48)
    }
}
