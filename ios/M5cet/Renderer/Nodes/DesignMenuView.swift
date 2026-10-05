// ui/look/Menus: the app's menus — the design's menus (menu.open), a select's
// choices, a part's long press — a card in the design's own colours, each item an
// icon on the left and its label, a danger item (delete, erase) in the danger
// colour, the chosen one with a check. Shown as a popover at the element.

import M5Design
import SwiftUI
import UIKit

struct DesignMenuView: View {
    let entries: [MenuEntry]
    let pick: (MenuEntry) -> Void
    @Environment(\.designRenderContext) private var context
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let ctx = context
        let surface = ctx?.swiftColor("@surface", .white) ?? Color(.systemBackground)
        let onSurface = ctx?.color("@onSurface", .black) ?? .black
        let primary = ctx?.swiftColor("@primary", .blue) ?? .accentColor
        let danger = ctx?.swiftColor("@danger", .red) ?? .red
        let fs = CGFloat(ctx?.appearance.fontScale ?? 1) * scale
        let family = ctx.map { $0.look.family($0.design) } ?? .sans
        let icons = entries.contains { !$0.icon.isEmpty }
        let screen = Self.screenSize
        let maxW = min(320, screen.width - 32)
        let longest = entries.map { CGFloat($0.label.count) }.max() ?? 0
        let width = max(min(200, maxW), min(maxW, longest * 15.5 * fs * 0.52 + (icons ? 36 : 0) + 34 + (entries.contains { $0.checked } ? 30 : 0)))
        let tall = CGFloat(entries.count) * 48 + 12 > screen.height * 0.6

        let list = VStack(spacing: 0) {
            ForEach(entries) { entry in
                Button {
                    DesignHaptics.tick(ctx?.look.haptics ?? true)
                    pick(entry)
                } label: {
                    HStack(spacing: 0) {
                        if icons {
                            Group {
                                if entry.icon.isEmpty { Color.clear } else { DesignIcon(name: entry.icon, size: 20, color: entry.danger ? danger : primary) }
                            }
                            .frame(width: 22, height: 22)
                            .padding(.trailing, 14)
                        }
                        Text(verbatim: entry.label)
                            .font(entry.checked ? DesignFonts.label(size: 15.5 * fs, family: family)
                                  : DesignFonts.font(size: 15.5 * fs, weight: .regular, italic: false, family: family))
                            .foregroundStyle(entry.danger ? danger : onSurface.color)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if entry.checked {
                            DesignIcon(name: "check", size: 18, color: primary)
                                .padding(.leading, 12)
                        }
                    }
                    .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 18))
                    .frame(minHeight: 48)
                    .contentShape(Rectangle())
                }
                .buttonStyle(MenuRowStyle(highlight: onSurface.withAlpha(0.12).color))
                .accessibilityAddTraits(entry.checked ? .isSelected : [])
                .accessibilityIdentifier("menu/\(entry.id)")
            }
        }
        .padding(.vertical, 6)

        Group {
            if tall { ScrollView { list }.frame(height: screen.height * 0.6) } else { list }
        }
        .frame(width: width)
        .presentationBackground(surface)
    }

    @MainActor private static var screenSize: CGSize {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.keyWindow?.bounds.size ?? scene?.screen.bounds.size ?? CGSize(width: 390, height: 844)
    }
}

private struct MenuRowStyle: ButtonStyle {
    let highlight: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? highlight : .clear)
    }
}
