// ui/parts/PlaceSheet (6.7) and location/GeoLinks for iOS: the place of a message —
// the map (when the operator has maps on), the coordinates, and the same three
// actions as the web's place window, in the same order: Navigate, Ride, Copy.
// Navigate offers the navigation apps on this iPhone (the known ones with their own
// links — Apple Maps always), then the web; Ride the ride-hailing apps (Uber with
// the destination; Bolt, Liftago, FREENOW open and get it from the clipboard), then
// the web. The links are Platform/Location's GeoLinks (one table with Android and
// client/src/lib/geo-links.ts); nothing is opened until a line is tapped. "Open map"
// is Apple Maps (Where.appleMapsPinWeb) after the confirmation every link gets.

import M5Core
import M5Design
import M5Proto
import SwiftUI
import UIKit

@MainActor
enum PlaceSheet {
    static func show(_ m: ChatMessage, host: DesignHost) {
        guard BubbleKinds.position(m) != nil else { return }
        let vc = UIHostingController(rootView: AnyView(EmptyView()))
        let view = PlaceSheetView(message: m, host: host, close: { [weak vc] then in
            vc?.dismiss(animated: true) { then?() }
        })
        vc.rootView = AnyView(view.environment(host))
        if let sheet = vc.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        vc.view.backgroundColor = host.renderContext().color("@surface", .white).uiColor
        ChatFileActions.present(vc)
    }
}

private struct PlaceSheetView: View {
    let message: ChatMessage
    let host: DesignHost
    let close: (_ then: (() -> Void)?) -> Void
    @State private var picking: String?
    @Environment(\.designTextScale) private var scale

    var body: some View {
        let c = host.renderContext()
        let fg = c.swiftColor("@onSurface", .black), accent = c.swiftColor("@primary", .blue)
        let pos = BubbleKinds.position(message) ?? JSONObject()
        let lat = pos.chatDouble("lat"), lon = pos.chatDouble("lon"), acc = pos.optInt64("acc")
        let t = host.translator
        let title = message.mine ? t.t("map.captionMine") : t.t("map.caption").replacingOccurrences(of: "{name}", with: message.senderName)
        // The label goes along only with apps that show one: the sender's name, never mine.
        let label = message.mine ? "" : message.senderName
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: picking.map { t.t($0 == GeoLinks.nav ? "loc.navigateWith" : "loc.rideWith") } ?? title)
                    .font(.system(size: 20 * scale, weight: .bold))
                    .foregroundStyle(fg)
                    .padding(.bottom, 12)
                if let kind = picking {
                    picker(kind, lat: lat, lon: lon, label: label, fg: fg)
                } else {
                    let policy = MapBubble.policy(for: message)
                    if let policy {
                        MapBubbleView(message: message, policy: policy, fg: fg, primary: c.color("@primary", .blue), maxWidth: 560, t: t.t,
                                      onTap: { close { ChatActions.openMap(message, host: host) } })
                    }
                    if policy == nil || policy?.showCoords == false {
                        Text(verbatim: MapBubble.coords(lat, lon, acc))
                            .font(.system(size: 14 * scale)).foregroundStyle(fg.opacity(0.8)).textSelection(.enabled).padding(.top, 4)
                    }
                    HStack(spacing: 6) {
                        action("navigation", t.t("loc.navigate"), fg: fg, accent: accent) { picking = GeoLinks.nav }
                        action("hand", t.t("loc.ride"), fg: fg, accent: accent) { picking = GeoLinks.ride }
                        action("copy", t.t("loc.copy"), fg: fg, accent: accent) {
                            host.copy(GeoLinks.destinationText(lat, lon))
                            host.flash(title: "", text: "✓ " + t.t("loc.copy"), level: .success)
                        }
                    }
                    .padding(.top, 12).padding(.bottom, 4)
                    Text(verbatim: t.t("loc.privacy")).font(.system(size: 11.5 * scale)).foregroundStyle(fg.opacity(0.6)).padding(.top, 6)
                    HStack {
                        Spacer()
                        Button(t.t("nav.close")) { close(nil) }.buttonStyle(.borderless)
                        Button(t.t("map.open")) { close { ChatActions.openMap(message, host: host) } }.buttonStyle(.borderedProminent)
                    }
                    .tint(accent)
                    .padding(.top, 16)
                }
            }
            .padding(.horizontal, 20).padding(.top, 24).padding(.bottom, 16)
        }
    }

    /// One of the three: its icon over its label, the whole a pressable tile.
    private func action(_ icon: String, _ label: String, fg: Color, accent: Color, _ run: @escaping () -> Void) -> some View {
        Button {
            DesignHaptics.tick(Look(settings: host.settings).haptics)
            run()
        } label: {
            VStack(spacing: 4) {
                DesignIcon(name: icon, size: 22, color: accent)
                Text(verbatim: label).font(.system(size: 12.5 * scale, weight: .bold)).foregroundStyle(fg)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10).padding(.horizontal, 6)
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(fg.opacity(0.18), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(Text(verbatim: label))
    }

    /// The picker: the apps here first (their icon), then the web; each line says what happens.
    private func picker(_ kind: String, lat: Double, lon: Double, label: String, fg: Color) -> some View {
        let t = host.translator
        let list = GeoLinks.iosChoices(kind, lat, lon, label) { scheme in
            URL(string: scheme + "://").map { UIApplication.shared.canOpenURL($0) } ?? false
        }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(list, id: \.id) { choice in
                Button { open(choice, lat: lat, lon: lon) } label: {
                    HStack(spacing: 14) {
                        DesignIcon(name: choice.web ? "globe" : "map", size: 24, color: fg.opacity(0.7)).frame(width: 32, height: 32)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: choice.name).font(.system(size: 16 * scale)).foregroundStyle(fg)
                            let sub = [choice.web ? t.t("loc.inBrowser") : "", choice.prefill ? "" : t.t("loc.ride.paste")].filter { !$0.isEmpty }.joined(separator: " · ")
                            if !sub.isEmpty { Text(verbatim: sub).font(.system(size: 12.5 * scale)).foregroundStyle(fg.opacity(0.65)) }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
            }
            HStack {
                Spacer()
                Button(t.t("nav.close")) { picking = nil }.buttonStyle(.borderless)
            }
            .padding(.top, 12)
        }
    }

    /// Opens a choice: in its app (its link), or in the browser; an app that cannot take the destination gets it pasted.
    private func open(_ c: GeoLinks.Choice, lat: Double, lon: Double) {
        if !c.prefill {
            host.copy(GeoLinks.destinationText(lat, lon))
            host.flash(title: "", text: host.translator.t("loc.copied"), level: .info)
        }
        // In its app (its link, else just the app), or in the browser; an app that refuses it: its web link.
        let tries = [c.uri ?? c.pkg.map { $0 + "://" }, c.fallback].compactMap { $0 }.compactMap(URL.init(string:))
        func attempt(_ i: Int) {
            guard i < tries.count else { host.flash(title: "", text: host.translator.t("file.noApp"), level: .warn); return }
            UIApplication.shared.open(tries[i]) { ok in if !ok { Task { @MainActor in attempt(i + 1) } } }
        }
        attempt(0)
        close(nil)
    }
}
