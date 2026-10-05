// The placeholder first screen of the shell: the mark, the version and the linked
// libraries (proof that M5Kit and WebRTC link on iPhone and iPad). Wave 2 replaces
// it with the design's screens (Renderer/ — Android A/ui/Renderer, MainActivity.route).
// Texts are verbatim: the real screens take every text from the design.

import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var widthClass

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()
            ScrollView {
                VStack(spacing: 28) {
                    header
                    libraries
                    status
                }
                .frame(maxWidth: 560)
                .padding(.horizontal, 24)
                .padding(.vertical, widthClass == .regular ? 72 : 40)
                .frame(maxWidth: .infinity)
            }
        }
        .preferredColorScheme(.dark)
        .tint(Color.accentColor)
    }

    private var header: some View {
        VStack(spacing: 14) {
            Image("Mark")
                .resizable()
                .scaledToFit()
                .frame(width: 112, height: 112)
                .accessibilityHidden(true)
            Text(verbatim: "M5cet")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .accessibilityIdentifier("app.title")
            Text(verbatim: "\(AppInfo.version) (\(AppInfo.build))")
                .font(.title3.monospacedDigit())
                .foregroundStyle(.white.opacity(0.7))
                .accessibilityIdentifier("app.version")
        }
    }

    private var libraries: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: "M5Kit")
                .font(.headline)
                .foregroundStyle(.white.opacity(0.85))
            FlowLayout(spacing: 8) {
                ForEach(AppInfo.modules, id: \.self) { name in
                    chip(name)
                }
            }
            .accessibilityIdentifier("app.modules")
            Text(verbatim: "WebRTC M150 · \(AppInfo.webRTC)")
                .font(.subheadline.monospaced())
                .foregroundStyle(.white.opacity(0.7))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var status: some View {
        VStack(alignment: .leading, spacing: 6) {
            row("Device", UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
            row("Layout", widthClass == .regular ? "regular width" : "compact width")
            row("APNs", model.apnsToken.map { String($0.prefix(12)) + "…" } ?? model.apnsError.map { _ in "no token" } ?? "registering…")
            if let link = model.pendingLink {
                row("Link", link.url.absoluteString)
            }
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }

    private func chip(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.callout.weight(.medium).monospaced())
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.accentColor.opacity(0.85), in: Capsule())
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(verbatim: label).foregroundStyle(.white.opacity(0.5)).frame(width: 64, alignment: .leading)
            Text(verbatim: value).foregroundStyle(.white.opacity(0.8)).lineLimit(2).truncationMode(.middle)
        }
    }
}

/// Chips that wrap onto the next line when the width runs out.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row { var items: [Int] = []; var y: CGFloat = 0; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + spacing))
            }
            var row = rows[rows.count - 1]
            row.width += (row.items.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.items.append(index)
            rows[rows.count - 1] = row
        }
        return rows
    }
}

#Preview {
    RootView().environment(AppModel())
}
